/**
 * The project's config, `harness.toml`, and the root it sits in: every tool
 * takes its paths and names from here, never from a folder it assumes.
 *
 *   bun harness/config.ts root              the project root
 *   bun harness/config.ts repo-name [dir]   the repository's name (cwd's by default)
 *   bun harness/config.ts events-path       the event log's file ("" when off)
 *   bun harness/config.ts show              the whole config as JSON
 *
 * The root, in this order:
 *   1. HARNESS_ROOT, or WOW_ADDONS_ROOT as its alias (the family's name for
 *      it, which the existing tests and tools set): that folder, config or not
 *   2. up from the working directory to a folder holding harness.toml
 *   3. up from the repository's main checkout (git's common dir: a worktree
 *      anywhere on the disk still belongs to its main checkout)
 *   4. up from this file
 * A harness.toml inside a repository (a one-repository project) is read from
 * the main checkout when the working directory is one of its worktrees, so
 * every worktree shares one board and one lock.
 *
 * `include = "<path>"` in the file reads that file (from the root) first and
 * the file's own keys override it: the family's root file points at a
 * versioned one. Every key is optional; the defaults are for a project that
 * is one repository (docs/design.md, section 2).
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const CONFIG_FILE = "harness.toml";

type Table = Record<string, unknown>;
export type RepoConf = { name: string; path: string; check?: string; rules?: string };
export type Config = {
  root: string;
  name: string;
  /** What the messages call the project: "project", the family's "family". */
  term: string;
  stateDir: string;
  boardDir: string;
  cacheDir: string;
  /** Where the harness's tools are vendored, relative to the root. */
  toolsDir: string;
  repos: RepoConf[];
  defaults: { check?: string; rules: string };
  groups: Record<string, { hasScript?: string; hasFile?: string; list?: string[] }>;
  hooks: { trailers: boolean; lock: boolean; stamp: boolean; review: boolean };
  review: { waive: RegExp[]; copies: { patterns: RegExp[]; except: string[] } };
  extensions: { packet?: string; status?: string };
  session: { rules: string; models: { code: string; prose: string } };
};

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const git = (cwd: string, ...args: string[]) => {
  if (!isDir(cwd)) return undefined;
  const p = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
};

