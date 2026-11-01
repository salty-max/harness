// harness-sync.ts's stamps and checks, and init.ts's pieces (bun test).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, stamped, sync, unstamped, VENDORED } from "./harness-sync";
import { detectCheck, parseArgs, renderToml, withAsks, withIgnore, withSection } from "./init";
import { parseConfig } from "./config";
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
    expect(a).toBe("# Mine\n\ntext\n\n<!-- harness:start -->\n## Harness\none\n<!-- harness:end -->\n");
    const b = withSection(a + "\nafter\n", "## Harness\ntwo\n");
    expect(b).toContain("two");
    expect(b).not.toContain("one");
    expect(b).toContain("# Mine");
    expect(b.endsWith("after\n")).toBe(true);
    expect(withSection(undefined, "x")).toBe("<!-- harness:start -->\nx\n<!-- harness:end -->\n");
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
