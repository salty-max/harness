/**
 * What is wrong with a project's harness setup, in one list:
 *
 *   bun doctor.ts [project folder]     exit 1 when anything is
 *
 * The config's unknown keys and missing paths, a repository with no check
 * known, hooks that aren't ours, copies that aren't the harness's, the
 * template's permission asks missing from .claude/settings.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check } from "./harness-sync";
import { CONFIG_FILE, loadConfig, projectTree, repoDir, treeConfig } from "./config";
import { renderSection, withSection } from "./init";
import { checkCommand } from "./q";

const KNOWN = new Set(["include", "project", "state", "tools", "repos", "defaults", "groups", "hooks", "review", "extensions", "session", "checks"]);
// (a misspelt switch is a switch that was never set: `lok = false` leaves the lock on, quietly)
const KNOWN_KEYS: Record<string, string[]> = { hooks: ["trailers", "lock", "stamp", "review"], session: ["rules", "models", "worktrees", "decisions"], checks: ["queue"] };

export function problems(project: string): string[] {
  const out: string[] = [];
  const conf = loadConfig(project);
  // (given a worktree of the project, its own files are judged: the tools, CLAUDE.md, settings, the config's text. What runs, the hooks, is the repository's)
  const tree = projectTree(project);
  // (what is rendered into the tree, from the tree's own file: a branch may have changed a switch)
  const treeConf = treeConfig(project);
  const file = join(tree, CONFIG_FILE);
  if (existsSync(file)) {
    const own = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const k of Object.keys(own)) if (!KNOWN.has(k)) out.push(`${CONFIG_FILE}: unknown key [${k}]`);
    for (const [table, keys] of Object.entries(KNOWN_KEYS)) {
      const t = own[table];
      if (t && typeof t === "object") for (const k of Object.keys(t)) if (!keys.includes(k)) out.push(`${CONFIG_FILE}: unknown key ${k} in [${table}] (${keys.join(", ")})`);
    }
  } else out.push(`${CONFIG_FILE}: not there (running on defaults)`);
  for (const [what, p] of [["packet extension", treeConf.extensions.packet], ["status extension", treeConf.extensions.status]] as const)
    if (p && !existsSync(join(tree, p))) out.push(`[extensions] ${what} ${p}: no such file`);
  if (!existsSync(join(tree, treeConf.toolsDir))) out.push(`[tools] dir ${treeConf.toolsDir}: no such folder (harness-sync.ts ${tree})`);
  else out.push(...check(tree).problems);
  if (!conf.repos.length) out.push("no repository found (a folder with a .git, or [repos])");
  for (const r of conf.repos) {
    const dir = repoDir(r.name, conf.root);
    if (!existsSync(join(dir, ".git"))) {
      out.push(`${r.name}: ${dir} is no git repository`);
      continue;
    }
    if (!checkCommand(dir)) out.push(`${r.name}: no check known (check = "…" in ${CONFIG_FILE}, or git config harness.check)`);
  }
  // (the hooks are judged by the project's own copy: ours means the vendored githooks/, not the source's)
  const vendored = join(conf.root, conf.toolsDir, "hooks.ts");
  if (existsSync(vendored)) {
    const p = Bun.spawnSync(["bun", vendored, "status"], { cwd: conf.root, env: { ...process.env, HARNESS_ROOT: conf.root }, stderr: "pipe" });
    if (p.exitCode !== 0) out.push(`hooks: ${(p.stdout.toString() + p.stderr.toString()).trim().split("\n").filter((l) => !l.includes("hooks ✓")).join("; ") || "bun " + conf.toolsDir + "/hooks.ts status says a repository wants a hand"}`);
  }
  out.push(...missingAsks(tree));
  out.push(...staleSection(treeConf, tree));
  // (`claude --bg --worktree` makes the worktree of the repository it starts in: a root of many repositories has none to make)
  if (conf.session.worktrees && !existsSync(join(conf.root, ".git"))) out.push(`[session] worktrees = true, but ${conf.root} is no git repository: it is for a project that is one repository (a CLI child gets no --worktree here)`);
  return out;
}

/** The Harness section of the project's CLAUDE.md when it isn't the one the config renders (the lock off, worktrees on, a newer template): init.ts --section-only writes it. */
export function staleSection(conf: ReturnType<typeof loadConfig>, tree: string = conf.root): string[] {
  const file = join(tree, "CLAUDE.md");
  if (!existsSync(file)) return [];
  const have = readFileSync(file, "utf8");
  if (!have.includes("<!-- harness:start -->")) return [];
  return withSection(have, renderSection(conf)) === have ? [] : [`CLAUDE.md: the Harness section isn't the one this config renders (bun init.ts ${tree} --section-only, from the harness repository)`];
}

/** The template's permission asks a project's .claude/settings.json lacks (init.ts merges them in). */
export function missingAsks(root: string): string[] {
  const asks = JSON.parse(readFileSync(join(import.meta.dir, "templates", "settings-asks.json"), "utf8")) as string[];
  const file = join(root, ".claude", "settings.json");
  let have: string[] = [];
  try {
    const ask = JSON.parse(readFileSync(file, "utf8"))?.permissions?.ask;
    if (Array.isArray(ask)) have = ask;
  } catch {
    return [`.claude/settings.json: ${existsSync(file) ? "not valid JSON" : "not there"}, so none of the template's ${asks.length} asks (bun init.ts merges them)`];
  }
  const missing = asks.filter((a) => !have.includes(a));
  if (!missing.length) return [];
  const shown = missing.slice(0, 3).join(", ");
  return [`.claude/settings.json: ${missing.length} of the template's asks missing (bun init.ts merges them): ${shown}${missing.length > 3 ? ", …" : ""}`];
}

if (import.meta.main) {
  const p = problems(resolve(process.argv[2] ?? process.cwd()));
  console.log(p.length ? p.map((l) => `- ${l}`).join("\n") : "nothing wrong");
  process.exit(p.length ? 1 : 0);
}