/** The main checkout of the repository `from` is in (a worktree's too), or undefined. */
function mainCheckout(from: string): string | undefined {
  const common = git(from, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common?.endsWith("/.git") ? dirname(common) : undefined;
}
/** Where a bare repository's worktrees look for the root too: the folder holding the common dir. */
const commonParent = (from: string) => {
  const common = git(from, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common ? dirname(common) : undefined;
};

export function findUp(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function projectRoot(from: string = process.cwd()): string {
  const env = process.env.HARNESS_ROOT || process.env.WOW_ADDONS_ROOT;
  if (env) {
    if (!isDir(env)) throw new Error(`HARNESS_ROOT=${env} is no folder`);
    if (!existsSync(join(env, CONFIG_FILE))) throw new Error(`HARNESS_ROOT=${env} holds no ${CONFIG_FILE}`);
    return resolve(env);
  }
  const main = mainCheckout(from);
  let found = findUp(from);
  // (a harness.toml inside the repository itself: the main checkout's, so worktrees share the board)
  if (found && main && found !== main && git(found, "rev-parse", "--show-toplevel") === realpath(found) && existsSync(join(main, CONFIG_FILE))) found = main;
  const parent = commonParent(from);
  found ??= (main && findUp(main)) ?? (parent && findUp(parent)) ?? findUp(import.meta.dir);
  if (found) return found;
  throw new Error(`no ${CONFIG_FILE} above ${from}: run harness init, or set HARNESS_ROOT`);
}

const realpath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export const projectPath = (...parts: string[]) => join(projectRoot(), ...parts);

function readToml(file: string, root: string, depth = 0): Table {
  const own = Bun.TOML.parse(readFileSync(file, "utf8")) as Table;
  const inc = own.include;
  if (typeof inc !== "string" || depth > 3) return own;
  const path = isAbsolute(inc) ? inc : join(root, inc);
  if (!existsSync(path)) throw new Error(`${file}: include ${inc} is not there`);
  return merge(readToml(path, dirname(path), depth + 1), own);
}
function merge(a: Table, b: Table): Table {
  const out: Table = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const old = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && old && typeof old === "object" && !Array.isArray(old) ? merge(old as Table, v as Table) : v;
  }
  return out;
}
const table = (v: unknown): Table => (v && typeof v === "object" && !Array.isArray(v) ? (v as Table) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** The repositories: those listed, else the root itself when it is one, else every folder under it with a .git. */
function discover(root: string, name: string, ignore: string[]): string[] {
  if (existsSync(join(root, ".git"))) return [name];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !ignore.includes(d.name) && existsSync(join(root, d.name, ".git")))
    .map((d) => d.name)
    .sort();
}

export function parseConfig(root: string, raw: Table): Config {
  const project = table(raw.project);
  const name = str(project.name) ?? basename(root);
  const state = table(raw.state);
  const stateDir = str(state.dir) ?? ".harness";
  const defaults = table(raw.defaults);
  const reposRaw = table(raw.repos);
  const ignore = Array.isArray(reposRaw.ignore) ? (reposRaw.ignore as string[]) : ["harness"];
  const listed = Object.entries(reposRaw).filter(([k, v]) => k !== "ignore" && v && typeof v === "object");
  const names = listed.length ? listed.map(([k]) => k) : discover(root, name, ignore);
  const repos = names.map((n): RepoConf => {
    const t = table(reposRaw[n]);
    return { name: n, path: str(t.path) ?? (n === name && existsSync(join(root, ".git")) ? "." : n), check: str(t.check), rules: str(t.rules) };
  });
  const groups: Config["groups"] = {};
  for (const [k, v] of Object.entries(table(raw.groups))) {
    if (Array.isArray(v)) groups[k] = { list: v as string[] };
    else groups[k] = { hasScript: str(table(v).has_script), hasFile: str(table(v).has_file) };
  }
  const hooks = table(raw.hooks);
  const review = table(raw.review);
  const waive = Array.isArray(review.waive) ? (review.waive as string[]) : ["^docs/", "(^|/)(README|CLAUDE)\\.md$"];
  const copies = table(review.copies);
  const ext = table(raw.extensions);
  const session = table(raw.session);
  const models = table(session.models);
  return {
    root,
    name,
    term: str(project.term) ?? "project",
    stateDir,
    boardDir: join(root, str(state.board) ?? join(stateDir, "board")),
    cacheDir: join(root, str(state.cache) ?? join(stateDir, "cache")),
    toolsDir: str(table(raw.tools).dir) ?? "harness",
    repos,
    defaults: { check: str(defaults.check), rules: str(defaults.rules) ?? "CLAUDE.md" },
    groups,
    hooks: { trailers: bool(hooks.trailers, true), lock: bool(hooks.lock, true), stamp: bool(hooks.stamp, true), review: bool(hooks.review, true) },
    review: {
      waive: waive.map((w) => new RegExp(w, "i")),
      copies: { patterns: (Array.isArray(copies.patterns) ? (copies.patterns as string[]) : []).map((w) => new RegExp(w)), except: Array.isArray(copies.except) ? (copies.except as string[]) : [] },
    },
    extensions: { packet: str(ext.packet), status: str(ext.status) },
    session: { rules: str(session.rules) ?? str(defaults.rules) ?? "CLAUDE.md", models: { code: str(models.code) ?? "opusplan", prose: str(models.prose) ?? "opus" } },
  };
}

const cache = new Map<string, Config>();
export function loadConfig(from: string = process.cwd()): Config {
  const root = projectRoot(from);
  const hit = cache.get(root);
  if (hit) return hit;
  const file = join(root, CONFIG_FILE);
  const conf = parseConfig(root, existsSync(file) ? readToml(file, root) : {});
  cache.set(root, conf);
  return conf;
}

/** The repository's folder, absolute (a name need not be its folder's). */
export function repoDir(name: string, from?: string): string {
  const c = loadConfig(from);
  const r = c.repos.find((x) => x.name === name);
  return resolve(c.root, r ? r.path : name);
}
export const repoNames = (from?: string) => loadConfig(from).repos.map((r) => r.name);

/** The repository's name from any folder in it, a worktree too: the configured one, else the main checkout's folder name. */
export function repoName(cwd: string = process.cwd()): string {
  const main = mainCheckout(cwd);
  const dir = main ?? resolve(cwd);
  try {
    const c = loadConfig(cwd);
    const hit = c.repos.find((r) => realpath(resolve(c.root, r.path)) === realpath(dir));
    if (hit) return hit.name;
  } catch {}
  return basename(dir);
}

/** A tool of the harness as a command to type from the root, `bun addon-kit/board.ts` where the tools are vendored there. */
export const toolCmd = (tool: string, from?: string) => `bun ${loadConfig(from).toolsDir}/${tool}.ts`;

/** The configured entry of the repository `dir` is in, if it has one. */
export function repoConf(dir: string): RepoConf | undefined {
  try {
    const c = loadConfig(dir);
    return c.repos.find((r) => realpath(resolve(c.root, r.path)) === realpath(mainCheckout(dir) ?? dir));
  } catch {
    return undefined;
  }
}

/** The check a repository's push is gated on, per the config: its own entry's, else the default. */
export function configuredCheck(dir: string): string | undefined {
  return repoConf(dir)?.check;
}

/** What config.ts check prints for a hook's hint: the repository's own check, else the default where package.json has none. */
function checkHint(dir: string): string | undefined {
  const own = configuredCheck(dir);
  if (own) return own;
  try {
    if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts?.check) return undefined;
  } catch {}
  return loadConfig(dir).defaults.check;
}

/** A tool as a command to type inside a repository: its path from the repository's folder (`bun ../addon-kit/q.ts` from a family repository). */
export function toolCmdIn(tool: string, repo: string): string {
  const c = loadConfig();
  const rel = relative(repoDir(repo), join(c.root, c.toolsDir)) || ".";
  return `bun ${rel}/${tool}.ts`;
}

/** The event log's file: HARNESS_EVENTS, "off" for none, else the project's cache folder. */
export function eventsFile(): string | undefined {
  const set = process.env.HARNESS_EVENTS;
  if (set === "off") return undefined;
  if (set) return set;
  try {
    return join(loadConfig().cacheDir, "events.log");
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "root") console.log(projectRoot());
    else if (cmd === "repo-name") console.log(repoName(arg ?? process.cwd()));
    else if (cmd === "hook") console.log(loadConfig().hooks[arg as "trailers" | "lock" | "stamp" | "review"] === false ? "off" : "on");
    else if (cmd === "check") console.log(checkHint(process.cwd()) ?? "");
    else if (cmd === "term") console.log(loadConfig().term);
    else if (cmd === "events-path") console.log(eventsFile() ?? "");
    else if (cmd === "show") console.log(JSON.stringify(loadConfig(), (k, v) => (v instanceof RegExp ? v.source : v), 2));
    else {
      console.error("usage: config.ts root | repo-name [dir] | events-path | show");
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
