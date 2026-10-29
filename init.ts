/**
 * Adopts the harness in a project, in one command, from the harness repository:
 *
 *   bun init.ts [project folder] [--name n] [--check "<cmd>"] [--tools dir] [--dry-run] [--dirty]
 *
 * It prints what it writes, then (idempotent: what is there is kept, a second
 * run only brings the copies up to date):
 *   1. harness.toml, with the shape it found (the folder a git repository: one
 *      repository, else the child repositories) and the check it found
 *      (package.json's `check`, else its `test`, else `bun test`)
 *   2. the tools and git hooks, vendored and stamped into <tools dir> (harness-sync.ts)
 *   3. the git hooks installed in each repository (hooks.ts install --all)
 *   4. .claude/settings.json: the asks (push, release, deploy, secrets) merged
 *      into what is there, never replacing a key
 *   5. .claude/agents/reviewer.md and architect.md, where there are none
 *   6. a "Harness" section in CLAUDE.md between <!-- harness:start --> and
 *      <!-- harness:end --> markers, so a later run replaces only that block
 *   7. .gitignore: .harness/ and .cache/
 * Commits nothing: review the diff. --dirty is harness-sync.ts's trial copy.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sync } from "./harness-sync";
import { parseConfig } from "./config";

const SRC = dirname(new URL(import.meta.url).pathname);
const read = (p: string) => readFileSync(p, "utf8");

type Opts = { dir: string; name?: string; check?: string; tools: string; dry: boolean; dirty: boolean };

export function parseArgs(argv: string[]): Opts | string {
  const o: Opts = { dir: process.cwd(), tools: "harness", dry: false, dirty: false };
  let dirSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dry = true;
    else if (a === "--dirty") o.dirty = true;
    else if (a === "--name" || a === "--check" || a === "--tools") {
      const v = argv[++i];
      if (!v) return `${a} takes a value`;
      if (a === "--name") o.name = v;
      else if (a === "--check") o.check = v;
      else o.tools = v;
    } else if (a.startsWith("--")) return `unknown option ${a}`;
    else if (dirSet) return "one project folder only";
    else (o.dir = resolve(a)), (dirSet = true);
  }
  return o;
}

/** The check a project runs: package.json's check, else its test, else bun test. */
export function detectCheck(dir: string): string {
  try {
    const scripts = JSON.parse(read(join(dir, "package.json"))).scripts ?? {};
    if (scripts.check) return "bun run check";
    if (scripts.test) return "bun run test";
  } catch {}
  return "bun test";
}

export function renderToml(name: string, check: string, tools: string): string {
  return `# The harness's config (docs: harness/docs/design.md in the harness repository).
[project]
name = "${name}"

[tools]
dir = "${tools}"

[defaults]
check = "${check}"
rules = "CLAUDE.md"

# [hooks]
# trailers = true   # refuse AI co-author / "generated with" trailers
# lock     = true   # a Claude session's commit wants its running card
# stamp    = true   # a push wants a passing check on the tree
# review   = true   # a push wants a recorded review
`;
}

const fill = (text: string, tools: string, rules: string) => text.replaceAll("{{TOOLS}}", tools).replaceAll("{{RULES}}", rules);
const START = "<!-- harness:start -->";
const END = "<!-- harness:end -->";

/** CLAUDE.md with the harness section put in, or replaced between its markers. */
export function withSection(current: string | undefined, section: string): string {
  const block = `${START}\n${section.trimEnd()}\n${END}\n`;
  if (current === undefined) return block;
  const a = current.indexOf(START);
  const b = current.indexOf(END);
  if (a >= 0 && b > a) return current.slice(0, a) + block + current.slice(b + END.length).replace(/^\n/, "");
  return `${current.trimEnd()}\n\n${block}`;
}

/** settings.json with the asks merged in (existing entries and every other key kept). */
export function withAsks(current: Record<string, any> | undefined, asks: string[]): Record<string, any> {
  const out = { ...(current ?? {}) };
  const perms = { ...(out.permissions ?? {}) };
  const ask: string[] = Array.isArray(perms.ask) ? [...perms.ask] : [];
  for (const a of asks) if (!ask.includes(a)) ask.push(a);
  out.permissions = { ...perms, ask };
  return out;
}

export function withIgnore(current: string | undefined, lines: string[]): string {
  const have = new Set((current ?? "").split("\n").map((l) => l.trim()));
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return current ?? "";
  const head = current ? `${current.replace(/\n*$/, "\n")}\n` : "";
  return `${head}# the harness's local state\n${add.join("\n")}\n`;
}

