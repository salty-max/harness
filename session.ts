/**
 * A new task opened in a session of its own (the family's "one session per
 * task"): a session asked a task that isn't its own opens one here, tells
 * the user its name and how to attach, and writes nothing for it.
 *
 *   bun session.ts "<card title>" --repos a,b --kind code|prose [--plan] [--dry-run] [--desktop] -- "<the task>"
 *
 *   title     the new session's name and its card's title
 *   repos     every repository the task writes: its card's --repos, the
 *             first its repo
 *   kind      the family's models by kind: code (and mechanical work)
 *             opusplan, prose (voices, translations, design) opus. opusplan
 *             is Opus in plan mode and Sonnet otherwise: without --plan the
 *             session settles its own plan, the architect helper (Opus)
 *             looking before it locks, and never stops for the user's
 *             approval of it
 *   plan      the opener's call, never a question for the user: start the
 *             session in plan mode when its task needs a design settled
 *             first. It plans on Opus and writes nothing, its card
 *             included, until the user approves the plan (leaving plan mode
 *             always asks): one stop, so only when the design is worth it.
 *             No card shows that wait: the output says it, for the opener
 *             to tell the user
 *   dry-run   print the command and the prompt, start nothing
 *   desktop   the prompt alone, for a desktop child: the opener hands it to
 *             the app's own session tool. Printed alone on stdout, nothing
 *             started (notes still go to stderr), and it wins over --dry-run
 *   the task  in the user's words, with what the opener knows
 *
 * It runs `claude --bg -n <title> --model <model> <prompt>` from the family
 * folder, without the running session's variables (CLAUDECODE and every
 * CLAUDE_*, but CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR and the user's
 * CLAUDE_CONFIG_DIR): the board's lock tells sessions apart by
 * CLAUDE_CODE_SESSION_ID, and a session that inherited the opener's would
 * write its card as the opener's. The prompt begins with the family's
 * CLAUDE.md and the card, then the task; it names the opener (its display
 * name, else its open card's title). It prints the new session's id and
 * how to attach, says which of its repositories another card holds now, and
 * logs the opening in the harness's event log.
 *
 * The child reports to its opener (SendMessage, to the opener's socket from
 * Claude Code's session registry, else to its name) each time its card stops
 * and once it has pushed: the opener checks its work, then closes it. Each
 * opening leaves a record, `.cache/harness/opened/<short id>.json`.
 *
 *   bun session.ts children [--all]
 *   bun session.ts close <id> [--force]
 *   bun session.ts check <id>
 *
 *   children  the records of the sessions this one opened (--all: every
 *             record), their state, their cards, and what keeps each from
 *             closing
 *   close     stops a finished child (`claude stop`) and drops its record:
 *             refused while it is mid-turn (never overridden), and, unless
 *             --force (on the user's word), while this session didn't open
 *             it (no record, or another opener's), it wrote no card, a card
 *             is not done, a repository of it has commits unpushed (on no
 *             remote at all, committed since it started: another open card
 *             there never excuses them, the reason names it) or uncommitted
 *             changes no other running card explains
 *   check     a desktop child's verdict, for its opener to archive it (the
 *             desktop app's own session tool opens it, archiving closes it):
 *             close's verdict without the stop, the record or the log, and
 *             without asking whose it is (the opener confirms that in the
 *             desktop app). <id> is a desktop id (local_<uuid>, mapped through
 *             the registry's hostSessionId), a session id or a short one. No
 *             --force: forcing is the archive's, on the user's word. Exit 0:
 *             may close, 1: not yet, or can't tell
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Card, cards, holders, repoList, strangers } from "./board";
import { logEvent } from "./events";
import { loadConfig, projectPath, projectRoot, repoDir, toolCmd } from "./config";

export const KINDS = { code: "opusplan", prose: "opus" } as const;
export type Kind = keyof typeof KINDS;

export type Ask = { title: string; repos: string[]; kind: Kind; plan: boolean; dryRun: boolean; desktop: boolean; task: string };

const tilde = (p: string) => (p.startsWith(homedir() + "/") ? `~${p.slice(homedir().length)}` : p);
const USAGE = () => `usage: ${toolCmd("session")} "<card title>" --repos a,b --kind code|prose [--plan] [--dry-run] [--desktop] -- "<the task>"
       ${toolCmd("session")} children [--all]
       ${toolCmd("session")} close <id> [--force]
       ${toolCmd("session")} check <id>`;

export function parse(argv: string[]): Ask | string {
  const cut = argv.indexOf("--");
  const head = cut === -1 ? argv : argv.slice(0, cut);
  const task = cut === -1 ? "" : argv.slice(cut + 1).join(" ").trim();
  let title = "";
  let repos: string[] = [];
  let kind = "";
  let plan = false;
  let dryRun = false;
  let desktop = false;
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--repos" || a === "--kind") {
      if (head[i + 1] === undefined) return `${a} takes a value`;
      if (a === "--repos") repos = repoList(head[++i]);
      else kind = head[++i];
    } else if (a === "--plan") plan = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--desktop") desktop = true;
    else if (a.startsWith("-")) return `unknown option ${a}`;
    else if (title) return `one title (a second: ${a}); the task goes after --`;
    else title = a.trim();
  }
  if (!title) return "the card's title first";
  if (repos.length === 0) return "--repos names every repository the task writes";
  const odd = repos.find((r) => !/^[\w.-]+$/.test(r));
  if (odd) return `--repos takes folder names, a comma between them (not ${JSON.stringify(odd)})`;
  if (!(kind in KINDS)) return "--kind is code or prose";
  if (!task) return "the task after --, in the user's words";
  return { title, repos, kind: kind as Kind, plan, dryRun, desktop, task };
}

// (a shell's single quotes: what the prompt shows the new session to run)
const sq = (s: string) => (/^[\w./,:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const dq = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

/** Who opened the new session: the name it is known by, the socket SendMessage reaches it on. */
export type Opener = { name?: string; socket?: string };

