/**
 * The task board: one Markdown card per task in <the board folder>/,
 * written and listed here so no session hand-edits its front matter (repo,
 * title, status, session, updated, repos, waits, since). Its body says what to
 * try, what's committed and what's left. The desktop panel reads the same
 * files.
 *
 *   bun board.ts add <repo> "<title>" [--repos a,b] [--status s] [--on id] [--session id] [fields]
 *   bun board.ts set <id> [--repos a,b] [--status s] [--on id] [--title t] [--session id] [fields]
 *   bun board.ts list [--all] [--json]
 *   bun board.ts held [repo…]
 *   bun board.ts may <repo>   exit 1 unless this session's running card may write it
 *
 *   repos    every repository the task writes (add: the card's repo); a
 *            running card holds them, the first to run there first
 *   fields   --try "…" --committed "…" --left "…" (each its section of the
 *            body, replaced), --body "…" (the whole body)
 *   status   running, blocked, waiting-test, waiting-review, ready-to-push,
 *            done (add: running); list puts what waits on the user first
 *            and leaves done out unless --all
 *   on       blocked: the card it waits on (cleared when it leaves blocked)
 *   session  the session's name or id (add: $CLAUDE_CODE_SESSION_ID)
 *
 * The board is the lock of "two sessions never write the same repository at
 * once". A running card holds its repositories, each in the order cards
 * came to hold it (`since`: a time per repository, set when the card starts
 * running and when `--repos` adds one, so a widened card queues at the
 * back). The later of two is written anyway and warned on stderr (`held:`):
 * it drops that repository and goes on, or blocks --on the holder and
 * writes nothing. A blocked or waiting card holds nothing (a waiter never
 * locks out another, nor its holder), but its unpushed commits are a
 * `note:` to a card in the same repository: they go out with the next
 * push. A blocked card is told whether anything still holds its
 * repositories (its holder may drop one, another come to hold one). `held` lists who holds what (each repository named, or
 * all), exit 1 when another session's card holds one named before this
 * session's own. A card that stops running names the blocked cards it frees.
 *
 * add prints the card's id: <repo>-<a slug of the title>. A card added or
 * moved to another status gets a line in the harness's event log (events.ts).
 */
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logEvent, type Tone } from "./events";
import { loadConfig, repoDir, toolCmd } from "./config";

// (in the order the list shows them: what waits on the user first, then
// what waits on another card, then what runs)
export const STATUSES = ["waiting-test", "waiting-review", "ready-to-push", "blocked", "running", "done"] as const;
export type Status = (typeof STATUSES)[number];
export type Card = {
  id: string;
  repo: string;
  title: string;
  status: Status;
  session: string;
  updated: string;
  repos: string[];
  waits: string;
  /** A running card's place in each repository's queue: when it came to hold it. */
  since: Record<string, string>;
  body: string;
  /** Its front matter unreadable (cut short, never closed): it holds nothing it can say, and set refuses it. */
  broken?: boolean;
};
const KEYS = ["repo", "title", "status", "session", "updated"] as const;
/** A card writing its repositories now: it holds them. */
export const HOLDS: readonly Status[] = ["running"];
/** A card stopped mid-task (on the user, or on another card): its commits are in its repositories, unpushed. */
export const WAITS: readonly Status[] = ["waiting-test", "waiting-review", "ready-to-push", "blocked"];
const SECTIONS = { try: "Try", committed: "Committed", left: "Left" } as const;

export const boardDir = () => loadConfig().boardDir;

