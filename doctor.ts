/**
 * What is wrong with a project's harness setup, in one list:
 *
 *   bun doctor.ts [project folder]     exit 1 when anything is
 *
 * The config's unknown keys and missing paths, a repository with no check
 * known, hooks that aren't ours, copies that aren't the harness's.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check } from "./harness-sync";
import { CONFIG_FILE, loadConfig, repoDir } from "./config";
import { checkCommand } from "./q";

const KNOWN = new Set(["include", "project", "state", "tools", "repos", "defaults", "groups", "hooks", "review", "extensions", "session"]);

export function problems(project: string): string[] {
  const out: string[] = [];
  const conf = loadConfig(project);
  const file = join(conf.root, CONFIG_FILE);
  if (existsSync(file)) {
    for (const k of Object.keys(Bun.TOML.parse(readFileSync(file, "utf8")))) if (!KNOWN.has(k)) out.push(`${CONFIG_FILE}: unknown key [${k}]`);
  } else out.push(`${CONFIG_FILE}: not there (running on defaults)`);
  for (const [what, p] of [["packet extension", conf.extensions.packet], ["status extension", conf.extensions.status]] as const)
    if (p && !existsSync(join(conf.root, p))) out.push(`[extensions] ${what} ${p}: no such file`);
  if (!existsSync(join(conf.root, conf.toolsDir))) out.push(`[tools] dir ${conf.toolsDir}: no such folder (harness-sync.ts ${conf.root})`);
  else out.push(...check(conf.root).problems);
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
    if (p.exitCode !== 0) out.push(`hooks: ${(p.stdout.toString() + p.stderr.toString()).trim().split("\n").filter((l) => /want|gone|not|husky/.test(l)).join("; ") || "bun " + conf.toolsDir + "/hooks.ts status says a repository wants a hand"}`);
  }
  return out;
}

if (import.meta.main) {
  const p = problems(resolve(process.argv[2] ?? process.cwd()));
  console.log(p.length ? p.map((l) => `- ${l}`).join("\n") : "nothing wrong");
  process.exit(p.length ? 1 : 0);
}
