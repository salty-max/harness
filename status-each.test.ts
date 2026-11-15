// status.ts's and each.ts's pure parts (bun test).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argvOf, parse, pick, unknown } from "./each";
import { scopedRoot, useBoardGuard } from "./testing";
import { attention, latestPerWorkflow, read, slugOf, treeAttention, type Repo, type Run } from "./status";

useBoardGuard();

describe("status", () => {
  test("a GitHub remote, ssh or https", () => {
    expect(slugOf("git@github.com:salty-max/palaver.git")).toBe("salty-max/palaver");
    expect(slugOf("https://github.com/salty-max/wow-data")).toBe("salty-max/wow-data");
    expect(slugOf("https://example.com/x/y.git")).toBeUndefined();
  });

  test("each workflow's newest run", () => {
    const run = (workflow: string, conclusion: string, sha: string): Run => ({ workflow, status: "completed", conclusion, sha, at: "" });
    const latest = latestPerWorkflow([run("CI", "failure", "b"), run("Game data", "success", "b"), run("CI", "success", "a")]);
    expect(latest.map((r) => `${r.workflow} ${r.conclusion}`)).toEqual(["CI failure", "Game data success"]);
  });

  test("what wants a hand", () => {
    const r: Repo = {
      name: "palaver",
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 0,
      dirty: 1,
      head: "",
      runs: [{ workflow: "CI", status: "completed", conclusion: "failure", sha: "1234567890", at: "" }],
      prs: [{ number: 8, title: "chore: players' facts" }],
      extra: { column: "zip −1", attention: ["test build Palaver-x.zip is 1 commit behind HEAD"] },
    };
    expect(attention(r)).toEqual([
      "1 file uncommitted",
      "2 commits to push",
      "CI: failure (1234567)",
      "pull request #8 open: chore: players' facts",
      "test build Palaver-x.zip is 1 commit behind HEAD",
    ]);
    expect(attention({ ...r, ahead: 0, dirty: 0, runs: [], prs: [], extra: undefined })).toEqual([]);
    expect(attention({ ...r, upstream: undefined, ahead: 0, dirty: 0, runs: [], prs: [], extra: undefined })).toEqual([
      "no upstream (local only)",
    ]);
  });
});

