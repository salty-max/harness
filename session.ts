/**
 * A new task opened in a session of its own (the family's "one session per
 * task"): a session asked a task that isn't its own opens one here, tells
 * the user its name and how to attach, and writes nothing for it.
 *
 *   bun session.ts "<card title>" --repos a,b --kind code|prose [--plan] [--dry-run] [--desktop] [--opener <name|socket>] -- "<the task>"
 *
 *   title     the new session's name and its card's title
 *   repos     every repository the task writes: its card's --repos, the
 *             first its repo
 *   kind      code (and mechanical work) or prose (voices, translations,
 *             design): the model of each is the project's `[session] models`
 *             (the family's: code opusplan, prose opus). opusplan
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
 *   opener    who receives the child's reports instead of the session that
 *             runs this (an app that is no session, a dispatch): a live
 *             session's name, short id or messaging socket path, found in
 *             Claude Code's registry. No live match, no start
 *   the task  in the user's words, with what the opener knows
 *
 * It runs `claude --bg -n <title> --model <model> <prompt>` from the family
 * folder (a project with `[session] worktrees = true` adds `--worktree <name>`,
 * and the prompt says the child works in a worktree of its own), without the running session's variables (CLAUDECODE and every
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
 *             a child that works in a worktree is looked for there: the
 *             `worktree:` its card names (board.ts writes it from the child's
 *             own session), else its live session's working directory, else
 *             the main checkout, said when the repository has other worktrees
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
import { type Card, cards, holders, repoList, slug, strangers } from "./board";
import { logEvent } from "./events";
import { linkedWorktree, loadConfig, projectPath, projectRoot, repoDir, toolCmd, workDir } from "./config";
import { unpushed } from "./trees";

export const KINDS = { code: "opusplan", prose: "opus" } as const;
export type Kind = keyof typeof KINDS;

export type Ask = { title: string; repos: string[]; kind: Kind; plan: boolean; dryRun: boolean; desktop: boolean; opener?: string; task: string };

const tilde = (p: string) => (p.startsWith(homedir() + "/") ? `~${p.slice(homedir().length)}` : p);
const USAGE = () => `usage: ${toolCmd("session")} "<card title>" --repos a,b --kind code|prose [--plan] [--dry-run] [--desktop] [--opener <name|socket>] -- "<the task>"
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
  let opener: string | undefined;
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (a === "--repos" || a === "--kind" || a === "--opener") {
      if (head[i + 1] === undefined) return `${a} takes a value`;
      if (a === "--repos") repos = repoList(head[++i]);
      else if (a === "--opener") {
        opener = head[++i].trim();
        // (a name as the registry shows it, a short id, or a socket path: no option, no quote or backslash, no control character or newline)
        if (!/^(\/[\w./-]+\.sock|[^\s"\\\p{Cc}-][^"\\\p{Cc}]{0,199})$/u.test(opener)) return `--opener takes a live session's name, id or socket path (not ${JSON.stringify(opener)})`;
      } else kind = head[++i];
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
  return { title, repos, kind: kind as Kind, plan, dryRun, desktop, ...(opener ? { opener } : {}), task };
}

// (a shell's single quotes: what the prompt shows the new session to run)
const sq = (s: string) => (/^[\w./,:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const dq = (s: string) => `"${s.replace(/\p{Cc}/gu, " ").replace(/(["\\$`])/g, "\\$1")}"`;

/** Who opened the new session: the name it is known by, the socket SendMessage reaches it on. */
export type Opener = { name?: string; socket?: string };

/**
 * What a child is told when its project takes every decision in the opener
 * (`[session] decisions = "opener"`): it asks the user nothing, it sends each
 * question or go to its opener with the options and its recommendation and
 * stops, and the opener asks the user, then pushes or relays the answer quoted.
 * `to` is where SendMessage reaches the opener; without one the child's last
 * message carries the question instead.
 */
export function reportToOpener(to: string, plan = false): string {
  const send = to ? `Report to the session that opened you with SendMessage, ${to}: a few lines each time your card stops running (waiting on a decision or on another card, ready to push), saying what is committed and what you need decided, and again once your commits are pushed: the range, CI's verdict, your card done.` : "No live opener could be named, so your last message of a turn carries what a report would: what is committed, what you need decided.";
  const ask = to ? "send every question (a push, a merge, any choice) to your opener with the options and your recommendation, then stop" : "put every question (a push, a merge, any choice) in that message with the options and your recommendation, then stop";
  return `${send} You do not push yourself, and you do not ask the user anything (this project takes every decision in the session that opened you, \`[session] decisions = "opener"\`): ${ask}. Your opener asks the user in its own session, then pushes on their answer or relays it to you quoted. A push go never covers a deploy or a release, each is its own go. ${plan ? "Your plan's approval is the one exception: leaving plan mode always asks the user, in your own session, and your opener can't answer it for them. " : ""}Your opener checks your work and closes this session: never close it yourself, and after your last report write nothing more.`;
}