// ── the card's text, pure (harness.test.ts) ─────────────────────────────────
// (bare where any YAML reads it back as the same string, quoted elsewhere:
// a date or a number too, which YAML 1.1 would turn into one)
const quote = (v: string) =>
  /^[\w./][\w ./@+(),':-]*$/.test(v) && !/(: |:$| $)/.test(v) && !/^(true|false|null|yes|no|on|off|[\d.+-]+)$/i.test(v) && !/^\d{4}-\d\d-\d\d/.test(v)
    ? v
    : JSON.stringify(v);

// A value as written, quoted or not, a comment after a quoted one left out.
function unquote(v: string): string {
  if (!v.startsWith('"')) return v.replace(/^'(.*)'$/, "$1");
  try {
    return JSON.parse(v);
  } catch {
    const m = v.match(/^"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : v;
  }
}

// A card's repositories as written: none when they are its repo alone (every older card).
const isOwn = (c: Pick<Card, "repo" | "repos">) => c.repos.length === 1 && c.repos[0] === c.repo;

export function format(c: Card): string {
  const keys = KEYS.map((k) => `${k}: ${quote(c[k])}`);
  if (c.repos.length > 0 && !isOwn(c)) keys.push(`repos: ${quote(c.repos.join(", "))}`);
  if (c.waits) keys.push(`waits: ${quote(c.waits)}`);
  const since = Object.entries(c.since).map(([r, t]) => `${r}@${t}`);
  if (since.length) keys.push(`since: ${quote(since.join(", "))}`);
  return `---\n${keys.join("\n")}\n---\n${c.body.replace(/^\n+/, "").trimEnd()}\n`;
}

/** `a, b` or `a,b` as a list; a repo that names one folder is its own list (`every repo` names none). */
export function repoList(text: string): string[] {
  return [...new Set(text.split(",").map((r) => r.trim()).filter(Boolean))];
}
/** `yonder@<time>, wow-data@<time>` as a map; a bare time (the first cut's) is every repository's. */
function sinceMap(text: string, repos: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(",").map((p) => p.trim()).filter(Boolean)) {
    const at = part.indexOf("@");
    if (at > 0) out[part.slice(0, at)] = part.slice(at + 1);
    else for (const r of repos) out[r] = part;
  }
  return out;
}
const ownRepos = (repo: string) => (/^[a-z0-9][\w.-]*$/i.test(repo) && repo !== "every-repo" ? [repo] : []);

export function parseCard(id: string, raw: string): Card {
  const text = raw.replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fields: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    fields[kv[1]] = unquote(v);
  }
  return {
    id,
    repo: fields.repo ?? "",
    title: fields.title ?? id,
    status: (STATUSES as readonly string[]).includes(fields.status) ? (fields.status as Status) : "running",
    session: fields.session ?? "",
    updated: fields.updated ?? "",
    repos: fields.repos !== undefined ? repoList(fields.repos) : ownRepos(fields.repo ?? ""),
    waits: fields.waits ?? "",
    since: sinceMap(fields.since ?? "", fields.repos !== undefined ? repoList(fields.repos) : ownRepos(fields.repo ?? "")),
    body: m ? m[2] : text,
    ...(m && fields.repo !== undefined && fields.status !== undefined ? {} : { broken: true }),
  };
}

