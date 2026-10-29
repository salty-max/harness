/**
 * The family's git hooks (githooks/: commit-msg refuses an AI co-author or a
 * "generated with" line, pre-push a tree with no passing check), put in a
 * repository by pointing its core.hooksPath at them. A hooks folder the
 * repository had (husky's .husky/_, .git/hooks) is kept in harness.chain and
 * still runs after ours.
 *
 *   bun hooks.ts status                  every repository: its hooks, HEAD's check (exit 1: one wants a hand)
 *   bun hooks.ts install <repo...>       folder names of the family or paths
 *   bun hooks.ts install --all           every repository
 *   bun hooks.ts uninstall <repo...>     its hooks as they were
 *
 * husky's prepare script (`bun install`) points core.hooksPath back at
 * .husky/_: status says so, install again. install does nothing in CI (CI
 * set): a job's push has no check stamp to show.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { headTree, stampOf } from "./q";
import { loadConfig, repoDir, repoNames, toolCmd } from "./config";

export const HOOKS = join(import.meta.dir, "githooks");

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const isExec = (f: string) => existsSync(f) && (statSync(f).mode & 0o111) !== 0;

function git(cwd: string, ...args: string[]): string | undefined {
  const p = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
}

export function repos(): string[] {
  return repoNames()
    .map((n) => repoDir(n))
    .filter((d) => existsSync(join(d, ".git")))
    .sort();
}

const target = (name: string) => (isAbsolute(name) || name.startsWith(".") ? resolve(name) : repoDir(name));

// The hooks a repository had before ours: its own hooksPath, else .git/hooks
// when it holds a hook that isn't a sample.
function previous(dir: string): string | undefined {
  const path = git(dir, "config", "--get", "core.hooksPath");
  // (never a folder of the harness's own hooks, reached another way: it would chain itself)
  if (path) return existsSync(join(resolve(dir, path), "_chain")) ? undefined : path;
  const own = join(git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir")!, "hooks");
  const real = existsSync(own) && readdirSync(own).some((f) => !f.endsWith(".sample") && statSync(join(own, f)).mode & 0o111);
  return real ? own : undefined;
}

export type State = {
  dir: string;
  ours: boolean;
  hooksPath?: string;
  /** core.hooksPath names a folder that isn't there, or lacks the gates: git then runs no hook and says nothing. */
  missing: boolean;
  chain?: string;
  husky: boolean;
  checked?: boolean;
};

export function state(dir: string): State {
  const hooksPath = git(dir, "config", "--get", "core.hooksPath");
  const pkg = join(dir, "package.json");
  const tree = headTree(dir);
  const at = hooksPath ? resolve(dir, hooksPath) : undefined;
  return {
    dir,
    ours: !!at && real(at) === real(HOOKS),
    hooksPath,
    missing: !!at && (!isExec(join(at, "pre-push")) || !isExec(join(at, "commit-msg"))) && !(at.includes(".husky") && existsSync(at)),
    chain: git(dir, "config", "--get", "harness.chain"),
    husky: existsSync(pkg) && /"prepare"\s*:\s*"[^"]*husky/.test(readFileSync(pkg, "utf8")),
    checked: tree ? !!stampOf(dir, tree) : undefined,
  };
}

export function install(dir: string): string {
  // (never in CI: a job has no check stamp, so the pre-push gate would refuse
  // its pushes; its own check and the pull request's checks gate it there)
  if (process.env.CI) return `${dir}: skipped in CI`;
  if (!existsSync(join(dir, ".git"))) return `${dir}: not a repository`;
  const s = state(dir);
  if (s.ours && !s.missing) return `${dir}: already`;
  const prev = previous(dir);
  if (prev) git(dir, "config", "harness.chain", prev);
  git(dir, "config", "core.hooksPath", HOOKS);
  return `${dir}: installed${prev ? `, its own ${prev} chained` : ""}`;
}

export function uninstall(dir: string): string {
  const s = state(dir);
  if (!s.ours) return `${dir}: not installed`;
  const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (s.chain && s.chain !== join(common!, "hooks")) git(dir, "config", "core.hooksPath", s.chain);
  else git(dir, "config", "--unset", "core.hooksPath");
  git(dir, "config", "--unset", "harness.chain");
  return `${dir}: uninstalled${s.chain ? `, ${s.chain} back` : ""}`;
}

/** What a repository's hooks want, in a word for status.ts: none when the gates are ours and there. */
export function hooksWant(s: State): string | undefined {
  if (s.missing && s.ours) return `its hooks folder is gone: git runs no hook (${toolCmd("hooks")} install)`;
  if (s.missing) return `core.hooksPath ${s.hooksPath} has no gates: git runs none of ours (${toolCmd("hooks")} install)`;
  if (!s.ours) return s.husky && s.hooksPath ? `husky took its hooks back (${toolCmd("hooks")} install)` : `the ${loadConfig().term}'s hooks aren't installed (${toolCmd("hooks")} install)`;
  return undefined;
}

function status(dirs: string[]): boolean {
  const root = loadConfig().root;
  const name = (d: string) => (d.startsWith(root + "/") ? d.slice(root.length + 1) : d);
  const w = Math.max(...dirs.map((d) => name(d).length));
  let sound = true;
  for (const d of dirs) {
    const s = state(d);
    if (hooksWant(s)) sound = false;
    const hooks = s.ours && !s.missing
      ? `hooks ✓${s.chain ? ` (then ${s.chain})` : ""}`
      : s.missing
        ? `hooks MISSING: ${s.hooksPath} isn't there, git runs none (install again)`
        : s.hooksPath
          ? `hooks: ${s.hooksPath}${s.husky ? " (husky's: install again)" : ""}`
          : "hooks –";
    const check = s.checked === undefined ? "" : s.checked ? "HEAD checked ✓" : "HEAD unchecked";
    console.log(`${name(d).padEnd(w)}  ${check.padEnd(14)}  ${hooks}`);
  }
  return sound;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const dirs = rest.includes("--all") ? repos() : rest.map(target);
  if (cmd === "status") process.exit(status(rest.length ? dirs : repos()) ? 0 : 1);
  else if ((cmd === "install" || cmd === "uninstall") && dirs.length) for (const d of dirs) console.log((cmd === "install" ? install : uninstall)(d));
  else {
    console.error("usage: bun hooks.ts status [repo...] | install <repo...|--all> | uninstall <repo...|--all>");
    process.exit(2);
  }
}
