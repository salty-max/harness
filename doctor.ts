/**
 * What is wrong with a project's harness setup, in one list:
 *
 *   bun doctor.ts [project folder]     exit 1 when anything is
 *
 * The config's unknown keys and missing paths, a repository with no check
 * known, hooks that aren't ours, copies that aren't the harness's, the
 * template's permission asks missing from .claude/settings.json (less the ones
 * `[asks] skip` leaves out, which are wrong where they are still there).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check } from "./harness-sync";
import { CONFIG_FILE, loadConfig, projectTree, readToml, repoDir, treeConfig } from "./config";
import { askSkip, renderSection, withSection } from "./init";
import { checkCommand } from "./q";

const KNOWN = new Set(["include", "project", "state", "tools", "repos", "defaults", "groups", "hooks", "review", "extensions", "session", "checks", "asks"]);
// (a misspelt switch is a switch that was never set: `lok = false` leaves the lock on, quietly)
const KNOWN_KEYS: Record<string, string[]> = { hooks: ["trailers", "lock", "stamp", "review"], session: ["rules", "models", "worktrees", "decisions"], checks: ["queue", "queue_limit"], asks: ["skip"] };

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
  out.push(...asksProblems(tree));
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

const templateAsks = () => JSON.parse(readFileSync(join(import.meta.dir, "templates", "settings-asks.json"), "utf8")) as string[];

/** The asks in a project's .claude/settings.json, or the reason it has none to read. */
function haveAsks(root: string): string[] | { why: string } {
  const file = join(root, ".claude", "settings.json");
  try {
    const ask = JSON.parse(readFileSync(file, "utf8"))?.permissions?.ask;
    return Array.isArray(ask) ? ask : [];
  } catch {
    return { why: existsSync(file) ? "not valid JSON" : "not there" };
  }
}

/** The template's permission asks a project's .claude/settings.json lacks, `skip` (`[asks] skip`) apart (init.ts merges them in). */
export function missingAsks(root: string, skip: string[] = []): string[] {
  const asks = templateAsks().filter((a) => !skip.includes(a));
  const have = haveAsks(root);
  if (!Array.isArray(have)) return [`.claude/settings.json: ${have.why}, so none of the template's ${asks.length} asks (bun init.ts merges them)`];
  const missing = asks.filter((a) => !have.includes(a));
  if (!missing.length) return [];
  const shown = missing.slice(0, 3).join(", ");
  return [`.claude/settings.json: ${missing.length} of the template's asks missing (bun init.ts merges them): ${shown}${missing.length > 3 ? ", …" : ""}`];
}

/** What is wrong with the asks: `[asks] skip` not a list, naming an ask the template lacks (a typo), or an ask it leaves out that settings.json still holds; and the template's asks that are missing, the skipped apart. */
export function asksProblems(tree: string): string[] {
  const file = join(tree, CONFIG_FILE);
  const skip = askSkip(existsSync(file) ? readToml(file, tree) : {});
  if ("error" in skip) return [skip.error, ...missingAsks(tree)];
  const out = missingAsks(tree, skip);
  const known = templateAsks();
  const strange = skip.filter((s) => !known.includes(s));
  if (strange.length) out.push(`${CONFIG_FILE}: [asks] skip names ${strange.join(", ")}, which the template (templates/settings-asks.json) doesn't have: it must be an ask's exact string`);
  const have = haveAsks(tree);
  const still = Array.isArray(have) ? skip.filter((s) => have.includes(s)) : [];
  if (still.length) out.push(`.claude/settings.json: ${still.length} of the asks [asks] skip leaves out are still there (bun init.ts takes them out): ${still.slice(0, 3).join(", ")}${still.length > 3 ? ", …" : ""}`);
  return out;
}

if (import.meta.main) {
  const p = problems(resolve(process.argv[2] ?? process.cwd()));
  console.log(p.length ? p.map((l) => `- ${l}`).join("\n") : "nothing wrong");
  process.exit(p.length ? 1 : 0);
}
