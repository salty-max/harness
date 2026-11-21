// session.ts: its parts, and the whole run with `claude` stubbed on the PATH (no real session).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scopedRoot, useBoardGuard, useFixtureRoot, writeFamilyConfig } from "./testing";
import { problems } from "./doctor";
import { type Live, cleanEnv, command, idOf, lookIn, notes, openerOf, parse, pickOpener, planRefusal, prompt, registry, repoStates, verdict, worktreeName } from "./session";

useFixtureRoot();
useBoardGuard();


describe("session: its parts", () => {
  test("the title, the repositories, the kind and the task after --", () => {
    expect(parse(["Eight riddles", "--repos", "yonder, wow-data", "--kind", "code", "--", "Write", "eight riddles"])).toEqual({
      title: "Eight riddles",
      repos: ["yonder", "wow-data"],
      kind: "code",
      plan: false,
      dryRun: false,
      desktop: false,
      task: "Write eight riddles",
    });
    expect(parse(["T", "--repos", "a", "--kind", "prose", "--plan", "--dry-run", "--", "x"])).toMatchObject({ kind: "prose", plan: true, dryRun: true, desktop: false });
    expect(parse(["T", "--repos", "a", "--kind", "code", "--desktop", "--", "x"])).toMatchObject({ desktop: true, dryRun: false });
    expect(parse(["--repos", "a", "--kind", "code", "--", "x"])).toBe("the card's title first");
    expect(parse(["T", "--kind", "code", "--", "x"])).toBe("--repos names every repository the task writes");
    expect(parse(["T", "--repos", "a", "--kind", "poetry", "--", "x"])).toBe("--kind is code or prose");
    expect(parse(["T", "--repos", "a", "--kind", "code"])).toBe("the task after --, in the user's words");
    expect(parse(["T", "--repos", "a", "--kind", "code", "--", "  "])).toBe("the task after --, in the user's words");
    expect(parse(["T", "--repos", "a", "--model", "haiku", "--", "x"])).toBe("unknown option --model");
    expect(parse(["T", "U", "--repos", "a", "--kind", "code", "--", "x"])).toBe("one title (a second: U); the task goes after --");
    expect(parse(["T", "--repos"])).toBe("--repos takes a value");
    // (a space for a comma would put a broken board.ts add in the prompt)
    expect(parse(["T", "--repos", "yonder wow-data", "--kind", "code", "--", "x"])).toBe('--repos takes folder names, a comma between them (not "yonder wow-data")');
    expect(parse(["T", "--repos", "yonder,$(x)", "--kind", "code", "--", "x"])).toBe('--repos takes folder names, a comma between them (not "$(x)")');
  });

  test("the model by kind, plan mode on demand", () => {
    expect(command({ title: "T", kind: "code", plan: false })).toEqual(["claude", "--bg", "-n", "T", "--model", "opusplan"]);
    expect(command({ title: "T", kind: "prose", plan: false })).toEqual(["claude", "--bg", "-n", "T", "--model", "opus"]);
    expect(command({ title: "T", kind: "code", plan: true })).toEqual(["claude", "--bg", "-n", "T", "--model", "opusplan", "--permission-mode", "plan"]);
  });

  test("the prompt: the maps, the card, the model, the task, in that order", () => {
    const p = prompt({ title: 'The "Duskwood" riddles', repos: ["yonder", "wow-data"], kind: "code", plan: false, task: "Five riddles." }, { name: "The kit audited" });
    const at = (s: string) => p.indexOf(s);
    expect(p.startsWith('A new task from the user. The session "The kit audited" opened this one for it')).toBe(true);
    expect(p).toContain("bun addon-kit/board.ts add yonder \"The \\\"Duskwood\\\" riddles\" --repos yonder,wow-data --status running");
    expect(p).toContain("(yonder, wow-data)");
    expect(p).toContain("not the opener's");
    expect(p).toContain("opusplan: Sonnet, and Opus in plan mode");
    // (without --plan, nothing waits on the user: the architect is its Opus)
    expect(p).toContain("without stopping for the user's approval");
    expect(p).toContain("architect helper");
    expect(at("CLAUDE.md")).toBeLessThan(at("board.ts add"));
    expect(at("board.ts add")).toBeLessThan(at("opusplan"));
    expect(at("opusplan")).toBeLessThan(at("Five riddles."));
    expect(p.endsWith("end with a `result:` line.")).toBe(true);
    expect(prompt({ title: "T", repos: ["a"], kind: "prose", plan: false, task: "x" })).toContain("Another session opened this one");
    expect(prompt({ title: "T", repos: ["a"], kind: "prose", plan: false, task: "x" })).toContain("You run on Opus (");
    expect(prompt({ title: "T", repos: ["a"], kind: "code", plan: true, task: "x" })).toContain("start in plan mode");
  });

  test("the running session's variables dropped, the working directory's pin and the config folder kept", () => {
    const env = cleanEnv({
      PATH: "/bin",
      HOME: "/h",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_JOB_DIR: "/j",
      CLAUDE_PID: "1",
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
      CLAUDE_CONFIG_DIR: "/c",
      UNSET: undefined,
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1", CLAUDE_CONFIG_DIR: "/c" });
  });

  test("the opener: its display name, else its open card, never a card it finished", () => {
    const list = [
      { session: "s1", status: "done" as const, title: "Store pages", updated: "2026-10-25T19:30:00+01:00" },
      { session: "s1", status: "running" as const, title: "The kit audited", updated: "2026-10-25T10:00:00+01:00" },
      { session: "s2", status: "running" as const, title: "Another's", updated: "2026-10-25T19:40:00+01:00" },
    ];
    const agents = [{ sessionId: "s2", name: "Other" }, { sessionId: "s1", name: "kit-addon-audit" }];
    expect(openerOf("s1", agents, list)).toBe("kit-addon-audit");
    expect(openerOf("s1", undefined, list)).toBe("The kit audited");
    expect(openerOf("s1", [{ sessionId: "s1", name: "  " }, null, "x"], list)).toBe("The kit audited");
    expect(openerOf("s1", { not: "a list" }, list.slice(0, 1))).toBeUndefined();
    // (a card waiting on the user is still its session's: the user answers there, and may ask a new task)
    expect(openerOf("s1", undefined, [...list, { session: "s1", status: "waiting-test" as const, title: "Waiting", updated: "2026-10-25T11:00:00+01:00" }])).toBe("Waiting");
  });

  test("the registry: live rows read, dead pids and junk skipped, a missing folder nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    try {
      writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "e5a0fd61-0b4d", kind: "bg", jobId: "e5a0fd61", name: "kit-addon-audit", status: "idle", messagingSocketPath: "/tmp/cc-socks/1.sock" }));
      writeFileSync(join(dir, "2.json"), JSON.stringify({ pid: process.pid, sessionId: "971e2d60-df57" }));
      writeFileSync(join(dir, "3.json"), JSON.stringify({ pid: 2147483000, sessionId: "dead" }));
      writeFileSync(join(dir, "4.json"), "{ not json");
      writeFileSync(join(dir, "5.json"), JSON.stringify({ pid: "x" }));
      writeFileSync(join(dir, "notes.txt"), "x");
      const rows = registry(dir);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.sessionId === "e5a0fd61-0b4d")).toEqual({ pid: process.pid, sessionId: "e5a0fd61-0b4d", job: "e5a0fd61", name: "kit-addon-audit", status: "idle", socket: "/tmp/cc-socks/1.sock" });
    writeFileSync(join(dir, "7.json"), JSON.stringify({ pid: process.pid, sessionId: "971e2d60-0000", entrypoint: "claude-desktop", hostSessionId: "local_8caf759e-16c9-4579-80be-0b90ed02c5f6" }));
    expect(registry(dir).find((r) => r.sessionId === "971e2d60-0000")?.host).toBe("local_8caf759e-16c9-4579-80be-0b90ed02c5f6");
    writeFileSync(join(dir, "6.json"), JSON.stringify({ pid: process.pid, sessionId: "83-1e0000", name: "83-1e", nameSource: "derived" }));
    expect(registry(dir).find((r) => r.sessionId === "83-1e0000")?.nameSource).toBe("derived");
      // (no jobId: the short id is the session id's first 8)
      expect(rows.find((r) => r.sessionId === "971e2d60-df57")?.job).toBe("971e2d60");
      expect(registry(join(dir, "missing"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the prompt: the report to the opener, before the background paragraph", () => {
    const a = { title: "T", repos: ["a"], kind: "code" as const, plan: false, task: "x" };
    const both = prompt(a, { name: "kit-addon-audit", socket: "/tmp/cc-socks/56581.sock" });
    expect(both).toContain('Report to the session that opened you with SendMessage, to "uds:/tmp/cc-socks/56581.sock" (else to its name, "kit-addon-audit"): a few lines each time your card stops running');
    expect(both).toContain("never close it yourself, and after that last report write nothing more.");
    expect(both.indexOf("Report to the session")).toBeLessThan(both.indexOf("You run in the background"));
    expect(both).toContain("quotes their words and says what they cover");
    expect(both).toContain("never covers a deploy or a release");
    expect(both).toContain("You do not push yourself");
    expect(both.indexOf("The task:")).toBeLessThan(both.indexOf("Report to the session"));
    expect(prompt(a, { name: "kit-addon-audit" })).toContain('SendMessage, to "kit-addon-audit": a few lines');
    expect(prompt(a, { socket: "/tmp/s.sock" })).toContain('SendMessage, to "uds:/tmp/s.sock": a few lines');
    expect(prompt(a, { socket: "/tmp/s.sock" })).toContain("Another session opened this one");
    expect(prompt(a)).not.toContain("Report to the session");
    expect(prompt(a, {})).not.toContain("Report to the session");
  });

  test("the prompt names the project's own model, not the family's", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-sonnet-"));
    writeFileSync(join(dir, "harness.toml"), '[project]\nname = "p"\n[session]\nmodels = { code = "sonnet", prose = "sonnet" }\n');
    const restore = scopedRoot(dir);
    try {
      const a = { title: "T", repos: ["p"], kind: "prose" as const, plan: false, task: "x" };
      const p = prompt(a);
      expect(p).toContain("You run on sonnet. Settle your own plan");
      expect(p).not.toContain("opusplan");
      expect(p).not.toContain("You run on Opus");
      expect(prompt({ ...a, plan: true })).toContain("You run on sonnet and start in plan mode: plan first");
      expect(prompt({ ...a, plan: true }, undefined, true)).toContain("your opener then moves you to Sonnet for the build");
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the prompt for a desktop child: Sonnet or Opus lines, no background paragraph", () => {
    const a = { title: "T", repos: ["a"], kind: "code" as const, plan: false, task: "x" };
    const code = prompt(a, { socket: "/tmp/s.sock" }, true);
    expect(code).toContain("You run on Sonnet. Settle your own plan without stopping for the user's approval of it");
    expect(code).toContain("architect helper");
    expect(code).not.toContain("opusplan");
    expect(code.endsWith("\n\nNarrate briefly, move your card at each stop, and end with a `result:` line.")).toBe(true);
    expect(code).not.toContain("in the background");
    expect(code).toContain('SendMessage, to "uds:/tmp/s.sock": a few lines');
    expect(prompt({ ...a, plan: true }, undefined, true)).toContain("You start on Opus in plan mode: plan first, and write nothing (your card included) until the user approves the plan, your opener then moves you to Sonnet for the build.");
    expect(prompt({ ...a, kind: "prose" }, undefined, true)).toContain("You run on Opus (prose, voices, translations, design).");
    expect(prompt({ ...a, kind: "prose", plan: true }, undefined, true)).toContain("You run on Opus and start in plan mode");
    expect(prompt({ ...a, kind: "prose" }, undefined, true)).toContain("Narrate briefly");
    expect(prompt(a)).toContain("You run in the background: narrate briefly");
  });

  test("the short id from claude's answer", () => {
    expect(idOf("backgrounded · 1f8f36b9 · Harness: sessions opened by sessions\n  claude agents             list sessions")).toBe("1f8f36b9");
    expect(idOf("Error: unknown model")).toBeUndefined();
  });
});

