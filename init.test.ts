// harness-sync.ts's stamps and checks, and init.ts's pieces (bun test).
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, stamped, sync, unstamped, VENDORED } from "./harness-sync";
import { detectCheck, parseArgs, renderToml, withAsks, withIgnore, withSection } from "./init";
import { parseConfig } from "./config";

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

  test("a trial copy is made, kept in step, and refused by the check; a hand edit is found", () => {
    const dir = temp();
    writeFileSync(join(dir, "harness.toml"), '[tools]\ndir = "tools/h"\n');
    // (other test files leave WOW_ADDONS_ROOT set in this process: the project is named by HARNESS_ROOT here)
    process.env.HARNESS_ROOT = dir;
    const first = sync(dir, true);
    if (!Array.isArray(first)) throw new Error(first.error);
    expect(first.length).toBe(VENDORED.length);
    expect(readFileSync(join(dir, "tools/h/board.ts"), "utf8").split("\n")[0]).toMatch(/^\/\/ harness [0-9a-f]+\+: a copy/);
    expect(sync(dir, true)).toEqual([]);
    chmodSync(join(dir, "tools/h/githooks/pre-push"), 0o755);
    const c = check(dir);
    expect(c.problems.length).toBe(VENDORED.length);
    expect(c.problems[0]).toContain("a trial copy");
    delete process.env.HARNESS_ROOT;
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
});
