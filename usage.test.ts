// usage.ts: the cost of a session read from transcripts (fixtures in a temp folder).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseline, commitCount, commitRuns, commitSegments, costOf, gitCommits, type CommitRun, family, line, projectDirs, sessionFiles, spend, spendOf, summarise, turns, units, zero } from "./usage";
import { useBoardGuard, useFixtureRoot, writeFamilyConfig } from "./testing";
useFixtureRoot();
useBoardGuard();


let tmp: string;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "usage-test-")));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const msg = (id: string, model: string, ts: string, u: Partial<Record<string, number>>, req = `r${id}`) =>
  JSON.stringify({ type: "assistant", timestamp: ts, requestId: req, message: { id, model, usage: u } });

describe("usage", () => {
  test("units: dollars at list price, the cache write at its rate", () => {
    const t = { in: 1e6, out: 1e6, cacheWrite: 2e6, cacheWrite1h: 1e6, cacheRead: 1e6, msgs: 1 };
    // opus: 4 + 20 + 0.2 + one million five-minute writes (5) + one million an hour (8)
    expect(units(t, "claude-opus-5-5")).toBeCloseTo(4 + 20 + 0.2 + 5 + 8);
    expect(units(t, "claude-sonnet-5-5")).toBeCloseTo(2 + 10 + 0.2 + 2.5 + 4);
    expect(units(t, "<synthetic>")).toBe(0);
    expect(family("claude-haiku-5-5")).toBe("haiku");
    expect(family("claude-mythos-5-1")).toBe("fable");
    expect(family("<synthetic>")).toBe("other");
  });

  test("commitSegments: git commit segments, an --amend and each.ts included", () => {
    expect(commitSegments("git -C yonder commit -qm x")).toBe(1);
    expect(commitSegments("git -C palaver commit -qm a && git -C addon-kit commit -qm b")).toBe(2);
    expect(commitSegments("cd a && git add -A && git commit -qm x")).toBe(1);
    expect(commitSegments("git commit --amend --no-edit")).toBe(1);
    expect(commitSegments("bun addon-kit/each.ts --all -- git commit -qm x")).toBe(1);
    expect(commitSegments('cat <<E\ngit(repo, "commit", "-m")\nE')).toBe(0);
    expect(commitSegments("git log --oneline | grep commit")).toBe(0);
    expect(commitSegments("git --no-pager log --grep commit")).toBe(0);
    expect(commitSegments("git -c user.name=t commit -qm x")).toBe(1);
  });

  const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 10, 0, s)).toISOString();
  const use = (id: string, command: string, s: number) => JSON.stringify({ type: "assistant", timestamp: at(s), message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const res = (id: string, s: number, isError = false) => JSON.stringify({ type: "user", timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "x" }] } });

  test("commitRuns / commitCount: the fallback counts the segments of commands that did not fail", () => {
    const lines = [
      use("1", "git -C yonder commit -qm 'feat: x'", 0),
      res("1", 1),
      use("2", "git commit -qm 'feat: y'", 2),
      res("2", 3, true),
      use("3", "git log --oneline | grep commit", 4),
      res("3", 5),
      use("4", "git -C a commit -qm z && git -C b commit -qm z", 6),
      res("4", 7),
      res("9", 8),
    ];
    expect(commitRuns(lines)).toHaveLength(3);
    expect(commitRuns(lines)[1]).toMatchObject({ failed: true, segments: 1 });
    expect(commitCount(lines)).toBe(3);
  });

  describe("gitCommits: git counts what the commands made", () => {
    const base = Math.floor(Date.UTC(2026, 9, 25, 10, 0, 0) / 1000);
    const dirs: string[] = [];
    const repo = (name: string, commits: { s: number; email?: string; amend?: boolean; commitAt?: number }[]) => {
      const dir = mkdtempSync(join(tmpdir(), `usage-${name}-`));
      dirs.push(dir);
      const git = (env: Record<string, string>, ...a: string[]) => {
        const r = Bun.spawnSync(["git", "-C", dir, ...a], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      };
      git({}, "init", "-q", "-b", "main");
      git({}, "config", "user.email", "me@x");
      git({}, "config", "user.name", "me");
      commits.forEach((c, i) => {
        const when = `${base + c.s} +0000`;
        const env = { GIT_COMMITTER_DATE: `${base + (c.commitAt ?? c.s)} +0000`, GIT_AUTHOR_DATE: when, GIT_COMMITTER_EMAIL: c.email ?? "me@x", GIT_AUTHOR_EMAIL: c.email ?? "me@x", GIT_COMMITTER_NAME: "n", GIT_AUTHOR_NAME: "n" };
        writeFileSync(join(dir, "f"), String(i));
        git(env, "add", "f");
        git(env, "commit", "-q", ...(c.amend ? ["--amend"] : []), "-m", `c${i}`);
      });
      return dir;
    };
    afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
    const run = (from: number, to: number, segments = 1, failed = false): CommitRun => ({ from: (base + from) * 1000, to: (base + to) * 1000, segments, failed });

    test("two repositories in one command are two commits", () => {
      const a = repo("a", [{ s: 5 }]);
      const b = repo("b", [{ s: 6 }]);
      expect(gitCommits([a, b], [run(4, 8, 2)])).toBe(2);
    });
    test("a later segment's failure does not drop a commit that landed", () => {
      const a = repo("a", [{ s: 5 }]);
      expect(gitCommits([a], [run(4, 9, 1, true)])).toBe(1);
    });
    test("each.ts across nine repositories counts nine", () => {
      const rs = Array.from({ length: 9 }, (_, i) => repo(`r${i}`, [{ s: 5 + (i % 3) }]));
      expect(gitCommits(rs, [run(4, 12)])).toBe(9);
    });
    test("an --amend replaces the commit it amended", () => {
      const a = repo("a", [{ s: 5 }, { s: 5, commitAt: 20, amend: true }]);
      expect(gitCommits([a], [run(4, 6), run(19, 21)])).toBe(1);
    });
    test("a rebased commit (committer time moved) still counts", () => {
      const a = repo("a", [{ s: 5, commitAt: 300 }]);
      expect(gitCommits([a], [run(4, 8)])).toBe(1);
    });
    test("a run with no time (a line without its timestamp) counts as the transcript does", () => {
      const a = repo("a", [{ s: 5 }]);
      const untimed = (failed = false): CommitRun => ({ from: Number.NaN, to: Number.NaN, segments: 1, failed });
      expect(gitCommits([a], [untimed()])).toBeUndefined();
      expect(gitCommits([a], [untimed(), run(4, 6)])).toBe(2);
      expect(gitCommits([a], [untimed(true), run(4, 6)])).toBe(1);
    });
    test("a hook's refusal committed nothing", () => {
      const a = repo("a", []);
      expect(gitCommits([a], [run(4, 6, 1, true)])).toBe(0);
    });
    test("commits outside the commands' runs and the bot's are not counted", () => {
      const a = repo("a", [{ s: 5 }, { s: 500 }, { s: 6, email: "bot@jobs" }]);
      expect(gitCommits([a], [run(4, 8)])).toBe(1);
    });
    test("no repository answering is undefined, no runs is zero", () => {
      expect(gitCommits(["/nonexistent-dir-x"], [run(0, 1)])).toBeUndefined();
      expect(gitCommits(["/nonexistent-dir-x"], [])).toBe(0);
    });
  });

  test("turns: each message once, noise skipped", () => {
    const seen = new Set<string>();
    const lines = [
      msg("a", "claude-opus-5-5", "2026-10-25T10:00:00Z", { output_tokens: 10, cache_read_input_tokens: 100 }),
      msg("a", "claude-opus-5-5", "2026-10-25T10:00:01Z", { output_tokens: 10, cache_read_input_tokens: 100 }),
      "not json with \"usage\"",
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      msg("b", "claude-opus-5-5", "2026-10-25T10:01:00Z", { input_tokens: 5 }),
    ];
    const got = turns(lines, seen);
    expect(got.map((t) => t.id)).toEqual(["a|ra", "b|rb"]);
    expect(got[0]!.tally).toEqual({ in: 0, out: 10, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 100, msgs: 1 });
    // a second file of the same session, the same message: not counted again
    expect(turns([lines[0]!], seen)).toEqual([]);
  });

  test("a session: its main file, its helpers by type, the cache", () => {
    const projects = join(tmp, "config", "projects");
    const root = join(tmp, "family");
    const dir = join(projects, root.replace(/[/.]/g, "-"));
    const wt = join(projects, root.replace(/[/.]/g, "-") + "--claude-worktrees-x");
    mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
    mkdirSync(wt, { recursive: true });
    mkdirSync(join(projects, "-elsewhere"), { recursive: true });
    writeFileSync(
      join(dir, "s1.jsonl"),
      [msg("m1", "claude-sonnet-5-5", "2026-10-25T10:00:00Z", { output_tokens: 100, cache_read_input_tokens: 10_000 }), msg("m2", "claude-sonnet-5-5", "2026-10-25T10:30:00Z", { output_tokens: 100, cache_read_input_tokens: 30_000 })].join("\n"),
    );
    writeFileSync(join(dir, "s1", "subagents", "agent-x.jsonl"), msg("h1", "claude-opus-5-5", "2026-10-25T10:10:00Z", { output_tokens: 50 }));
    writeFileSync(join(dir, "s1", "subagents", "agent-x.meta.json"), JSON.stringify({ agentType: "reviewer" }));

    expect(projectDirs(root, join(tmp, "config"))).toEqual([dir, wt]);
    const files = sessionFiles([dir], "s1");
    expect(files.map((f) => f.kind)).toEqual(["main", "helper:reviewer"]);
    expect(sessionFiles([dir], "nope")).toEqual([]);

    const s = spend(files)!;
    expect(s.turns).toBe(2);
    expect(s.contextPerTurn).toBe(20_000);
    expect(s.first).toBe("2026-10-25T10:00:00Z");
    expect(s.last).toBe("2026-10-25T10:30:00Z");
    expect(s.helpers).toEqual({ reviewer: 1 });
    expect(s.by.main).toBeCloseTo(0.01);
    expect(s.by["helper:reviewer"]).toBeCloseTo(0.001);
    expect(Object.keys(s.models).sort()).toEqual(["opus", "sonnet"]);

    const cache = join(tmp, "cache");
    expect(spendOf([dir], "s1", cache)!.units).toBeCloseTo(s.units);
    // the cached copy is served until a transcript changes
    writeFileSync(join(cache, "s1.json"), JSON.stringify({ key: JSON.parse(readFileSync(join(cache, "s1.json"), "utf8")).key, spend: { ...s, units: 7 } }));
    expect(spendOf([dir], "s1", cache)!.units).toBe(7);
    writeFileSync(join(dir, "s1.jsonl"), msg("m9", "claude-opus-5-5", "2026-10-25T11:00:00Z", { output_tokens: 1 }));
    expect(spendOf([dir], "s1", cache)!.units).toBeCloseTo(0.00102);
    expect(spendOf([dir], "ghost", cache)).toBeUndefined();
    expect(spend([])).toBeUndefined();
  });

  test("a card's cost: the session's commits, several cards sharing it", () => {
    const sp = { by: { main: 9, "helper:reviewer": 1 }, models: { opus: zero() }, units: 10, first: "2026-10-25T10:00:00Z", last: "2026-10-25T10:30:00Z", turns: 4, contextPerTurn: 50_000, helpers: { reviewer: 1 }, commitRuns: [], commits: 4 };
    const cards = [
      { id: "a", title: "One", status: "done", repos: ["r"], repo: "r", session: "s" },
      { id: "b", title: "Two", status: "done", repos: ["r"], repo: "r", session: "s" },
    ] as any;
    // no repository answering: the transcript's count stands in
    expect(costOf(cards, sp, () => undefined, (r) => r).commits).toBe(4);
    // git's count wins, asked about the card's repositories
    let asked: string[] = [];
    const c = costOf(cards, sp, (dirs) => ((asked = dirs), 5), (r) => `/x/${r}`);
    expect(asked).toEqual(["/x/r"]);
    expect(c.commits).toBe(5);
    expect(c.unitsPerCommit).toBe(2);
    expect(c.helperShare).toBeCloseTo(0.1);
    expect(c.cards).toBe(2);
    expect(c.status).toBe("done");
    expect(costOf([{ ...cards[0], status: "running" }, cards[1]], sp, () => 4).status).toBe("running");

    const sum = summarise([c, { ...c, session: "t", cards: 1, units: 8, commits: 4, unitsPerCommit: 2 }], [sp as any], ["lost"], "2026-10-25T20:00:00Z");
    expect(sum).toMatchObject({ sessions: 2, cards: 3, done: 3, commits: 9 });
    // (per card: 5, 5 and 8)
    expect(sum.medianUnitsPerDoneCard).toBe(5);
    expect(line(sum)).toContain("2 sessions, 3 cards (3 done)");
    expect(baseline([c], sum)).toContain("# Usage baseline, 2026-10-25");
  });
});
