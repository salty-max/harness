// harness-sync.ts's stamps and checks, and init.ts's pieces (bun test).
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, standing, stamped, sync, unstamped, VENDORED } from "./harness-sync";
import { AGENTS, DEFAULT_FLAGS, detectCheck, fill, flagsOf, frontmatter, lackedGate, lackedRules, lackedSessionGate, parseArgs, renderSection, renderToml, ruleNames, sessionGate, withAsks, withHooks, withIgnore, withSection } from "./init";
import { parseConfig } from "./config";
import { agentProblems, hookProblems, problems, staleSection } from "./doctor";
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
    expect(VENDORED).toContain("trees.ts");
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
    expect(fill(t, "kit", "R.md", { lock: true, worktrees: false, opener: false })).toBe("a\nL on\nz kit/x R.md\n");
    expect(fill(t, "kit", "R.md", { lock: false, worktrees: true, opener: false })).toBe("a\nL off\nW on\nz kit/x R.md\n");
    expect(() => fill("{{#nope}}\nx\n{{/nope}}\n", "k", "r")).toThrow("no switch");
  });

  test("the defaults are the family's: the lock, no worktree rules", () => {
    expect(DEFAULT_FLAGS).toEqual({ lock: true, worktrees: false, opener: false });
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

  test('decisions = "opener": no plan mode in a child, the plan comes to the opener; the default keeps plan mode', () => {
    const opener = renderSection(conf('[session]\ndecisions = "opener"\n'));
    expect(opener).toContain("- **A plan comes to the opener, not to a child in plan mode.**");
    expect(opener).toContain("(`--plan` is refused)");
    expect(opener).toContain("default model (`set_session_model`) before it relays the answer quoted");
    expect(opener).toContain("Set it when the child starts and say the choice in one line.");
    expect(opener).not.toMatch(/once its plan is approved/);
    const child = renderSection(conf(""));
    expect(child).toContain("(a plan child once its plan is approved)");
    expect(child).not.toMatch(/A plan comes to the opener|--plan. is refused/);
  });

  test("no line of any rendering passes 88 columns but a lone code span", () => {
    const every = [true, false].flatMap((lock) => [true, false].flatMap((worktrees) => [true, false].map((opener) => ({ lock, worktrees, opener }))));
    expect(every).toHaveLength(8);
    for (const flags of every) {
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
      expect(found).toContain("harness.toml: unknown key worktree in [session] (rules, models, worktrees, decisions)");
    } finally {
      restore();
    }
  });
});

describe("where the stamps stand against the harness's tip", () => {
  const line = (older: string[]) => (a: string, b: string) => older.includes(`${a}>${b}`);
  test("behind is an ancestor, ahead is a descendant (commits not pushed), the rest sits on no line of it", () => {
    const is = line(["aaaaaaaaa>bbbbbbbbb", "bbbbbbbbb>ccccccccc"]);
    expect(standing(["bbbbbbbbb"], "bbbbbbbbb", "p", is)).toEqual([]);
    expect(standing(["bbbbbbbbb"], "bbbbbbbbb123", "p", is)).toEqual([]);
    expect(standing(["aaaaaaaaa", "bbbbbbbbb"], "bbbbbbbbb", "/x/p", is)).toEqual(["behind the harness's bbbbbbbbb: aaaaaaaaa (harness-sync.ts /x/p when you want the newer)"]);
    const ahead = standing(["ccccccccc"], "bbbbbbbbb", "p", is);
    expect(ahead).toHaveLength(1);
    expect(ahead[0]).toStartWith("ahead of the harness's bbbbbbbbb: ccccccccc come from commits it hasn't pushed");
    expect(ahead[0]).toContain("push the harness first");
    expect(ahead[0]).not.toContain("behind");
    expect(standing(["ddddddddd"], "bbbbbbbbb", "p", is)).toEqual(["ddddddddd sits on no line of the harness's bbbbbbbbb"]);
    expect(standing(["ddddddddd", "eeeeeeeee"], "bbbbbbbbb", "p", is)).toEqual(["ddddddddd, eeeeeeeee sit on no line of the harness's bbbbbbbbb"]);
    // (both at once: each said, only the stale ones named)
    expect(standing(["aaaaaaaaa", "bbbbbbbbb", "ccccccccc"], "bbbbbbbbb", "p", is)).toHaveLength(2);
  });
});