/** The new session's first words: the maps, its card, its model, the task, how it ends. */
export function prompt(a: Pick<Ask, "title" | "repos" | "kind" | "plan" | "task">, opener?: Opener, desktop = false): string {
  const [repo] = a.repos;
  const conf = loadConfig();
  const model =
    a.kind === "prose"
      ? a.plan
        ? "You run on Opus and start in plan mode: plan first, and write nothing (your card included) until the user approves the plan."
        : "You run on Opus (prose, voices, translations, design)."
      : desktop
        ? a.plan
          ? "You start on Opus in plan mode: plan first, and write nothing (your card included) until the user approves the plan, your opener then moves you to Sonnet for the build."
          : "You run on Sonnet. Settle your own plan without stopping for the user's approval of it, and where it needs a design settled (a change across files), have the architect helper look before it locks."
        : a.plan
          ? "You run on opusplan and start in plan mode: Opus plans, nothing is written (your card included) until the user approves the plan, then Sonnet carries it out."
          : "You run on opusplan: Sonnet, and Opus in plan mode. Settle your own plan without stopping for the user's approval of it, and where it needs a design settled (a change across files), have the architect helper look before it locks.";
  const to = [opener?.socket && `to ${dq(`uds:${opener.socket}`)}`, opener?.name && `${opener.socket ? "(else to its name, " : "to "}${dq(opener.name)}${opener.socket ? ")" : ""}`].filter(Boolean).join(" ");
  const report = to
    ? `Report to the session that opened you with SendMessage, ${to}: a few lines each time your card stops running (waiting on the user or on another card, ready to push), saying what is committed and what is asked of whom, and again once your commits are pushed: the range, CI's verdict, your card done. You do not push yourself: with the user's go, report the quote and your opener pushes, then tells you to set your card done. A go to push is asked of the user in your own session (the question tool), never left to your opener to ask: your next report quotes their words and says what they cover (repository, range by sha, push only). A push go never covers a deploy or a release, each is its own go. Without a quoted go your opener will not push. It checks your work and closes this session: never close it yourself, and after that last report write nothing more.`
    : undefined;
  return [
    `A new task from the user. ${opener?.name ? `The session "${opener.name}"` : "Another session"} opened this one for it (the ${conf.term}'s one session per task).`,
    `Read ${tilde(join(conf.root, conf.session.rules))} first, then the ${conf.session.rules} of each repository you write (${a.repos.join(", ")}).`,
    `Your first write, before any file, is your card:\n\n  ${toolCmd("board")} add ${repo} ${dq(a.title)} --repos ${a.repos.join(",")} --status running --try "…" --committed "(none yet)" --left "…"\n\nThis session already carries the card's title. Check the card's \`session\` is this session's own id ($CLAUDE_CODE_SESSION_ID), not the opener's: if it isn't, say so first.`,
    model,
    `The task:\n\n${a.task}`,
    ...(report ? [report] : []),
    desktop ? "Narrate briefly, move your card at each stop, and end with a `result:` line." : "You run in the background: narrate briefly, move your card at each stop, and end with a `result:` line.",
  ].join("\n\n");
}

