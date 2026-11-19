/**
 * The quiet runner: a command's whole output kept in a log, one verdict line
 * printed, and on a failure the lines that matter (20 at most). The exit
 * code passes through, so `q.ts … | tail` is never needed and never hides
 * one. A passing `check` stamps the tree it ran on: the pre-push hook asks
 * for that stamp.
 *
 *   bun q.ts [--queue|--no-queue] [--limit <minutes>] <name> -- <command...>
 *   bun q.ts --queue-status
 *
 *   bun q.ts check -- bun run check   check: ok (41s) · stamped 3f2a1b9 · .cache/logs/check-20261118T125539Z-4821.log
 *   bun q.ts test -- bun test         test: FAILED (exit 1, 3s) · .cache/logs/test-20261118T125601Z-4830.log
 *                                                    (fail) the stamp > …
 *
 * The log: one file for each run, <repo>/.cache/logs/<name>-<UTC time>-<pid>.log,
 * the command first, its exit last, and the verdict line ends with its path:
 * read that one. Two runs of one name in one tree (a check and a reviewer's
 * check, queued or not) never overwrite each other. <name>.log is a link to
 * the latest run started, for a reader who looks by name only: another run
 * may have moved it since, so a verdict's own path is the one to trust. The
 * last 10 logs of each name are kept (<repo>: the repository the command runs
 * in; .cache/ is ignored by a .gitignore of its own). The stamp: <git common dir>/harness/check-<tree>,
 * the tree of the working directory as the check found it (tracked and
 * untracked files, the ignored left out), shared by the repository's
 * worktrees: a commit of exactly that state pushes. Only the repository's
 * own check stamps (harness.check, else `bun run check` where package.json
 * has one; a repository with neither stamps nothing), and a failing check
 * on a stamped tree takes the stamp back. Stamps older than 30 days go.
 * A check says so when the repository's git hooks are gone (core.hooksPath
 * naming a folder without them: git then runs no gate at all).
 * The verdict line goes to the harness's event log too (events.ts), and while
 * it runs a file of its own says so beside it (the panel's gates lit).
 *
 * The queue (queue.ts): with `[checks] queue = true` in harness.toml every
 * `check` waits its turn, one at a time on the machine, whatever worktree or
 * repository it runs in; `--queue` queues any other run, `--no-queue` skips
 * the queue once, HARNESS_QUEUE=off everywhere. A waiting run says so in one
 * line on stderr and takes its place before anything else: the log, the
 * panel's file and the tree it stamps are those of the moment it runs. The
 * verdict, the stamp, the event log and the exit code are what they are
 * without a queue. A run inside a queued command (HARNESS_QUEUE_HELD) never
 * waits for its holder.
 *
 * The time limit: a run that holds a place in the queue is stopped when it
 * has run for DEFAULT_LIMIT (30) minutes, `[checks] queue_limit` in
 * harness.toml (minutes, 0 for none) or `--limit <minutes>` (decimals allowed,
 * 0 for none; also on a run that isn't queued, which has no limit otherwise).
 * A hung command holds the machine's one place for everyone behind it, and the
 * queue frees a place only when its holder dies. Past the limit q sends SIGTERM
 * to the command and everything it started (the whole tree below it as `ps`
 * shows it, a browser that left the command's process group included), SIGKILL
 * to what is left after GRACE seconds (HARNESS_QUEUE_GRACE moves it, for tests),
 * gives the place up and ends with `check: FAILED (timed out after 30min, exit
 * 124)` and the log's path. The clock starts when the command does, not while
 * the run waits. A timed-out `check` stamps nothing. A run inside a queued
 * command holds no place and gets no limit of its own: its holder's covers it.
 * q stopped by a signal passes it to the command, as it always did, and
 * SIGKILLs what is left of the tree after the same grace (a second signal at
 * once): a command that ignores SIGTERM no longer keeps q, and its place,
 * forever.
 * `--queue-status` prints who holds the queue and who waits, writing nothing.
 */
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { configuredCheck, loadConfig, toolCmd } from "./config";
import { logEvent, repoOf, startRun } from "./events";
import { acquire, DEFAULT_LIMIT, inside, queueDir, span, status, statusLines, type Lease } from "./queue";

