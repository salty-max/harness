/**
 * The check queue: one `check` at a time on this machine, the others wait
 * their turn. Several sessions (a worktree each, or the family's shared
 * checkouts) running a heavy check at once starve each other: tests time out
 * on a load nobody asked for. q.ts takes a place here before it runs a
 * queued command (harness.toml `[checks] queue = true` queues every `check`;
 * `q.ts --queue <name>` queues any other run, `--no-queue` skips it once).
 *
 * The folder: $HARNESS_QUEUE (`off`: no queue), else <cache>/harness/queue
 * under the user's cache (XDG_CACHE_HOME, else ~/.cache): one line for every
 * project and repository of the user that asks, a project that doesn't ask
 * neither waits nor holds.
 *
 *   lock.json              the holder: { pid, at, name, repo, where }
 *   waiting/<ms>-<pid>.json   a waiter's ticket, in the order they came
 *
 * The lock is made whole by a link (a temp file linked in: it fails when the
 * name is taken, so two never share one, as board.ts makes a card). A waiter
 * takes it only when its ticket is the oldest living one, so the queue is
 * first come, first served and the lock needs no other mutex. Tickets and
 * holders die with their process: a pid gone, or one started after the file
 * was written (a pid reused), is dead, and a dead ticket is swept. A dead
 * holder's lock, or one held past MAX_HOLD (a wedged check), is taken over by
 * the head waiter alone (renamed aside and read again, so a lock that was
 * replaced meanwhile is put back), never by everyone at once. The command a
 * holder runs inherits HARNESS_QUEUE_HELD=<its pid>: a q run inside it (a
 * test of the harness, a check that calls a check) skips the queue instead
 * of waiting for its own holder.
 *
 * Waiting says one line on stderr, once. Not covered: a holder killed
 * with SIGKILL leaves its command running with the lock looking stale, and a
 * Mac that sleeps through MAX_HOLD makes a healthy holder look wedged: two
 * checks may overlap for a while (load, never a wrong stamp); and a
 * queue only orders what goes through q.
 */
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A lock held longer than this (seconds) is a wedged check: the head waiter takes its place. The family's longest check ran 9 minutes. */
export const MAX_HOLD = 3600;
const POLL_MS = 1000;

export type Holder = { pid: number; at: number; name: string; repo: string; where: string };
type Env = Record<string, string | undefined>;

/** The queue's folder, or undefined when the environment says there is none. */
export function queueDir(env: Env = process.env): string | undefined {
  const set = env.HARNESS_QUEUE;
  if (set === "off") return undefined;
  if (set) return set;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "harness", "queue");
}

/** Each pid's process start in ms (`ps`'s lstart, local time, C locale: cut to the second, never later than the real one); a pid gone has none; null when ps can't run. */
export function startOf(pid: number): number | undefined | null {
  let ran: ReturnType<typeof Bun.spawnSync>;
  try {
    ran = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } });
  } catch {
    return null;
  }
  const at = Date.parse(ran.stdout.toString().trim());
  return Number.isNaN(at) ? undefined : at;
}

/** Whether a process that wrote a file at `at` still runs: its pid is there and started no later than the file (a pid reused since started after). */
export function aliveSince(pid: number, at: number, start: typeof startOf = startOf): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const began = start(pid);
  // (ps can't say: the pid answers, that is all there is to go on)
  return began === null || began === undefined ? began === null : began <= at + 1000;
}

const lockFile = (dir: string) => join(dir, "lock.json");
const waitingDir = (dir: string) => join(dir, "waiting");
const field = (v: string) => v.replace(/[\r\n\t]+/g, " ").trim();

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The holder written in the lock file, undefined when there is none or it is unreadable. */
export const holderOf = (dir: string): Holder | undefined => {
  const h = readJson<Holder>(lockFile(dir));
  return h && Number.isInteger(h.pid) && Number.isFinite(h.at) ? h : undefined;
};

type Ticket = { pid: number; at: number; name: string; repo: string; where: string };
const ticketName = (t: Pick<Ticket, "pid" | "at">) => `${String(t.at).padStart(13, "0")}-${t.pid}.json`;

/** The tickets of waiters still alive, oldest first; the dead ones swept. The caller's own is never judged: it is alive, whatever a clock that stepped back says. */
function tickets(dir: string, alive: (pid: number, at: number) => boolean, self?: Pick<Ticket, "pid" | "at">): Ticket[] {
  const out: Ticket[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(waitingDir(dir));
  } catch {}
  for (const name of names.sort()) {
    const file = join(waitingDir(dir), name);
    if (name.endsWith(".tmp")) {
      // (a ticket being written is not ours to sweep: only one left behind, a minute old)
      try {
        if (Date.now() - statSync(file).mtimeMs > 60_000) rmSync(file, { force: true });
      } catch {}
      continue;
    }
    const t = /^\d{13}-\d+\.json$/.test(name) ? readJson<Ticket>(file) : undefined;
    if (t && Number.isInteger(t.pid) && ((self && t.pid === self.pid && t.at === self.at) || alive(t.pid, t.at))) out.push(t);
    else rmSync(file, { force: true });
  }
  return out;
}