/** The command, without the prompt (its last argument). */
export function command(a: Pick<Ask, "title" | "kind" | "plan">): string[] {
  return ["claude", "--bg", "-n", a.title, "--model", loadConfig().session.models[a.kind], ...(a.plan ? ["--permission-mode", "plan"] : [])];
}

const KEEP = new Set(["CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR", "CLAUDE_CONFIG_DIR"]);
/** The environment without the running session's own variables. */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (!/^CLAUDE/.test(k) || KEEP.has(k))) out[k] = v;
  return out;
}
export const dropped = (env: Record<string, string | undefined>) => Object.keys(env).filter((k) => /^CLAUDE/.test(k) && !KEEP.has(k)).sort();

/** The short id `claude --bg` prints (`backgrounded · 1f8f36b9 · <name>`), the one `claude attach` takes. */
export function idOf(out: string): string | undefined {
  return out.match(/backgrounded\s+·\s+([0-9a-f]{6,})\b/i)?.[1];
}

/**
 * The opener's name: its display name (`claude agents --json`, matched by
 * its session id: what the user and SendMessage know it by), else the
 * title of its newest card still open (running, or waiting on the user).
 * Never a card it finished: a session's done cards are older tasks it
 * carried.
 */
export function openerOf(session: string, agents: unknown, list: Pick<Card, "session" | "status" | "title" | "updated">[]): string | undefined {
  const row = Array.isArray(agents) ? agents.find((r) => r && typeof r === "object" && (r as { sessionId?: unknown }).sessionId === session) : undefined;
  const name = (row as { name?: unknown } | undefined)?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  return list.filter((c) => c.session === session && c.status !== "done").sort((a, b) => b.updated.localeCompare(a.updated))[0]?.title;
}

export type Live = { pid: number; sessionId: string; job: string; name?: string; nameSource?: string; status?: string; socket?: string; host?: string };

/**
 * The sessions alive on this computer, from Claude Code's own registry
 * (`~/.claude/sessions/<pid>.json`, an internal format): unreadable rows and
 * dead pids skipped, nothing when the folder can't be read.
 */
export function registry(dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions")): Live[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: Live[] = [];
  for (const name of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
      if (!Number.isInteger(r.pid) || typeof r.sessionId !== "string") continue;
      process.kill(r.pid as number, 0);
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      out.push({ pid: r.pid as number, sessionId: r.sessionId, job: str(r.jobId) ?? r.sessionId.slice(0, 8), name: str(r.name), nameSource: str(r.nameSource), status: str(r.status), socket: str(r.messagingSocketPath), host: str(r.hostSessionId) });
    } catch {}
  }
  return out;
}

function openerInfo(session: string | undefined): Opener | undefined {
  if (!session) return undefined;
  const live = registry();
  try {
    // (an automatic name, "83-1e", is no name to send to: the open card's title is)
    const name = openerOf(session, live.filter((r) => r.nameSource !== "derived"), cards());
    const socket = live.find((r) => r.sessionId === session)?.socket;
    return name || socket ? { name, socket } : undefined;
  } catch {
    return undefined;
  }
}

/** What the new session will meet: its repositories another card holds now, a name that is no folder of the project. */
function notes(repos: string[]): string[] {
  const out = strangers(repos).map((r) => `note: ${r} is no ${loadConfig().term} folder yet`);
  try {
    for (const h of holders(cards(), repos))
      if (h.kind === "held") out.push(`note: ${h.repo} is held by ${h.card.id} (running): the new session will block on it until it's free`);
  } catch {}
  return out;
}

// ── the record of each child ────────────────────────────────────────────────
export type Opened = { id: string; title: string; repos: string[]; kind: Kind; plan: boolean; opener: string | null; openerName: string | null; at: string };
const openedDir = () => join(loadConfig().cacheDir, "opened");