describe("check() says where the stamps stand, with git's own is-ancestor", () => {
  const harness = import.meta.dir;
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: harness, stdout: "pipe", stderr: "ignore" });
  // (a shallow clone, as CI makes one, has no older commit to stamp a copy with)
  const shallow = git("rev-parse", "--is-shallow-repository").stdout.toString().trim() !== "false";
  test.skipIf(shallow)("a copy stamped with the harness's first commit is behind, one stamped with a commit it doesn't have is a problem said once", () => {
    const root = git("rev-list", "--max-parents=0", "HEAD").stdout.toString().trim().split("\n")[0]!.slice(0, 9);
    const dir = temp();
    writeFileSync(join(dir, "harness.toml"), "");
    expect(sync(dir, true)).not.toHaveProperty("error");
    const old = (sha: string) => {
      for (const f of VENDORED) {
        const path = join(dir, "harness", f);
        writeFileSync(path, stamped(f, unstamped(f, readFileSync(path, "utf8"))!.text, sha));
      }
    };
    old(root);
    const { notes } = check(dir);
    expect(notes.filter((n) => n.startsWith("behind the harness's"))).toHaveLength(1);
    expect(notes.join("\n")).toContain(`: ${root} (harness-sync.ts`);
    old("deadbeef0");
    const odd = check(dir);
    expect(odd.problems.some((p) => p.includes("stamp deadbeef0 is no commit of the harness"))).toBe(true);
    expect(odd.notes.join("\n")).not.toContain("deadbeef0");
  });
});

