// The harness: q.ts, the stamp, the git hooks, config.ts,
// packet.ts and board.ts (bun test). Each test makes its repositories in a
// family folder of its own under the system's temp folder, git kept from the
// user's own configuration.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add, before, cardId, cards, conflicts, format, holders, holding, isHeld, lines, options, parseCard, repoList, set, setSection, slug, strangers, waitingOn, warnings } from "./board";
import { eventLine, eventsPath, logEvent, repoOf } from "./events";
import { HOOKS } from "./hooks";
import { packet, sizeLine, packetRange, range, subjectProblem, trailerProblem } from "./packet";
import { clean, headTree, matters, parse, stampDir, stampOf, verdict, workTree } from "./q";
import { parseReview, pushProblem, record, reviewOf, waived } from "./review";
import { loadConfig, projectRoot, repoDir, repoName } from "./config";
import { useBoardGuard, writeFamilyConfig } from "./testing";

const KIT = import.meta.dir;
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
const saved: Record<string, string | undefined> = {};
let tmp: string;
let defaultRoot = "";
/** HARNESS_ROOT back to the default fixture, the alias cleared. */
const resetRoot = () => {
  process.env.HARNESS_ROOT = defaultRoot;
  delete process.env.WOW_ADDONS_ROOT;
};
/** Names `root` as the project for in-process calls until resetRoot(). */
const setRoot = (root: string) => {
  process.env.HARNESS_ROOT = root;
  delete process.env.WOW_ADDONS_ROOT;
};
useBoardGuard();
// Every tool's event line goes here, never into the family folder's log.
let events: string;

beforeAll(() => {
  for (const k of [...Object.keys(GIT_ENV), "WOW_ADDONS_ROOT", "HARNESS_ROOT", "HARNESS_EVENTS", "CLAUDE_CODE_SESSION_ID", "CI"]) saved[k] = process.env[k];
  Object.assign(process.env, GIT_ENV);
  // (a root for everything no test scopes by hand: an unscoped call falls on a fixture, never on the real family folder this checkout may sit in)
  defaultRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "harness-default-"))));
  writeFamilyConfig(defaultRoot);
  resetRoot();
  // (the tests' commits are a person's: the lock's gate is tested on its own)
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CI;
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "harness-test-")));
  events = join(tmp, "events.log");
  process.env.HARNESS_EVENTS = events;
});

// The event lines written since the last call, as [source, tone, repo, text].
function newEvents(): string[][] {
  if (!existsSync(events)) return [];
  const rows = readFileSync(events, "utf8").trimEnd().split("\n").filter(Boolean).map((l) => l.split("\t").slice(1));
  rmSync(events);
  return rows;
}
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(defaultRoot, { recursive: true, force: true });
});

function run(cwd: string, cmd: string[], env: Record<string, string> = {}) {
  // (a root given as the alias is given as HARNESS_ROOT too: the default fixture's must not win or clash)
  const named = env.HARNESS_ROOT ?? env.WOW_ADDONS_ROOT;
  const roots = named ? { HARNESS_ROOT: named, WOW_ADDONS_ROOT: named } : {};
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env, ...roots }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const git = (cwd: string, ...args: string[]) => run(cwd, ["git", ...args]);
const q = (cwd: string, ...args: string[]) => run(cwd, ["bun", join(KIT, "q.ts"), ...args]);

let n = 0;
// A family-shaped project root (harness.toml, addon-kit/, wow-data/) holding one repository with a commit.
function family(files: Record<string, string> = { "a.txt": "one\n" }) {
  const root = join(tmp, `family-${++n}`);
  mkdirSync(join(root, "wow-data"), { recursive: true });
  writeFamilyConfig(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(repo, f, ".."), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "chore: first");
  // (the repository's own check, as every repository of the family has one: `true` unless package.json says)
  if (!files["package.json"]) git(repo, "config", "harness.check", "true");
  return { root, repo };
}