describe("session: whether a child may close", () => {
  const live = (status: string): Live => ({ pid: 1, sessionId: "abc12345-x", job: "abc12345", status });
  const card = (status: string, id = "c1") => ({ id, status }) as never;
  const clean = { repo: "yonder", ahead: 0, dirty: false, running: [] as string[], open: [] as string[] };
  const ok = { live: live("idle"), cards: [card("done")], repos: [clean], force: false };

  test("idle, done, clean: closable", () => {
    expect(verdict(ok)).toEqual({ ok: true, why: [], notes: [] });
  });

  test("a busy or waiting child is never closed, --force or not", () => {
    expect(verdict({ ...ok, live: live("busy") })).toMatchObject({ ok: false, why: ["it is busy: mid-turn"] });
    expect(verdict({ ...ok, live: live("waiting"), force: true })).toMatchObject({ ok: false, why: ["it is waiting"] });
  });

  test("no card, an open card, unpushed commits, changes: refused, and --force goes past them", () => {
    expect(verdict({ ...ok, cards: [] }).why).toEqual(["it wrote no card"]);
    expect(verdict({ ...ok, cards: [card("running", "kit-x")] }).why).toEqual(["card kit-x is running"]);
    expect(verdict({ ...ok, repos: [{ ...clean, ahead: 2 }] }).why).toEqual(["yonder: 2 commits unpushed"]);
    expect(verdict({ ...ok, repos: [{ ...clean, ahead: 1, dirty: true }] }).why).toEqual(["yonder: 1 commit unpushed, uncommitted changes"]);
    // (another open card there never excuses unpushed commits, the reason names it)
    expect(verdict({ ...ok, repos: [{ ...clean, ahead: 2, open: ["kit-y"] }] }).why).toEqual(["yonder: 2 commits unpushed since it started (kit-y open there too: if they are theirs, the user's --force)"]);
    expect(verdict({ ...ok, repos: [{ ...clean, dirty: true }] }).why).toEqual(["yonder: uncommitted changes"]);
    const forced = verdict({ ...ok, cards: [], repos: [{ ...clean, dirty: true }], force: true });
    expect(forced.ok).toBe(true);
    expect(forced.why).toEqual([]);
  });

  test("notes: already closed, a running card there, no remote", () => {
    expect(verdict({ ...ok, live: undefined })).toEqual({ ok: true, why: [], notes: ["already closed"] });
    const near = verdict({ ...ok, repos: [{ ...clean, dirty: true, running: ["kit-y"], open: ["kit-y"] }] });
    expect(near.ok).toBe(true);
    expect(near.notes).toEqual(["yonder: uncommitted changes, kit-y is running there too: check they aren't this session's"]);
    // (a waiting card isn't writing now: it explains no changes)
    expect(verdict({ ...ok, repos: [{ ...clean, dirty: true, open: ["kit-y"] }] }).why).toEqual(["yonder: uncommitted changes"]);
    expect(verdict({ ...ok, repos: [{ ...clean, ahead: -1 }] })).toEqual({ ok: true, why: [], notes: ["yonder: no remote to compare"] });
  });
});

