/**
 * One command in every repository of the project, one after the other: a
 * line for each that passed, the end of the output of each that failed, and
 * a non-zero exit if one did. A script, not a model.
 *
 *   bun each.ts [which] [--verbose] [--parallel] -- <command>
 *
 *   command     its words as given, no shell between (quotes, $ and globs
 *               reach the program as typed); one word alone is a shell line
 *               ('git status --short && git log -1'), run by /bin/sh
 *
 *   which       the "addons" group of harness.toml [groups] (every repository
 *               when the project has none), else:
 *     --kit       the "kit" group (the family's: package.json's kit:sync)
 *     --group g   the group g
 *     --all       every repository
 *     --only a,b  these (repository names; one that isn't one is refused)
 *     --skip a,b  not these (the same)
 *   --verbose   every output as it comes, not only a failure's
 *   --parallel  all at once (the output still one repository at a time)
 *
 *   bun each.ts --kit -- bun run kit:sync
 *   bun each.ts --all -- git status --short
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, repoDir, repoNames } from "./config";

// the project root, from a worktree too (config.ts); found when first asked
const ROOT = () => loadConfig().root;
const TAIL = 30;

export type Options = { which: string; only?: string[]; skip?: string[]; verbose: boolean; parallel: boolean; command: string[] };

/** The program and its arguments: the words as given, or a shell line when there's one word. */
export const argvOf = (command: string[]) => (command.length === 1 ? ["/bin/sh", "-c", command[0]] : command);

export function parse(argv: string[]): Options | string {
  const dash = argv.indexOf("--");
  if (dash < 0 || dash === argv.length - 1) return "give the command after --";
  const flags = argv.slice(0, dash);
  const o: Options = { which: "addons", verbose: false, parallel: false, command: argv.slice(dash + 1) };
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    if (f === "--kit") o.which = "kit";
    else if (f === "--all") o.which = "all";
    else if (f === "--group") o.which = flags[++i] ?? "";
    else if (f === "--verbose") o.verbose = true;
    else if (f === "--parallel") o.parallel = true;
    else if (f === "--only" || f === "--skip") {
      const list = (flags[++i] ?? "").split(",").filter(Boolean);
      if (!list.length) return `${f} takes folder names, a,b`;
      o[f === "--only" ? "only" : "skip"] = list;
    } else return `unknown option ${f}`;
  }
  return o;
}

/** Whether a repository is in a group of harness.toml [groups]: a list of names, a package.json script, or a file glob. */
function inGroup(group: string, name: string): boolean {
  const g = loadConfig().groups[group];
  if (!g) return false;
  const dir = repoDir(name);
  if (g.list) return g.list.includes(name);
  if (g.hasScript) {
    const pkg = join(dir, "package.json");
    return existsSync(pkg) && readFileSync(pkg, "utf8").includes(`"${g.hasScript}"`);
  }
  if (g.hasFile) return [...new Bun.Glob(g.hasFile).scanSync({ cwd: dir })].length > 0;
  return false;
}

/** The names --only and --skip give that are no repository of the project's (a typo would run nothing, quietly). */
export const unknown = (names: string[], o: Options) => [...(o.only ?? []), ...(o.skip ?? [])].filter((n) => !names.includes(n));

export function pick(names: string[], o: Options, test: (group: string, n: string) => boolean): string[] {
  let list = names.filter((n) => o.which === "all" || test(o.which, n));
  if (o.only) list = o.only.filter((n) => names.includes(n));
  if (o.skip) list = list.filter((n) => !o.skip!.includes(n));
  return list;
}

async function one(name: string, o: Options): Promise<{ name: string; ok: boolean; code: number; out: string; secs: number }> {
  const t0 = performance.now();
  const p = Bun.spawn(argvOf(o.command), {
    cwd: repoDir(name),
    stdout: o.verbose && !o.parallel ? "inherit" : "pipe",
    stderr: o.verbose && !o.parallel ? "inherit" : "pipe",
  });
  const [out, err] = o.verbose && !o.parallel ? ["", ""] : await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { name, ok: code === 0, code, out: (out + err).trimEnd(), secs: (performance.now() - t0) / 1000 };
}

function report(r: Awaited<ReturnType<typeof one>>, o: Options) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name} (${r.secs.toFixed(1)} s${r.ok ? "" : `, exit ${r.code}`})`);
  if (r.out && (o.verbose || !r.ok)) {
    const lines = r.out.split("\n");
    const shown = o.verbose ? lines : lines.slice(-TAIL);
    if (!o.verbose && lines.length > TAIL) console.log(`  … ${lines.length - TAIL} lines above`);
    console.log(shown.map((l) => `  ${l}`).join("\n"));
  }
}

if (import.meta.main) {
  const o = parse(process.argv.slice(2));
  if (typeof o === "string") {
    console.error(`each: ${o}`);
    process.exit(2);
  }
  const names = repoNames().sort();
  // (no "addons" group in the config: the default is every repository)
  if (o.which === "addons" && !loadConfig().groups.addons) o.which = "all";
  else if (o.which !== "all" && !loadConfig().groups[o.which]) {
    console.error(`each: no group ${o.which} in harness.toml [groups]`);
    process.exit(2);
  }
  const strays = unknown(names, o);
  if (strays.length) {
    console.error(`each: no repository ${strays.join(", ")} in ${ROOT()}`);
    process.exit(2);
  }
  const list = pick(names, o, inGroup);
  if (!list.length) {
    console.error("each: no repository matches");
    process.exit(2);
  }
  console.log(`${o.command.join(" ")}  in ${list.join(", ")}\n`);
  const results = [];
  if (o.parallel) {
    for (const r of await Promise.all(list.map((n) => one(n, o)))) {
      report(r, o);
      results.push(r);
    }
  } else {
    for (const n of list) {
      if (o.verbose) console.log(`── ${n}`);
      const r = await one(n, o);
      report(r, o);
      results.push(r);
    }
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  console.log(failed.length ? `\n${failed.length} of ${results.length} failed: ${failed.join(", ")}` : `\nall ${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