function record(o: Opened): void {
  try {
    mkdirSync(openedDir(), { recursive: true });
    writeFileSync(join(openedDir(), `${o.id}.json`), `${JSON.stringify(o, null, 2)}\n`);
  } catch (e) {
    console.error(`note: the record of ${o.id} not written (${(e as Error).message})`);
  }
}

function records(): Opened[] {
  let names: string[];
  try {
    names = readdirSync(openedDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Opened[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(openedDir(), n), "utf8")) as Opened;
      if (typeof r.id === "string" && typeof r.title === "string") out.push(r);
    } catch {}
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// ── closing a child ─────────────────────────────────────────────────────────
/** ahead: commits on no remote since the child started (-1: no remote to compare); running: other sessions' running cards there; open: all their open cards. */
export type RepoState = { repo: string; ahead: number; dirty: boolean; running: string[]; open: string[] };

/** Whether a child may be closed: hard refusals (never overridden), soft ones (--force), notes. */
export function verdict(o: { live?: Live; cards: Card[]; repos: RepoState[]; force: boolean; whose?: string }): { ok: boolean; why: string[]; notes: string[] } {
  const hard: string[] = [];
  const soft: string[] = [];
  const notes: string[] = [];
  // (another session's child, or one opened by hand: its opener checks it, not this one)
  if (o.whose) soft.push(o.whose);
  if (o.live) {
    if (o.live.status !== "idle") hard.push(`it is ${o.live.status ?? "in an unknown state"}${o.live.status === "busy" ? ": mid-turn" : ""}`);
  } else notes.push("already closed");
  if (o.cards.length === 0) soft.push("it wrote no card");
  for (const c of o.cards) if (c.status !== "done") soft.push(`card ${c.id} is ${c.status}`);
  for (const r of o.repos) {
    const n = r.ahead > 0 ? `${r.ahead} commit${r.ahead === 1 ? "" : "s"} unpushed` : "";
    // (unpushed commits are always the child's to push, another card there or not: it only changes the words)
    if (n && r.open.length) soft.push(`${r.repo}: ${n} since it started (${r.open.join(", ")} open there too: if they are theirs, the user's --force)`);
    else if (n) soft.push(`${r.repo}: ${[n, r.dirty && r.running.length === 0 ? "uncommitted changes" : ""].filter(Boolean).join(", ")}`);
    // (changes a running card there may explain: a waiting card isn't writing now)
    if (r.dirty && r.running.length === 0 && !(n && !r.open.length)) soft.push(`${r.repo}: uncommitted changes`);
    else if (r.dirty && r.running.length) notes.push(`${r.repo}: uncommitted changes, ${r.running.join(", ")} ${r.running.length === 1 ? "is" : "are"} running there too: check they aren't this session's`);
    if (r.ahead === -1) notes.push(`${r.repo}: no remote to compare`);
  }
  const why = o.force ? hard : [...hard, ...soft];
  if (o.force && soft.length) notes.push(`forced past: ${soft.join("; ")}`);
  return { ok: why.length === 0, why, notes };
}

const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });

/**
 * Each repository's state for `id`: HEAD's commits on no remote at all
 * (`--not --remotes`, never other local branches) committed since the child
 * started (its record's time; no record: every one), -1 with no remote; dirty; other sessions' cards there.
 */
export function repoStates(repos: string[], id: string, all: Card[], notes: string[], at?: string): RepoState[] {
  const out: RepoState[] = [];
  for (const repo of repos) {
    const dir = repoDir(repo);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      notes.push(`${repo}: no such folder here`);
      continue;
    }
    // (not its cards' `since`: a card stops holding, and keeps none, once done)
    const start = at && !Number.isNaN(Date.parse(at)) ? at : undefined;
    const remote = git(dir, "remote");
    const hasRemote = remote.exitCode === 0 && remote.stdout.toString().trim() !== "";
    const ahead = hasRemote ? git(dir, "rev-list", "--count", ...(start ? [`--since=${start}`] : []), "HEAD", "--not", "--remotes") : undefined;
    const n = ahead && ahead.exitCode === 0 ? Number.parseInt(ahead.stdout.toString(), 10) : -1;
    const dirty = git(dir, "status", "--porcelain").stdout.toString().trim() !== "";
    const open = all.filter((c) => c.status !== "done" && !c.session.startsWith(id) && (c.repo === repo || c.repos.includes(repo)));
    out.push({ repo, ahead: Number.isNaN(n) ? -1 : n, dirty, running: open.filter((c) => c.status === "running").map((c) => c.id), open: open.map((c) => c.id) });
  }
  return out;
}

