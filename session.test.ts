// session.ts: its parts, and the whole run with `claude` stubbed on the PATH (no real session).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { useBoardGuard, useFixtureRoot, writeFamilyConfig } from "./testing";
import { type Live, cleanEnv, command, idOf, openerOf, parse, prompt, registry, verdict } from "./session";

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
    git("commit", "-q", "--allow-empty", "--no-verify", "-m", "work");
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

  test("plan mode on demand, prose on Opus", () => {
    const plan = run(["T", "--repos", "yonder", "--kind", "code", "--plan", "--", "x"]);
    expect(plan.code).toBe(0);
    // (it writes no card while it plans: the user hears of the wait here)
    expect(plan.out).toContain("it waits for your approval of its plan before it writes anything, its card too: claude attach abc12345");
    expect(given().argv.slice(4, 8)).toEqual(["opusplan", "--permission-mode", "plan", given().argv[7]]);
    expect(run(["T", "--repos", "yonder", "--kind", "prose", "--", "x"]).code).toBe(0);
    expect(given().argv[4]).toBe("opus");
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