export const MAX_LINES = 20;

// ── git ─────────────────────────────────────────────────────────────────────
function git(cwd: string, args: string[], env?: Record<string, string>): string | undefined {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: env ? { ...process.env, ...env } : undefined, stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
}

export const topLevel = (cwd: string) => git(cwd, ["rev-parse", "--show-toplevel"]);
export const commonDir = (cwd: string) => git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
export const headTree = (cwd: string) => git(cwd, ["rev-parse", "--verify", "-q", "HEAD^{tree}"]);

// The tree a commit of everything in the working directory would have, read
// through an index of its own (the repository's index untouched).
export function workTree(cwd: string): string | undefined {
  const top = topLevel(cwd);
  const index = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  if (!top || !index) return undefined;
  const tmp = mkdtempSync(join(tmpdir(), "q-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE);
    if (git(top, ["add", "-A"], env) === undefined) return undefined;
    return git(top, ["write-tree"], env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The repository's check: harness.check (git config), else harness.toml's
// for it, else `bun run check` where package.json has one, else the
// config's default (undefined: none known, any check stamps).
export function checkCommand(top: string): string | undefined {
  const set = git(top, ["config", "--get", "harness.check"]);
  if (set) return set;
  const own = configuredCheck(top);
  if (own) return own;
  try {
    if (JSON.parse(readFileSync(join(top, "package.json"), "utf8")).scripts?.check) return "bun run check";
  } catch {}
  try {
    return loadConfig(top).defaults.check;
  } catch {
    return undefined;
  }
}

// ── the stamps ──────────────────────────────────────────────────────────────
export type Stamp = { tree: string; head?: string; at: string; command: string; seconds: number };

export const stampDir = (cwd: string) => {
  const common = commonDir(cwd);
  return common ? join(common, "harness") : undefined;
};

export function stampOf(cwd: string, tree: string | undefined): Stamp | undefined {
  const dir = stampDir(cwd);
  if (!dir || !tree) return undefined;
  const file = join(dir, `check-${tree}`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { tree, at: new Date(statSync(file).mtimeMs).toISOString(), command: "?", seconds: 0 };
  }
}

// The newest stamp of a repository, whatever its tree.
export function lastStamp(cwd: string): Stamp | undefined {
  const dir = stampDir(cwd);
  if (!dir || !existsSync(dir)) return undefined;
  const newest = readdirSync(dir)
    .filter((f) => f.startsWith("check-"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  return newest && stampOf(cwd, newest.f.slice("check-".length));
}

function stamp(cwd: string, s: Stamp) {
  const dir = stampDir(cwd)!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `check-${s.tree}`), JSON.stringify(s) + "\n");
}

// Stamps older than a month: a tree that old won't be pushed (its check would run again).
const STAMP_DAYS = 30;
function prune(cwd: string, now = Date.now()) {
  const dir = stampDir(cwd);
  if (!dir || !existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((f) => f.startsWith("check-")))
    if (now - statSync(join(dir, f)).mtimeMs > STAMP_DAYS * 86_400_000) rmSync(join(dir, f), { force: true });
}

// core.hooksPath naming a folder without the gates (the kit moved, an old
// checkout of it): git runs no hook and says nothing, so the check does.
export function hooksGone(top: string): string | undefined {
  const path = git(top, ["config", "--get", "core.hooksPath"]);
  if (!path || path.includes(".husky")) return undefined;
  const at = path.startsWith("/") ? path : join(top, path);
  const ok = (f: string) => existsSync(join(at, f)) && (statSync(join(at, f)).mode & 0o111) !== 0;
  return ok("pre-push") && ok("commit-msg") ? undefined : `hooks gone: ${path} has no gates, git runs none (${toolCmd("hooks")} install)`;
}

function unstamp(cwd: string, tree: string) {
  const dir = stampDir(cwd);
  if (dir) rmSync(join(dir, `check-${tree}`), { force: true });
}

// ── the lines that matter, pure (harness.test.ts) ───────────────────────────
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const BAD =
  /\b(errors?|fail|failed|failures?|failing|assert|assertion|expected|received|traceback|exception|panic|fatal|refused|missing|cannot|can't|unable|not found|mismatch|stale|differs?)\b|✗|✘|×|❌|:\d+:(\d+:)?\s/i;
// (what a passing step says in words BAD knows: every addon's ids check and selene print some)
const FINE = /\b0 (errors?|fail(ed|ures?)?|problems?)\b|\b0 [\w ]*errors?\b|\bno errors?\b|\bnone missing\b|^\s*at\s|^\s*\d+ pass\b|^\s*✓|\(pass\)/i;
// (the output's end, always shown: a chain of steps stops on the one that failed)
const END = 5;

export function clean(text: string): string[] {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.split("\r").pop()!.trimEnd())
    .filter((l) => l.trim());
}

export function matters(lines: string[], max = MAX_LINES): string[] {
  const cut = (l: string) => (l.length > 200 ? `${l.slice(0, 199)}…` : l);
  const flagged = lines.map((l, i) => (BAD.test(l) && !FINE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!flagged.length) return lines.slice(-max).map(cut);
  // The flagged lines, then the output's last lines whatever they say: a
  // failure no word of BAD names (a diff, a crash) is at the end.
  const end = lines.map((_, i) => i).slice(-END);
  const early = flagged.filter((i) => i < end[0]).filter((i, k, a) => k === 0 || lines[i] !== lines[a[k - 1]]);
  const room = max - end.length - (early.length + end.length > max ? 1 : 0);
  const head = early.length > room ? [...early.slice(0, Math.max(0, room - 3)), -1, ...early.slice(-3)] : early;
  const hidden = early.length - (head.length - (head.includes(-1) ? 1 : 0));
  const out = head.map((i) => (i < 0 ? `… ${hidden} more in the log` : lines[i]));
  if (early.length && end[0] > (early.at(-1) ?? -1) + 1) out.push("…");
  return [...out, ...end.map((i) => lines[i])].map(cut);
}

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

/** The exit code of a run q stopped for running past its limit, as timeout(1)'s. */
export const TIMED_OUT = 124;

export function verdict(name: string, code: number, ms: number, limitMs?: number): string {
  if (limitMs !== undefined) return `${name}: FAILED (timed out after ${span(limitMs)}, exit ${code})`;
  return code === 0 ? `${name}: ok (${secs(ms)})` : `${name}: FAILED (exit ${code}, ${secs(ms)})`;
}

// <repo>/.cache/<sub>, made; a .cache/ the repository's .gitignore forgot
// still stays out of git (a .gitignore of its own).
export function cacheDir(top: string, sub: string): string {
  const cache = join(top, ".cache");
  mkdirSync(join(cache, sub), { recursive: true });
  if (!existsSync(join(cache, ".gitignore"))) writeFileSync(join(cache, ".gitignore"), "*\n");
  return join(cache, sub);
}

// ── the logs ────────────────────────────────────────────────────────────────
// One file for each run: <name>-<UTC time>-<pid>.log (a counter after the pid
// if the same process ran the same name in the same second), made with "wx" so
// no run ever opens another's. <name>.log is a link to the latest run started.
export const LOG_KEEP = 10;

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
const runLog = (name: string) => new RegExp(`^${escapeRe(name)}-\\d{8}T\\d{6}Z-\\d+(?:-\\d+)?\\.log$`);

function newLog(dir: string, name: string, now = new Date()): { fd: number; file: string } {
  const at = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  for (let n = 0; ; n++) {
    const file = join(dir, `${name}-${at}-${process.pid}${n ? `-${n}` : ""}.log`);
    try {
      return { fd: openSync(file, "wx+"), file };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 99) throw e;
    }
  }
}

/** <name>.log made to point at `file`, in one step (a reader never finds it missing); an older q's plain file is replaced. Never fails the run: where no link can be made, the name is left without a log, never with an older run's. */
export function pointAt(dir: string, name: string, file: string): void {
  const tmp = join(dir, `.${name}.log.${process.pid}`);
  try {
    rmSync(tmp, { force: true });
    symlinkSync(basename(file), tmp);
    renameSync(tmp, join(dir, `${name}.log`));
  } catch {
    for (const f of [tmp, join(dir, `${name}.log`)])
      try {
        rmSync(f, { force: true });
      } catch {}
  }
}

/** Every run log of `name` but the newest `keep` removed (the last written first to stay, so a run still going keeps its file) and never `except`, the one just made (whatever its mtime says, a clock set back included). Other names, the link and any other file in the folder stay. Never fails the run. */
export function pruneLogs(dir: string, name: string, keep = LOG_KEEP, except?: string): void {
  try {
    const own = runLog(name);
    const logs = readdirSync(dir)
      .filter((f) => own.test(f) && f !== except)
      .flatMap((f) => {
        try {
          return [{ f, at: statSync(join(dir, f)).mtimeMs }];
        } catch {
          return []; // (gone meanwhile)
        }
      })
      .sort((a, b) => a.at - b.at || (a.f < b.f ? -1 : 1));
    for (const { f } of logs.slice(0, Math.max(0, logs.length - (except ? keep - 1 : keep)))) rmSync(join(dir, f), { force: true });
  } catch {}
}

// The log as written so far, read through its own descriptor: a file another run pruned meanwhile is still there to this one.
function readLog(fd: number): string {
  const buf = Buffer.alloc(fstatSync(fd).size);
  readSync(fd, buf, 0, buf.length, 0);
  return buf.toString("utf8");
}

// ── stopping a command ──────────────────────────────────────────────────────
/** Seconds a stopped command and its tree have to end on SIGTERM before they get SIGKILL. */
export const GRACE = 10;
const graceMs = (env: Record<string, string | undefined> = process.env) => {
  const n = Number(env.HARNESS_QUEUE_GRACE);
  return (env.HARNESS_QUEUE_GRACE && Number.isFinite(n) && n >= 0 ? n : GRACE) * 1000;
};

/** Processes by pid, each with its start as `ps` writes it: a pid met again with another start is another process (a pid reused). */
export type Procs = Map<number, string>;

/** The same process by its start as two looks at `ps` give it (to the second: Linux's start can move by one between looks); a start that is no date is compared as text. */
export const sameStart = (a: string | undefined, b: string): boolean => {
  if (a === undefined) return false;
  const [x, y] = [Date.parse(a), Date.parse(b)];
  return a === b || (!Number.isNaN(x) && !Number.isNaN(y) && Math.abs(x - y) <= 2000);
};
export type PsRow = { pid: number; ppid: number; start: string };

/** `ps -A -o pid=,ppid=,lstart=` read. */
export function parsePs(text: string): PsRow[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), start: m[3]! }] : [];
  });
}

