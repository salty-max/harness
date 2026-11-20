/**
 * Adopts the harness in a project, in one command, from the harness repository:
 *
 *   bun init.ts [project folder] [--name n] [--check "<cmd>"] [--tools dir] [--dry-run] [--dirty] [--section-only]
 *
 * It prints what it writes, then (idempotent: what is there is kept, a second
 * run only brings the copies up to date):
 *   1. harness.toml, with the shape it found (the folder a git repository: one
 *      repository, else the child repositories) and the check it found
 *      (package.json's `check`, else its `test`, else `bun test`)
 *   2. the tools and git hooks, vendored and stamped into <tools dir> (harness-sync.ts)
 *   3. the git hooks installed in each repository (hooks.ts install --all)
 *   4. .claude/settings.json: the asks (push, release, deploy, GitHub and Vercel writes, secrets) merged
 *      into what is there, never replacing a key, except the asks `[asks] skip` in harness.toml names (those are
 *      left out, and taken out if the file has them)
 *   5. .claude/agents/reviewer.md and architect.md, where there are none (one
 *      that is there is kept as it is, and says which marked rules of the template it lacks)
 *   6. a "Harness" section in CLAUDE.md between <!-- harness:start --> and
 *      <!-- harness:end --> markers, so a later run replaces only that block
 *      (its text follows the config: `[hooks] lock = false` leaves the lock out of
 *      it, `[session] worktrees = true` adds the worktree rules, `[session] decisions
 *      = "opener"` moves the questions and the go to the opener)
 *   7. .gitignore: .harness/ and .cache/
 * Commits nothing: review the diff. --dirty is harness-sync.ts's trial copy.
 * Run in a linked worktree of the project, it adopts that worktree's own files
 * (its copies, CLAUDE.md, settings), never the main checkout's, and leaves the
 * hooks to the main checkout.
 * --section-only does step 6 alone, for a folder that already has its harness.toml
 * (the WoW family's root, no repository, tools vendored elsewhere).
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { sync } from "./harness-sync";
import { type Config, linkedWorktree, parseConfig, projectTree, readToml, treeConfig } from "./config";

const SRC = dirname(new URL(import.meta.url).pathname);
const read = (p: string) => readFileSync(p, "utf8");

type Opts = { dir: string; name?: string; check?: string; tools: string; dry: boolean; dirty: boolean; section: boolean };

export function parseArgs(argv: string[]): Opts | string {
  const o: Opts = { dir: process.cwd(), tools: "harness", dry: false, dirty: false, section: false };
  let dirSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dry = true;
    else if (a === "--dirty") o.dirty = true;
    else if (a === "--section-only") o.section = true;
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
# A project whose every child session works in a git worktree of its own sets lock = false
# (nothing is shared to queue for) and:
# [session]
# worktrees = true
# A project whose user takes every decision in the dispatch session (never in a child):
# decisions = "opener"   # a child asks the user nothing, it sends each question to its opener
`;
}

/** The switches a template's blocks follow: `lock` is `[hooks] lock`, `worktrees` is `[session] worktrees`, `opener` is `[session] decisions = "opener"`. */
export type Flags = { lock: boolean; worktrees: boolean; opener: boolean };
/** What the family's own sessions run on: the lock, every child in the one shared checkout, the decisions in the child. */
export const DEFAULT_FLAGS: Flags = { lock: true, worktrees: false, opener: false };
export const flagsOf = (c: Pick<Config, "hooks" | "session">): Flags => ({ lock: c.hooks.lock, worktrees: c.session.worktrees, opener: c.session.decisions === "opener" });

/**
 * A template filled in: its `{{#name}}…{{/name}}` blocks kept when that switch is on (`{{^name}}` when off),
 * each marker alone on its line and gone with it, then {{TOOLS}} and {{RULES}}. Blocks never nest.
 */
