// harness-sync.ts's stamps and checks, and init.ts's pieces (bun test).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, stamped, sync, unstamped, VENDORED } from "./harness-sync";
import { DEFAULT_FLAGS, detectCheck, fill, flagsOf, parseArgs, renderSection, renderToml, withAsks, withIgnore, withSection } from "./init";
import { parseConfig } from "./config";
import { problems, staleSection } from "./doctor";
import { scopedRoot, useBoardGuard } from "./testing";

useBoardGuard();

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "init-test-")));

describe("harness-sync", () => {
  test("a stamp goes on line 1 of a .ts and line 2 of a hook, and comes off again", () => {
    const ts = stamped("board.ts", "export {};\n", "abc1234");
    expect(ts.split("\n")[0]).toBe("// harness abc1234: a copy; edit it in the harness repository instead");
    expect(unstamped("board.ts", ts)).toEqual({ sha: "abc1234", text: "export {};\n" });
    const hook = stamped("githooks/pre-push", "#!/bin/sh\necho hi\n", "abc1234+");
    expect(hook.split("\n").slice(0, 3)).toEqual(["#!/bin/sh", "# harness abc1234+: a copy; edit it in the harness repository instead", "echo hi"]);
    expect(unstamped("githooks/pre-push", hook)).toEqual({ sha: "abc1234+", text: "#!/bin/sh\necho hi\n" });
    expect(unstamped("board.ts", "export {};\n")).toBeUndefined();
  });

  test("what is vendored: the tools and every hook, never a test or the setup scripts", () => {
    expect(VENDORED).toContain("board.ts");
    expect(VENDORED).toContain("config.ts");
    expect(VENDORED).toContain("githooks/pre-push");
    expect(VENDORED).toContain("githooks/_ai");
    expect(VENDORED.some((f) => f.includes("test") || f === "init.ts" || f === "harness-sync.ts" || f === "doctor.ts")).toBe(false);
  });

  test("a copy's stamp has a + exactly while the harness has uncommitted code, and the copies are in step", () => {
    const dir = temp();
    writeFileSync(join(dir, "harness.toml"), '[tools]\ndir = "tools/h"\n');
    const restore = scopedRoot(dir);
    try {
      const first = sync(dir, true);
      if (!Array.isArray(first)) throw new Error(first.error);
      expect(first.length).toBe(VENDORED.length);
      // (the expected state is worked out here, from git, not from the stamp under test)
      const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--", ...VENDORED], { cwd: import.meta.dir }).stdout.toString().trim().length > 0;
      const stamp = readFileSync(join(dir, "tools/h/board.ts"), "utf8").split("\n")[0];
      expect(stamp).toMatch(/^\/\/ harness [0-9a-f]+\+?: a copy; edit it in the harness repository instead$/);
      expect(stamp.includes("+: a copy")).toBe(dirty);
      expect(sync(dir, true)).toEqual([]);
      chmodSync(join(dir, "tools/h/githooks/pre-push"), 0o755);
    } finally {
      restore();
    }
  });

  test("the check refuses a trial copy and finds a hand edit, on any tree", () => {
    const dir = temp();
    writeFileSync(join(dir, "harness.toml"), '[tools]\ndir = "tools/h"\n');
    const restore = scopedRoot(dir);
    try {
      sync(dir, true);
      const head = Bun.spawnSync(["git", "rev-parse", "--short=9", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim();
      // a trial copy of one file, and a committed stamp over text the harness never had in another
      writeFileSync(join(dir, "tools/h/each.ts"), stamped("each.ts", "export {};\n", `${head}+`));
      writeFileSync(join(dir, "tools/h/board.ts"), stamped("board.ts", "export const edited = true;\n", head));
      const problems = check(dir).problems;
      expect(problems.some((p) => p.includes("each.ts") && p.includes("a trial copy"))).toBe(true);
      expect(problems.some((p) => p.includes("board.ts") && p.includes("a hand edit"))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("init", () => {
  test("its arguments", () => {
    expect(parseArgs(["--dry-run", "--name", "geo", "--check", "bun test", "/tmp/x"])).toMatchObject({ dry: true, name: "geo", check: "bun test", dir: "/tmp/x", tools: "harness" });
    expect(parseArgs(["--nope"])).toBe("unknown option --nope");
    expect(parseArgs(["--name"])).toBe("--name takes a value");
    expect(parseArgs(["a", "b"])).toBe("one project folder only");
  });

  test("the check it finds", () => {
    const dir = temp();
    expect(detectCheck(dir)).toBe("bun test");
    writeFileSync(join(dir, "package.json"), '{"scripts":{"test":"vitest"}}');
    expect(detectCheck(dir)).toBe("bun run test");
    writeFileSync(join(dir, "package.json"), '{"scripts":{"test":"vitest","check":"tsc && vitest"}}');
    expect(detectCheck(dir)).toBe("bun run check");
  });

  test("the config it writes is read back as the defaults for a one-repository project", () => {
    const root = temp();
    const conf = parseConfig(root, Bun.TOML.parse(renderToml("geo", "bun run test", "harness")) as any);
    expect([conf.name, conf.toolsDir, conf.defaults.check, conf.hooks.lock]).toEqual(["geo", "harness", "bun run test", true]);
    expect(conf.boardDir).toBe(join(root, ".harness", "board"));
  });

  test("the rules section is replaced between its markers and the rest kept", () => {
    const a = withSection("# Mine\n\ntext\n", "## Harness\none\n");
    expect(a).toBe("# Mine\n\ntext\n\n<!-- harness:start -->\n\n## Harness\none\n\n<!-- harness:end -->\n");
    const b = withSection(a + "\nafter\n", "## Harness\ntwo\n");
    expect(b).toContain("two");
    expect(b).not.toContain("one");
    expect(b).toContain("# Mine");
    expect(b.endsWith("after\n")).toBe(true);
    const old = "# M\n<!-- harness:start -->\nold\n<!-- harness:end -->\n\nafter\n";
    const moved = withSection(old, "x");
    expect(moved).toBe("# M\n<!-- harness:start -->\n\nx\n\n<!-- harness:end -->\n\nafter\n");
    expect(withSection(moved, "x")).toBe(moved);
    expect(withSection(undefined, "x")).toBe("<!-- harness:start -->\n\nx\n\n<!-- harness:end -->\n");
  });

  test("the asks are merged, never replacing a key", () => {
    const merged = withAsks({ model: "opus", permissions: { allow: ["Bash(ls)"], ask: ["Bash(git push *)"] } }, ["Bash(git push *)", "Bash(gh pr merge *)"]);
    expect(merged.model).toBe("opus");
    expect(merged.permissions.allow).toEqual(["Bash(ls)"]);
    expect(merged.permissions.ask).toEqual(["Bash(git push *)", "Bash(gh pr merge *)"]);
    expect(withAsks(undefined, ["a"]).permissions.ask).toEqual(["a"]);
  });

  test(".gitignore gets only what it lacks", () => {
    expect(withIgnore("node_modules/\n.cache/\n", [".harness/", ".cache/"])).toBe("node_modules/\n.cache/\n\n# the harness's local state\n.harness/\n");
    expect(withIgnore(".harness/\n.cache/\n", [".harness/", ".cache/"])).toBe(".harness/\n.cache/\n");
    expect(withIgnore(undefined, [".harness/"])).toBe("# the harness's local state\n.harness/\n");
  });

  test("the template carries the session rules, with the project's own placeholders left to fill", () => {
    const t = readFileSync(join(import.meta.dir, "templates", "rules-section.md"), "utf8");
    for (const w of ["question tool", "belongs to the session that asks it", "Close a finished child", "fixed now", "Review your own work"]) expect(t.toLowerCase()).toContain(w.toLowerCase());
    expect(t.indexOf("{{RULES}}")).toBeLessThan(t.indexOf("How sessions work together"));
    expect(t).not.toMatch(/wow|addon|family/i);
  });

  test("the template has no line over 88 columns once filled (Prettier's printWidth in a project that wraps prose)", () => {
    const t = readFileSync(join(import.meta.dir, "templates", "rules-section.md"), "utf8").replaceAll("{{TOOLS}}", "harness").replaceAll("{{RULES}}", "CLAUDE.md");
    // only a line that is one unbreakable code span may pass the width
    const over = t.split("\n").filter((l) => l.length > 88 && !/^\s*`[^`]*`[.,]?$/.test(l));
    expect(over).toEqual([]);
  });

  test("--section-only writes the block alone, with the tools dir of an existing config", () => {
    const dir = temp();
    writeFileSync(join(dir, "harness.toml"), '[tools]\ndir = "kit"\n');
    expect(parseArgs(["--section-only"])).toMatchObject({ section: true });
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "init.ts"), dir, "--section-only"], { env: { ...process.env, HARNESS_ROOT: dir, WOW_ADDONS_ROOT: dir } });
    expect(p.exitCode).toBe(0);
    const text = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(text).toContain("bun kit/board.ts add");
    expect(text).toContain("kit/session.ts check");
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });
});

describe("init: the section follows the config", () => {
  const template = readFileSync(join(import.meta.dir, "templates", "rules-section.md"), "utf8");
  const conf = (toml: string) => parseConfig(temp(), Bun.TOML.parse(toml) as any);

  test("a block is kept when its switch is on, its inverse when off, and the markers leave no trace", () => {
    const t = "a\n{{#lock}}\nL on\n{{/lock}}\n{{^lock}}\nL off\n{{/lock}}\n{{#worktrees}}\nW on\n{{/worktrees}}\nz {{TOOLS}}/x {{RULES}}\n";
    expect(fill(t, "kit", "R.md", { lock: true, worktrees: false })).toBe("a\nL on\nz kit/x R.md\n");
    expect(fill(t, "kit", "R.md", { lock: false, worktrees: true })).toBe("a\nL off\nW on\nz kit/x R.md\n");
    expect(() => fill("{{#nope}}\nx\n{{/nope}}\n", "k", "r")).toThrow("no switch");
  });

  test("the defaults are the family's: the lock, no worktree rules", () => {
    expect(DEFAULT_FLAGS).toEqual({ lock: true, worktrees: false });
    const text = renderSection(conf(""));
    expect(text).toContain("- **The board is the lock.**");
    expect(text).toContain("It holds the repositories it names, and a commit by a Claude session is refused unless");
    expect(text).not.toMatch(/list, not a lock|worktree|\{\{|\}\}/);
    expect(text).toBe(fill(template, "harness", "CLAUDE.md"));
    expect(flagsOf(conf(""))).toEqual(DEFAULT_FLAGS);
  });

  test("lock = false: the lock and the refusal are gone, the list says what it is", () => {
    const text = renderSection(conf("[hooks]\nlock = false\n"));
    expect(text).not.toMatch(/is the lock|refused unless|`held:`|write nothing until|holds the repositories it names/);
    expect(text).toContain("- **The board is a list, not a lock.**");
    expect(text).toContain("Nothing refuses a commit for want of it");
    expect(text).not.toContain("worktree");
  });

  test("worktrees = true: the worktree rules, with the tools dir of the config", () => {
    const text = renderSection(conf('[tools]\ndir = "kit"\n[hooks]\nlock = false\n[session]\nworktrees = true\n'));
    expect(text).toContain("- **Each child works in a worktree of its own**");
    expect(text).toContain("`session.ts check` act on the worktree");
    expect(text).toContain("bun kit/board.ts add");
  });

  test("no line of any rendering passes 88 columns but a lone code span", () => {
    for (const flags of [DEFAULT_FLAGS, { lock: false, worktrees: false }, { lock: false, worktrees: true }, { lock: true, worktrees: true }]) {
      const over = fill(template, "harness", "CLAUDE.md", flags).split("\n").filter((l) => l.length > 88 && !/^\s*`[^`]*`[.,]?$/.test(l));
      expect(over).toEqual([]);
    }
  });

  test("--section-only renders what the file says, an include's switches too", () => {
    const dir = temp();
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "tools", "base.toml"), "[hooks]\nlock = false\n[session]\nworktrees = true\n");
    writeFileSync(join(dir, "harness.toml"), 'include = "tools/base.toml"\n[tools]\ndir = "kit"\n');
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "init.ts"), dir, "--section-only"], { env: { ...process.env, HARNESS_ROOT: dir, WOW_ADDONS_ROOT: dir } });
    expect(p.exitCode).toBe(0);
    const text = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(text).toContain("The board is a list, not a lock");
    expect(text).toContain("Each child works in a worktree of its own");
    expect(text).not.toContain("The board is the lock");
  });

  test("doctor names a Harness section the config doesn't render, and a misspelt switch", () => {
    const dir = temp();
    writeFileSync(join(dir, "harness.toml"), "[hooks]\nlock = false\n");
    const c = parseConfig(dir, { hooks: { lock: false } });
    expect(staleSection(c)).toEqual([]);
    writeFileSync(join(dir, "CLAUDE.md"), `# P\n\n${withSection(undefined, renderSection(parseConfig(dir, {})))}`);
    expect(staleSection(c)).toHaveLength(1);
    expect(staleSection(c)[0]).toContain("isn't the one this config renders");
    writeFileSync(join(dir, "CLAUDE.md"), `# P\n\n${withSection(undefined, renderSection(c))}`);
    expect(staleSection(c)).toEqual([]);
    // (a CLAUDE.md with no harness block is none of the doctor's business)
    writeFileSync(join(dir, "CLAUDE.md"), "# P\n");
    expect(staleSection(c)).toEqual([]);
    writeFileSync(join(dir, "harness.toml"), "[hooks]\nlok = false\n[session]\nworktree = true\n");
    const restore = scopedRoot(dir);
    try {
      const found = problems(dir);
      expect(found).toContain("harness.toml: unknown key lok in [hooks] (trailers, lock, stamp, review)");
      expect(found).toContain("harness.toml: unknown key worktree in [session] (rules, models, worktrees)");
    } finally {
      restore();
    }
  });
});