// A section of the body (## Try, ## Committed, ## Left) replaced, or added
// in its place among the three.
export function setSection(body: string, heading: string, text: string): string {
  const order = Object.values(SECTIONS) as string[];
  const parts = new Map<string, string>();
  const head: string[] = [];
  let cur: string | undefined;
  for (const line of body.split("\n")) {
    const h = line.match(/^## (.+)$/);
    if (h) parts.set((cur = h[1].trim()), "");
    else if (cur) parts.set(cur, parts.get(cur) + line + "\n");
    else head.push(line);
  }
  parts.set(heading, text.trim() + "\n");
  // (the three in their order, any other heading after them as it came)
  const seen = [...parts.keys()];
  const rank = (n: string) => (order.includes(n) ? order.indexOf(n) : order.length + seen.indexOf(n));
  const names = seen.sort((a, b) => rank(a) - rank(b));
  const top = head.join("\n").trim();
  return [top, ...names.map((n) => `## ${n}\n\n${parts.get(n)!.trim()}\n`)].filter(Boolean).join("\n").trimEnd() + "\n";
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f'\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

export function now(d = new Date(), isPrecise = false): string {
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, isPrecise ? 23 : 19);
  return `${local}${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

export function ago(iso: string, from = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.round((from - t) / 60_000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

// ── the board ───────────────────────────────────────────────────────────────
export function cards(all = false): Card[] {
  const dir = boardDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseCard(f.slice(0, -3), readFileSync(join(dir, f), "utf8")))
    .filter((c) => all || c.status !== "done")
    .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || b.updated.localeCompare(a.updated));
}

/** The repositories as a list says them: the repo, its others after a +. */
export function where(c: Card): string {
  const others = c.repos.filter((r) => r !== c.repo);
  return others.length ? `${c.repo}+${others.join("+")}` : c.repo;
}

export function lines(list: Card[], from = Date.now()): string[] {
  const wi = Math.max(0, ...list.map((c) => c.id.length));
  const wr = Math.max(0, ...list.map((c) => where(c).length));
  return list.map((c) =>
    `${(c.broken ? "BROKEN" : c.status).padEnd(14)} ${where(c).padEnd(wr)}  ${c.id.padEnd(wi)}  ${c.title}${c.waits ? ` (on ${c.waits})` : ""}  ${ago(c.updated, from)}`.trimEnd(),
  );
}

// A card's text, written whole: beside it first, then moved in, so a reader
// (another session's read-back, the panel every 2 seconds) never sees it cut.
function writeCard(file: string, text: string) {
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, text);
  renameSync(part, file);
}
// A new card under a name no other card has: linked in whole, which fails
// when the name is taken (two adds at once never share one file).
function createCard(file: string, text: string): boolean {
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, text);
  try {
    linkSync(part, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    unlinkSync(part);
  }
}

/**
 * The sessions alive on this computer, from Claude Code's own registry
 * (`~/.claude/sessions/<pid>.json`, an internal format: the panel reads it
 * too) and whether each pid still runs; undefined when it can't be read.
 */
export function liveSessions(dir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions")): Set<string> | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return undefined;
  }
  const out = new Set<string>();
  for (const name of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid?: unknown; sessionId?: unknown };
      if (!Number.isInteger(r.pid) || typeof r.sessionId !== "string") continue;
      process.kill(r.pid as number, 0);
      out.add(r.sessionId);
    } catch {}
  }
  return out;
}

type Since = Pick<Card, "id" | "since" | "updated">;
/** When a card came to hold `repo` (an older card's last update when it says none), as a time; unknown sorts last. */
function sinceOf(c: Since, repo: string): number {
  const t = Date.parse(c.since[repo] || c.updated);
  return Number.isNaN(t) ? Infinity : t;
}
/** Whether `a` came to hold `repo` before `b`: the earlier holds, the id breaks a tie (two adds in the same second). */
export const before = (a: Since, b: Since, repo: string) => sinceOf(a, repo) < sinceOf(b, repo) || (sinceOf(a, repo) === sinceOf(b, repo) && a.id < b.id);
const clock = (c: Since, repo: string) => (c.since[repo] || c.updated).slice(11, 16);

type Near = { card: Card; repos: string[] };
/**
 * What stands in the way of `card` writing its repositories, repository by
 * repository: another session's running cards that came to hold one first
 * (`held`: it waits for them), those that came after (`later`: they were
 * told to wait), and cards stopped mid-task there (`pending`: their commits
 * go out with the next push). A card of the same session, or the card
 * itself, is none of them.
 */
export function conflicts(card: Pick<Card, "id" | "session" | "repos" | "since" | "updated">, list: Card[]): { held: Near[]; later: Near[]; pending: Near[] } {
  const isOther = (c: Card) => c.id !== card.id && !(card.session && c.session === card.session);
  const out: { held: Near[]; later: Near[]; pending: Near[] } = { held: [], later: [], pending: [] };
  for (const c of list.filter(isOther)) {
    const shared = c.repos.filter((r) => card.repos.includes(r));
    if (!shared.length) continue;
    if (WAITS.includes(c.status)) out.pending.push({ card: c, repos: shared });
    if (!HOLDS.includes(c.status)) continue;
    const first = shared.filter((r) => before(c, card, r));
    const after = shared.filter((r) => !before(c, card, r));
    if (first.length) out.held.push({ card: c, repos: first });
    if (after.length) out.later.push({ card: c, repos: after });
  }
  return out;
}

/**
 * The running cards of other sessions that hold `card`'s repositories, by
 * repository: what a blocked card waits for (its holder may have dropped
 * the repository, or another come to hold one). None: it is free.
 */
export function holding(card: Pick<Card, "session" | "repos">, list: Card[]): Near[] {
  return list
    .filter((c) => HOLDS.includes(c.status) && !(card.session && c.session === card.session))
    .map((c) => ({ card: c, repos: c.repos.filter((r) => card.repos.includes(r)) }))
    .filter((h) => h.repos.length > 0);
}

/** What a session reads after writing its card: whether it may write, whether what it waits for still holds, why. */
export function warnings(card: Card, list: Card[], live?: Set<string>): string[] {
  const gone = (c: Card) => (live && c.session && !live.has(c.session) ? "; its session looks gone: the user moves it, or a session does on their word" : "");
  if (card.status === "blocked") {
    const still = holding(card, list);
    if (!still.length) return [`free: nothing holds ${card.repos.join(", ") || "its repositories"}: set ${card.id} --status running (held again if another got there first)`];
    return still.map((h) => `still held: ${h.repos.join(", ")} by ${h.card.id} (running${gone(h.card)}): write nothing until it's free`);
  }
  if (!HOLDS.includes(card.status)) return [];
  const { held, later, pending } = conflicts(card, list);
  const taken = new Set(held.flatMap((h) => h.repos));
  const rest = card.repos.filter((r) => !taken.has(r));
  const out = held.map(({ card: c, repos }) => {
    const drop = rest.length ? `drop ${repos.join(", ")} (set ${card.id} --repos ${rest.join(",")}) and go on, or ` : "";
    return `held: ${repos.join(", ")} by ${c.id} (there since ${clock(c, repos[0])}, session ${c.session || "?"}${gone(c)}): ${drop}commit what you have, set ${card.id} --on ${c.id} and write nothing until it's free`;
  });
  for (const { card: c, repos } of later) out.push(`note: ${repos.join(", ")} has ${c.id} running there since after this card: it was told to wait`);
  for (const { card: c, repos } of pending) out.push(`note: ${repos.join(", ")} has ${c.id} (${c.status}) with unpushed work: its commits go out with the next push`);
  return out;
}