/** The new session's first words: the maps, its card, its model, the task, how it ends. */
export function prompt(a: Pick<Ask, "title" | "repos" | "kind" | "plan" | "task">, opener?: Opener, desktop = false): string {
  const [repo] = a.repos;
  const conf = loadConfig();
  const m = conf.session.models[a.kind];
  const settle = "Settle your own plan without stopping for the user's approval of it, and where it needs a design settled (a change across files), have the architect helper look before it locks.";
  // a desktop child starts on the model the alias names (opusplan is Sonnet outside plan mode)
  const dm = m === "sonnet" || m === "opusplan" ? "Sonnet" : m === "opus" ? "Opus" : m;
  const planFirst = "plan first, and write nothing (your card included) until the user approves the plan";
  // the family's words stay for its own models (opusplan, opus); any other model is named as the config has it
  const model =
    a.kind === "prose" && m === "opus"
      ? a.plan
        ? `You run on Opus and start in plan mode: ${planFirst}.`
        : "You run on Opus (prose, voices, translations, design)."
      : a.kind === "code" && m === "opusplan" && !desktop
        ? a.plan
          ? "You run on opusplan and start in plan mode: Opus plans, nothing is written (your card included) until the user approves the plan, then Sonnet carries it out."
          : `You run on opusplan: Sonnet, and Opus in plan mode. ${settle}`
        : a.plan
          ? !desktop
            ? `You run on ${m} and start in plan mode: ${planFirst}.`
            : dm === "Opus"
              ? `You run on Opus and start in plan mode: ${planFirst}.`
              : `You start on Opus in plan mode: ${planFirst}, your opener then moves you to ${dm} for the build.`
          : `You run on ${desktop ? dm : m}. ${settle}`;
  const worktree = conf.session.worktrees
    ? `You work in a git worktree of your own, on a branch of your own (this ${conf.term} opens every child that way, \`[session] worktrees = true\`): commit there, never in the main checkout, and push as the ${conf.term}'s rules say. If you were not started in one, say so first. The board, its cards and the check stamps are shared by every worktree: ${toolCmd("packet")} <repo> and ${toolCmd("review")} <repo> from inside yours act on yours.`
    : undefined;
  const to = [opener?.socket && `to ${dq(`uds:${opener.socket}`)}`, opener?.name && `${opener.socket ? "(else to its name, " : "to "}${dq(opener.name)}${opener.socket ? ")" : ""}`].filter(Boolean).join(" ");
  // (the family's words stay for a decision taken in the child; `decisions = "opener"` takes it to the opener, the user asked there)
  const report = conf.session.decisions === "opener" ? reportToOpener(to, a.plan) : to
    ? `Report to the session that opened you with SendMessage, ${to}: a few lines each time your card stops running (waiting on the user or on another card, ready to push), saying what is committed and what is asked of whom, and again once your commits are pushed: the range, CI's verdict, your card done. You do not push yourself: with the user's go, report the quote and your opener pushes, then tells you to set your card done. A go to push is asked of the user in your own session (the question tool), never left to your opener to ask: your next report quotes their words and says what they cover (repository, range by sha, push only). A push go never covers a deploy or a release, each is its own go. Without a quoted go your opener will not push. It checks your work and closes this session: never close it yourself, and after that last report write nothing more.`
    : undefined;
  return [
    `A new task from the user. ${opener?.name ? `The session "${opener.name}"` : "Another session"} opened this one for it (the ${conf.term}'s one session per task).`,
    `Read ${tilde(join(conf.root, conf.session.rules))} first, then the ${conf.session.rules} of each repository you write (${a.repos.join(", ")}).`,
    `Your first write, before any file, is your card:\n\n  ${toolCmd("board")} add ${repo} ${dq(a.title)} --repos ${a.repos.join(",")} --status running --try "…" --committed "(none yet)" --left "…"\n\nThis session already carries the card's title. Check the card's \`session\` is this session's own id ($CLAUDE_CODE_SESSION_ID), not the opener's: if it isn't, say so first.`,
    model,
    ...(worktree ? [worktree] : []),
    `The task:\n\n${a.task}`,
    ...(report ? [report] : []),
    desktop ? "Narrate briefly, move your card at each stop, and end with a `result:` line." : "You run in the background: narrate briefly, move your card at each stop, and end with a `result:` line.",
  ].join("\n\n");
}