describe("the helpers' copies: a template's new rule and its gate are named where a copy lacks them, a project's own edits never are", () => {
  const tpl = (agent: string) => readFileSync(join(import.meta.dir, "templates", "agents", `${agent}.md`), "utf8");
  // (what init writes, and what a copy made before the rule looked like: the template less the marked block, less the hook)
  const written = (agent: string) => fill(tpl(agent), "harness", "CLAUDE.md");
  const noMark = (agent: string) => written(agent).replace(/<!-- harness:rule bash -->\n[\s\S]*?(\n\n|(?![\s\S]))/, "");
  const noHook = (agent: string) => written(agent).replace(/^hooks:\n(  .*\n|\n(?=  ))*/m, "");
  // (the project holding the tools: a hook that names a nokill.ts the project lacks is a problem of its own)
  const withCopy = (files: Record<string, string>, tools = true) => {
    const dir = temp();
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    for (const [agent, text] of Object.entries(files)) writeFileSync(join(dir, ".claude", "agents", `${agent}.md`), text);
    if (tools) {
      mkdirSync(join(dir, "harness"), { recursive: true });
      writeFileSync(join(dir, "harness", "nokill.ts"), "");
    }
    return dir;
  };
  const command = (agent: string): string => (Bun.YAML.parse(frontmatter(written(agent))!) as any).hooks.PreToolUse[0].hooks[0].command;

  test("both templates say what Bash is for and what it never does, behind a mark", () => {
    for (const agent of AGENTS) {
      expect(ruleNames(tpl(agent))).toEqual(["bash"]);
      const text = tpl(agent).replace(/\s+/g, " ");
      for (const w of ["Bash is for reading", "Never kill or signal a process", "start, stop or restart a server or a watcher", "never touch another worktree", "never install, push or change git state"]) expect(text).toContain(w);
    }
    // (the older copies these tests use really lack the block and the hook, or what follows proves nothing)
    for (const agent of AGENTS) {
      expect(noMark(agent)).not.toContain("Never kill");
      expect(noHook(agent)).not.toContain("nokill.ts");
      expect(noHook(agent)).toContain("Never kill");
      expect(noHook(agent)).toContain("---\n\n");
    }
  });

  test("both templates gate the helper's Bash: a PreToolUse hook that runs the project's nokill.ts and refuses when it can't run", () => {
    for (const agent of AGENTS) {
      const front = Bun.YAML.parse(frontmatter(tpl(agent))!) as any;
      expect(front.hooks.PreToolUse).toHaveLength(1);
      expect(front.hooks.PreToolUse[0].matcher).toBe("Bash");
      expect(front.hooks.PreToolUse[0].hooks).toHaveLength(1);
      expect(front.hooks.PreToolUse[0].hooks[0].type).toBe("command");
      const cmd: string = front.hooks.PreToolUse[0].hooks[0].command;
      // (CLAUDE_PROJECT_DIR is the worktree in a `claude --bg --worktree` child, so a worktree runs its own copy; the PATH is the one a desktop app may lack)
      expect(cmd).toContain('bun "$CLAUDE_PROJECT_DIR/{{TOOLS}}/nokill.ts"');
      expect(cmd).toMatch(/PATH="\$PATH:[^"]*\.bun\/bin[^"]*\.volta\/bin/);
      expect(cmd).toEndWith("|| exit 2");
      expect(command(agent)).toContain('bun "$CLAUDE_PROJECT_DIR/harness/nokill.ts"');
    }
  });

  test("a copy as init writes it lacks nothing", () => {
    for (const agent of AGENTS) {
      expect(lackedRules(agent, written(agent))).toEqual([]);
      expect(lackedGate(written(agent))).toBeUndefined();
    }
    expect(agentProblems(withCopy({ reviewer: written("reviewer"), architect: written("architect") }))).toEqual([]);
  });

  test("an older copy is named, with the mark to look for and the template to take it from", () => {
    const found = agentProblems(withCopy({ reviewer: noMark("reviewer"), architect: written("architect") }));
    expect(found).toHaveLength(1);
    expect(found[0]).toStartWith(".claude/agents/reviewer.md: lacks the template's rule marked <!-- harness:rule bash -->");
    expect(found[0]).toContain("templates/agents/reviewer.md");
    expect(agentProblems(withCopy({ reviewer: noMark("reviewer"), architect: noMark("architect") }))).toHaveLength(2);
  });

  test("a copy with the rule but no hook is named for the hook, with where to take it from", () => {
    const found = agentProblems(withCopy({ reviewer: noHook("reviewer"), architect: written("architect") }));
    expect(found).toHaveLength(1);
    expect(found[0]).toStartWith(".claude/agents/reviewer.md: its frontmatter has no PreToolUse hook on Bash that runs nokill.ts");
    expect(found[0]).toContain("templates/agents/reviewer.md");
    // (a copy with neither is named for both)
    const both = agentProblems(withCopy({ reviewer: noHook("reviewer").replace(/<!-- harness:rule bash -->\n[\s\S]*?(\n\n|(?![\s\S]))/, "") }));
    expect(both).toHaveLength(2);
  });

  test("a hook of another kind, on another tool or another event, or only commented out, is no gate", () => {
    const of = (hooks: string) => `---\nname: reviewer\n${hooks}---\n\n<!-- harness:rule bash -->\nBash reads.\n`;
    const gate = (event: string, matcher: string, cmd: string) => of(`hooks:\n  ${event}:\n    - matcher: ${matcher}\n      hooks:\n        - type: command\n          command: ${cmd}\n`);
    const ok = "bun x/nokill.ts || exit 2";
    expect(lackedGate(gate("PreToolUse", "Bash", ok))).toBeUndefined();
    expect(lackedGate(gate("PreToolUse", "Bash|Edit", ok))).toBeUndefined();
    // (Claude Code matches a hook with no matcher, "", "*" or a pattern like .* on every tool, Bash too)
    for (const m of ['"*"', '""', ".*", "Bash.*"]) expect(lackedGate(gate("PreToolUse", m, ok))).toBeUndefined();
    expect(lackedGate(of(`hooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: ${ok}\n`))).toBeUndefined();
    expect(lackedGate(gate("PreToolUse", "Edit", ok))).toContain("no PreToolUse hook on Bash");
    expect(lackedGate(gate("PreToolUse", "Bas", ok))).toContain("no PreToolUse hook on Bash");
    expect(lackedGate(gate("PreToolUse", "Edit|Write", ok))).toContain("no PreToolUse hook on Bash");
    expect(lackedGate(gate("PostToolUse", "Bash", ok))).toContain("no PreToolUse hook on Bash");
    expect(lackedGate(gate("PreToolUse", "Bash", "bun x/other.ts || exit 2"))).toContain("no PreToolUse hook on Bash");
    expect(lackedGate(of("# hooks: bun x/nokill.ts\n"))).toContain("no PreToolUse hook on Bash");
    expect(lackedGate(of(""))).toContain("no PreToolUse hook on Bash");
    expect(lackedGate("no frontmatter at all, nokill.ts")).toContain("no PreToolUse hook on Bash");
    expect(lackedGate("---\nname: [unclosed\n---\n")).toContain("can't be read as YAML");
  });

  test("a hook that isn't fail-closed is named: without `|| exit 2` a missing bun or file exits 127 or 1 and the call runs", () => {
    const of = (cmd: string) => `---\nname: reviewer\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ${cmd}\n---\n\n<!-- harness:rule bash -->\nBash reads.\n`;
    for (const cmd of ["bun x/nokill.ts", "echo nokill.ts; true", "bun x/nokill.ts || true", "bun x/nokill.ts || exit 1", "bun x/nokill.ts && exit 2"]) expect(lackedGate(of(cmd))).toContain("isn't fail-closed");
    for (const cmd of ["bun x/nokill.ts || exit 2", "bun x/nokill.ts ||exit 2", "bun x/nokill.ts || exit 2 # refuse"]) expect(lackedGate(of(cmd))).toBeUndefined();
    const found = agentProblems(withCopy({ reviewer: of("bun harness/nokill.ts") }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("isn't fail-closed");
    expect(found[0]).toContain("templates/agents/reviewer.md");
  });

  test("a hook that names a nokill.ts the project doesn't have is named: it would refuse every Bash call of the helper", () => {
    const dir = withCopy({ reviewer: written("reviewer"), architect: written("architect") }, false);
    const found = agentProblems(dir);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("its hook runs harness/nokill.ts, which this project doesn't have");
    expect(found[0]).toContain("every Bash call of the helper is refused");
    writeFileSync(join(dir, "nokill.ts"), "");
    expect(agentProblems(dir)).toHaveLength(2);
    mkdirSync(join(dir, "harness"));
    writeFileSync(join(dir, "harness", "nokill.ts"), "");
    expect(agentProblems(dir)).toEqual([]);
    // (a copy that points at the tools dir another project uses is as broken as one with no file)
    const other = fill(tpl("reviewer"), "addon-kit", "CLAUDE.md");
    expect(agentProblems(withCopy({ reviewer: other }))[0]).toContain("its hook runs addon-kit/nokill.ts");
  });

  test("a project's own copy, reworded and cut down, passes while the mark and the hook stand, and is named once either goes", () => {
    const hook = `hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: "bun \\"$CLAUDE_PROJECT_DIR\\"/harness/nokill.ts || exit 2"\n`;
    const own = `---\nname: reviewer\n${hook}---\n\nMy own reviewer.\n\n<!--harness:rule   bash-->\nBash reads. It never kills anything.\n`;
    expect(agentProblems(withCopy({ reviewer: own }))).toEqual([]);
    expect(agentProblems(withCopy({ reviewer: own.replace(/<!--.*-->\n/, "") }))).toHaveLength(1);
    expect(agentProblems(withCopy({ reviewer: own.replace(hook, "") }))).toHaveLength(1);
  });

  test("no copy is none of the doctor's business, and only the project's own .claude/agents/ is read", () => {
    expect(agentProblems(temp())).toEqual([]);
    const dir = withCopy({ architect: written("architect") });
    mkdirSync(join(dir, "node_modules", "x", ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", ".claude", "agents", "reviewer.md"), noMark("reviewer"));
    expect(agentProblems(dir)).toEqual([]);
  });

  test("doctor's whole list carries it", () => {
    const dir = withCopy({ reviewer: noMark("reviewer") });
    writeFileSync(join(dir, "harness.toml"), "");
    const restore = scopedRoot(dir);
    try {
      expect(problems(dir).filter((l) => l.startsWith(".claude/agents/"))).toHaveLength(1);
    } finally {
      restore();
    }
    const ungated = withCopy({ reviewer: noHook("reviewer") });
    writeFileSync(join(ungated, "harness.toml"), "");
    const again = scopedRoot(ungated);
    try {
      expect(problems(ungated).filter((l) => l.includes("no PreToolUse hook on Bash"))).toHaveLength(1);
    } finally {
      again();
    }
  });

  describe("the command init writes into the frontmatter, run the way Claude Code runs a hook (sh -c, the hook's JSON on stdin)", () => {
    const hook = (agent: string, project: string, env: Record<string, string> = {}, stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo ok" } })) => {
      const p = Bun.spawnSync(["sh", "-c", command(agent)], { cwd: project, stdin: Buffer.from(stdin), env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "", ...env, CLAUDE_PROJECT_DIR: project }, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const call = (cmd: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } });
    // (a project with the tools where init puts them: the harness's own files, unstamped, which is all they need to run)
    const project = () => {
      const dir = temp();
      mkdirSync(join(dir, "harness"), { recursive: true });
      for (const f of ["nokill.ts", "shell.ts"]) writeFileSync(join(dir, "harness", f), readFileSync(join(import.meta.dir, f), "utf8"));
      return dir;
    };

    test("a read passes, a kill is refused with exit 2 and the reason, in the project CLAUDE_PROJECT_DIR names", () => {
      const dir = project();
      for (const agent of AGENTS) {
        expect(hook(agent, dir)).toEqual({ code: 0, out: "", err: "" });
        const r = hook(agent, dir, {}, call("pkill -f scripts/serve.mjs"));
        expect(r.code).toBe(2);
        expect(r.err).toContain("Refused (the no-kill gate): pkill");
      }
      // (a worktree runs its own copy: another project dir with the tools in it answers for itself)
      expect(hook("reviewer", project(), {}, call("lsof -ti:3000 | xargs kill")).code).toBe(2);
    });

    test("a project without the tools is a refusal and not a call that goes through (bun's failure to run the file is exit 2 too)", () => {
      const r = hook("reviewer", temp());
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(r.err).toContain("nokill.ts");
    });

    test("bun in the user's own folders is found when the hook's PATH is only the system's", () => {
      const dir = project();
      mkdirSync(join(dir, ".bun", "bin"), { recursive: true });
      symlinkSync(process.execPath, join(dir, ".bun", "bin", "bun"));
      expect(hook("reviewer", dir, { PATH: "/usr/bin:/bin", HOME: dir })).toEqual({ code: 0, out: "", err: "" });
      expect(hook("reviewer", dir, { PATH: "/usr/bin:/bin", HOME: dir }, call("kill 1")).code).toBe(2);
    });
  });
});

describe("a worktree of a one-repository project: its own files, never the main checkout's", () => {
  const GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd, env: GIT, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };
  // (no project named by the environment: the config is found from the folder asked about)
  const bare = { ...process.env, HARNESS_ROOT: "", WOW_ADDONS_ROOT: "" } as Record<string, string>;
  const unset = () => {
    const saved = { h: process.env.HARNESS_ROOT, w: process.env.WOW_ADDONS_ROOT };
    delete process.env.HARNESS_ROOT;
    delete process.env.WOW_ADDONS_ROOT;
    return () => {
      if (saved.h !== undefined) process.env.HARNESS_ROOT = saved.h;
      if (saved.w !== undefined) process.env.WOW_ADDONS_ROOT = saved.w;
    };
  };
  function oneRepo() {
    const main = temp();
    g(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "harness.toml"), '[tools]\ndir = "harness"\n[hooks]\nlock = false\n');
    writeFileSync(join(main, "CLAUDE.md"), "# P\n");
    g(main, "add", "-A");
    g(main, "commit", "-q", "-m", "chore: start");
    const wt = join(temp(), "kid");
    g(main, "worktree", "add", "-q", "-b", "side", wt);
    return { main, wt };
  }

  test("sync writes and check reads the worktree's own tools folder", () => {
    const { main, wt } = oneRepo();
    const restore = unset();
    try {
      const res = sync(wt, true);
      if (!Array.isArray(res)) throw new Error(res.error);
      expect(res.length).toBe(VENDORED.length);
      expect(existsSync(join(wt, "harness", "config.ts"))).toBe(true);
      // (the main checkout stays as it was: no folder, nothing to commit)
      expect(existsSync(join(main, "harness"))).toBe(false);
      expect(g(main, "status", "--porcelain")).toBe("");
      expect(check(wt).problems.some((p) => p.includes("missing"))).toBe(false);
      expect(check(main).problems.some((p) => p.includes("harness/config.ts") && p.includes("missing"))).toBe(true);
      // a worktree given by a folder inside it is the same tree
      mkdirSync(join(wt, "sub"));
      expect(sync(join(wt, "sub"), true)).toEqual([]);
    } finally {
      restore();
    }
  });

  test("a branch's own harness.toml renders its own section, and doctor judges the tree it is given", () => {
    const { main, wt } = oneRepo();
    const restore = unset();
    try {
      writeFileSync(join(wt, "harness.toml"), '[tools]\ndir = "harness"\n[hooks]\nlock = false\n[session]\ndecisions = "opener"\n');
      const run = (dir: string) => Bun.spawnSync(["bun", join(import.meta.dir, "init.ts"), dir, "--section-only"], { env: bare });
      expect(run(wt).exitCode).toBe(0);
      expect(readFileSync(join(wt, "CLAUDE.md"), "utf8")).toContain("Every decision is taken in the opener");
      // the main checkout's file is not the one written
      expect(readFileSync(join(main, "CLAUDE.md"), "utf8")).toBe("# P\n");
      expect(run(main).exitCode).toBe(0);
      expect(readFileSync(join(main, "CLAUDE.md"), "utf8")).toContain("Questions go through the question tool");
      expect(readFileSync(join(main, "CLAUDE.md"), "utf8")).not.toContain("Every decision is taken in the opener");
      const stale = (dir: string) => problems(dir).filter((l) => l.includes("Harness section"));
      expect(stale(wt)).toEqual([]);
      expect(stale(main)).toEqual([]);
      // the worktree's section rendered from the main's config is stale for the worktree's own
      writeFileSync(join(wt, "CLAUDE.md"), readFileSync(join(main, "CLAUDE.md"), "utf8"));
      expect(stale(wt)).toHaveLength(1);
      expect(stale(wt)[0]).toContain(`bun init.ts ${wt} --section-only`);
      expect(stale(main)).toEqual([]);
    } finally {
      restore();
    }
  });

  test("a full init honours [asks] skip: the asks it names are left out and taken out of settings.json, a typo stops it", () => {
    const { wt } = oneRepo();
    const push = ["Bash(git push *)", "Bash(git -C * push)", "Bash(git -C * push *)"];
    mkdirSync(join(wt, ".claude"), { recursive: true });
    writeFileSync(join(wt, ".claude", "settings.json"), JSON.stringify({ permissions: { ask: [...push, "Bash(my own ask)"] } }));
    writeFileSync(join(wt, "harness.toml"), `[asks]\nskip = ${JSON.stringify(push)}\n`);
    const init = () => Bun.spawnSync(["bun", join(import.meta.dir, "init.ts"), wt, "--dirty"], { env: bare, stdout: "pipe", stderr: "pipe" });
    const first = init();
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain("and take out the 3 that [asks] skip names");
    const ask = JSON.parse(readFileSync(join(wt, ".claude", "settings.json"), "utf8")).permissions.ask as string[];
    expect(ask.filter((a) => push.includes(a))).toEqual([]);
    expect(ask).toContain("Bash(my own ask)");
    expect(ask).toContain("Bash(gh pr merge *)");
    expect(init().stdout.toString()).toContain("the asks are there (3 left out by [asks] skip)");
    writeFileSync(join(wt, "harness.toml"), `[asks]\nskip = "Bash(git push *)"\n`);
    const bad = init();
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("[asks] skip is a list");
  });

  test("a second init keeps a helper's copy as it is and says which marked rule it lacks", () => {
    const { wt } = oneRepo();
    const init = () => Bun.spawnSync(["bun", join(import.meta.dir, "init.ts"), wt, "--dirty"], { env: bare, stdout: "pipe", stderr: "pipe" });
    const first = init();
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain(".claude/agents/reviewer.md");
    const file = join(wt, ".claude", "agents", "reviewer.md");
    expect(readFileSync(file, "utf8")).toContain("Never kill or signal a process");
    expect(init().stdout.toString()).toContain(".claude/agents/reviewer.md: kept\n");
    const older = readFileSync(file, "utf8").replace(/<!-- harness:rule bash -->\n[\s\S]*?\n\n/, "");
    writeFileSync(file, older);
    const again = init().stdout.toString();
    expect(again).toContain(".claude/agents/reviewer.md: kept (lacks the template's rule marked <!-- harness:rule bash -->");
    expect(again).toContain(".claude/agents/architect.md: kept\n");
    expect(readFileSync(file, "utf8")).toBe(older);
    // (a copy made before the gate: the rule is there, the hook isn't, and init says so without touching it)
    const ungated = readFileSync(join(wt, ".claude", "agents", "architect.md"), "utf8").replace(/^hooks:\n(  .*\n)+/m, "");
    writeFileSync(join(wt, ".claude", "agents", "architect.md"), ungated);
    const third = init().stdout.toString();
    expect(third).toContain(".claude/agents/architect.md: kept (its frontmatter has no PreToolUse hook on Bash that runs nokill.ts");
    expect(readFileSync(join(wt, ".claude", "agents", "architect.md"), "utf8")).toBe(ungated);
    // (and the gate's own files came with the tools)
    expect(existsSync(join(wt, "harness", "nokill.ts"))).toBe(true);
    expect(existsSync(join(wt, "harness", "shell.ts"))).toBe(true);
  });

  test("a full init in a worktree adopts it there and leaves the hooks to the main checkout", () => {
    const { main, wt } = oneRepo();
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "init.ts"), wt, "--dirty"], { env: bare, stdout: "pipe", stderr: "pipe" });
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
    const out = p.stdout.toString();
    expect(out).toContain("hooks: not installed from a linked worktree");
    expect(out).toContain(`bun harness/hooks.ts install --all`);
    expect(existsSync(join(wt, "harness", "config.ts"))).toBe(true);
    expect(existsSync(join(wt, ".claude", "settings.json"))).toBe(true);
    expect(readFileSync(join(wt, "CLAUDE.md"), "utf8")).toContain("<!-- harness:start -->");
    // nothing of it in the main checkout, and no hooks path set for the repository
    expect(g(main, "status", "--porcelain")).toBe("");
    expect(Bun.spawnSync(["git", "config", "--get", "core.hooksPath"], { cwd: main, env: GIT }).exitCode).not.toBe(0);
  });
});