type Opts = Partial<Record<"status" | "title" | "session" | "body" | "repos" | "on" | keyof typeof SECTIONS, string>> & { all?: boolean; json?: boolean };

export function options(argv: string[]): { rest: string[]; o: Opts } | string {
  const o: Opts = {};
  const rest: string[] = [];
  const valued = ["status", "title", "session", "body", "repos", "on", ...Object.keys(SECTIONS)];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all" || a === "--json") o[a.slice(2) as "all" | "json"] = true;
    else if (a.startsWith("--") && valued.includes(a.slice(2))) {
      if (argv[i + 1] === undefined) return `${a} takes a value`;
      (o as Record<string, string>)[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) return `unknown option ${a}`;
    else rest.push(a);
  }
  if (o.status && !(STATUSES as readonly string[]).includes(o.status)) return `status is one of ${STATUSES.join(", ")}`;
  if (o.on !== undefined && o.status !== undefined && o.status !== "blocked") return "--on goes with --status blocked";
  if (o.repos !== undefined && repoList(o.repos).length === 0) return "--repos names one repository at least";
  return { rest, o };
}

function apply(c: Card, o: Opts): Card {
  const next = { ...c };
  if (o.status) next.status = o.status as Status;
  if (o.title) next.title = o.title;
  if (o.session !== undefined) next.session = o.session;
  if (o.repos !== undefined) next.repos = repoList(o.repos);
  if (o.on !== undefined) next.status = "blocked";
  if (o.on !== undefined) next.waits = o.on;
  if (next.status !== "blocked") next.waits = "";
  // A running card's place in each repository's queue: kept while it runs, now for a repository --repos
  // adds or for all when it starts running (added, or again). Stopped, it holds nothing and keeps no place.
  // (to the millisecond: of two cards written in the same second, the one stamped later must lose,
  // so the read-back a moment after writing settles it)
  const at = new Date();
  if (next.status === "running") {
    const isStart = c.status !== "running" || !c.updated;
    const stamp = now(at, true);
    const since: Record<string, string> = {};
    // (a card of the first cut, running with no place: its last update, as it was read)
    for (const r of next.repos) since[r] = !isStart && (c.since[r] || (c.repos.includes(r) && c.updated)) ? c.since[r] || c.updated : stamp;
    next.since = since;
  } else next.since = {};
  next.updated = now(at);
  if (o.body !== undefined) next.body = o.body;
  for (const [k, heading] of Object.entries(SECTIONS)) {
    const v = o[k as keyof typeof SECTIONS];
    if (v !== undefined) next.body = setSection(next.body, heading, v);
  }
  return next;
}