/** The name of a child's worktree: its title, a slug, and the minute, so two children of one title never share one. */
export const worktreeName = (title: string, at = new Date()) => `${slug(title) || "task"}-${at.toISOString().slice(5, 16).replace(/\D/g, "")}`;

/** Whether the folder is a git repository's own (a family-shaped root of many repositories is none). */
const isRepository = (dir: string) => existsSync(join(dir, ".git"));

/**
 * The command, without the prompt (its last argument). A project whose
 * children work in worktrees names one (`--worktree` takes an optional name,
 * so it never stands last: the prompt would be read as the name). A project
 * whose root is no repository has no worktree to make there: none is asked.
 */
export function command(a: Pick<Ask, "title" | "kind" | "plan">, at = new Date()): string[] {
  const conf = loadConfig();
  return ["claude", "--bg", "-n", a.title, "--model", conf.session.models[a.kind], ...(a.plan ? ["--permission-mode", "plan"] : []), ...(conf.session.worktrees && isRepository(conf.root) ? ["--worktree", worktreeName(a.title, at)] : [])];
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

export type Live = { pid: number; sessionId: string; job: string; name?: string; nameSource?: string; status?: string; socket?: string; host?: string; cwd?: string };

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
      out.push({ pid: r.pid as number, sessionId: r.sessionId, job: str(r.jobId) ?? r.sessionId.slice(0, 8), name: str(r.name), nameSource: str(r.nameSource), status: str(r.status), socket: str(r.messagingSocketPath), host: str(r.hostSessionId), cwd: str(r.cwd) });
    } catch {}
  }
  return out;
}

/**
 * The session `--opener` names, alive in the registry: by name, session id
 * (or its short form), job id or socket path. Undefined when none matches or
 * several do (a report must not go to the wrong session).
 */
export function pickOpener(given: string, live: Live[]): (Opener & { sessionId: string }) | undefined {
  const hits = live.filter((r) => r.name === given || r.sessionId === given || r.job === given || r.socket === given || (/^[0-9a-f]{8,}$/i.test(given) && r.sessionId.startsWith(given.toLowerCase())));
  if (new Set(hits.map((r) => r.sessionId)).size !== 1) return undefined;
  const r = hits[0];
  // (an automatic name is no name to send to, and a name carries no control character into the prompt)
  const name = r.nameSource === "derived" ? undefined : r.name?.replace(/\p{Cc}/gu, " ").trim() || undefined;
  return name || r.socket ? { name, socket: r.socket, sessionId: r.sessionId } : undefined;
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

/** What the new session will meet: its repositories another card holds now (no lock: only runs there too), a name that is no folder of the project. */
export function notes(repos: string[]): string[] {
  const conf = loadConfig();
  const out = strangers(repos).map((r) => `note: ${r} is no ${conf.term} folder yet`);
  try {
    for (const h of holders(cards(), repos))
      if (h.kind === "held") out.push(conf.hooks.lock ? `note: ${h.repo} is held by ${h.card.id} (running): the new session will block on it until it's free` : `note: ${h.repo} has ${h.card.id} running too: nothing makes the new session wait`);
  } catch {}
  if (conf.session.worktrees) out.push(`note: this ${conf.term} works in worktrees: a desktop child is started with use_worktree: true (from the main branch: source_branch)${isRepository(conf.root) ? ", a CLI one gets --worktree" : `, and ${conf.root} is no repository: a CLI child gets no --worktree`}`);
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
export type RepoState = { repo: string; ahead: number; dirty: boolean; running: string[]; open: string[]; /** Why the child's own work wasn't looked at (a worktree project, its worktree unknown): a refusal, never a pass. */ unseen?: string };

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
    // (unpushed is counted against the remotes as last fetched: a branch merged since reads unpushed until they are)
    if (r.ahead > 0) notes.push(`${r.repo}: unpushed is by content against the remote as last fetched: if the branch was merged since, git fetch first`);
    // (a worktree project's main checkout is always clean: reading it says nothing of the child's work)
    if (r.unseen) soft.push(r.unseen);
  }
  const why = o.force ? hard : [...hard, ...soft];
  if (o.force && soft.length) notes.push(`forced past: ${soft.join("; ")}`);
  return { ok: why.length === 0, why, notes };
}

const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });

/**
 * The folder to read `repo`'s state in for a child: the linked worktree of it
 * among `homes`, else its main checkout. A worktree named and gone is said.
 * A main checkout read while the repository has other worktrees is said too,
 * and in a project whose children all work in worktrees (`[session] worktrees`)
 * it is `unseen`: that checkout is clean whatever the child did, so a verdict
 * must not pass on it.
 */