describe("the session's no-kill gate: a PreToolUse hook in the project's .claude/settings.json", () => {
  const gate = sessionGate("harness");
  const command = gate[0]!.hooks[0]!.command;

  test("the template runs the project's own nokill.ts in the session's mode, and its {{TOOLS}} is filled", () => {
    expect(gate).toHaveLength(1);
    expect(gate[0]!.matcher).toBe("Bash");
    expect(command).toContain('bun "$CLAUDE_PROJECT_DIR/harness/nokill.ts" --session');
    expect(command).toMatch(/PATH="\$PATH:[^"]*\.bun\/bin[^"]*\.volta\/bin/);
    expect(command).not.toContain("{{TOOLS}}");
    expect(sessionGate("addon-kit")[0]!.hooks[0]!.command).toContain("$CLAUDE_PROJECT_DIR/addon-kit/nokill.ts");
  });

  test("merged into a file without it, every other key and hook kept; a file that has it comes back as it was", () => {
    const other = { matcher: "Edit", hooks: [{ type: "command", command: "echo edit" }] };
    const before = { permissions: { ask: ["Bash(git push *)"] }, hooks: { PreToolUse: [other], Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] }, model: "opus" };
    const after = withHooks(before, gate);
    expect(after.permissions).toEqual(before.permissions);
    expect(after.model).toBe("opus");
    expect(after.hooks.Stop).toEqual(before.hooks.Stop);
    expect(after.hooks.PreToolUse).toEqual([other, ...gate]);
    expect(withHooks(after, gate)).toBe(after);
    expect(withHooks(undefined, gate).hooks.PreToolUse).toEqual(gate);
  });

  test("an older or doubled gate is replaced by the template's, wherever it sat; the hooks beside it in its group stay", () => {
    const old = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }, { type: "command", command: 'bun "$CLAUDE_PROJECT_DIR/harness/nokill.ts" --session || exit 2' }] };
    const after = withHooks({ hooks: { PreToolUse: [old, { matcher: "Bash", hooks: [{ type: "command", command: "bun x/nokill.ts --session" }] }] } }, gate);
    expect(after.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }, ...gate]);
  });

  test("hooks that aren't Claude Code's shape are never overwritten: the merge refuses and doctor says why", () => {
    for (const odd of [{ hooks: [] }, { hooks: "x" }, { hooks: { PreToolUse: { matcher: "Bash" } } }]) {
      expect(() => withHooks(odd, gate)).toThrow("init writes nothing into it");
      expect(lackedSessionGate(odd, "harness")).toContain("init writes nothing into it");
    }
  });

  test("doctor names it missing, not the template's, or running a nokill.ts the project lacks, and nothing once init wrote it", () => {
    const dir = temp();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const put = (v: unknown) => writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(v));
    put({ permissions: { ask: [] } });
    expect(hookProblems(dir, "harness")).toEqual([".claude/settings.json: no session no-kill gate (a PreToolUse hook running nokill.ts --session): bun init.ts writes it"]);
    put({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "bun harness/nokill.ts --session" }] }] } });
    expect(hookProblems(dir, "harness")[0]).toContain("isn't the template's");
    put(withHooks({}, gate));
    expect(hookProblems(dir, "harness")[0]).toContain("runs harness/nokill.ts, which this project doesn't have");
    mkdirSync(join(dir, "harness"));
    writeFileSync(join(dir, "harness", "nokill.ts"), "");
    expect(hookProblems(dir, "harness")).toEqual([]);
    // (a file that isn't JSON is the asks' problem, said once there)
    writeFileSync(join(dir, ".claude", "settings.json"), "{");
    expect(hookProblems(dir, "harness")).toEqual([]);
    expect(lackedSessionGate(undefined, "harness")).toContain("no session no-kill gate");
  });

  // (the command as Claude Code runs it: sh -c, the hook's JSON on stdin, CLAUDE_PROJECT_DIR the project)
  const project = (nokill: string | undefined) => {
    const dir = temp();
    if (nokill !== undefined) {
      mkdirSync(join(dir, "harness"), { recursive: true });
      writeFileSync(join(dir, "harness", "nokill.ts"), nokill);
      for (const f of ["shell.ts"]) writeFileSync(join(dir, "harness", f), readFileSync(join(import.meta.dir, f), "utf8"));
    }
    return dir;
  };
  const hook = (dir: string, cmd: string) => {
    const p = Bun.spawnSync(["sh", "-c", command], { stdin: Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: cmd }, cwd: dir })), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("run as Claude Code runs it: the gate's own verdicts, a kill refused and the rest silent", () => {
    const dir = project(readFileSync(join(import.meta.dir, "nokill.ts"), "utf8"));
    expect(hook(dir, "git status")).toEqual({ code: 0, out: "", err: "" });
    expect(hook(dir, "sleep 9 & kill $!")).toEqual({ code: 0, out: "", err: "" });
    const r = hook(dir, "pkill -f vite");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Refused (the no-kill gate): pkill. A session stops only");
  });

  test("a gate that can't run refuses a call that mentions a kill, and lets the rest through with a warning for the user", () => {
    for (const dir of [project(undefined), project('throw new Error("broken")')]) {
      const k = hook(dir, "kill $(lsof -ti:3000)");
      expect(k.code).toBe(2);
      expect(k.err).toContain("Refused: the no-kill gate failed (exit 1), and this call mentions a kill");
      const r = hook(dir, "git status");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ systemMessage: "The no-kill gate failed (exit 1), so this Bash call ran ungated: check bun and harness/nokill.ts." });
    }
  });

  test("init writes it into the settings beside the asks, and a second init changes nothing", () => {
    const dir = temp();
    Bun.spawnSync(["git", "init", "-q", dir]);
    const bare = { ...process.env, HARNESS_ROOT: undefined, WOW_ADDONS_ROOT: undefined } as Record<string, string>;
    const run = () => Bun.spawnSync(["bun", join(import.meta.dir, "init.ts"), dir, "--dirty", "--check", "true"], { env: bare, stdout: "pipe", stderr: "pipe" });
    const first = run();
    expect(first.exitCode).toBe(0);
    expect(first.stdout.toString()).toContain("add the session no-kill gate (a PreToolUse hook on Bash running harness/nokill.ts --session)");
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toEqual(gate);
    expect(settings.permissions.ask.length).toBeGreaterThan(10);
    const second = run();
    expect(second.stdout.toString()).toContain(".claude/settings.json: the session no-kill gate is there");
    expect(hookProblems(dir, "harness")).toEqual([]);
  });
});