// A card added or moved, in the harness's event log: what waits on the user amber, done green.
function logCard(c: Card, text: string) {
  const tone: Tone = c.status === "done" ? "ok" : c.status === "running" ? "info" : "wait";
  logEvent("board", tone, c.repo, text);
}

/** A card's id: its repo and title as a slug, the repo once when the title starts with it. */
export function cardId(repo: string, title: string): string {
  const own = slug(repo);
  const t = slug(title);
  return (own && (t === own || t.startsWith(`${own}-`)) ? t : slug(`${repo} ${title}`)) || "task";
}

export function add(repo: string, title: string, o: Opts = {}): Card {
  const dir = boardDir();
  mkdirSync(dir, { recursive: true });
  const base = cardId(repo, title);
  const blank = Object.values(SECTIONS).map((h) => `## ${h}\n\n`).join("\n");
  const session = process.env.CLAUDE_CODE_SESSION_ID ?? "";
  let card: Card;
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (existsSync(join(dir, `${id}.md`))) continue;
    card = apply({ id, repo, title, status: "running", session, updated: "", repos: ownRepos(repo), waits: "", since: {}, body: blank }, o);
    if (createCard(join(dir, `${id}.md`), format(card))) break;
  }
  // (the status last: the panel's log shows a line's last word as its figure)
  logCard(card, `${card.title}${card.waits ? ` (on ${card.waits})` : ""} added, ${card.status}`);
  return card;
}

/** Repository names that aren't a folder of the project's (a typo holds nothing). */
export function strangers(repos: string[]): string[] {
  return repos.filter((r) => {
    try {
      return !statSync(repoDir(r)).isDirectory();
    } catch {
      return true;
    }
  });
}

/** Who holds each repository: every one some card names, or those asked; running cards first, the first to run first. */
export function holders(list: Card[], only: string[] = []): { repo: string; card: Card; kind: "held" | "pending" }[] {
  const out: { repo: string; card: Card; kind: "held" | "pending" }[] = [];
  for (const c of list) {
    const kind = HOLDS.includes(c.status) ? "held" : WAITS.includes(c.status) ? "pending" : null;
    if (!kind) continue;
    for (const repo of c.repos) if (!only.length || only.includes(repo)) out.push({ repo, card: c, kind });
  }
  const rank = (h: (typeof out)[number]) => (h.kind === "held" ? 0 : 1);
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || rank(a) - rank(b) || (before(a.card, b.card, a.repo) ? -1 : 1));
}

/**
 * Whether `repo` is another session's to write now: a running card of
 * another session there that ran before this session's own running card
 * there (or any, when this session runs none there).
 */
export function isHeld(repo: string, list: Card[], session: string): boolean {
  const running = list.filter((c) => HOLDS.includes(c.status) && c.repos.includes(repo));
  const mine = running.filter((c) => session && c.session === session).sort((a, b) => (before(a, b, repo) ? -1 : 1))[0];
  return running.some((c) => !(session && c.session === session) && (!mine || before(c, mine, repo)));
}

export function set(id: string, o: Opts): Card | string {
  const file = join(boardDir(), `${id}.md`);
  if (!existsSync(file)) return `no card ${id} (${toolCmd("board")} list --all)`;
  const was = parseCard(id, readFileSync(file, "utf8"));
  if (was.broken) return `${id}'s front matter is unreadable (cut short?): look at ${file} and mend it by hand first`;
  if (o.on === id) return `${id} can't wait on itself`;
  const card = apply(was, o);
  writeCard(file, format(card));
  if (card.status !== was.status) logCard(card, `${card.title}${card.waits ? ` (on ${card.waits})` : ""} ${was.status} → ${card.status}`);
  return card;
}

/**
 * Why this session may not write `repo` now, or none: no running card of
 * its own names it (every task on the board), or another session's running
 * card came to hold it first. The pre-commit hook asks it of a session's
 * every commit; a person's own commit (no session) is never asked.
 */