export function fill(text: string, tools: string, rules: string, flags: Flags = DEFAULT_FLAGS): string {
  const kept = text.replace(/^\{\{([#^])(\w+)\}\}\n([\s\S]*?)^\{\{\/\2\}\}\n/gm, (_m, kind: string, name: string, body: string) => {
    if (!(name in flags)) throw new Error(`the template has a block for ${name}, which is no switch (${Object.keys(flags).join(", ")})`);
    return flags[name as keyof Flags] === (kind === "#") ? body : "";
  });
  return kept.replaceAll("{{TOOLS}}", tools).replaceAll("{{RULES}}", rules);
}

/** The helpers init writes into .claude/agents/, each from templates/agents/<name>.md. */
export const AGENTS = ["reviewer", "architect"];
/** A rule a template's block carries, marked on a line of its own: `<!-- harness:rule bash -->`. */
const RULE_MARK = /<!--\s*harness:rule\s+([\w-]+)\s*-->/g;
export const ruleNames = (text: string): string[] => [...text.matchAll(RULE_MARK)].map((m) => m[1]);

/**
 * The rules the template of an agent has that a project's copy lacks, by their marks. A copy is the project's
 * (init keeps it), so only the mark is judged, never the words: it may reword the block as it likes.
 */
export function lackedRules(agent: string, copy: string): string[] {
  const have = new Set(ruleNames(copy));
  return ruleNames(read(join(SRC, "templates", "agents", `${agent}.md`))).filter((r) => !have.has(r));
}

/** The line that says what a kept agent copy lacks (init's "kept" line and doctor's problem both end in it). */
export const lackedSay = (agent: string, lacks: string[]): string =>
  `lacks the template's ${lacks.length > 1 ? "rules" : "rule"} marked ${lacks.map((r) => `<!-- harness:rule ${r} -->`).join(", ")}: add ${lacks.length > 1 ? "each block" : "the block"} from templates/agents/${agent}.md in the harness repository (reword it, keep the mark)`;

/** The Harness section a project's config renders. */
export const renderSection = (c: Pick<Config, "toolsDir" | "defaults" | "hooks" | "session">): string =>
  fill(read(join(SRC, "templates", "rules-section.md")), c.toolsDir, c.defaults.rules, flagsOf(c));
const START = "<!-- harness:start -->";
const END = "<!-- harness:end -->";

/** CLAUDE.md with the harness section put in, or replaced between its markers. */
export function withSection(current: string | undefined, section: string): string {
  const block = `${START}\n\n${section.trimEnd()}\n\n${END}\n`; // blank lines inside the markers: Markdown formatters (Prettier) put them there
  if (current === undefined) return block;
  const a = current.indexOf(START);
  const b = current.indexOf(END);
  if (a >= 0 && b > a) return current.slice(0, a) + block + current.slice(b + END.length).replace(/^\n/, "");
  return `${current.trimEnd()}\n\n${block}`;
}

/**
 * settings.json with the asks merged in (existing entries and every other key kept), except the ones `skip` names
 * (`[asks] skip`): those are not merged, and are taken out of the list when it holds them, so the config is the one
 * truth about which asks a project carries.
 */
export function withAsks(current: Record<string, any> | undefined, asks: string[], skip: string[] = []): Record<string, any> {
  const out = { ...(current ?? {}) };
  const perms = { ...(out.permissions ?? {}) };
  const ask: string[] = Array.isArray(perms.ask) ? perms.ask.filter((a: string) => !skip.includes(a)) : [];
  for (const a of asks) if (!skip.includes(a) && !ask.includes(a)) ask.push(a);
  out.permissions = { ...perms, ask };
  return out;
}

/**
 * The asks a project's harness.toml leaves out, `[asks] skip = ["Bash(git push *)", …]`: exact strings of
 * templates/settings-asks.json. A project whose branch protection or review stands in for one of the harness's
 * asks says so here, in one place, where `init.ts` and `doctor.ts` both read it. It is read here and not in
 * config.ts on purpose: only these two (neither is vendored) need it, so a project's copy of config.ts, and the
 * copies' stamps, don't move for it. A typo (not a list of strings) is an error, never an empty list.
 */
export function askSkip(raw: Record<string, unknown>): string[] | { error: string } {
  const asks = raw.asks;
  if (asks === undefined) return [];
  const skip = asks && typeof asks === "object" && !Array.isArray(asks) ? (asks as Record<string, unknown>).skip : undefined;
  if (skip === undefined) return [];
  if (!Array.isArray(skip) || skip.some((s) => typeof s !== "string" || !s)) return { error: `harness.toml: [asks] skip is a list of the template's ask strings, not ${JSON.stringify(skip)}` };
  return skip as string[];
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
    console.error(`init: ${o}\nusage: bun init.ts [project folder] [--name n] [--check "<cmd>"] [--tools dir] [--dry-run] [--dirty] [--section-only]`);
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
  if (o.section) {
    if (!existsSync(join(o.dir, "harness.toml"))) {
      console.error("init: --section-only wants an existing harness.toml");
      process.exit(2);
    }
    const c = treeConfig(resolve(o.dir));
    // (a linked worktree of the project is its own tree: its CLAUDE.md is the one written)
    if (realpathSync(projectTree(resolve(o.dir))) !== realpathSync(resolve(o.dir))) {
      console.error(`init: the config found is ${c.root}'s, not ${resolve(o.dir)}'s (HARNESS_ROOT or WOW_ADDONS_ROOT set?)`);
      process.exit(2);
    }
    const path = join(o.dir, "CLAUDE.md");
    const next = withSection(existsSync(path) ? read(path) : undefined, renderSection(c));
    if (existsSync(path) && next === read(path)) console.log("CLAUDE.md: the harness section is current");
    else {
      say("put the Harness section into CLAUDE.md");
      put("CLAUDE.md", next);
    }
    process.exit(0);
  }
  const name = o.name ?? basename(o.dir);
  const check = o.check ?? detectCheck(o.dir);
  const tomlPath = join(o.dir, "harness.toml");

  // 1. the config
  if (existsSync(tomlPath)) console.log("harness.toml: kept");
  else {
    say(`write harness.toml (project ${name}, check "${check}", tools in ${o.tools}/)`);
    put("harness.toml", renderToml(name, check, o.tools));
  }
  // (the merged file: an include's switches count as the project's own)
  const conf = parseConfig(resolve(o.dir), existsSync(tomlPath) ? readToml(tomlPath, resolve(o.dir)) : (Bun.TOML.parse(renderToml(name, check, o.tools)) as any));
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

  // 3. the hooks (core.hooksPath is the repository's, every worktree's: never set from a worktree)
  if (linkedWorktree(o.dir)) console.log(`hooks: not installed from a linked worktree (core.hooksPath is shared by all of them): from the main checkout, bun ${tools}/hooks.ts install --all`);
  else if (o.dry) console.log("would install the git hooks in each repository");
  else {
    const p = Bun.spawnSync(["bun", join(o.dir, tools, "hooks.ts"), "install", "--all"], { cwd: o.dir, env: { ...process.env, HARNESS_ROOT: o.dir } });
    const text = (p.stdout.toString() + p.stderr.toString()).trim();
    console.log(`hooks: ${text || (p.exitCode === 0 ? "installed" : `failed (exit ${p.exitCode})`)}`);
  }

  // 4. permissions
  const asks = JSON.parse(read(join(SRC, "templates", "settings-asks.json"))) as string[];
  const settingsPath = join(o.dir, ".claude", "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(read(settingsPath)) : undefined;
  const skipped = askSkip(existsSync(tomlPath) ? readToml(tomlPath, resolve(o.dir)) : {});
  if ("error" in skipped) {
    console.error(`init: ${skipped.error}`);
    process.exit(1);
  }
  const merged = withAsks(settings, asks, skipped);
  const left = asks.filter((a) => !skipped.includes(a)).length;
  const have: string[] = Array.isArray(settings?.permissions?.ask) ? settings.permissions.ask : [];
  const dropped = skipped.filter((a) => have.includes(a));
  if (JSON.stringify(merged) === JSON.stringify(settings)) console.log(`.claude/settings.json: the asks are there${skipped.length ? ` (${skipped.length} left out by [asks] skip)` : ""}`);
  else {
    say(`merge ${left} asks (push, release, deploy, GitHub and Vercel writes, secrets) into .claude/settings.json${dropped.length ? `, and take out the ${dropped.length} that [asks] skip names` : ""}`);
    put(".claude/settings.json", JSON.stringify(merged, null, 2) + "\n");
  }

  // 5. the helpers
  for (const agent of AGENTS) {
    const rel = join(".claude", "agents", `${agent}.md`);
    if (existsSync(join(o.dir, rel))) {
      const lacks = lackedRules(agent, read(join(o.dir, rel)));
      console.log(`${rel}: kept${lacks.length ? ` (${lackedSay(agent, lacks)})` : ""}`);
    } else {
      say(`write ${rel}`);
      put(rel, fill(read(join(SRC, "templates", "agents", `${agent}.md`)), tools, rules));
    }
  }

  // 6. the rules section
  const claudePath = join(o.dir, "CLAUDE.md");
  const claude = withSection(existsSync(claudePath) ? read(claudePath) : undefined, renderSection(conf));
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