describe("session: a run, claude stubbed", () => {
  let tmp: string;
  let root: string;
  let bin: string;
  let seen: string;
  let events: string;
  let config: string;
  const row = (name: string, o: Record<string, unknown>) => writeFileSync(join(config, "sessions", name), JSON.stringify({ pid: process.pid, ...o }));

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "session-test-")));
    root = join(tmp, "family");
    for (const d of ["addon-kit", "wow-data", "board", "yonder"]) mkdirSync(join(root, d), { recursive: true });
    writeFamilyConfig(root);
    // (the opener's card: it holds yonder, and names the opener)
    writeFileSync(
      join(root, "board", "addon-kit-the-kit-audited.md"),
      '---\nrepo: addon-kit\ntitle: The kit audited\nstatus: running\nsession: s-opener\nupdated: "2026-10-25T10:00:00+01:00"\nrepos: addon-kit, yonder\nsince: "addon-kit@2026-10-25T10:00:00.000+01:00, yonder@2026-10-25T10:00:00.000+01:00"\n---\n## Try\n\nx\n',
    );
    writeFileSync(
      join(root, "board", "addon-kit-store-pages.md"),
      '---\nrepo: addon-kit\ntitle: Store pages\nstatus: done\nsession: s-opener\nupdated: "2026-10-25T19:30:00+01:00"\n---\n## Try\n\nx\n',
    );
    // (a tmp git repo for the child's work: clean, one commit, no upstream)
    const git = (...a: string[]) => expect(Bun.spawnSync(["git", "-C", join(root, "wow-data"), ...a]).exitCode).toBe(0);
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "--no-verify", "-m", "x");
    // (Claude Code's registry: the opener alone; a pid that runs, so it counts as live)
    config = join(tmp, "config");
    mkdirSync(join(config, "sessions"), { recursive: true });
    row(`${process.pid}.json`, { sessionId: "s-opener", kind: "interactive", name: "kit-addon-audit", status: "busy", messagingSocketPath: "/tmp/cc-socks/56581.sock" });
    writeFileSync(
      join(root, "board", "wow-data-the-child.md"),
      '---\nrepo: wow-data\ntitle: The child\nstatus: done\nsession: abc12345-6789-aaaa\nupdated: "2026-10-25T20:00:00+01:00"\nrepos: wow-data\n---\n## Try\n\nx\n',
    );
    writeFileSync(
      join(root, "board", "wow-data-the-slow-one.md"),
      '---\nrepo: wow-data\ntitle: The slow one\nstatus: running\nsession: def67890-1111-bbbb\nupdated: "2026-10-25T20:00:00+01:00"\nrepos: wow-data\nsince: "wow-data@2026-10-25T20:00:00.000+01:00"\n---\n## Try\n\nx\n',
    );
    bin = join(tmp, "bin");
    mkdirSync(bin);
    seen = join(tmp, "seen.json");
    events = join(tmp, "events.log");
    // A claude that says what it was given, and answers as STUB says.
    writeFileSync(
      join(bin, "claude"),
      `#!${process.execPath}
const { writeFileSync } = require("node:fs");
if (process.argv[2] === "stop") {
  writeFileSync(process.env.STUB_SEEN, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
  if (process.env.STUB === "stopfail") { console.error("error: no such job"); process.exit(4); }
  process.exit(0);
}
writeFileSync(process.env.STUB_SEEN, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));
const name = process.argv[process.argv.indexOf("-n") + 1];
if (process.env.STUB === "fail") { console.error("error: model 'opusplan' not available"); process.exit(3); }
if (process.env.STUB === "noid") { console.log("something else"); process.exit(0); }
console.log("backgrounded · abc12345 · " + name + "\\n  claude agents             list sessions\\n  claude attach abc12345    open in this terminal");
`,
    );
    chmodSync(join(bin, "claude"), 0o755);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const run = (args: string[], more: Record<string, string> = {}) => {
    rmSync(seen, { force: true });
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "session.ts"), ...args], {
      cwd: tmp,
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: process.env.HOME ?? tmp,
        HARNESS_ROOT: root,
        WOW_ADDONS_ROOT: root,
        HARNESS_EVENTS: events,
        STUB_SEEN: seen,
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "s-opener",
        CLAUDE_JOB_DIR: "/jobs/opener",
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
        ...more,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const given = () => JSON.parse(readFileSync(seen, "utf8")) as { argv: string[]; cwd: string; env: Record<string, string> };

  test("opens it from the family folder, clean of the opener's session, and says how to attach", () => {
    const r = run(["Eight riddles", "--repos", "yonder", "--kind", "code", "--", "Write eight riddles."]);
    expect(r.code).toBe(0);
    const g = given();
    expect(g.argv.slice(0, 6)).toEqual(["--bg", "-n", "Eight riddles", "--model", "opusplan", g.argv[5]]);
    expect(g.argv).toHaveLength(6);
    expect(g.argv[5]).toContain('The session "kit-addon-audit" opened this one');
    expect(g.argv[5]).toContain("Write eight riddles.");
    expect(g.argv[5]).toContain('Report to the session that opened you with SendMessage, to "uds:/tmp/cc-socks/56581.sock" (else to its name, "kit-addon-audit")');
    expect(g.cwd).toBe(root);
    expect(g.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(g.env.CLAUDECODE).toBeUndefined();
    expect(g.env.CLAUDE_JOB_DIR).toBeUndefined();
    expect(g.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
    expect(r.out).toContain('opened "Eight riddles" (opusplan) as abc12345');
    expect(r.out).toContain("claude attach abc12345");
    expect(r.out).not.toContain("waits for your approval");
    // (the opener's card holds yonder: the new session will block on it)
    expect(r.err).toContain("note: yonder is held by addon-kit-the-kit-audited (running)");
    expect(readFileSync(events, "utf8")).toContain("\tsession\tok\tyonder\tEight riddles opened (opusplan) as abc12345");
    const rec = JSON.parse(readFileSync(join(root, ".cache", "harness", "opened", "abc12345.json"), "utf8"));
    expect(rec).toMatchObject({ id: "abc12345", title: "Eight riddles", repos: ["yonder"], kind: "code", plan: false, opener: "s-opener", openerName: "kit-addon-audit" });
    expect(Number.isNaN(Date.parse(rec.at))).toBe(false);
  });

  test("children: the ones this session opened, their state and what keeps them open", () => {
    expect(run(["Eight riddles", "--repos", "wow-data", "--kind", "code", "--", "x"]).code).toBe(0);
    // (the child lives, idle, with its card done)
    row("424242.json", { sessionId: "abc12345-6789-aaaa", kind: "bg", jobId: "abc12345", status: "idle" });
    const r = run(["children"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("abc12345  idle  Eight riddles  [done]  → close: bun addon-kit/session.ts close abc12345");
    // (another opener's record is not listed, unless --all)
    const dir = join(root, ".cache", "harness", "opened");
    writeFileSync(join(dir, "def67890.json"), JSON.stringify({ id: "def67890", title: "Slow", repos: ["wow-data"], kind: "code", plan: false, opener: "s-else", openerName: null, at: "2026-10-25T20:00:00.000Z" }));
    expect(run(["children"]).out).not.toContain("def67890");
    expect(run(["children", "--all"]).out).toContain("def67890  closed  Slow  [running]  card wow-data-the-slow-one is running");
    expect(run(["children"], { CLAUDE_CODE_SESSION_ID: "s-nobody" }).out.trim()).toBe("no children");
    rmSync(join(dir, "def67890.json"));
  });

  test("close: a finished idle child is stopped and its record dropped", () => {
    expect(run(["Eight riddles", "--repos", "wow-data", "--kind", "code", "--", "x"]).code).toBe(0);
    row("424242.json", { sessionId: "abc12345-6789-aaaa", kind: "bg", jobId: "abc12345", status: "idle" });
    const r = run(["close", "abc12345"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(given().argv).toEqual(["stop", "abc12345"]);
    expect(given().cwd).toBe(root);
    expect(existsSync(join(root, ".cache", "harness", "opened", "abc12345.json"))).toBe(false);
    expect(r.out).toContain('closed "Eight riddles" (abc12345)');
    expect(r.out).toContain("note: wow-data: no remote to compare");
    expect(readFileSync(events, "utf8")).toContain("\tsession\tok\twow-data\tEight riddles closed (abc12345)");
  });

  test("close: a card still running refuses, --force closes, a busy child never", () => {
    const dir = join(root, ".cache", "harness", "opened");
    writeFileSync(join(dir, "def67890.json"), JSON.stringify({ id: "def67890", title: "Slow", repos: ["wow-data"], kind: "code", plan: false, opener: "s-opener", openerName: null, at: "2026-10-25T20:00:00.000Z" }));
    row("515151.json", { sessionId: "def67890-1111-bbbb", kind: "bg", jobId: "def67890", status: "idle" });
    const no = run(["close", "def67890"]);
    expect(no.code).toBe(1);
    expect(no.err).toContain("not closed: card wow-data-the-slow-one is running");
    expect(existsSync(seen)).toBe(false);
    expect(existsSync(join(dir, "def67890.json"))).toBe(true);
    expect(readFileSync(events, "utf8")).toContain("\tsession\tfail\twow-data\tSlow not closed (def67890)");
    row("515151.json", { sessionId: "def67890-1111-bbbb", kind: "bg", jobId: "def67890", status: "busy" });
    const busy = run(["close", "def67890", "--force"]);
    expect(busy.code).toBe(1);
    expect(busy.err).toContain("it is busy: mid-turn");
    expect(existsSync(seen)).toBe(false);
    row("515151.json", { sessionId: "def67890-1111-bbbb", kind: "bg", jobId: "def67890", status: "idle" });
    // (a stop that fails keeps the record)
    expect(run(["close", "def67890", "--force"], { STUB: "stopfail" }).code).toBe(4);
    expect(existsSync(join(dir, "def67890.json"))).toBe(true);
    const yes = run(["close", "def67890", "--force"]);
    expect(yes.code).toBe(0);
    expect(given().argv).toEqual(["stop", "def67890"]);
    expect(existsSync(join(dir, "def67890.json"))).toBe(false);
  });

  test("close: a session this one didn't open refuses (--force on the user's word), a bad id the usage", () => {
    const r = run(["close", "aaaaaaaa"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not closed: this session didn't open it (no record from session.ts)");
    expect(r.err).toContain("it wrote no card");
    // (another session's child: its opener checks it)
    const dir = join(root, ".cache", "harness", "opened");
    writeFileSync(join(dir, "fed00000.json"), JSON.stringify({ id: "fed00000", title: "Theirs", repos: ["wow-data"], kind: "code", plan: false, opener: "s-else", openerName: "Else", at: "2026-10-25T20:00:00.000Z" }));
    const theirs = run(["close", "fed00000"]);
    expect(theirs.code).toBe(1);
    expect(theirs.err).toContain("not closed: another session opened it (Else)");
    expect(existsSync(join(dir, "fed00000.json"))).toBe(true);
    expect(run(["close", "fed00000", "--force"]).out).toContain("note: forced past: another session opened it (Else)");
    expect(run(["close", "x/../y"]).code).toBe(2);
  });

  test("close: a live idle session with a done card but no record from session.ts is refused, not stopped", () => {
    row("626262.json", { sessionId: "cafe0000-1111-2222", kind: "bg", jobId: "cafe0000", status: "idle" });
    writeFileSync(
      join(root, "board", "ghost-the-stranger.md"),
      '---\nrepo: ghost\ntitle: The stranger\nstatus: done\nsession: cafe0000-1111-2222\nupdated: "2026-10-25T20:00:00+01:00"\nrepos: ghost\n---\n## Try\n\nx\n',
    );
    const r = run(["close", "cafe0000"]);
    expect(r.code).toBe(1);
    expect(r.err.split("\n").filter((l) => l.startsWith("not closed:"))).toEqual(["not closed: this session didn't open it (no record from session.ts)"]);
    expect(existsSync(seen)).toBe(false);
    const f = run(["close", "cafe0000", "--force"]);
    expect(f.code).toBe(0);
    expect(given().argv).toEqual(["stop", "cafe0000"]);
  });

  // a repo in the family folder with a bare origin; `work` puts one commit on a branch with no upstream
  const repoWith = (name: string, remote: boolean, date?: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) };
    const git = (...a: string[]) => expect(Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { env }).exitCode).toBe(0);
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "--no-verify", "-m", "first");
    if (remote) {
      const bare = join(tmp, `${name}.git`);
      expect(Bun.spawnSync(["git", "init", "-q", "--bare", bare]).exitCode).toBe(0);
      git("remote", "add", "origin", bare);
      git("push", "-q", "-u", "origin", "main");
    }
    git("checkout", "-q", "-b", "work");
    // (a commit that changes nothing has nothing to lose: unpushed work is a change the remote lacks)
    writeFileSync(join(dir, "work.txt"), `${name} work\n`);
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "work");
    return git;
  };
  const child = (id: string, repo: string, at: string, status = "done") => {
    const dir = join(root, ".cache", "harness", "opened");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, title: `Child ${id}`, repos: [repo], kind: "code", plan: false, opener: "s-opener", openerName: null, at }));
    row(`${id}.json`, { sessionId: `${id}-1111`, kind: "bg", jobId: id, status: "idle" });
    writeFileSync(
      join(root, "board", `${repo}-${id}.md`),
      `---\nrepo: ${repo}\ntitle: Child ${id}\nstatus: ${status}\nsession: ${id}-1111\nupdated: "2026-10-25T20:00:00+01:00"\nrepos: ${repo}\n---\n## Try\n\nx\n`,
    );
  };

  test("close: a commit on a branch with no upstream is unpushed once a remote exists, a repo with no remote only a note", () => {
    const git = repoWith("pushy", true);
    child("beef0001", "pushy", "2000-01-01T00:00:00.000Z");
    const no = run(["close", "beef0001"]);
    expect(no.code).toBe(1);
    expect(no.err).toContain("not closed: pushy: 1 commit unpushed");
    expect(existsSync(seen)).toBe(false);
    // (pushed to a remote: nothing is left)
    git("push", "-q", "origin", "work");
    expect(run(["close", "beef0001"]).code).toBe(0);
    repoWith("lonely", false);
    child("beef0002", "lonely", "2000-01-01T00:00:00.000Z");
    const alone = run(["close", "beef0002"]);
    expect(alone.code).toBe(0);
    expect(alone.out).toContain("note: lonely: no remote to compare");
  });

  test("close: another session's waiting card never excuses unpushed commits, and only those since the start count", () => {
    repoWith("shared", true);
    child("beef0003", "shared", "2000-01-01T00:00:00.000Z");
    writeFileSync(
      join(root, "board", "shared-other.md"),
      '---\nrepo: shared\ntitle: Other\nstatus: waiting-test\nsession: 99999999-aaaa\nupdated: "2026-10-25T20:00:00+01:00"\nrepos: shared\n---\n## Try\n\nx\n',
    );
    const no = run(["close", "beef0003"]);
    expect(no.code).toBe(1);
    expect(no.err).toContain("not closed: shared: 1 commit unpushed since it started (shared-other open there too: if they are theirs, the user's --force)");
    expect(existsSync(seen)).toBe(false);
    // (a commit dated before the child started is not its own)
    repoWith("aged", true, "2020-01-01T00:00:00Z");
    child("beef0004", "aged", "2026-01-01T00:00:00.000Z");
    const yes = run(["close", "beef0004"]);
    expect(yes.err).toBe("");
    expect(yes.code).toBe(0);
  });

  test("check: a desktop child through its hostSessionId, close's verdict without the stop", () => {
    const local = "local_8caf759e-16c9-4579-80be-0b90ed02c5f6";
    row("737373.json", { sessionId: "abc12345-6789-aaaa", kind: "bg", entrypoint: "claude-desktop", hostSessionId: local, status: "idle" });
    const r = run(["check", local]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`may close "The child" (${local}): archive it`);
    expect(existsSync(seen)).toBe(false);
    row("737373.json", { sessionId: "abc12345-6789-aaaa", kind: "bg", entrypoint: "claude-desktop", hostSessionId: local, status: "busy" });
    const busy = run(["check", local]);
    expect(busy.code).toBe(1);
    expect(busy.err).toContain("not yet: it is busy: mid-turn");
    row("737373.json", { sessionId: "def67890-1111-bbbb", kind: "bg", entrypoint: "claude-desktop", hostSessionId: local, status: "idle" });
    const slow = run(["check", local]);
    expect(slow.code).toBe(1);
    expect(slow.err).toContain("not yet: card wow-data-the-slow-one is running");
    expect(existsSync(seen)).toBe(false);
    rmSync(join(config, "sessions", "737373.json"));
    const gone = run(["check", local]);
    expect(gone.code).toBe(1);
    expect(gone.err).toContain(`can't tell: ${local} isn't running here, check its card by hand (bun addon-kit/board.ts list --all)`);
    expect(run(["check", "abc12345", "--force"]).code).toBe(2);
    expect(run(["check", "x"]).code).toBe(2);
  });

  test("no display name: the opener's open card names it, not the one it finished last", () => {
    expect(run(["T", "--repos", "yonder", "--kind", "code", "--", "x"], { CLAUDE_CONFIG_DIR: join(tmp, "empty") }).code).toBe(0);
    expect(given().argv[5]).toContain('The session "The kit audited" opened this one');
  });

  test("an automatic name is no name: the open card's title is, the socket still comes from the row", () => {
    const cfg = join(tmp, "derived");
    mkdirSync(join(cfg, "sessions"), { recursive: true });
    writeFileSync(join(cfg, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s-opener", kind: "interactive", name: "83-1e", nameSource: "derived", status: "busy", messagingSocketPath: "/tmp/cc-socks/77.sock" }));
    expect(run(["T", "--repos", "yonder", "--kind", "code", "--", "x"], { CLAUDE_CONFIG_DIR: cfg }).code).toBe(0);
    const p = given().argv[5];
    expect(p).toContain('The session "The kit audited" opened this one');
    expect(p).toContain('to "uds:/tmp/cc-socks/77.sock" (else to its name, "The kit audited")');
    expect(p).not.toContain("83-1e");
  });

  test("--opener: the reports go to the named live session, the caller needs no session of its own", () => {
    // (an app, no CLAUDE_* of its own: the dispatcher is named)
    row("515151.json", { sessionId: "s-dispatch", kind: "interactive", name: "the-dispatch", status: "idle", messagingSocketPath: "/tmp/cc-socks/99.sock" });
    const env = { CLAUDE_CODE_SESSION_ID: "" };
    const r = run(["Fix: yonder ci CI", "--repos", "yonder", "--kind", "code", "--opener", "the-dispatch", "--", "Fix it."], env);
    expect(r.code).toBe(0);
    const p = given().argv.at(-1) as string;
    expect(p).toContain('The session "the-dispatch" opened this one');
    expect(p).toContain('Report to the session that opened you with SendMessage, to "uds:/tmp/cc-socks/99.sock" (else to its name, "the-dispatch")');
    expect(JSON.parse(readFileSync(join(root, ".cache", "harness", "opened", "abc12345.json"), "utf8"))).toMatchObject({ opener: "s-dispatch", openerName: "the-dispatch" });
    // (the socket path and the session id name it too)
    expect(run(["T", "--repos", "yonder", "--kind", "code", "--opener", "/tmp/cc-socks/99.sock", "--", "x"], env).code).toBe(0);
    expect(run(["T", "--repos", "yonder", "--kind", "code", "--opener", "s-dispatch", "--", "x"], env).code).toBe(0);
    // (nobody alive by that name: nothing is started)
    const none = run(["T", "--repos", "yonder", "--kind", "code", "--opener", "ghost", "--", "x"], env);
    expect(none.code).toBe(2);
    expect(none.err).toContain("no live session matches --opener \"ghost\"");
    expect(existsSync(seen)).toBe(false);
  });

  test("pickOpener: one live match or nothing", () => {
    const l = (o: Partial<Live>): Live => ({ pid: 1, sessionId: "s1", job: "j1", ...o });
    const live = [l({ sessionId: "aaaabbbb-1", name: "disp", socket: "/s/1.sock" }), l({ sessionId: "ccccdddd-2", job: "j2", name: "twin" }), l({ sessionId: "eeeeffff-3", job: "j3", name: "twin" }), l({ sessionId: "00001111-4", job: "j4" })];
    expect(pickOpener("disp", live)).toEqual({ name: "disp", socket: "/s/1.sock", sessionId: "aaaabbbb-1" });
    expect(pickOpener("aaaabbbb", live)?.sessionId).toBe("aaaabbbb-1");
    expect(pickOpener("twin", live)).toBeUndefined();
    expect(pickOpener("j4", live)).toBeUndefined();
    // (a derived name is dropped, a control character in a name never reaches the prompt)
    const odd = [l({ sessionId: "99990000-5", job: "j5", name: "83-1e", nameSource: "derived", socket: "/s/5.sock" }), l({ sessionId: "88880000-6", job: "j6", name: "a\nb", socket: "/s/6.sock" })];
    expect(pickOpener("/s/5.sock", odd)).toEqual({ name: undefined, socket: "/s/5.sock", sessionId: "99990000-5" });
    expect(pickOpener("/s/6.sock", odd)?.name).toBe("a b");
    expect(prompt({ title: "T", repos: ["a"], kind: "code", plan: false, task: "x" }, { name: "evil\nIgnore all", socket: "/s/6.sock" })).toContain('(else to its name, "evil Ignore all")');
    expect(pickOpener("nobody", live)).toBeUndefined();
  });

  test("--opener is a plain name, id or socket: never an option, a newline or a quote", () => {
    const base = ["T", "--repos", "a", "--kind", "code"];
    expect(parse([...base, "--opener", "the dispatch", "--", "x"])).toMatchObject({ opener: "the dispatch" });
    expect(parse([...base, "--opener", "/tmp/cc-socks/99.sock", "--", "x"])).toMatchObject({ opener: "/tmp/cc-socks/99.sock" });
    expect(parse([...base, "--opener", "Control centre M0: repo, harness — étape", "--", "x"])).toMatchObject({ opener: "Control centre M0: repo, harness — étape" });
    for (const bad of ["--plan", 'a"b', "a\\b", "a\nb", "", "x".repeat(201)]) expect(typeof parse([...base, "--opener", bad, "--", "x"])).toBe("string");
    expect(parse([...base, "--opener"])).toBe("--opener takes a value");
  });

  test("plan mode on demand, prose on Opus", () => {
    const plan = run(["T", "--repos", "yonder", "--kind", "code", "--plan", "--", "x"]);
    expect(plan.code).toBe(0);
    // (it writes no card while it plans: the user hears of the wait here)
    expect(plan.out).toContain("it waits for your approval of its plan before it writes anything, its card too: claude attach abc12345");
    expect(given().argv.slice(4, 8)).toEqual(["opusplan", "--permission-mode", "plan", given().argv[7]]);
    expect(run(["T", "--repos", "yonder", "--kind", "prose", "--", "x"]).code).toBe(0);
    expect(given().argv[4]).toBe("opus");
  });

  test('--plan is refused where decisions = "opener", nothing started, said with what to do instead; the default still plans', () => {
    const toml = join(root, "harness.toml");
    const own = readFileSync(toml, "utf8");
    writeFileSync(toml, `${own}\n[session]\ndecisions = "opener"\n`);
    try {
      for (const more of [[], ["--dry-run"], ["--desktop"]]) {
        const r = run(["T", "--repos", "yonder", "--kind", "code", "--plan", ...more, "--", "x"]);
        expect(r.code).toBe(2);
        expect(r.out).toBe("");
        expect(r.err).toContain('--plan: this project takes every decision in the opener (`[session] decisions = "opener"`)');
        expect(r.err).toContain("Open a plan child instead (--kind prose, which is Opus where the config maps it; no --plan)");
        expect(r.err).toContain("Nothing started");
        expect(existsSync(seen)).toBe(false);
      }
      expect(readFileSync(events, "utf8")).toContain("\tsession\tfail\tyonder\tT: --plan refused, this project decides in the opener");
      // (without --plan the child opens as ever)
      expect(run(["T", "--repos", "yonder", "--kind", "prose", "--", "x"]).code).toBe(0);
    } finally {
      writeFileSync(toml, own);
    }
    expect(run(["T", "--repos", "yonder", "--kind", "code", "--plan", "--", "x"]).code).toBe(0);
  });

  test("--dry-run prints the command and the prompt and starts nothing", () => {
    const r = run(["Eight riddles", "--repos", "yonder,wow-data", "--kind", "code", "--dry-run", "--", "Write eight riddles."]);
    expect(r.code).toBe(0);
    expect(existsSync(seen)).toBe(false);
    expect(r.out).toContain(`would run, from ${root}:\n  claude --bg -n 'Eight riddles' --model opusplan "$PROMPT"`);
    expect(r.out).toContain("without CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_JOB_DIR");
    expect(r.out).toContain("--repos yonder,wow-data --status running");
  });

  test("--desktop prints the prompt alone and starts nothing, --dry-run or not", () => {
    for (const more of [[], ["--dry-run"]]) {
      const r = run(["Eight riddles", "--repos", "yonder", "--kind", "code", "--desktop", ...more, "--", "Write eight riddles."]);
      expect(r.code).toBe(0);
      expect(existsSync(seen)).toBe(false);
      expect(r.out.startsWith("A new task from the user.")).toBe(true);
      expect(r.out).toContain('Report to the session that opened you with SendMessage, to "uds:/tmp/cc-socks/56581.sock"');
      expect(r.out).toContain("You run on Sonnet.");
      expect(r.out).not.toContain("would run");
      expect(r.out).not.toContain("without CLAUDE");
      expect(r.out).not.toContain("PROMPT:");
      expect(r.err).toContain("note: yonder is held by");
    }
  });

  test("a refusal or an answer without an id fails with what claude said", () => {
    const fail = run(["T", "--repos", "yonder", "--kind", "code", "--", "x"], { STUB: "fail" });
    expect(fail.code).toBe(3);
    expect(fail.err).toContain("error: model 'opusplan' not available");
    expect(fail.err).toContain("claude --bg failed (exit 3)");
    const noid = run(["T", "--repos", "yonder", "--kind", "code", "--", "x"], { STUB: "noid" });
    expect(noid.code).toBe(1);
    expect(noid.err).toContain("something else");
    expect(noid.err).toContain("claude --bg answered without a session id: it may have started all the same. Look in `claude agents` before opening it again");
    expect(readFileSync(events, "utf8")).toContain("\tsession\tfail\tyonder\tT: claude --bg answered without a session id");
  });

  test("a bad ask is refused with the usage, nothing started", () => {
    const r = run(["T", "--repos", "yonder", "--", "x"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--kind is code or prose\nusage: bun addon-kit/session.ts");
    expect(existsSync(seen)).toBe(false);
  });

  test("a name that is no family folder is a note, not a refusal", () => {
    const r = run(["T", "--repos", "new-addon", "--kind", "code", "--", "x"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("note: new-addon is no family folder yet");
  });
});


describe("session: a project whose children work in worktrees", () => {
  const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "session-wt-")));
  const GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd, env: GIT, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };

  test("the prompt says so, the command names the worktree before the prompt, the opener is told how to open it", () => {
    const dir = temp();
    g(dir, "init", "-q", "-b", "main");
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "harness.toml"), '[tools]\ndir = "harness"\n[hooks]\nlock = false\n[session]\nworktrees = true\n');
    const restore = scopedRoot(dir);
    try {
      const p = prompt({ title: "T", repos: ["a"], kind: "code", plan: false, task: "x" });
      expect(p).toContain("You work in a git worktree of your own");
      expect(p).toContain("bun harness/packet.ts <repo>");
      expect(p.indexOf("worktree of your own")).toBeLessThan(p.indexOf("The task:"));
      expect(command({ title: "Kit: one dropdown", kind: "code", plan: false }, new Date("2026-11-15T01:50:00Z"))).toEqual(["claude", "--bg", "-n", "Kit: one dropdown", "--model", "opusplan", "--worktree", "kit-one-dropdown-11150150"]);
      expect(notes(["a"]).some((l) => l.includes("use_worktree: true") && l.includes("a CLI one gets --worktree"))).toBe(true);
    } finally {
      restore();
    }
    // a root that is no repository (the family's shape) has no worktree to make: none is asked, and the note says so
    const many = temp();
    mkdirSync(join(many, "a"));
    writeFileSync(join(many, "harness.toml"), "[session]\nworktrees = true\n");
    const back = scopedRoot(many);
    try {
      expect(command({ title: "T", kind: "code", plan: false })).not.toContain("--worktree");
      expect(notes(["a"]).some((l) => l.includes("is no repository: a CLI child gets no --worktree"))).toBe(true);
      expect(problems(many).some((l) => l.includes("is no git repository: it is for a project that is one repository"))).toBe(true);
    } finally {
      back();
    }
  });

  test('decisions = "opener": the child asks the user nothing, sends every question and go to its opener; the default keeps them in the child', () => {
    const opener = { name: "Hundo dispatcher", socket: "/tmp/cc-socks/1.sock" };
    const ask = { title: "T", repos: ["a"], kind: "code" as const, plan: false, task: "x" };
    // the family's way, unchanged
    const own = prompt(ask, opener, true);
    expect(own).toContain("A go to push is asked of the user in your own session (the question tool), never left to your opener to ask");
    expect(own).not.toContain("decisions");
    const dir = temp();
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "harness.toml"), '[session]\ndecisions = "opener"\n');
    const restore = scopedRoot(dir);
    try {
      const p = prompt(ask, opener, true);
      expect(p).toContain('Report to the session that opened you with SendMessage, to "uds:/tmp/cc-socks/1.sock" (else to its name, "Hundo dispatcher")');
      expect(p).toContain("you do not ask the user anything");
      expect(p).toContain("send every question (a push, a merge, any choice) to your opener with the options and your recommendation, then stop");
      expect(p).toContain("Your opener asks the user in its own session, then pushes on their answer or relays it to you quoted");
      expect(p).toContain("A push go never covers a deploy or a release");
      expect(p).not.toContain("asked of the user in your own session");
      expect(p).not.toContain("plan's approval");
      // a plan child: leaving plan mode would ask the user in the child, where nothing routes it to the opener, so there is none
      expect(() => prompt({ ...ask, plan: true }, opener, true)).toThrow("--plan: this project takes every decision in the opener");
      expect(planRefusal(true, "opener")).toContain("Open a plan child instead (--kind prose, which is Opus where the config maps it; no --plan)");
      expect(planRefusal(true, "opener")).toContain("send the plan to your opener and stop");
      expect(planRefusal(true, "opener")).toContain("moves a desktop child to Sonnet (set_session_model) before it relays the approval quoted");
      expect(planRefusal(true, "opener")).toContain("a CLI child can't be moved, so the build is a new --kind code child on the approved plan");
      expect(planRefusal(false, "opener")).toBeUndefined();
      expect(planRefusal(true, "child")).toBeUndefined();
      expect(planRefusal(false, "child")).toBeUndefined();
      expect(p).not.toContain("one exception");
      // no opener to send to: the question rides in its last message, it still asks nobody
      const alone = prompt(ask, undefined, true);
      expect(alone).toContain("No live opener could be named");
      expect(alone).toContain("put every question (a push, a merge, any choice) in that message with the options and your recommendation, then stop");
      expect(alone).not.toContain("SendMessage");
    } finally {
      restore();
    }
    // a word that is neither is an error, never the default
    const typo = temp();
    mkdirSync(join(typo, "a"));
    writeFileSync(join(typo, "harness.toml"), '[session]\ndecisions = "dispatch"\n');
    const back = scopedRoot(typo);
    try {
      expect(() => prompt(ask, opener, true)).toThrow('[session] decisions is "child" or "opener", not "dispatch"');
    } finally {
      back();
    }
  });

  test("a verdict says the unpushed count is against the remote as last fetched", () => {
    const clean = { repo: "yonder", ahead: 0, dirty: false, running: [] as string[], open: [] as string[] };
    const v = verdict({ live: { pid: 1, sessionId: "abc12345-x", job: "abc12345", status: "idle" }, cards: [{ id: "c", status: "done" } as never], repos: [{ ...clean, ahead: 1 }], force: false });
    expect(v.ok).toBe(false);
    expect(v.notes).toEqual(["yonder: unpushed is by content against the remote as last fetched: if the branch was merged since, git fetch first"]);
  });

  test("a project that shares one checkout hears nothing of worktrees", () => {
    const p = prompt({ title: "T", repos: ["a"], kind: "code", plan: false, task: "x" });
    expect(p.toLowerCase()).not.toContain("worktree");
    expect(command({ title: "T", kind: "code", plan: false })).not.toContain("--worktree");
    expect(notes(["a"]).join("\n")).not.toContain("worktree");
  });

  test("a worktree's name: the title as a slug, the minute", () => {
    expect(worktreeName("Harness: worktree-aware tools and an optional lock", new Date("2026-11-15T01:50:00Z"))).toBe("harness-worktree-aware-tools-and-an-opti-11150150");
    expect(worktreeName("???", new Date("2026-11-15T01:50:00Z"))).toBe("task-11150150");
  });

  test("with no lock the note is who runs there too, never that the new session will block", () => {
    const dir = temp();
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, ".harness", "board"), { recursive: true });
    writeFileSync(join(dir, "harness.toml"), "[hooks]\nlock = false\n");
    writeFileSync(join(dir, ".harness", "board", "a-other.md"), '---\nrepo: a\ntitle: other\nstatus: running\nsession: s-other\nupdated: "2026-11-15T01:00:00+01:00"\n---\n');
    const restore = scopedRoot(dir);
    try {
      expect(notes(["a"])).toEqual(["note: a has a-other running too: nothing makes the new session wait"]);
    } finally {
      restore();
    }
    const locked = temp();
    mkdirSync(join(locked, "a"));
    mkdirSync(join(locked, ".harness", "board"), { recursive: true });
    writeFileSync(join(locked, "harness.toml"), "");
    writeFileSync(join(locked, ".harness", "board", "a-other.md"), '---\nrepo: a\ntitle: other\nstatus: running\nsession: s-other\nupdated: "2026-11-15T01:00:00+01:00"\n---\n');
    const back = scopedRoot(locked);
    try {
      expect(notes(["a"])).toEqual(["note: a is held by a-other (running): the new session will block on it until it's free"]);
    } finally {
      back();
    }
  });

  test("a child in a worktree is read there: its card's, else its session's, else the main checkout, said", () => {
    const root = temp();
    writeFileSync(join(root, "harness.toml"), "");
    const repo = join(root, "repo");
    mkdirSync(repo);
    g(repo, "init", "-q", "-b", "main");
    g(repo, "commit", "-q", "--allow-empty", "-m", "chore: first");
    const remote = join(root, "remote.git");
    g(root, "init", "-q", "--bare", remote);
    g(repo, "remote", "add", "origin", remote);
    g(repo, "push", "-q", "origin", "main");
    const wt = join(temp(), "kid");
    g(repo, "worktree", "add", "-q", "-b", "side", wt);
    writeFileSync(join(wt, "work.txt"), "x\n");
    g(wt, "add", "-A");
    g(wt, "commit", "-q", "-m", "feat: work");
    writeFileSync(join(wt, "more.txt"), "y\n");
    const restore = scopedRoot(root);
    try {
      // the card's worktree: its unpushed commit and its dirty file
      const said: string[] = [];
      expect(repoStates(["repo"], "kid", [], said, undefined, [wt])).toMatchObject([{ repo: "repo", ahead: 1, dirty: true }]);
      expect(said).toEqual([`repo: read in the worktree ${wt} (side)`]);
      // no card names one, the live session's cwd does
      const viaCwd: string[] = [];
      expect(repoStates(["repo"], "kid", [], viaCwd, undefined, [undefined, wt])).toMatchObject([{ ahead: 1, dirty: true }]);
      // neither: the main checkout looks clean, and the note says the child's own may be elsewhere
      const lost: string[] = [];
      expect(repoStates(["repo"], "kid", [], lost, undefined, [undefined, undefined])).toMatchObject([{ ahead: 0, dirty: false }]);
      expect(lost).toEqual([`repo: read in the main checkout, no worktree of the child's is known, and 1 other worktree exists: its own may be one of them (git -C ${repo} worktree list)`]);
      // a worktree gone: said, and the main checkout read
      const gone: string[] = [];
      expect(lookIn("repo", [join(root, "gone")], gone).dir).toBe(repo);
      expect(gone[0]).toBe(`repo: the worktree ${join(root, "gone")} is gone`);
      // a worktree of another repository is none of this one's
      const other = join(root, "other");
      mkdirSync(other);
      g(other, "init", "-q", "-b", "main");
      g(other, "commit", "-q", "--allow-empty", "-m", "chore: first");
      const owt = join(temp(), "kid2");
      g(other, "worktree", "add", "-q", "-b", "oside", owt);
      expect(lookIn("repo", [owt], []).dir).toBe(repo);
      // a repository with one worktree only, the family's own case, says nothing
      const solo = join(root, "solo");
      mkdirSync(solo);
      g(solo, "init", "-q", "-b", "main");
      g(solo, "commit", "-q", "--allow-empty", "-m", "chore: first");
      const quiet: string[] = [];
      expect(lookIn("solo", [], quiet)).toEqual({ dir: solo });
      expect(quiet).toEqual([]);
      expect(repoStates(["solo"], "kid", [], quiet)).toMatchObject([{ repo: "solo", ahead: -1, dirty: false }]);
      expect(quiet).toEqual([]);
    } finally {
      restore();
    }
  });

  test("a worktree project never passes a child on the main checkout's clean state", () => {
    const root = temp();
    writeFileSync(join(root, "harness.toml"), "[session]\nworktrees = true\n");
    const repo = join(root, "repo");
    mkdirSync(repo);
    g(repo, "init", "-q", "-b", "main");
    g(repo, "commit", "-q", "--allow-empty", "-m", "chore: first");
    const wt = join(temp(), "kid");
    g(repo, "worktree", "add", "-q", "-b", "side", wt);
    const restore = scopedRoot(root);
    try {
      const done = [{ id: "kid-task", status: "done" }] as never;
      const lost: string[] = [];
      const [state] = repoStates(["repo"], "kid", [], lost, undefined, []);
      expect(state?.unseen).toContain("the child's own worktree isn't known");
      expect(lost).toEqual([]);
      const v = verdict({ cards: done, repos: [state!], force: false });
      expect(v.ok).toBe(false);
      expect(v.why[0]).toContain("its work wasn't looked at");
      // the user's --force goes past it, said
      const forced = verdict({ cards: done, repos: [state!], force: true });
      expect(forced.ok).toBe(true);
      expect(forced.notes.some((l) => l.includes("forced past"))).toBe(true);
      // its worktree known: read there, and a clean one may close
      const found: string[] = [];
      const [seen] = repoStates(["repo"], "kid", [], found, undefined, [wt]);
      expect(seen?.unseen).toBeUndefined();
      expect(verdict({ cards: done, repos: [seen!], force: false }).ok).toBe(true);
    } finally {
      restore();
    }
  });

  test("the registry row carries the session's working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-cwd-"));
    try {
      writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "aaaaaaaa-1111", cwd: "/p/.claude/worktrees/x" }));
      expect(registry(dir)[0]?.cwd).toBe("/p/.claude/worktrees/x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