function children(argv: string[]): void {
  const all = argv.includes("--all");
  const bad = argv.find((a) => a !== "--all");
  if (bad) {
    console.error(`unknown option ${bad}\n${USAGE()}`);
    process.exit(2);
  }
  const me = process.env.CLAUDE_CODE_SESSION_ID;
  const mine = records().filter((r) => all || (me && r.opener === me));
  if (mine.length === 0) return void console.log("no children");
  const live = registry();
  const board = cards(true);
  for (const r of mine) {
    const row = live.find((l) => l.job === r.id || l.sessionId.startsWith(r.id));
    const own = board.filter((c) => c.session.startsWith(r.id));
    const notes: string[] = [];
    const v = verdict({ live: row, cards: own, repos: repoStates([...new Set([...own.flatMap((c) => c.repos), ...r.repos])], r.id, board, notes, r.at), force: false });
    const state = row ? (row.status ?? "live") : "closed";
    const cs = own.length ? own.map((c) => c.status).join(", ") : "no card";
    console.log(`${r.id}  ${state}  ${r.title}  [${cs}]  ${v.ok ? `→ close: ${toolCmd("session")} close ${r.id}` : v.why[0]}`);
  }
}

/** What close and check both look at: the live row, the child's cards, its repositories' states, the notes met on the way. */
function gather(id: string, rec: Opened | undefined, row: Live | undefined) {
  const board = cards(true);
  const own = board.filter((c) => c.session.startsWith(id));
  const extra: string[] = [];
  const names = [...new Set([...own.flatMap((c) => c.repos), ...(rec?.repos ?? [])])];
  return { own, extra, names, states: repoStates(names, id, board, extra, rec?.at), row };
}

function check(argv: string[]): void {
  const given = argv[0]?.toLowerCase();
  if (argv.length !== 1 || !given || !/^(local_[0-9a-f-]{8,}|[0-9a-f][0-9a-f-]{5,})$/.test(given)) {
    console.error(`check takes one session id (a desktop local_ id, the session's, or the short one), and no --force\n${USAGE()}`);
    process.exit(2);
  }
  const live = registry();
  let id = given;
  let row: Live | undefined;
  if (given.startsWith("local_")) {
    row = live.find((l) => l.host?.toLowerCase() === given);
    if (!row) {
      console.error(`can't tell: ${given} isn't running here, check its card by hand (${toolCmd("board")} list --all)`);
      process.exit(1);
    }
    id = row.sessionId.toLowerCase();
  } else row = live.find((l) => l.job === id.slice(0, 8) || l.sessionId.startsWith(id) || l.job === id);
  const short = id.slice(0, 8);
  const rec = records().find((r) => r.id === short);
  const g = gather(id, rec, row);
  // (no `whose`: a desktop child has no record, its opener confirms the link in the desktop app)
  const v = verdict({ live: row, cards: g.own, repos: g.states, force: false });
  const notes = [...g.extra, ...v.notes].map((n) => `note: ${n}`);
  if (!v.ok) {
    for (const w of v.why) console.error(`not yet: ${w}`);
    for (const n of notes) console.error(n);
    process.exit(1);
  }
  console.log(`may close "${rec?.title ?? g.own[0]?.title ?? row?.name ?? given}" (${given}): archive it if list_sessions links it to you`);
  for (const n of notes) console.log(n);
}