describe("status: worktrees", () => {
  const GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd, env: GIT, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };

  test("a worktree with uncommitted files or unpushed commits wants a hand, a clean one doesn't", () => {
    const t = { path: "/w/side", head: "abc", branch: "side" };
    expect(treeAttention({ ...t, dirty: 3, ahead: 2 })).toEqual(["worktree side (/w/side): 3 files uncommitted, 2 commits to push"]);
    expect(treeAttention({ ...t, dirty: 1, ahead: 0 })).toEqual(["worktree side (/w/side): 1 file uncommitted"]);
    expect(treeAttention({ ...t, dirty: 0, ahead: 1 })).toEqual(["worktree side (/w/side): 1 commit to push"]);
    // nothing in it, or no remote to say (-1): nothing to ask
    expect(treeAttention({ ...t, dirty: 0, ahead: 0 })).toEqual([]);
    expect(treeAttention({ ...t, dirty: 0, ahead: -1 })).toEqual([]);
    expect(treeAttention({ path: "/w/x", head: "abc", dirty: 1, ahead: 0 })).toEqual(["worktree (detached) (/w/x): 1 file uncommitted"]);
  });

  test("read() carries each linked worktree's own state, and attention lists it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "status-wt-")));
    writeFileSync(join(root, "harness.toml"), "");
    const repo = join(root, "repo");
    mkdirSync(repo);
    g(repo, "init", "-q", "-b", "main");
    g(repo, "commit", "-q", "--allow-empty", "-m", "chore: first");
    const remote = join(root, "remote.git");
    g(root, "init", "-q", "--bare", remote);
    g(repo, "remote", "add", "origin", remote);
    g(repo, "push", "-q", "-u", "origin", "main");
    const restore = scopedRoot(root);
    try {
      expect((await read("repo", false)).trees).toBeUndefined();
      const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "status-wt2-"))), "kid");
      g(repo, "worktree", "add", "-q", "-b", "side", wt);
      writeFileSync(join(wt, "work.txt"), "x\n");
      g(wt, "add", "-A");
      g(wt, "commit", "-q", "-m", "feat: work");
      writeFileSync(join(wt, "more.txt"), "y\n");
      const r = await read("repo", false);
      expect(r.trees).toMatchObject([{ path: wt, branch: "side", dirty: 1, ahead: 1 }]);
      // (the main checkout itself is clean and level with origin)
      expect(r).toMatchObject({ dirty: 0, ahead: 0 });
      expect(attention(r)).toContain(`worktree side (${wt}): 1 file uncommitted, 1 commit to push`);
      // once its commit is pushed the branch has nothing of its own left, and nothing is asked
      g(wt, "add", "-A");
      g(wt, "commit", "-q", "-m", "feat: more");
      g(wt, "push", "-q", "origin", "side");
      expect(attention(await read("repo", false)).some((l) => l.startsWith("worktree"))).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("each", () => {
  const names = ["addon-kit", "keyring", "palaver", "wow-data"];
  const groups: Record<string, string[]> = { addons: ["keyring", "palaver"], kit: ["palaver"] };
  const test_ = (g: string, n: string) => groups[g]?.includes(n) ?? false;

  test("the command after --", () => {
    expect(parse(["--kit", "--", "bun", "run", "check"])).toMatchObject({ which: "kit", command: ["bun", "run", "check"] });
    // (the words as given, no shell between; one word alone a shell line)
    expect(argvOf(["printf", "[%s]", "two words"])).toEqual(["printf", "[%s]", "two words"]);
    expect(argvOf(["git status && git log -1"])).toEqual(["/bin/sh", "-c", "git status && git log -1"]);
    const o = parse(["--only", "yonder,yondr", "--", "x"]) as Exclude<ReturnType<typeof parse>, string>;
    expect(unknown(["yonder", "keyring"], o)).toEqual(["yondr"]);
    expect(parse(["--kit"])).toBe("give the command after --");
    expect(parse(["--nope", "--", "x"])).toBe("unknown option --nope");
    expect(parse(["--only", "--", "x"])).toBe("--only takes folder names, a,b");
  });

  test("which repositories", () => {
    const o = (argv: string[]) => parse([...argv, "--", "x"]) as Exclude<ReturnType<typeof parse>, string>;
    expect(pick(names, o([]), test_)).toEqual(["keyring", "palaver"]);
    expect(pick(names, o(["--kit"]), test_)).toEqual(["palaver"]);
    expect(pick(names, o(["--group", "kit"]), test_)).toEqual(["palaver"]);
    expect(pick(names, o(["--all", "--skip", "wow-data"]), test_)).toEqual(["addon-kit", "keyring", "palaver"]);
    expect(pick(names, o(["--only", "wow-data,nope"]), test_)).toEqual(["wow-data"]);
  });
});


describe("hints", () => {
  test("the q command a hint names is typed inside the repository: its path from there", () => {
    const root = mkdtempSync(join(tmpdir(), "hint-test-"));
    mkdirSync(join(root, "palaver", ".git"), { recursive: true });
    writeFileSync(join(root, "harness.toml"), '[tools]\ndir = "addon-kit"\n');
    const restore = scopedRoot(root);
    try {
      const r: Repo = { name: "palaver", branch: "main", upstream: "origin/main", ahead: 1, behind: 0, dirty: 0, head: "", checked: false, check: "bun run check" };
      expect(attention(r)).toEqual(["1 commit to push", "no passing check on HEAD's tree (bun ../addon-kit/q.ts check -- bun run check)"]);
    } finally {
      restore();
    }
  });
});