if (import.meta.main) {
  const o = parseArgs(process.argv.slice(2));
  if (typeof o === "string") {
    console.error(`init: ${o}\nusage: bun init.ts [project folder] [--name n] [--check "<cmd>"] [--tools dir] [--dry-run] [--dirty]`);
    process.exit(2);
  }
  if (!existsSync(o.dir)) {
    console.error(`init: ${o.dir} is no folder`);
    process.exit(2);
  }
  const say = (m: string) => console.log(o.dry ? `would ${m}` : m);
  const put = (rel: string, text: string) => {
    const path = join(o.dir, rel);
    if (!o.dry) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  };
  const name = o.name ?? basename(o.dir);
  const check = o.check ?? detectCheck(o.dir);
  const tomlPath = join(o.dir, "harness.toml");

  // 1. the config
  if (existsSync(tomlPath)) console.log("harness.toml: kept");
  else {
    say(`write harness.toml (project ${name}, check "${check}", tools in ${o.tools}/)`);
    put("harness.toml", renderToml(name, check, o.tools));
  }
  const conf = parseConfig(resolve(o.dir), existsSync(tomlPath) ? (Bun.TOML.parse(read(tomlPath)) as any) : (Bun.TOML.parse(renderToml(name, check, o.tools)) as any));
  const tools = conf.toolsDir;
  const rules = conf.defaults.rules;
  console.log(`shape: ${existsSync(join(o.dir, ".git")) ? "one repository" : `${conf.repos.length} repositories under the folder`} (${conf.repos.map((r) => r.name).join(", ") || "none yet"})`);

  // 2. the copies
  if (o.dry) console.log(`would vendor the tools and git hooks into ${tools}/`);
  else {
    const res = sync(o.dir, o.dirty);
    if ("error" in res) {
      console.error(`init: ${res.error}`);
      process.exit(1);
    }
    console.log(`${tools}/: ${res.length ? `${res.length} files written` : "the copies are current"}`);
  }

  // 3. the hooks
  if (o.dry) console.log("would install the git hooks in each repository");
  else {
    const p = Bun.spawnSync(["bun", join(o.dir, tools, "hooks.ts"), "install", "--all"], { cwd: o.dir, env: { ...process.env, HARNESS_ROOT: o.dir } });
    const text = (p.stdout.toString() + p.stderr.toString()).trim();
    console.log(`hooks: ${text || (p.exitCode === 0 ? "installed" : `failed (exit ${p.exitCode})`)}`);
  }

  // 4. permissions
  const asks = JSON.parse(read(join(SRC, "templates", "settings-asks.json"))) as string[];
  const settingsPath = join(o.dir, ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(read(settingsPath)) : undefined;
  const merged = withAsks(settings, asks);
  if (JSON.stringify(merged) === JSON.stringify(settings)) console.log(".claude/settings.json: the asks are there");
  else {
    say(`merge ${asks.length} asks (push, release, deploy, secrets) into .claude/settings.json`);
    put(".claude/settings.json", JSON.stringify(merged, null, 2) + "\n");
  }

  // 5. the helpers
  for (const agent of ["reviewer", "architect"]) {
    const rel = join(".claude", "agents", `${agent}.md`);
    if (existsSync(join(o.dir, rel))) console.log(`${rel}: kept`);
    else {
      say(`write ${rel}`);
      put(rel, fill(read(join(SRC, "templates", "agents", `${agent}.md`)), tools, rules));
    }
  }

  // 6. the rules section
  const claudePath = join(o.dir, "CLAUDE.md");
  const claude = withSection(existsSync(claudePath) ? read(claudePath) : undefined, fill(read(join(SRC, "templates", "rules-section.md")), tools, rules));
  if (existsSync(claudePath) && claude === read(claudePath)) console.log("CLAUDE.md: the harness section is current");
  else {
    say("put the Harness section into CLAUDE.md");
    put("CLAUDE.md", claude);
  }

  // 7. the ignore file
  const ignorePath = join(o.dir, ".gitignore");
  const ignore = withIgnore(existsSync(ignorePath) ? read(ignorePath) : undefined, [".harness/", ".cache/"]);
  if (existsSync(ignorePath) && ignore === read(ignorePath)) console.log(".gitignore: current");
  else {
    say("ignore .harness/ and .cache/ in .gitignore");
    put(".gitignore", ignore);
  }

  const first = conf.repos[0]?.name ?? name;
  console.log(`\nDone${o.dry ? " (a dry run: nothing written)" : ""}. Nothing is committed: read the diff.\nYour first write in a session is its card:\n  bun ${tools}/board.ts add ${first} "<title>" --repos ${first}`);
}