function close(argv: string[]): void {
  const force = argv.includes("--force");
  const rest = argv.filter((a) => a !== "--force");
  const id = rest[0]?.toLowerCase();
  if (rest.length !== 1 || !id || !/^[0-9a-f][0-9a-f-]{5,}$/.test(id)) {
    console.error(`close takes one session id (the short id or the full one)\n${USAGE()}`);
    process.exit(2);
  }
  const short = id.slice(0, 8);
  const file = join(openedDir(), `${short}.json`);
  const rec = records().find((r) => r.id === short);
  const row = registry().find((l) => l.job === short || l.sessionId.startsWith(id) || l.job === id);
  const { own, extra, names, states } = gather(id, rec, row);
  const me = process.env.CLAUDE_CODE_SESSION_ID;
  const whose = !rec ? "this session didn't open it (no record from session.ts)" : rec.opener !== me ? `another session opened it (${rec.openerName ?? rec.opener ?? "unknown"})` : undefined;
  const v = verdict({ live: row, cards: own, repos: states, force, whose });
  const notes = [...extra, ...v.notes].map((n) => `note: ${n}`);
  const title = rec?.title ?? own[0]?.title ?? short;
  const repo = names[0] ?? "";
  if (!v.ok) {
    for (const w of v.why) console.error(`not closed: ${w}`);
    for (const n of notes) console.error(n);
    logEvent("session", "fail", repo, `${title} not closed (${short}): ${v.why.join("; ")}`);
    process.exit(1);
  }
  if (row) {
    const run = Bun.spawnSync(["claude", "stop", row.job], { cwd: projectRoot(), env: cleanEnv(process.env), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    if (run.exitCode !== 0) {
      const said = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
      console.error(`${said ? `${said}\n` : ""}claude stop failed (exit ${run.exitCode ?? run.signalCode})`);
      logEvent("session", "fail", repo, `${title}: claude stop failed (${short})`);
      process.exit(run.exitCode || 1);
    }
  }
  rmSync(file, { force: true });
  logEvent("session", "ok", repo, `${title} closed (${short})`);
  console.log(`closed "${title}" (${short})`);
  for (const n of notes) console.log(n);
}

if (import.meta.main) {
  const sub = process.argv[2];
  if (sub === "children") {
    children(process.argv.slice(3));
    process.exit(0);
  }
  if (sub === "close") {
    close(process.argv.slice(3));
    process.exit(0);
  }
  if (sub === "check") {
    check(process.argv.slice(3));
    process.exit(0);
  }
  const a = parse(process.argv.slice(2));
  if (typeof a === "string") {
    console.error(`${a}\n${USAGE()}`);
    process.exit(2);
  }
  const root = projectRoot();
  const opener = openerInfo(process.env.CLAUDE_CODE_SESSION_ID);
  const text = prompt(a, opener, a.desktop);
  const cmd = command(a);
  for (const n of notes(a.repos)) console.error(n);
  if (a.desktop) {
    logEvent("session", "info", a.repos[0], `${a.title}: prompt for a desktop child`);
    console.log(text);
    process.exit(0);
  }
  if (a.dryRun) {
    console.log(`would run, from ${root}:\n  ${cmd.map(sq).join(" ")} "$PROMPT"`);
    const gone = dropped(process.env);
    console.log(`without ${gone.length ? gone.join(" ") : "(no CLAUDE_* to drop)"}`);
    console.log(`PROMPT:\n${text}`);
    process.exit(0);
  }
  const run = Bun.spawnSync([...cmd, text], { cwd: root, env: cleanEnv(process.env), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const out = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
  const id = idOf(out);
  if (run.exitCode !== 0 || !id) {
    if (out) console.error(out);
    // (claude said yes without an id: the session may run all the same, a second try would open it twice)
    const why = run.exitCode !== 0 ? `claude --bg failed (exit ${run.exitCode ?? run.signalCode})` : "claude --bg answered without a session id";
    console.error(run.exitCode === 0 ? `${why}: it may have started all the same. Look in \`claude agents\` before opening it again` : why);
    logEvent("session", "fail", a.repos[0], `${a.title}: ${why}`);
    process.exit(run.exitCode || 1);
  }
  record({ id, title: a.title, repos: a.repos, kind: a.kind, plan: a.plan, opener: process.env.CLAUDE_CODE_SESSION_ID ?? null, openerName: opener?.name ?? null, at: new Date().toISOString() });
  logEvent("session", "ok", a.repos[0], `${a.title} opened (${KINDS[a.kind]}${a.plan ? ", plan mode" : ""}) as ${id}`);
  console.log(`opened "${a.title}" (${KINDS[a.kind]}${a.plan ? ", plan mode" : ""}) as ${id}
  claude attach ${id}    join it (Ctrl+Z leaves it running)
  claude logs ${id}      its recent output
  its card, once written: ${toolCmd("board")} list`);
  // (plan mode writes nothing, its card included: the board can't show it waits, so the user is told here)
  if (a.plan) console.log(`  it waits for your approval of its plan before it writes anything, its card too: claude attach ${id}`);
}