describe("q", () => {
  test("the lines that matter", () => {
    // short: the whole of it
    expect(matters(clean("building\n\x1b[31mx.lua:12: attempt to index nil\x1b[0m\n 3 pass\n 1 fail\n 0 errors\n"))).toEqual([
      "building",
      "x.lua:12: attempt to index nil",
      " 3 pass",
      " 1 fail",
      " 0 errors",
    ]);
    // the flagged lines, then the end whatever it says (a diff, a crash: no word of BAD names it)
    const noisy = [...Array.from({ length: 10 }, (_, i) => `step ${i}`), "x.lua:4: boom", "ids: ok, none missing", "0 parse errors", ...Array.from({ length: 10 }, (_, i) => `step ${10 + i}`), "Diff in addon/A.lua:", "-local a=1", "+local a = 1"];
    expect(matters(noisy)).toEqual(["x.lua:4: boom", "…", "step 18", "step 19", "Diff in addon/A.lua:", "-local a=1", "+local a = 1"]);
    // nothing that looks like an error: the end of the output
    const plain = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    expect(matters(plain)).toEqual(plain.slice(-20));
    // more than 20: the first ones, how many were left out, the last five
    const many = matters(Array.from({ length: 50 }, (_, i) => `error ${i}`));
    expect(many).toHaveLength(20);
    expect(many[11]).toBe("… 31 more in the log");
    expect(many.at(-1)).toBe("error 49");
    expect(clean("10%\r50%\r100%\n\n")).toEqual(["100%"]);
  });

  test("the verdict line and the arguments", () => {
    expect(verdict("check", 0, 41_200)).toBe("check: ok (41s)");
    expect(verdict("test", 1, 3_000, ".cache/logs/test.log")).toBe("test: FAILED (exit 1, 3.0s) · .cache/logs/test.log");
    expect(parse(["check", "--", "bun", "run", "check"])).toEqual({ name: "check", command: ["bun", "run", "check"] });
    expect(parse(["check", "bun"])).toBeString();
    expect(parse(["check", "--"])).toBeString();
    expect(parse(["a/b", "--", "true"])).toBeString();
  });

  test("the exit code passes through, the output to the log", () => {
    const { repo } = family();
    const ok = q(repo, "demo", "--", "sh", "-c", "echo fine");
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^demo: ok \(\d+\.\ds\)\n$/);
    const bad = q(repo, "demo", "--", "sh", "-c", "echo building; echo 'x.lua:3: boom' >&2; exit 3");
    expect(bad.code).toBe(3);
    expect(bad.out.split("\n")[0]).toMatch(/^demo: FAILED \(exit 3, .*\) · \.cache\/logs\/demo\.log$/);
    expect(bad.out).toContain("  x.lua:3: boom");
    expect(bad.out).toContain("  building");
    const log = readFileSync(join(repo, ".cache", "logs", "demo.log"), "utf8");
    expect(log).toContain("$ sh -c echo building");
    expect(log).toContain("building\nx.lua:3: boom\n");
    expect(log).toContain("[exit 3,");
    // the cache stays out of git, the repository's .gitignore untouched
    expect(git(repo, "status", "--porcelain").out).toBe("");
    expect(q(repo, "demo", "--", "no-such-command-anywhere").code).toBe(127);
    // twenty lines at most under the verdict
    const loud = q(repo, "demo", "--", "sh", "-c", "for i in $(seq 40); do echo error $i; done; exit 1");
    expect(loud.out.trimEnd().split("\n")).toHaveLength(21);
    expect(q(repo, "demo").code).toBe(2);
    // killed by a signal: 128 and its number, as a shell says it
    expect(q(repo, "demo", "--", "sh", "-c", "kill -TERM $$").code).toBe(143);
  });

  test("a passing check stamps the tree it ran on, a failing one takes it back", () => {
    const { repo } = family();
    const tree = headTree(repo)!;
    expect(q(repo, "check", "--", "true").out).toContain(`stamped ${tree.slice(0, 7)}`);
    expect(stampOf(repo, tree)).toMatchObject({ tree, command: "true" });
    // another name never stamps
    expect(q(repo, "test", "--", "true").out).not.toContain("stamped");
    expect(q(repo, "check", "--", "false").code).toBe(1);
    expect(stampOf(repo, tree)).toBeUndefined();
    // the working files, uncommitted: their tree, the one their commit has
    writeFileSync(join(repo, "b.txt"), "two\n");
    q(repo, "check", "--", "true");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: two");
    expect(stampOf(repo, headTree(repo))).toBeDefined();
    // a check that changes the files isn't stamped
    git(repo, "config", "harness.check", "sh -c echo three > c.txt");
    const moving = q(repo, "check", "--", "sh", "-c", "echo three > c.txt");
    expect(moving.out).toContain("not stamped: the files changed");
    expect(stampOf(repo, workTree(repo))).toBeUndefined();
  });

  test("a repository with no check known stamps nothing", () => {
    const { repo } = family();
    git(repo, "config", "--unset", "harness.check");
    expect(q(repo, "check", "--", "true").out).toContain("not stamped: no check known here");
    expect(stampOf(repo, headTree(repo))).toBeUndefined();
  });

  test("stamps older than a month go; gone hooks are said", () => {
    const { repo } = family();
    const dir = join(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").out.trim(), "harness");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "check-old"), "{}\n");
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(join(dir, "check-old"), old, old);
    git(repo, "config", "core.hooksPath", join(tmp, "no-such-hooks"));
    const out = q(repo, "check", "--", "true").out;
    expect(out).toContain("stamped");
    expect(out).toContain("hooks gone:");
    expect(existsSync(join(dir, "check-old"))).toBe(false);
    git(repo, "config", "core.hooksPath", HOOKS);
    expect(q(repo, "check", "--", "true").out).not.toContain("hooks gone");
  });

  test("q stopped stops its command", async () => {
    const { repo } = family();
    const p = Bun.spawn([process.execPath, join(KIT, "q.ts"), "slow", "--", "sh", "-c", "sleep 2; echo late"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(700);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    await Bun.sleep(2000);
    expect(readFileSync(join(repo, ".cache", "logs", "slow.log"), "utf8")).not.toContain("\nlate\n");
  });

  test("only the repository's own check stamps", () => {
    const { repo } = family({ "package.json": '{"scripts":{"check":"true"}}\n' });
    const tree = headTree(repo)!;
    expect(q(repo, "check", "--", "true").out).toContain("not stamped: this repository's check is `bun run check`");
    expect(stampOf(repo, tree)).toBeUndefined();
    expect(q(repo, "check", "--", "bun", "run", "check").out).toContain("stamped");
    git(repo, "config", "harness.check", "sh -c true");
    q(repo, "check", "--", "false");
    expect(q(repo, "check", "--", "bun", "run", "check").out).toContain("not stamped");
    expect(q(repo, "check", "--", "sh", "-c", "true").out).toContain("stamped");
  });
});

describe("events", () => {
  test("a line of five fields, no tab or line break inside one", () => {
    const at = new Date("2026-10-20T12:00:00.000Z");
    expect(eventLine("check", "ok", "yonder", "check: ok\t(41s)\n· stamped", at)).toBe("2026-10-20T12:00:00.000Z\tcheck\tok\tyonder\tcheck: ok (41s) · stamped\n");
  });

  test("the family folder's .cache by default, another file or none by HARNESS_EVENTS", () => {
    const { root, repo } = family();
    try {
      delete process.env.HARNESS_EVENTS;
      setRoot(root);
      expect(eventsPath()).toBe(join(root, ".cache", "harness", "events.log"));
      logEvent("board", "wait", "yonder", "a card");
      expect(readFileSync(join(root, ".cache", "harness", "events.log"), "utf8")).toContain("\tboard\twait\tyonder\ta card\n");
      process.env.HARNESS_EVENTS = "off";
      expect(eventsPath()).toBeUndefined();
      logEvent("board", "wait", "yonder", "nothing written");
    } finally {
      resetRoot();
      process.env.HARNESS_EVENTS = events;
    }
    expect(repoOf(repo)).toBe("repo");
    // A worktree is its main checkout's repository.
    const wt = join(tmp, `wt-${n}`);
    git(repo, "worktree", "add", "-q", wt);
    expect(repoOf(wt)).toBe("repo");
  });

  test("a q run has a file of its own beside the log while it runs, gone by its verdict; a dead run's file swept", () => {
    const { repo } = family();
    const dir = join(tmp, "running");
    // A run killed before its end left its file: a pid that lives no more.
    const dead = Bun.spawnSync(["true"]).pid;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${dead}.json`), "{}\n");
    expect(q(repo, "demo", "--", "sh", "-c", `cat "${dir}"/*.json`).code).toBe(0);
    const seen = readFileSync(join(repo, ".cache", "logs", "demo.log"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
    expect(seen).toEqual([{ pid: expect.any(Number), name: "demo", repo: "repo", at: expect.any(Number) }]);
    expect(seen[0].pid).not.toBe(dead);
    expect(readdirSync(dir)).toEqual([]);
    newEvents();
  });

  test("a long log keeps its last 500 lines", () => {
    const file = join(tmp, "long.log");
    process.env.HARNESS_EVENTS = file;
    try {
      for (let i = 0; i < 2200; i++) logEvent("check", "ok", "r", `run ${i} ${"x".repeat(100)}`);
    } finally {
      process.env.HARNESS_EVENTS = events;
    }
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(2200);
    expect(lines.length).toBeGreaterThanOrEqual(500);
    expect(lines.at(-1)).toContain("run 2199");
  });

  test("q, review and board write theirs: a verdict, a stamp, a card added and moved", () => {
    const { root, repo } = family();
    newEvents();
    q(repo, "check", "--", "true");
    q(repo, "check", "--", "false");
    q(repo, "test", "--", "true");
    expect(newEvents().map((e) => [e[0], e[1], e[2], e[3]!.replace(/\(.*?\)/, "(t)")])).toEqual([
      ["check", "ok", "repo", expect.stringMatching(/^check: ok \(t\) · stamped [0-9a-f]{7}$/)],
      ["check", "fail", "repo", "check: FAILED (t) · .cache/logs/check.log"],
      ["test", "ok", "repo", "test: ok (t)"],
    ]);
    record(repo, "2 findings");
    expect(newEvents()).toEqual([["review", "", "repo", `${git(repo, "rev-parse", "--short=7", "HEAD").out.trim()} 2 findings`]]);
    setRoot(root);
    try {
      const card = add("yonder", "Eight riddles", { status: "waiting-test" });
      set(card.id, { try: "nothing moved" });
      set(card.id, { status: "done" });
    } finally {
      resetRoot();
    }
    expect(newEvents()).toEqual([
      ["board", "wait", "yonder", "Eight riddles added, waiting-test"],
      ["board", "ok", "yonder", "Eight riddles waiting-test → done"],
    ]);
  });
});

describe("git hooks", () => {
  test("never installed in CI: a job's push has no stamp to show", () => {
    const f = family();
    expect(run(f.repo, ["bun", join(KIT, "hooks.ts"), "install", f.repo], { CI: "true" }).out).toContain("skipped in CI");
    expect(git(f.repo, "config", "core.hooksPath").code).not.toBe(0);
  });
  function hooked() {
    const f = family();
    expect(run(f.repo, ["bun", join(KIT, "hooks.ts"), "install", f.repo], { CI: "" }).out).toContain("installed");
    expect(git(f.repo, "config", "core.hooksPath").out.trim()).toBe(HOOKS);
    const remote = join(f.root, "remote.git");
    git(f.root, "init", "-q", "--bare", remote);
    git(f.repo, "remote", "add", "origin", remote);
    return { ...f, remote };
  }
  const commit = (repo: string, msg: string) => {
    writeFileSync(join(repo, "a.txt"), `${Math.random()}\n`);
    git(repo, "add", "-A");
    return git(repo, "commit", "-q", "-m", msg);
  };

  test("commit-msg refuses an AI co-author or a generated-with line", () => {
    const { repo } = hooked();
    const coauthor = commit(repo, "feat: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
    expect(coauthor.code).not.toBe(0);
    expect(coauthor.err).toContain("Co-Authored-By: Claude Opus 5.5");
    expect(commit(repo, "feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)").code).not.toBe(0);
    expect(commit(repo, "fix: y\n\nGenerated by GitHub Copilot").code).not.toBe(0);
    for (const line of ["Co-Authored-By: Claude", "Generated with Claude", "Generated-by: Claude Code", "Assisted-by: Claude Opus", "Co-authored-by: Cursor Agent <cursoragent@cursor.com>"])
      expect([line, commit(repo, `fix: y\n\n${line}`).code]).not.toEqual([line, 0]);
    expect(git(repo, "log", "--format=%s").out.trim()).toBe("chore: first");
    const refused = newEvents();
    expect(refused.length).toBeGreaterThanOrEqual(8);
    expect(refused[0]).toEqual(["hook", "fail", "repo", "commit-msg refused an AI trailer: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"]);
    // a person, a generated file: fine
    expect(commit(repo, "chore: Text_frFR generated with locales.ts").code).toBe(0);
    expect(commit(repo, "feat: z\n\nGenerated with scripts/build.ts, then read.\n\nCo-authored-by: Egypt Smith <e@example.com>").code).toBe(0);
    expect(commit(repo, "feat(pages): the codex's\ngenerated with locales.ts, the Codex's own pages\n- generated by the cursor helper").code).toBe(0);
    newEvents();
    // packet.ts asking the hook about old commits writes no refusal
    expect(trailerProblem("feat: a\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n")).toContain("Claude");
    expect(trailerProblem("feat: a\n")).toBeUndefined();
    expect(newEvents()).toEqual([]);
  }, 30_000);

  test("pre-push refuses an unchecked tree and lets a checked one through", () => {
    const { repo, remote } = hooked();
    let refused = git(repo, "push", "-q", "origin", "main");
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("pre-push: no review stands behind");
    expect((packet(repo), record(repo, "clean"))).not.toBeString();
    refused = git(repo, "push", "-q", "origin", "main");
    expect(refused.err).toContain("pre-push: no passing check");
    expect(refused.err).toContain(`bun ${KIT}/q.ts check -- `);
    expect(newEvents().slice(-3)).toEqual([["hook", "fail", "repo", expect.stringMatching(/: no review$/)], ["review", "", "repo", expect.stringContaining("clean")], ["hook", "fail", "repo", expect.stringMatching(/^pre-push refused main \([0-9a-f]+\): no passing check$/)]]);
    expect(git(remote, "rev-parse", "-q", "--verify", "main").code).not.toBe(0);
    q(repo, "check", "--", "true");
    expect(git(repo, "push", "-q", "origin", "main").code).toBe(0);
    expect(git(remote, "rev-parse", "main").out).toBe(git(repo, "rev-parse", "HEAD").out);
    // a commit after the check: refused again; a branch deleted: no tree to check
    commit(repo, "feat: later");
    expect(git(repo, "push", "-q", "origin", "main").err).toContain("no review");
    // reviewed before its commit: the verdict lands on the tree committed unchanged
    writeFileSync(join(repo, "b.txt"), "b\n");
    expect((packet(repo), record(repo, "clean"))).not.toBeString();
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: b");
    expect(reviewOf(repo)?.verdict).toBe("clean");
    expect(git(repo, "push", "-q", "origin", "main").err).toContain("no passing check");
    q(repo, "check", "--", "true");
    expect(git(repo, "push", "-q", "origin", "main").code).toBe(0);
    // docs after the review ride along, code doesn't
    writeFileSync(join(repo, "README.md"), "n\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "docs: notes");
    expect(pushProblem(repo, "HEAD", git(repo, "rev-parse", "origin/main").out.trim())).toBeUndefined();
    commit(repo, "feat: unreviewed code");
    writeFileSync(join(repo, "c.lua"), "c\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: c");
    expect(pushProblem(repo, "HEAD", git(repo, "rev-parse", "origin/main").out.trim())).toContain("c.lua");
    // the kit's copies in an addon, never the kit's own sources
    expect(waived("addon/Yonder/Kit.lua", "yonder", repo)).toBe(true);
    expect(waived("scripts/root.ts", "yonder", repo)).toBe(true);
    expect(waived("Kit.lua", "addon-kit", repo)).toBe(false);
    expect(waived("atlas/x.md", "yonder", repo)).toBe(false);
    expect(waived("README.md", "addon-kit", repo)).toBe(true);
    git(repo, "reset", "-q", "--hard", "origin/main");
    expect(git(repo, "push", "-q", "origin", "--delete", "main").code).toBe(0);
  }, 30_000);

  test("the AI filter: every trailer form, nothing legitimate", () => {
    const ai = (msg: string) => Bun.spawnSync([join(HOOKS, "_ai")], { stdin: Buffer.from(`${msg}\n`), env: { ...process.env } }).exitCode;
    for (const bad of ["co-authored-by:claude", "Signed-off-by: Claude", "Reviewed-by: GPT-5", "Co-Developed-By: Claude", "Made with Claude", "Written with Claude Code", "Built with ChatGPT", "Made-with: Cursor", "Generated with [x](https://x.y)"])
      expect([bad, ai(bad)]).toEqual([bad, 1]);
    for (const fine of ["fix: claude-mem notes", "feat: the Claude Docs page", "chore: generated with locales.ts", "Co-Authored-By: Jane Doe <jane@x.org>", "made with love", "Signed-off-by: Max <m@x>"])
      expect([fine, ai(fine)]).toEqual([fine, 0]);
  });

  test("pre-push reads what it sends: a trailer brought in by a hookless commit is refused", () => {
    const { repo } = hooked();
    (packet(repo), record(repo, "clean"));
    q(repo, "check", "--", "true");
    expect(git(repo, "push", "-q", "origin", "main").code).toBe(0);
    writeFileSync(join(repo, "a.txt"), "picked\n");
    git(repo, "add", "-A");
    // (as a cherry-pick or a rebase would: no commit-msg ran)
    (packet(repo), record(repo, "clean"));
    git(repo, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "feat: picked\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    q(repo, "check", "--", "true");
    const refused = git(repo, "push", "-q", "origin", "main");
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("feat: picked");
    git(repo, "commit", "-q", "--amend", "-m", "feat: picked");
    q(repo, "check", "--", "true");
    expect(git(repo, "push", "-q", "origin", "main").code).toBe(0);
    newEvents();
  }, 30_000);

  test("a hooks folder gone is said, and the chain never runs the harness again", () => {
    const { repo } = hooked();
    // the chain pointed at our own folder by another path: a commit still ends
    const link = join(tmp, `hooks-link-${n}`);
    Bun.spawnSync(["ln", "-s", HOOKS, link]);
    git(repo, "config", "harness.chain", link);
    const p = Bun.spawnSync(["git", "commit", "-q", "--allow-empty", "-m", "chore: chained"], { cwd: repo, timeout: 10_000, stderr: "pipe", env: { ...process.env } });
    expect([p.exitCode, p.stderr.toString()]).toEqual([0, ""]);
    git(repo, "config", "--unset", "harness.chain");
    // installed through the link: already ours, never chained to itself
    git(repo, "config", "core.hooksPath", link);
    expect(run(repo, ["bun", join(KIT, "hooks.ts"), "install", repo], { CI: "" }).out).toContain("already");
    // gone: status says so and fails
    git(repo, "config", "core.hooksPath", join(tmp, "no-such-hooks"));
    const s = run(repo, ["bun", join(KIT, "hooks.ts"), "status", repo]);
    expect(s.code).toBe(1);
    expect(s.out).toContain("hooks MISSING");
  });

  test("the board as the lock: a session's commit wants its running card", () => {
    const { root, repo } = hooked();
    const env = { HARNESS_ROOT: root, WOW_ADDONS_ROOT: root, CLAUDE_CODE_SESSION_ID: "s-lock", CI: "" };
    const commit = () => run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "chore: locked"], env);
    const refused = commit();
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("this session has no card");
    const card = run(root, ["bun", join(KIT, "board.ts"), "add", "repo", "the task"], env);
    expect(card.code).toBe(0);
    expect(commit().code).toBe(0);
    // another session's card there first: held
    const other = { ...env, CLAUDE_CODE_SESSION_ID: "s-other" };
    run(root, ["bun", join(KIT, "board.ts"), "add", "repo", "another task"], other);
    expect(run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "chore: other"], other).err).toContain("is held by");
    // a person's commit is never asked
    expect(run(repo, ["git", "commit", "-q", "--allow-empty", "-m", "chore: mine"], { HARNESS_ROOT: root, WOW_ADDONS_ROOT: root }).code).toBe(0);
    newEvents();
  });

  test("the repository's own hooks still run, and come back on uninstall", () => {
    const { repo } = family();
    mkdirSync(join(repo, ".husky", "_"), { recursive: true });
    writeFileSync(join(repo, ".husky", "_", "pre-commit"), "#!/bin/sh\necho ran >> \"$(git rev-parse --show-toplevel)/.git/marker\"\n", { mode: 0o755 });
    git(repo, "config", "core.hooksPath", ".husky/_");
    expect(run(repo, ["bun", join(KIT, "hooks.ts"), "install", repo], { CI: "" }).out).toContain(".husky/_ chained");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    git(repo, "commit", "-qam", "fix: one");
    expect(readFileSync(join(repo, ".git", "marker"), "utf8")).toBe("ran\n");
    run(repo, ["bun", join(KIT, "hooks.ts"), "uninstall", repo]);
    expect(git(repo, "config", "core.hooksPath").out.trim()).toBe(".husky/_");
    expect(git(repo, "config", "harness.chain").code).not.toBe(0);
  });
});

describe("config", () => {
  // (the root is what these tests discover or name themselves: no default fixture under them)
  beforeEach(() => {
    delete process.env.HARNESS_ROOT;
    delete process.env.WOW_ADDONS_ROOT;
  });
  afterEach(resetRoot);

  test("the root from a worktree anywhere, and WOW_ADDONS_ROOT as HARNESS_ROOT's alias", () => {
    const { root, repo } = family();
    const outside = join(tmp, `elsewhere-${n}`, "wt");
    expect(git(repo, "worktree", "add", "-q", outside).code).toBe(0);
    expect(projectRoot(join(repo, "."))).toBe(root);
    expect(projectRoot(outside)).toBe(root);
    expect(run(outside, ["bun", join(KIT, "config.ts"), "root"]).out.trim()).toBe(root);
    expect(run(outside, ["bun", join(KIT, "config.ts"), "repo-name"]).out.trim()).toBe("repo");
    delete process.env.HARNESS_ROOT;
    process.env.WOW_ADDONS_ROOT = root;
    try {
      expect(projectRoot("/")).toBe(root);
      process.env.WOW_ADDONS_ROOT = join(tmp, "no-such-folder");
      expect(() => projectRoot()).toThrow("is no folder");
      delete process.env.WOW_ADDONS_ROOT;
      process.env.HARNESS_ROOT = root;
      expect(projectRoot("/")).toBe(root);
    } finally {
      resetRoot();
    }
  });

  test("a project that is one repository: a name that is not the folder's, and one board for every worktree", () => {
    const dir = join(tmp, `single-${++n}`, "geoguessr-web");
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "harness.toml"), '[project]\nname = "geoguessr"\n');
    writeFileSync(join(dir, "a.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore: first");
    const wt = join(tmp, `single-wt-${n}`);
    git(dir, "worktree", "add", "-q", wt);
    expect(existsSync(join(wt, "harness.toml"))).toBe(true);
    const conf = loadConfig(dir);
    expect(conf.repos.map((r) => [r.name, r.path])).toEqual([["geoguessr", "."]]);
    expect(conf.boardDir).toBe(join(dir, ".harness", "board"));
    expect(repoDir("geoguessr", dir)).toBe(dir);
    expect(repoName(dir)).toBe("geoguessr");
    // the worktree resolves to the main checkout's root: one board, one lock
    expect(projectRoot(wt)).toBe(dir);
    expect(repoName(wt)).toBe("geoguessr");
    expect(run(wt, ["bun", join(KIT, "config.ts"), "repo-name"]).out.trim()).toBe("geoguessr");
  });

  test("an included file inside a repository does not make that repository the root", () => {
    const root = join(tmp, `incl-${++n}`);
    const kit = join(root, "kit");
    mkdirSync(kit, { recursive: true });
    git(kit, "init", "-q", "-b", "main");
    writeFileSync(join(kit, "harness.family.toml"), '[project]\nname = "fam"\n[state]\nboard = "board"\n');
    writeFileSync(join(root, "harness.toml"), 'include = "kit/harness.family.toml"\n');
    delete process.env.HARNESS_ROOT;
    delete process.env.WOW_ADDONS_ROOT;
    try {
      expect(projectRoot(kit)).toBe(root);
      expect(run(kit, ["bun", join(KIT, "config.ts"), "root"]).out.trim()).toBe(root);
      expect(repoName(kit)).toBe("kit");
      expect(loadConfig(kit).boardDir).toBe(join(root, "board"));
    } finally {
      resetRoot();
    }
  });

  test("two different roots in the environment are an error, never a silent pick", () => {
    const { root } = family();
    const { root: other } = family();
    process.env.HARNESS_ROOT = root;
    process.env.WOW_ADDONS_ROOT = other;
    try {
      expect(() => projectRoot()).toThrow("name different projects");
      process.env.WOW_ADDONS_ROOT = root;
      expect(projectRoot()).toBe(root);
    } finally {
      resetRoot();
    }
  });

  test("an env root with no harness.toml is refused, said plainly", () => {
    const bare = join(tmp, `bare-${++n}`);
    mkdirSync(bare);
    process.env.HARNESS_ROOT = bare;
    try {
      expect(() => projectRoot()).toThrow("holds no harness.toml");
    } finally {
      resetRoot();
    }
  });

  test("include, the defaults and the hook switches", () => {
    const root = join(tmp, `inc-${++n}`);
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "tools", "base.toml"), '[project]\nname = "base"\nterm = "family"\n[hooks]\nreview = false\n');
    writeFileSync(join(root, "harness.toml"), 'include = "tools/base.toml"\n[project]\nname = "own"\n');
    const c = loadConfig(root);
    expect([c.name, c.term, c.hooks.review, c.hooks.stamp]).toEqual(["own", "family", false, true]);
    expect(c.review.waive.some((r) => r.test("docs/x.md"))).toBe(true);
    process.env.HARNESS_ROOT = root;
    try {
      expect(run(root, ["bun", join(KIT, "config.ts"), "hook", "review"]).out.trim()).toBe("off");
      expect(run(root, ["bun", join(KIT, "config.ts"), "hook", "stamp"]).out.trim()).toBe("on");
    } finally {
      resetRoot();
    }
  });
});

describe("packet", () => {
  test("commit subjects", () => {
    expect(subjectProblem("feat(expeditions): eight riddles more")).toBeUndefined();
    expect(subjectProblem("fix: Pool of Tears's quests")).toContain("capital");
    expect(subjectProblem("Added riddles")).toBe("not a Conventional Commit");
  });

  test("a repository never pushed anywhere: its whole history", () => {
    const { repo } = family();
    for (const n of [2, 3, 4]) {
      writeFileSync(join(repo, `f${n}.txt`), `${n}\n`);
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", `feat: ${n}`);
    }
    expect(range(repo)).toMatchObject({ base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", label: "the whole history (never pushed) and the uncommitted files" });
    git(repo, "remote", "add", "origin", join(tmp, "nowhere.git"));
    expect(range(repo)).toMatchObject({ base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" });
  });

  test("the size line: lines to read, a large change read biggest first", () => {
    expect(sizeLine("3\t1\ta.ts\n-\t-\timg.png\n")).toBe("Size: 2 files, +3 −1 lines. Read every changed file's diff, several in one turn.");
    // (untracked files are all added: a change of new files counts)
    expect(sizeLine("", 3000, 4)).toContain("Size: 4 files, +3000 −0 lines. Large");
    expect(sizeLine("2000\t600\tbig.lua\n")).toContain("Large (over 2500): read the biggest files");
  });

  test("the packet: commits, files, the stamp, the project's extension", () => {
    const { repo } = family({ "notes/a.md": "one\n", "a.txt": "one\n" });
    // (pushed once: its first commit on a remote, a branch of its own never pushed)
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(repo, "notes", "a.md"), "two\n");
    git(repo, "commit", "-qam", "feat(notes): a second line\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    q(repo, "check", "--", "true");
    writeFileSync(join(repo, "new.txt"), "untracked\n");

    const res = packet(repo);
    if (typeof res === "string") throw new Error(res);
    const text = readFileSync(res.file, "utf8");
    expect(res.file).toBe(join(repo, ".cache", "review", `${git(repo, "rev-parse", "HEAD").out.slice(0, 12)}.md`));
    expect(text).toContain("Range: everything no remote has (no upstream) and the uncommitted files.");
    // Its range written for review.ts, whole.
    expect(packetRange(text)).toEqual({ base: git(repo, "rev-parse", "HEAD~1").out.trim(), tip: git(repo, "rev-parse", "HEAD").out.trim() });
    expect(text).toContain("- check: passed on HEAD's tree");
    expect(text).toContain("- the uncommitted files have no passing check of their own.");
    expect(text).toContain("feat(notes): a second line");
    expect(text).toContain('trailers: AI co-author or "generated with" found');
    expect(text).toContain("- M notes/a.md");
    expect(text).toMatch(/Size: 2 files, \+2 −1 lines\. Read every changed file's diff/);
    expect(text).toContain("- A new.txt (untracked)");
    // the extension of harness.toml [extensions] packet: handed the files, its lines in the packet, its count in the summary
    expect(text).toContain("## Extra\nfiles: notes/a.md,new.txt");
    expect(res.summary).toContain("2 files");
    expect(git(repo, "status", "--porcelain").out).toBe("?? new.txt\n");
    expect(packetRange("# Review packet\n\nno range here\n")).toBeUndefined();
  });

  test("by default, everything a push would send: past the upstream, else all no remote has", () => {
    const { repo } = family();
    const sha = (rev: string) => git(repo, "rev-parse", rev).out.trim();
    const remote = join(tmp, `remote-${++n}.git`);
    git(tmp, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "main");
    const pushed = sha("HEAD");
    // A branch never pushed, three commits on: all three, though it has no upstream.
    git(repo, "checkout", "-q", "-b", "side");
    for (const s of ["one", "two", "three"]) git(repo, "commit", "-q", "--allow-empty", "-m", `feat: ${s}`);
    expect(range(repo)).toMatchObject({ base: pushed, tip: sha("HEAD"), label: "everything no remote has (no upstream) and the uncommitted files" });
    // Its upstream set: past it.
    git(repo, "push", "-q", "-u", "origin", "side");
    git(repo, "commit", "-q", "--allow-empty", "-m", "feat: four");
    expect(range(repo)).toMatchObject({ base: sha("HEAD~1"), label: "origin/side..HEAD and the uncommitted files" });
  });
});

describe("review", () => {
  test("a verdict recorded for HEAD, first line first", () => {
    const { repo } = family();
    const head = git(repo, "rev-parse", "HEAD").out.trim();
    expect(reviewOf(repo)).toBeUndefined();
    expect(packet(repo)).not.toBeString();
    const r = record(repo, "2 findings,\n fixed");
    if (typeof r === "string") throw new Error(r);
    const text = readFileSync(join(stampDir(repo)!, `review-tree-${git(repo, "rev-parse", "HEAD^{tree}").out.trim()}`), "utf8");
    expect(text.split("\n")[0]).toBe("verdict: 2 findings, fixed");
    expect(text).toContain(`packet: ${join(repo, ".cache", "review", `${head.slice(0, 12)}.md`)}`);
    expect(reviewOf(repo)).toMatchObject({ verdict: "2 findings, fixed", head });
    expect(run(repo, ["bun", join(KIT, "review.ts"), repo]).out).toStartWith("2 findings, fixed (");
    expect(record(repo, "  ")).toBe("the verdict is empty");
    expect(parseReview("verdict: clean\nhead: abc\n")).toEqual({ verdict: "clean", head: "abc", tree: undefined, at: undefined, packet: undefined });
    // the same tree under a new commit keeps its verdict, another tree has none
    git(repo, "commit", "-q", "--allow-empty", "-m", "chore: later");
    expect(reviewOf(repo)?.verdict).toBe("2 findings, fixed");
    writeFileSync(join(repo, "other.txt"), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "chore: other");
    expect(reviewOf(repo)).toBeUndefined();
  });

  test("a review before the commit: the tree to commit, the fixes since the packet written down", () => {
    const { repo } = family();
    writeFileSync(join(repo, "new.txt"), "one\n");
    const made = packet(repo);
    if (typeof made === "string") throw new Error(made);
    expect(readFileSync(made.file, "utf8")).toMatch(/^<!-- tree: [0-9a-f]{40} -->$/m);
    // the reviewer's finding fixed before the commit
    writeFileSync(join(repo, "new.txt"), "one\ntwo\n");
    const r = record(repo, "1 finding, fixed");
    if (typeof r === "string") throw new Error(r);
    expect(r.edited).toContain("1 insertion");
    expect(reviewOf(repo)).toBeUndefined(); // (not committed yet: HEAD's tree is another)
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: new");
    expect(reviewOf(repo)).toMatchObject({ verdict: "1 finding, fixed", edited: r.edited });
    // an edit after the record: the committed tree has no verdict
    writeFileSync(join(repo, "new.txt"), "three\n");
    git(repo, "commit", "-q", "-am", "fix: three");
    expect(reviewOf(repo)).toBeUndefined();
    expect(record(repo, "again")).not.toBeString();
    expect(record(repo, "twice")).toContain("already has a verdict");
  });

  test("a verdict is for one tree and doesn't overwrite one without --again", () => {
    const { repo } = family();
    writeFileSync(join(repo, "untracked.txt"), "x\n");
    const first = record(repo, "first");
    if (typeof first === "string") throw new Error(first);
    // the tree has a record: refused, the old verdict named, until --again.
    const again = record(repo, "second");
    expect(again).toContain("already has a verdict (first)");
    expect(again).toContain("--again");
    expect(run(repo, ["bun", join(KIT, "review.ts"), repo, "second"]).code).toBe(1);
    expect(run(repo, ["bun", join(KIT, "review.ts"), repo, "--again", "second"]).code).toBe(0);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "chore: x");
    expect(reviewOf(repo)?.verdict).toBe("second");
  });

  test("the verdict keeps the range its reviewer read: HEAD's packet, else the newest HEAD is built on", () => {
    const { repo } = family();
    const sha = (rev: string) => git(repo, "rev-parse", rev).out.trim();
    const commit = (subject: string) => git(repo, "commit", "-q", "--allow-empty", "-m", subject);
    commit("feat: two");
    // The reviewer reads HEAD~1..HEAD; its findings are fixed in a commit on top, the verdict recorded there.
    expect(packet(repo, "HEAD~1..HEAD")).not.toBeString();
    const reviewed = sha("HEAD");
    commit("fix: the findings");
    // A packet made since on another line of work isn't the one read.
    git(repo, "checkout", "-q", "-b", "side", "HEAD~2");
    commit("feat: elsewhere");
    expect(packet(repo, "HEAD~1..HEAD")).not.toBeString();
    git(repo, "checkout", "-q", "main");
    const r = record(repo, "clean (1 finding fixed)");
    if (typeof r === "string") throw new Error(r);
    expect([r.base, r.tip]).toEqual([sha(`${reviewed}~1`), reviewed]);
    expect(reviewOf(repo)).toMatchObject({ verdict: "clean (1 finding fixed)", base: sha(`${reviewed}~1`), tip: reviewed });
    expect(readFileSync(join(stampDir(repo)!, `review-tree-${git(repo, "rev-parse", "HEAD^{tree}").out.trim()}`), "utf8")).toContain(`\nbase: ${sha(`${reviewed}~1`)}\ntip: ${reviewed}\n`);
    // what came after the tip, unread by the reviewer, written down
    expect(r.after).toEqual([`${sha("HEAD").slice(0, 7)} fix: the findings`]);
    expect(reviewOf(repo)?.after).toEqual(r.after);
    // HEAD's own packet first, though an older one would do.
    expect(packet(repo)).not.toBeString();
    const own = record(repo, "clean", true);
    if (typeof own === "string") throw new Error(own);
    expect(own.tip).toBe(sha("HEAD"));
    // Pushed: next week's commit, its verdict recorded with no new packet, isn't
    // covered by this one (its tip went out with the last push).
    const remote = join(tmp, `remote-${++n}.git`);
    git(tmp, "init", "-q", "--bare", remote);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "-u", "origin", "main");
    commit("feat: next week");
    const later = record(repo, "clean", true);
    if (typeof later === "string") throw new Error(later);
    expect([later.packet, later.base]).toEqual([undefined, undefined]);
    // No packet at all: no range, the verdict still kept.
    const bare = family().repo;
    const none = record(bare, "clean");
    if (typeof none === "string") throw new Error(none);
    expect([none.packet, none.base]).toEqual([undefined, undefined]);
  });
});

describe("board", () => {
  test("a card's text round-trips", () => {
    const card = { id: "yonder-x", repo: "yonder", title: "Eight riddles: the review's fixes", status: "waiting-test" as const, session: "", updated: "2026-10-20T09:00:00+02:00", repos: ["yonder"], waits: "", since: {}, body: "## Try\n\nFreewind\n" };
    const text = format(card);
    expect(text).toContain('title: "Eight riddles: the review\'s fixes"');
    expect(text).toContain('updated: "2026-10-20T09:00:00+02:00"');
    expect(parseCard("x", '---\ntitle: "A: b" # a note\n---\n').title).toBe("A: b");
    expect(text).toContain('session: ""');
    expect(parseCard("yonder-x", text)).toEqual(card);
    expect(format({ ...card, title: "true" })).toContain('title: "true"');
    expect(slug("Yonder: Kel'Theril, à nouveau")).toBe("yonder-keltheril-a-nouveau");
    // A card's own repo is its repos, unwritten (every older card reads so); others and a wait are written.
    expect(text).not.toContain("repos:");
    const wide = { ...card, status: "blocked" as const, repos: ["wow-data", "mealbook", "yonder"], waits: "yonder-y" };
    expect(format(wide)).toContain('repos: wow-data, mealbook, yonder\nwaits: yonder-y\n');
    expect(parseCard("yonder-x", format(wide))).toEqual(wide);
    expect(parseCard("x", "---\nrepo: every repo\n---\n").repos).toEqual([]);
    expect(parseCard("x", "---\nrepo: root .claude\n---\n").repos).toEqual([]);
    expect(repoList(" yonder,wow-data , yonder,")).toEqual(["yonder", "wow-data"]);
  });

  test("the board is the lock: the first to hold a repository holds it, a stopped card only notes its unpushed work", () => {
    const card = (id: string, status: string, session: string, repos: string[], since = "2026-10-20T21:00:00+02:00", waits = "") =>
      parseCard(id, `---\nrepo: ${repos[0]}\nstatus: ${status}\nsession: ${session}\nupdated: "${since}"\nrepos: "${repos.join(", ")}"\nsince: "${since}"\n${waits ? `waits: ${waits}\n` : ""}---\n`);
    const a = card("yonder-riddles", "running", "A", ["yonder"], "2026-10-20T20:00:00+02:00");
    const c = card("codex-german", "waiting-test", "C", ["lorekeepers-codex"]);
    const old = card("yonder-older", "ready-to-push", "D", ["yonder"]);
    const done = card("yonder-done", "done", "E", ["yonder"]);
    const mine = card("wow-data-other", "running", "B", ["wow-data"]);
    const b = card("mealbook-trainers", "running", "B", ["wow-data", "mealbook", "yonder", "lorekeepers-codex"], "2026-10-20T21:00:00+02:00");
    const list = [a, c, old, done, mine, b];
    const found = conflicts(b, list);
    expect(found.held.map((x) => [x.card.id, x.repos])).toEqual([["yonder-riddles", ["yonder"]]]);
    expect(found.pending.map((x) => x.card.id)).toEqual(["codex-german", "yonder-older"]);
    expect(warnings(b, list)).toEqual([
      "held: yonder by yonder-riddles (there since 20:00, session A): drop yonder (set mealbook-trainers --repos wow-data,mealbook,lorekeepers-codex) and go on, or commit what you have, set mealbook-trainers --on yonder-riddles and write nothing until it's free",
      "note: lorekeepers-codex has codex-german (waiting-test) with unpushed work: its commits go out with the next push",
      "note: yonder has yonder-older (ready-to-push) with unpushed work: its commits go out with the next push",
    ]);
    // The first to hold is told nothing to wait for, only that B came after.
    expect(warnings(a, list)).toEqual([
      "note: yonder has mealbook-trainers running there since after this card: it was told to wait",
      "note: yonder has yonder-older (ready-to-push) with unpushed work: its commits go out with the next push",
    ]);
    expect(warnings(c, list)).toEqual([]);

    // B blocked on A: it holds nothing, so A is never told to block on its waiter.
    const blocked = { ...b, status: "blocked" as const, waits: "yonder-riddles", since: {} };
    const withB = [a, blocked, old];
    expect(warnings(a, withB).some((w) => w.startsWith("held:"))).toBe(false);
    expect(warnings(blocked, withB)).toEqual(["still held: yonder by yonder-riddles (running): write nothing until it's free"]);
    expect(waitingOn("yonder-riddles", withB)).toEqual([blocked]);
    expect([isHeld("yonder", withB, "B"), isHeld("yonder", withB, "A")]).toEqual([true, false]);

    // A stops: B and C, both blocked on it, are both free; the first to run again holds, the other waits on it.
    const aStopped = { ...a, status: "waiting-test" as const, since: {} };
    const cBlocked = card("codex-yonder", "blocked", "C2", ["yonder"], "2026-10-20T21:05:00+02:00", "yonder-riddles");
    const freed = [aStopped, blocked, cBlocked];
    expect(warnings(blocked, freed)).toEqual(["free: nothing holds wow-data, mealbook, yonder, lorekeepers-codex: set mealbook-trainers --status running (held again if another got there first)"]);
    // Free too once the holder drops the repository and runs on; held again by another that comes to hold one.
    const aDropped = { ...a, repos: ["keyring"], since: { keyring: a.since.yonder! } };
    expect(warnings(blocked, [aDropped, blocked])[0]).toStartWith("free: nothing holds");
    const other = card("codex-other", "running", "X", ["lorekeepers-codex"]);
    expect(warnings(blocked, [aDropped, blocked, other])).toEqual(["still held: lorekeepers-codex by codex-other (running): write nothing until it's free"]);
    expect([isHeld("yonder", freed, "B"), isHeld("yonder", freed, "C2")]).toEqual([false, false]);
    const bRuns = { ...blocked, status: "running" as const, waits: "", since: { yonder: "2026-10-20T22:00:00+02:00" } };
    const cRuns = { ...cBlocked, status: "running" as const, waits: "", since: { yonder: "2026-10-20T22:00:05+02:00" } };
    expect(warnings(cRuns, [aStopped, bRuns, cRuns])[0]).toStartWith("held: yonder by mealbook-trainers");
    expect(warnings(bRuns, [aStopped, bRuns, cRuns]).some((w) => w.startsWith("held:"))).toBe(false);
    expect([isHeld("yonder", [aStopped, bRuns, cRuns], "B"), isHeld("yonder", [aStopped, bRuns, cRuns], "C2")]).toEqual([false, true]);
    // The same millisecond: the id breaks the tie, one of them waits.
    const x = { ...cRuns, id: "x", since: bRuns.since };
    expect([before(bRuns, x, "yonder"), before(x, bRuns, "yonder")]).toEqual([true, false]);

    // Widening queues the new repository at the back: A, in the Codex since 10:00, adds yonder at 10:30,
    // where B has run since 10:15. A is held, B isn't (the reviewer's case).
    const wide = { ...card("a-codex", "running", "A", ["lorekeepers-codex", "yonder"]), since: { "lorekeepers-codex": "2026-10-20T10:00:00+02:00", yonder: "2026-10-20T10:30:00+02:00" } };
    const bYonder = card("b-yonder", "running", "B", ["yonder"], "2026-10-20T10:15:00+02:00");
    expect(warnings(wide, [wide, bYonder])[0]).toStartWith("held: yonder by b-yonder (there since 10:15");
    expect([isHeld("yonder", [wide, bYonder], "A"), isHeld("yonder", [wide, bYonder], "B")]).toEqual([true, false]);
    // Times compare as times: across the clock change, 02:50+02:00 came before 02:10+01:00.
    const summer = card("summer", "running", "S", ["yonder"], "2026-10-25T02:50:00+02:00");
    const winter = card("winter", "running", "W", ["yonder"], "2026-10-25T02:10:00+01:00");
    expect(before(summer, winter, "yonder")).toBe(true);

    expect(holders(list, ["yonder"]).map((h) => [h.card.id, h.kind])).toEqual([
      ["yonder-riddles", "held"],
      ["mealbook-trainers", "held"],
      ["yonder-older", "pending"],
    ]);
    expect(lines([blocked], Date.parse("2026-10-20T21:00:00+02:00"))[0]).toBe("blocked        wow-data+mealbook+yonder+lorekeepers-codex  mealbook-trainers  mealbook-trainers (on yonder-riddles)  0m");
  });

  test("an id names the repo once", () => {
    expect(cardId("addon-kit", "addon-kit: the kit audited")).toBe("addon-kit-the-kit-audited");
    expect(cardId("yours-truly", "Yours Truly: Zephras Isle's letters")).toBe("yours-truly-zephras-isles-letters");
    expect(cardId("yonder", "Eight riddles")).toBe("yonder-eight-riddles");
    expect(cardId("yonder", "Yonderland")).toBe("yonder-yonderland");
  });

  test("a card cut short or written on Windows", () => {
    expect(parseCard("x", "---\r\nrepo: yonder\r\ntitle: T\r\nstatus: blocked\r\n---\r\nbody\r\n")).toMatchObject({ repo: "yonder", status: "blocked", repos: ["yonder"] });
    expect(parseCard("x", "---\nrepo: yonder\ntitle: T\nsta").broken).toBe(true);
    expect(parseCard("x", "").broken).toBe(true);
    expect(parseCard("x", "---\nrepo: yonder\nstatus: running\n---\n").broken).toBeUndefined();
    expect(lines([parseCard("x", "")])[0]).toStartWith("BROKEN");
  });

  test("adds at once under one title never share a card", async () => {
    const { root } = family();
    const procs = Array.from({ length: 6 }, (_, i) =>
      Bun.spawn(["bun", join(KIT, "board.ts"), "add", "yonder", "Yonder: the riddles of the Barrens"], {
        env: { ...process.env, HARNESS_ROOT: root, WOW_ADDONS_ROOT: root, CLAUDE_CODE_SESSION_ID: `s${i}` },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const ids = await Promise.all(procs.map(async (p) => (await new Response(p.stdout).text()).trim()));
    expect(new Set(ids).size).toBe(6);
    expect(readdirSync(join(root, "board")).filter((f) => f.endsWith(".md"))).toHaveLength(6);
    expect(readdirSync(join(root, "board")).some((f) => f.includes(".part"))).toBe(false);
    // (one holds, five are told they're held)
    const told = await Promise.all(procs.map(async (p) => await new Response(p.stderr).text()));
    expect(told.filter((t) => t.includes("held: yonder")).length).toBe(5);
  });

  test("a section replaced in its place", () => {
    const body = "## Try\n\nold\n\n## Committed\n\nabc\n\n## Left\n\n";
    expect(setSection(body, "Try", "new")).toBe("## Try\n\nnew\n\n## Committed\n\nabc\n\n## Left\n");
    expect(setSection("## Left\n\nmore\n", "Try", "go")).toBe("## Try\n\ngo\n\n## Left\n\nmore\n");
    // (a heading of its own stays after the three, in its place)
    expect(setSection("## Notes\n\nn\n\n## Left\n\nl\n", "Try", "t")).toBe("## Try\n\nt\n\n## Left\n\nl\n\n## Notes\n\nn\n");
  });

  test("add, set, list", () => {
    const { root } = family();
    setRoot(root);
    try {
      const a = add("yonder", "Eight riddles", { status: "waiting-test", try: "Freewind at night" });
      expect(a.id).toBe("yonder-eight-riddles");
      expect(add("yonder", "Eight riddles").id).toBe("yonder-eight-riddles-2");
      const b = set("yonder-eight-riddles", { status: "ready-to-push", committed: "f4ab31a", session: "s1" });
      if (typeof b === "string") throw new Error(b);
      const back = parseCard(b.id, readFileSync(join(root, "board", `${b.id}.md`), "utf8"));
      expect(back).toMatchObject({ repo: "yonder", title: "Eight riddles", status: "ready-to-push", session: "s1" });
      expect(back.body).toBe("## Try\n\nFreewind at night\n\n## Committed\n\nf4ab31a\n\n## Left\n");
      expect(set("nope", {})).toContain("no card nope");
      set("yonder-eight-riddles-2", { status: "done" });
      expect(cards().map((c) => c.id)).toEqual(["yonder-eight-riddles"]);
      expect(cards(true)).toHaveLength(2);
      expect(lines(cards())[0]).toMatch(/^ready-to-push +yonder +yonder-eight-riddles +Eight riddles +0m$/);
      expect(readdirSync(join(root, "board"))).toHaveLength(2);
      expect(options(["--status", "later"])).toBeString();
      expect(options(["--nope"])).toBeString();
      expect(options(["--on", "x", "--status", "running"])).toBeString();
      expect(options(["--repos", " , "])).toBeString();
      // --on blocks a card on another; leaving blocked forgets it.
      const c = set("yonder-eight-riddles", { on: "wow-data-x", repos: "yonder, wow-data" });
      if (typeof c === "string") throw new Error(c);
      expect([c.status, c.waits, c.repos]).toEqual(["blocked", "wow-data-x", ["yonder", "wow-data"]]);
      expect(set("yonder-eight-riddles", { on: "yonder-eight-riddles" })).toContain("can't wait on itself");
      const d = set("yonder-eight-riddles", { status: "running" });
      if (typeof d === "string") throw new Error(d);
      // Running again: its wait forgotten, its place in each queue taken now, to the millisecond.
      const ms = d.updated.slice(0, 19);
      expect([d.status, d.waits, Object.keys(d.since)]).toEqual(["running", "", ["yonder", "wow-data"]]);
      expect(Object.values(d.since).every((t) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/.test(t) && t.startsWith(ms))).toBe(true);
      const e = set("yonder-eight-riddles", { committed: "abc" });
      if (typeof e === "string") throw new Error(e);
      expect(e.since).toEqual(d.since);
      // Widened, the new repository queues now, the others keep their place; written and read back so.
      Bun.sleepSync(1100);
      const f = set("yonder-eight-riddles", { repos: "yonder,wow-data,mealbook" });
      if (typeof f === "string") throw new Error(f);
      expect([f.since.yonder, f.since["wow-data"], f.since.mealbook!.startsWith(f.updated.slice(0, 19)), Date.parse(f.since.mealbook!) > Date.parse(d.since.yonder!)]).toEqual([d.since.yonder, d.since["wow-data"], true, true]);
      expect(parseCard(f.id, readFileSync(join(root, "board", `${f.id}.md`), "utf8")).since).toEqual(f.since);
      set("yonder-eight-riddles", { status: "ready-to-push" });
      mkdirSync(join(root, "yonder"), { recursive: true });
      expect(strangers(["yonder", "yondr"])).toEqual(["yondr"]);
      expect(existsSync(join(root, "board", "yonder-eight-riddles.md"))).toBe(true);
    } finally {
      resetRoot();
    }
  });
});