/** The lock made whole, or false when someone holds it. */
function take(dir: string, h: Holder): boolean {
  const tmp = join(dir, `lock.${h.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(h)}\n`);
  try {
    linkSync(tmp, lockFile(dir));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** The lock of a dead or wedged holder taken away: renamed aside and read again, so a lock replaced meanwhile goes back. */
export function takeAway(dir: string, was: Holder | undefined): boolean {
  const aside = join(dir, `lock.${process.pid}.stale`);
  try {
    renameSync(lockFile(dir), aside);
  } catch {
    return false;
  }
  const moved = readJson<Holder>(aside);
  const same = was ? moved?.pid === was.pid && moved?.at === was.at : !moved;
  if (!same && moved) {
    try {
      linkSync(aside, lockFile(dir));
    } catch {}
  }
  rmSync(aside, { force: true });
  return same;
}

export type Options = {
  dir: string;
  name: string;
  repo: string;
  where: string;
  /** For tests: who asks, the clock, the wait between looks, what counts as alive, what is said. */
  pid?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  poll?: number;
  alive?: (pid: number, at: number) => boolean;
  maxHold?: number;
  say?: (line: string) => void;
};

export type Lease = {
  /** Ms spent waiting. */
  waited: number;
  /** The holder taken over (dead, or past MAX_HOLD), when there was one. */
  tookOver?: Holder;
  /** Gives the place up: the lock goes only when it is still this run's own. */
  release: () => void;
};

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}min`);

/** What the one waiting line says. */
export function waitingLine(name: string, holder: Holder | undefined, ahead: number, now: number): string {
  const who = holder ? `${holder.repo}'s ${holder.name} in ${holder.where} (pid ${holder.pid}, running ${secs(now - holder.at)})` : "the check ahead of it";
  const line = ahead > 0 ? `, ${ahead} more waiting ahead of this one` : "";
  return `${name}: waiting for ${who}${line}. Run it in the background or with a long timeout: a tool call that times out loses its place`;
}

/**
 * A place at the front of the queue: resolves when the lock is this run's.
 * Waits as long as it takes (a holder that is gone or wedged is taken over).
 */
export async function acquire(o: Options): Promise<Lease> {
  const pid = o.pid ?? process.pid;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // (a process's start never changes: asked of ps once for each pid and file, not at every look of every waiter)
  const starts = new Map<string, number | undefined | null>();
  const cached = (at: number) => (p: number) => {
    const key = `${p}:${at}`;
    if (!starts.has(key)) starts.set(key, startOf(p));
    return starts.get(key);
  };
  const alive = o.alive ?? ((p: number, at: number) => aliveSince(p, at, cached(at)));
  const limit = (o.maxHold ?? MAX_HOLD) * 1000;
  const begun = now();
  mkdirSync(waitingDir(o.dir), { recursive: true });
  const mine: Ticket = { pid, at: begun, name: field(o.name), repo: field(o.repo), where: field(o.where) };
  const ticket = join(waitingDir(o.dir), ticketName(mine));
  const part = `${ticket}.${pid}.tmp`;
  const write = () => {
    mkdirSync(waitingDir(o.dir), { recursive: true });
    writeFileSync(part, `${JSON.stringify(mine)}\n`);
    renameSync(part, ticket);
  };
  write();

  // (killed while it waits: its ticket goes, never another's lock)
  const stops = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((sig) => {
    const h = () => {
      rmSync(ticket, { force: true });
      process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGHUP" ? 1 : 15));
    };
    if (o.pid === undefined) process.on(sig, h);
    return [sig, h] as const;
  });
  const settle = () => {
    for (const [sig, h] of stops) process.off(sig, h);
  };

  let said = false;
  let took: Holder | undefined;
  let heldAt = 0;
  try {
    for (;;) {
      // (swept by mistake, or the folder cleared: its place is written again, never lost for good)
      if (!existsSync(ticket)) write();
      const line = tickets(o.dir, alive, mine);
      const head = line[0]?.pid === pid && line[0]?.at === begun;
      const holder = holderOf(o.dir);
      const locked = existsSync(lockFile(o.dir));
      const gone = locked && (!holder || !alive(holder.pid, holder.at) || now() - holder.at > limit);
      if (head) {
        if (gone && takeAway(o.dir, holder)) {
          took = holder;
          o.say?.(holder ? `${o.name}: ${holder.repo}'s ${holder.name} (pid ${holder.pid}) is ${alive(holder.pid, holder.at) ? `past ${Math.round(limit / 60_000)} minutes` : "gone"}: taking its place` : `${o.name}: the lock file was unreadable: taking its place`);
        }
        const at = now();
        if (!existsSync(lockFile(o.dir)) && take(o.dir, { pid, at, name: mine.name, repo: mine.repo, where: mine.where })) {
          heldAt = at;
          break;
        }
      }
      if (!said) {
        said = true;
        o.say?.(waitingLine(o.name, holder, line.findIndex((t) => t.pid === pid && t.at === begun), now()));
      }
      await sleep(o.poll ?? POLL_MS);
    }
  } finally {
    rmSync(ticket, { force: true });
    settle();
  }
  return {
    waited: now() - begun,
    ...(took ? { tookOver: took } : {}),
    release: () => {
      const h = holderOf(o.dir);
      if (h && h.pid === pid && h.at === heldAt) rmSync(lockFile(o.dir), { force: true });
    },
  };
}

/** Whether this process runs inside a command a queue holder started: HARNESS_QUEUE_HELD names a holder still alive. */
export function inside(env: Env = process.env, alive: (pid: number) => boolean = (p) => aliveSince(p, Date.now())): boolean {
  const held = Number(env.HARNESS_QUEUE_HELD);
  return Number.isInteger(held) && held > 0 && alive(held);
}
