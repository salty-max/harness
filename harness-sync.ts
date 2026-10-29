/**
 * Copies the harness into a project (its tools and git hooks, vendored),
 * each file under a stamp line naming the harness commit it is a copy of:
 *
 *   bun harness-sync.ts <project folder>            write the copies into harness.toml's [tools] dir
 *   bun harness-sync.ts --dirty <project folder>    a trial copy of uncommitted harness code ("<sha>+")
 *   bun harness-sync.ts --check <project folder>    fail if a copy isn't the harness's at its stamp
 *   --tools-only / --hooks-only                     half of the copies (a project whose hooks every repository runs swaps them last)
 *
 * (run from the harness repository: the sources are the files beside this one)
 *
 * What is copied: VENDORED below, the tool files and githooks/, never the
 * tests, this script, init.ts or doctor.ts. A `.ts` copy's first line is
 * `// harness <sha>: a copy; edit it in the harness repository instead`, a
 * shell hook's second (after its `#!/bin/sh`) the same with `#`.
 *
 * The check: each copy equals the harness's file at its stamp (a hand edit
 * or a stamp made up fails), and no stamp is a "+" trial. A copy behind the
 * harness's newest commit (origin/main when it has a remote, else its own
 * HEAD) is only said: a sibling repository moving on must not turn a project's
 * check red (the family's audit, incident 1). Where the harness itself isn't
 * there (CI, a clone on its own) it checks the stamps' form alone, and says so.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./config";

const SRC = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
export const TOOLS = ["config", "events", "board", "q", "hooks", "review", "packet", "each", "status", "usage", "session"].map((t) => `${t}.ts`);
export const VENDORED = [...TOOLS, ...readdirSync(join(SRC, "githooks")).sort().map((h) => `githooks/${h}`)];
const STAMP = /^(?:\/\/|#) harness ([0-9a-f]{7,40}\+?): a copy; edit it in the harness repository instead$/;

function git(...args: string[]): string | undefined {
  const p = Bun.spawnSync(["git", ...args], { cwd: SRC, stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trimEnd() : undefined;
}

const shell = (file: string) => file.startsWith("githooks/");
const mark = (file: string, sha: string) => `${shell(file) ? "#" : "//"} harness ${sha}: a copy; edit it in the harness repository instead`;

/** A source file's text with the stamp put in: line 1 for a .ts, line 2 (after the shebang) for a hook. */
export function stamped(file: string, text: string, sha: string): string {
  const lines = text.split("\n");
  if (shell(file) && lines[0].startsWith("#!")) return [lines[0], mark(file, sha), ...lines.slice(1)].join("\n");
  return `${mark(file, sha)}\n${text}`;
}
/** The stamp of a copy and its text without it, or undefined when the first lines carry none. */
export function unstamped(file: string, text: string): { sha: string; text: string } | undefined {
  const lines = text.split("\n");
  const at = shell(file) && lines[0].startsWith("#!") ? 1 : 0;
  const m = lines[at]?.match(STAMP);
  if (!m) return undefined;
  return { sha: m[1], text: [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n") };
}

/** The commit a copy is stamped with: the harness's HEAD, "+" when its files are dirty. */
function stampNow(dirty: boolean): string | { error: string } {
  const head = git("rev-parse", "--short=9", "HEAD");
  if (!head) return { error: "the harness has no commit to stamp (git init, commit)" };
  const unclean = (git("status", "--porcelain", "--", ...VENDORED) ?? "").length > 0;
  if (unclean && !dirty) return { error: "uncommitted harness code: commit it, or --dirty for a trial copy" };
  return unclean ? `${head}+` : head;
}

export function sync(project: string, dirty = false, only?: "tools" | "hooks"): string[] | { error: string } {
  const conf = loadConfig(project);
  const sha = stampNow(dirty);
  if (typeof sha !== "string") return sha;
  const out: string[] = [];
  const dest = join(conf.root, conf.toolsDir);
  for (const f of VENDORED) {
    if (only === "tools" && shell(f)) continue;
    if (only === "hooks" && !shell(f)) continue;
    const to = join(dest, f);
    const text = stamped(f, readFileSync(join(SRC, f), "utf8"), sha);
    mkdirSync(dirname(to), { recursive: true });
    if (!existsSync(to) || readFileSync(to, "utf8") !== text) {
      writeFileSync(to, text);
      out.push(`wrote ${join(conf.toolsDir, f)}`);
    }
    chmodSync(to, statSync(join(SRC, f)).mode & 0o777);
  }
  // a copy the harness dropped since (a stamped file no longer in the list)
  for (const dir of [dest, join(dest, "githooks")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const rel = dir === dest ? name : `githooks/${name}`;
      const path = join(dir, name);
      if (VENDORED.includes(rel) || !statSync(path).isFile()) continue;
      if (unstamped(rel, readFileSync(path, "utf8"))) {
        rmSync(path);
        out.push(`removed ${join(conf.toolsDir, rel)} (the harness dropped it)`);
      }
    }
  }
  return out;
}

/** Problems that fail the check, then notes (a stale copy). */
export function check(project: string): { problems: string[]; notes: string[] } {
  const conf = loadConfig(project);
  const dest = join(conf.root, conf.toolsDir);
  const problems: string[] = [];
  const notes: string[] = [];
  const sources = existsSync(join(SRC, ".git"));
  const stamps = new Set<string>();
  for (const f of VENDORED) {
    const path = join(dest, f);
    if (!existsSync(path)) {
      problems.push(`${join(conf.toolsDir, f)}: missing (harness-sync.ts ${project})`);
      continue;
    }
    const got = unstamped(f, readFileSync(path, "utf8"));
    if (!got) {
      problems.push(`${join(conf.toolsDir, f)}: no harness stamp (a hand-made file, or the stamp was edited)`);
      continue;
    }
    if (got.sha.endsWith("+")) {
      problems.push(`${join(conf.toolsDir, f)}: a trial copy (${got.sha}): sync again from a committed harness`);
      continue;
    }
    stamps.add(got.sha);
    if (!sources) continue;
    const at = git("show", `${got.sha}:${f}`);
    if (at === undefined) problems.push(`${join(conf.toolsDir, f)}: stamp ${got.sha} is no commit of the harness (or has no ${f})`);
    else if (at !== got.text.replace(/\n$/, "") && at + "\n" !== got.text) problems.push(`${join(conf.toolsDir, f)}: not the harness's file at ${got.sha}: a hand edit (edit it in the harness, then sync)`);
  }
  if (!sources) notes.push("the harness repository isn't here: the stamps' form alone was checked");
  else {
    const newest = git("rev-parse", "--short=9", git("rev-parse", "--verify", "-q", "origin/main") ? "origin/main" : "HEAD");
    const behind = [...stamps].filter((s) => newest && !newest.startsWith(s) && !s.startsWith(newest));
    if (behind.length) notes.push(`behind the harness's ${newest}: ${[...stamps].join(", ")} (harness-sync.ts ${project} when you want the newer)`);
  }
  return { problems, notes };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirty = args.includes("--dirty");
  const checking = args.includes("--check");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: bun harness-sync.ts [--dirty|--check] <project folder>");
    process.exit(2);
  }
  const project = resolve(dir);
  if (checking) {
    const { problems, notes } = check(project);
    for (const p of problems) console.error(p);
    for (const n of notes) console.log(`note: ${n}`);
    if (problems.length) process.exit(1);
    console.log("the harness copies are the harness's");
  } else {
    const only = args.includes("--tools-only") ? "tools" : args.includes("--hooks-only") ? "hooks" : undefined;
    const res = sync(project, dirty, only);
    if ("error" in res) {
      console.error(res.error);
      process.exit(1);
    }
    console.log(res.length ? res.join("\n") : "nothing to write: the copies are current");
  }
}