/** The `roots` and everything below them, found by parent pid: what the command started, a browser that left its process group included, and the ones that started those. The first root first; a root that is gone is skipped. */
export function treeOf(rows: PsRow[], roots: number | number[]): Procs {
  const kids = new Map<number, PsRow[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  const seeds = (Array.isArray(roots) ? roots : [roots]).flatMap((pid) => rows.filter((r) => r.pid === pid));
  const out: Procs = new Map();
  const todo = [...seeds];
  for (let r = todo.shift(); r; r = todo.shift()) {
    if (out.has(r.pid)) continue;
    out.set(r.pid, r.start);
    todo.push(...(kids.get(r.pid) ?? []));
  }
  return out;
}

function table(): PsRow[] | undefined {
  try {
    const p = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,ppid=,lstart="], { env: { ...process.env, LC_ALL: "C" }, stderr: "ignore" });
    return p.exitCode === 0 ? parsePs(p.stdout.toString()) : undefined;
  } catch {
    return undefined;
  }
}

const exists = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

function send(tree: Procs, sig: NodeJS.Signals) {
  for (const pid of tree.keys())
    try {
      process.kill(pid, sig);
    } catch {}
}

export type Stopper = {
  /** Whether a stop has begun. */
  started: () => boolean;
  /** Sends `sig` to the command's whole tree, or to the command alone (`whole` false: what q has always done with a signal it was sent, the terminal's Ctrl-C having reached the rest of the group already); the tree is SIGKILLed after the grace either way. Asked again (a second signal), everything is SIGKILLed at once. */
  stop: (sig: NodeJS.Signals, whole?: boolean) => void;
  /** Resolves once a stop has run its course: the tree gone, or what is left said. Undefined at once when none began. */
  finished: () => Promise<string | undefined>;
};

/**
 * Stops a command by its whole tree: SIGTERM to every process below `root` as `ps` shows them, SIGKILL after `grace` ms to the ones
 * that are still the same processes (a pid reused meanwhile is left alone) and to what the command started in the meantime, then up
 * to 10 s more for them to go before it gives up and says what is left. Never throws.
 */
export function stopper(root: number, grace: number = graceMs()): Stopper {
  let asked: Procs | undefined;
  let killNow = false;
  let wake = () => {};
  let course: Promise<string | undefined> | undefined;
  // (what of the first look still runs, and what those have started since: walked from the survivors alone, so a pid reused by another process, the root's too, is never one; with no ps, what answers)
  const left = (): Procs => {
    const rows = table();
    if (!rows) return new Map([...asked!].filter(([pid]) => exists(pid)));
    const now = new Map(rows.map((r) => [r.pid, r.start]));
    const still: Procs = new Map([...asked!].filter(([pid, start]) => sameStart(now.get(pid), start)));
    for (const [pid, start] of treeOf(rows, [...still.keys()])) still.set(pid, start);
    return still;
  };
  const go = async (): Promise<string | undefined> => {
    for (const end = Date.now() + grace; !killNow && Date.now() < end && left().size; ) await Promise.race([Bun.sleep(150), new Promise<void>((r) => (wake = r))]);
    const rest = left();
    if (!rest.size) return "ended on SIGTERM";
    send(rest, "SIGKILL");
    for (const end = Date.now() + 10_000; Date.now() < end && left().size; ) await Bun.sleep(100);
    const stuck = left();
    return stuck.size ? `SIGKILL to ${rest.size}, still running after it: pid ${[...stuck.keys()].join(", ")} (the place is given up anyway)` : `SIGKILL to ${rest.size}`;
  };
  return {
    started: () => asked !== undefined,
    stop(sig, whole = true) {
      if (asked) {
        killNow = true;
        wake();
        return;
      }
      const rows = table();
      asked = rows ? treeOf(rows, root) : new Map();
      // (no ps, or the root not in its table: the root alone, as far as a pid goes)
      if (!asked.size) asked.set(root, "");
      send(whole ? asked : new Map([[root, asked.get(root)!]]), sig);
      course = go();
    },
    finished: () => course ?? Promise.resolve(undefined),
  };
}

// ── the run ─────────────────────────────────────────────────────────────────
export type Parsed = { name: string; command: string[]; queue?: boolean; limit?: number };

const USAGE = "usage: bun q.ts [--queue|--no-queue] [--limit <minutes>] <name> -- <command...>   or: bun q.ts --queue-status";

export function parse(all: string[]): Parsed | { status: true } | string {
  if (all.length === 1 && all[0] === "--queue-status") return { status: true };
  let queue: boolean | undefined;
  let limit: number | undefined;
  let first = 0;
  for (;;) {
    const flag = all[first];
    if (flag === "--queue" || flag === "--no-queue") {
      queue = flag === "--queue";
      first++;
    } else if (flag === "--limit") {
      const given = all[first + 1];
      const n = given === undefined || !given.trim() ? NaN : Number(given);
      if (!Number.isFinite(n) || n < 0) return `--limit is a number of minutes (0: no limit), not ${given === undefined ? "nothing" : JSON.stringify(given)}`;
      limit = n;
      first += 2;
    } else break;
  }
  const argv = all.slice(first);
  const dash = argv.indexOf("--");
  const name = argv[0];
  if (dash !== 1 || !name || dash === argv.length - 1) return USAGE;
  if (!/^[\w.-]+$/.test(name)) return `a name of letters, digits, '.', '-' or '_', not ${name}`;
  return { name, command: argv.slice(dash + 1), ...(queue === undefined ? {} : { queue }), ...(limit === undefined ? {} : { limit }) };
}

/** The minutes a run may take: `--limit`'s when given (0: none), else, for a run that holds a place in the queue, the project's `queue_limit` or the default, else none (a run with no place in the line, a queued command's own included, has no limit unless it asks). Undefined: no limit. */
export function limitMinutes(o: { flag?: number; config?: number; leased: boolean }): number | undefined {
  const minutes = o.flag ?? (o.leased ? (o.config ?? DEFAULT_LIMIT) : undefined);
  return minutes !== undefined && minutes > 0 ? minutes : undefined;
}

/** A place in the check queue when this run should have one: the `check` of a project that queues, any run that asks; and the time limit its command gets, with the place or without. Never fails the run. */
async function enter(name: string, repo: string, where: string, cwd: string, ask?: boolean, flag?: number): Promise<{ lease?: Lease; limitMs?: number }> {
  const alone = limitMinutes({ flag, leased: false });
  try {
    let queued = ask;
    const checks = (() => {
      try {
        return loadConfig(cwd).checks;
      } catch (e) {
        // (a project with no config is no news; one with a bad value would otherwise run without its queue and its limit, quietly)
        if (!/^no harness\.toml above/.test((e as Error).message)) console.error(`${name}: ${(e as Error).message}: running without the queue`);
        return undefined;
      }
    })();
    queued ??= name === "check" && !!checks?.queue;
    const config = checks?.queueLimit;
    const dir = queued ? queueDir() : undefined;
    if (!dir || inside()) return { limitMs: alone === undefined ? undefined : alone * 60_000 };
    const minutes = limitMinutes({ flag, config, leased: true });
    const statusCmd = (() => {
      try {
        return `${toolCmd("q", cwd)} --queue-status`;
      } catch {
        return undefined;
      }
    })();
    const lease = await acquire({ dir, name, repo, where, ...(minutes ? { limit: minutes * 60 } : {}), ...(statusCmd ? { statusCmd } : {}), say: (line) => console.error(line) });
    return { lease, limitMs: minutes === undefined ? undefined : minutes * 60_000 };
  } catch (e) {
    console.error(`${name}: the queue failed (${(e as Error).message}): running without it`);
    return { limitMs: alone === undefined ? undefined : alone * 60_000 };
  }
}

export async function run(name: string, command: string[], cwd = process.cwd(), queue?: boolean, limit?: number): Promise<number> {
  const top = topLevel(cwd);
  const repo = repoOf(cwd);
  // (first, before the log, the panel's file and the tree are looked at: they are those of the moment it runs)
  const { lease, limitMs } = await enter(name, repo, top ?? cwd, cwd, queue, limit);
  try {
    return await runIt(name, command, cwd, top, repo, lease, limitMs);
  } finally {
    lease?.release();
  }
}

async function runIt(name: string, command: string[], cwd: string, top: string | undefined, repo: string, lease: Lease | undefined, limitMs?: number): Promise<number> {
  // The gates at work (the panel's) until just before the verdict reaches the
  // log. A run that throws leaves its file to a dead pid: the panel skips it.
  const done = startRun(name, repo);
  const logs = cacheDir(top ?? cwd, "logs");
  const checking = name === "check" && top !== undefined;
  const before = checking ? workTree(cwd) : undefined;

  const { fd, file: log } = newLog(logs, name);
  pointAt(logs, name, log);
  pruneLogs(logs, name, LOG_KEEP, basename(log));
  writeSync(fd, `$ ${command.join(" ")}\n`);
  const start = performance.now();
  let code: number;
  let timedOut = false;
  try {
    const p = Bun.spawn(command, { cwd, stdin: "ignore", stdout: fd, stderr: fd, env: { ...process.env, NO_COLOR: "1", ...(lease ? { HARNESS_QUEUE_HELD: String(process.pid) } : {}) } });
    // (q stopped stops its command too: never a check left running on its own, racing the next. The signal goes to the command, as it always did; what is left of the tree is SIGKILLed after the grace, all of it at once when a second comes)
    const reap = stopper(p.pid);
    let over = false;
    const pass = (sig: NodeJS.Signals) => () => {
      if (!over || reap.started()) reap.stop(sig, false);
    };
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((sig) => [sig, pass(sig)] as const);
    for (const [sig, h] of handlers) process.on(sig, h);
    // (the limit's clock starts with the command, not with the wait for its place)
    const clock =
      limitMs === undefined
        ? undefined
        : setTimeout(() => {
            if (over || reap.started()) return;
            timedOut = true;
            reap.stop("SIGTERM");
          }, limitMs);
    await p.exited;
    over = true;
    clearTimeout(clock);
    const note = await reap.finished();
    for (const [sig, h] of handlers) process.off(sig, h);
    code = timedOut ? TIMED_OUT : (p.exitCode ?? 128 + (constants.signals[p.signalCode as keyof typeof constants.signals] ?? 0));
    if (timedOut) writeSync(fd, `\n[timed out after ${span(limitMs!)}: ${note}]`);
    else if (note?.includes("still running")) writeSync(fd, `\n[${note}]`);
  } catch (e) {
    writeSync(fd, `${(e as Error).message}\n`);
    code = 127;
  }
  const ms = performance.now() - start;
  writeSync(fd, `\n[exit ${code}, ${secs(ms)}]\n`);
  const out = code !== 0 ? clean(readLog(fd)).slice(1, -1) : [];
  closeSync(fd);

  let line = verdict(name, code, ms, timedOut ? limitMs : undefined);
  if (checking && !before && code === 0) line += " · not stamped: couldn't read the working tree (git status)";
  if (checking && before) {
    const after = workTree(cwd);
    const expected = checkCommand(top!);
    if (code !== 0) unstamp(cwd, before);
    else if (!expected) line += " · not stamped: no check known here (git config harness.check '<the check>', or package.json's check)";
    else if (command.join(" ") !== expected) line += ` · not stamped: this repository's check is \`${expected}\``;
    else if (after !== before) line += " · not stamped: the files changed while it ran, run it again";
    else {
      stamp(cwd, { tree: before, head: git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]), at: new Date().toISOString(), command: command.join(" "), seconds: Math.round(ms / 1000) });
      line += ` · stamped ${before.slice(0, 7)}`;
      prune(cwd);
    }
    const gone = hooksGone(top!);
    if (gone) line += ` · ${gone}`;
  }
  // (last, after the stamp and the rest: this run's own log, the one to read; another run may have moved <name>.log since)
  line += ` · ${relative(process.cwd(), log) || log}`;
  done();
  console.log(line);
  logEvent(name, code !== 0 ? "fail" : line.includes("not stamped") ? "wait" : "ok", repo, line);
  if (code !== 0) for (const l of matters(out)) console.log(`  ${l}`);
  return code;
}

if (import.meta.main) {
  const args = parse(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(args);
    process.exit(2);
  }
  if ("status" in args) {
    const dir = queueDir();
    for (const line of dir ? statusLines(status(dir)) : ["queue: off (HARNESS_QUEUE=off)"]) console.log(line);
    process.exit(0);
  }
  process.exit(await run(args.name, args.command, process.cwd(), args.queue, args.limit));
}