export function mayWrite(repo: string, list: Card[], session: string): string | undefined {
  if (!session) return undefined;
  const mine = list.filter((c) => c.session === session && HOLDS.includes(c.status) && c.repos.includes(repo));
  if (!mine.length) {
    const own = list.filter((c) => c.session === session && c.status !== "done");
    return own.length
      ? `no running card of this session names ${repo}: ${own.map((c) => `${c.id} (${c.status})`).join(", ")}; set it running with ${repo} in --repos first`
      : `this session has no card: its first write is its card (${toolCmd("board")} add ${repo} "<title>" --repos ${repo})`;
  }
  if (isHeld(repo, list, session)) {
    const by = holders(list, [repo]).find((h) => h.kind === "held" && h.card.session !== session);
    return `${repo} is held by ${by?.card.id ?? "another session's card"}: commit nothing there until it's free (board.ts held ${repo})`;
  }
  return undefined;
}

/** The blocked cards waiting on `id`: freed once it is done. */
export const waitingOn = (id: string, list: Card[]) => list.filter((c) => c.status === "blocked" && c.waits === id);

if (import.meta.main) {
  const [cmd, ...argv] = process.argv.slice(2);
  const parsed = options(argv);
  const fail = (msg: string) => {
    console.error(msg);
    process.exit(2);
  };
  if (typeof parsed === "string") fail(parsed);
  const { rest, o } = parsed as Exclude<typeof parsed, string>;
  if (o.on && !existsSync(join(boardDir(), `${o.on}.md`))) fail(`no card ${o.on} to wait on (${toolCmd("board")} list --all)`);
  // What a session reads after writing its card: a repository held or a typo, cards it frees.
  const tell = (card: Card) => {
    const list = cards();
    for (const r of strangers(card.repos)) console.error(`note: ${r} is no folder of the ${loadConfig().term}'s: it holds nothing`);
    for (const w of warnings(card, list, liveSessions())) console.error(w);
    for (const c of list.filter((c) => c.broken)) console.error(`note: ${c.id}'s front matter is unreadable: it holds nothing until it's mended`);
    if (card.status === "blocked" && !card.waits) console.error(`note: ${card.id} is blocked on nothing: name the card with --on <id>`);
    if (card.status !== "running") for (const c of waitingOn(card.id, list)) console.error(`frees ${c.id} (blocked on it, session ${c.session || "?"})`);
  };
  // Read back a moment after writing: two cards written at once both see the other, and agree which came first.
  const SETTLE_MS = 150;
  if (cmd === "add" && rest.length === 2) {
    const card = add(rest[0], rest[1], o);
    console.log(card.id);
    await Bun.sleep(SETTLE_MS);
    tell(card);
  } else if (cmd === "set" && rest.length === 1) {
    const r = set(rest[0], o);
    if (typeof r === "string") fail(r);
    else {
      console.log(`${r.id}: ${r.status}${r.waits ? ` on ${r.waits}` : ""}`);
      await Bun.sleep(SETTLE_MS);
      tell(r);
    }
  } else if (cmd === "held") {
    const session = process.env.CLAUDE_CODE_SESSION_ID ?? "";
    const found = holders(cards(), rest);
    for (const h of found) console.log(`${h.repo.padEnd(18)} ${h.kind.padEnd(8)} ${h.card.status.padEnd(14)} ${h.card.id}${h.card.session === session && session ? " (this session)" : ""}`);
    if (!found.length) console.log(rest.length ? `${rest.join(", ")}: free` : "nothing held");
    // Scriptable: a named repository another session holds fails.
    const list = cards();
    if (rest.some((r) => isHeld(r, list, session))) process.exit(1);
  } else if (cmd === "may" && rest.length === 1) {
    const why = mayWrite(rest[0], cards(), process.env.CLAUDE_CODE_SESSION_ID ?? "");
    if (why) {
      console.error(`board: ${why}`);
      logEvent("board", "fail", rest[0], `a commit refused: ${why}`);
      process.exit(1);
    }
  } else if (cmd === "list" && !rest.length) {
    const list = cards(o.all);
    if (o.json) console.log(JSON.stringify(list, null, 2));
    else console.log(list.length ? lines(list).join("\n") : "the board is empty");
  } else fail('usage: bun board.ts add <repo> "<title>" [options] | set <id> [options] | list [--all] [--json] | held [repo…] | may <repo>');
}