export function lookIn(repo: string, homes: (string | undefined)[], notes: string[]): { dir: string; unseen?: string } {
  const main = repoDir(repo);
  for (const home of homes) {
    if (!home) continue;
    if (!existsSync(home)) {
      notes.push(`${repo}: the worktree ${home} is gone`);
      continue;
    }
    // (a folder of another project, or of another repository's worktree, is none of this repository's)
    let dir: string;
    try {
      dir = workDir(repo, home);
    } catch {
      continue;
    }
    if (dir !== main && linkedWorktree(home)?.top === dir) {
      const branch = git(dir, "symbolic-ref", "--short", "-q", "HEAD").stdout.toString().trim();
      notes.push(`${repo}: read in the worktree ${dir}${branch ? ` (${branch})` : ""}`);
      return { dir };
    }
  }
  const trees = existsSync(main) ? git(main, "worktree", "list", "--porcelain").stdout.toString().split("\n").filter((l) => l.startsWith("worktree ")).length : 0;
  if (trees > 1) {
    const others = `${trees - 1} other worktree${trees > 2 ? "s exist" : " exists"}`;
    const look = `git -C ${main} worktree list`;
    if (loadConfig().session.worktrees) return { dir: main, unseen: `${repo}: the child's own worktree isn't known (its card names none, no live session of it), so its work wasn't looked at: ${others}, find its with \`${look}\`` };
    notes.push(`${repo}: read in the main checkout, no worktree of the child's is known, and ${others}: its own may be one of them (${look})`);
  }
  return { dir: main };
}

/**
 * Each repository's state for `id`: HEAD's commits on no remote at all
 * (`--not --remotes`, never other local branches), and whose patch no remote
 * has either (a rebase-merged commit is pushed: trees.ts), committed since the
 * child started (its record's time; no record: every one), -1 with no remote;
 * dirty; other sessions' cards there.
 * `homes` are folders the child may work in (its cards' `worktree`, its live session's cwd): a repository is
 * read in the linked worktree of it among them, else in its main checkout (`lookIn`).
 */
export function repoStates(repos: string[], id: string, all: Card[], notes: string[], at?: string, homes: (string | undefined)[] = []): RepoState[] {
  const out: RepoState[] = [];
  for (const repo of repos) {
    const { dir, unseen } = lookIn(repo, homes, notes);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      notes.push(`${repo}: no such folder here`);
      continue;
    }
    // (not its cards' `since`: a card stops holding, and keeps none, once done)
    const start = at && !Number.isNaN(Date.parse(at)) ? at : undefined;
    const n = unpushed(dir, start);
    const dirty = git(dir, "status", "--porcelain").stdout.toString().trim() !== "";
    const open = all.filter((c) => c.status !== "done" && !c.session.startsWith(id) && (c.repo === repo || c.repos.includes(repo)));
    out.push({ repo, ahead: n, dirty, running: open.filter((c) => c.status === "running").map((c) => c.id), open: open.map((c) => c.id), ...(unseen ? { unseen } : {}) });
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
    const v = verdict({ live: row, cards: own, repos: repoStates([...new Set([...own.flatMap((c) => c.repos), ...r.repos])], r.id, board, notes, r.at, [...own.map((c) => c.worktree), row?.cwd]), force: false });
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
  return { own, extra, names, states: repoStates(names, id, board, extra, rec?.at, [...own.map((c) => c.worktree), row?.cwd]), row };
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
  let opener: Opener | undefined;
  let openerId = process.env.CLAUDE_CODE_SESSION_ID;
  if (a.opener) {
    const named = pickOpener(a.opener, registry());
    if (!named) {
      console.error(`no live session matches --opener ${JSON.stringify(a.opener)} (or it matches more than one): nothing started`);
      logEvent("session", "fail", a.repos[0], `${a.title}: no live opener ${a.opener}`);
      process.exit(2);
    }
    opener = { name: named.name, socket: named.socket };
    openerId = named.sessionId;
  } else opener = openerInfo(openerId);
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
  record({ id, title: a.title, repos: a.repos, kind: a.kind, plan: a.plan, opener: openerId ?? null, openerName: opener?.name ?? null, at: new Date().toISOString() });
  logEvent("session", "ok", a.repos[0], `${a.title} opened (${loadConfig().session.models[a.kind]}${a.plan ? ", plan mode" : ""}) as ${id}`);
  console.log(`opened "${a.title}" (${loadConfig().session.models[a.kind]}${a.plan ? ", plan mode" : ""}) as ${id}
  claude attach ${id}    join it (Ctrl+Z leaves it running)
  claude logs ${id}      its recent output
  its card, once written: ${toolCmd("board")} list`);
  // (plan mode writes nothing, its card included: the board can't show it waits, so the user is told here)
  if (a.plan) console.log(`  it waits for your approval of its plan before it writes anything, its card too: claude attach ${id}`);
}
