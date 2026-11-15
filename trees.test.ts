// trees.ts: unpushed commits counted by patch, and a repository's linked worktrees (bun test).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absorbedBy, parseWorktrees, refsToAsk, treeState, unpushed, worktreesOf } from "./trees";

const GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const g = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: GIT, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};

let tmp = "";
let n = 0;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "harness-trees-")));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A repository on main with one pushed commit, its remote beside it. */
function repo() {
  const dir = join(tmp, `repo-${++n}`);
  const remote = join(tmp, `remote-${n}.git`);
  mkdirSync(dir);
  g(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "base.txt"), "base\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "chore: first");
  g(tmp, "init", "-q", "--bare", remote);
  g(dir, "remote", "add", "origin", remote);
  g(dir, "push", "-q", "origin", "main");
  return { dir, remote };
}
const commit = (dir: string, file: string, text: string, msg: string, date?: string) => {
  writeFileSync(join(dir, file), text);
  g(dir, "add", "-A");
  const p = Bun.spawnSync(["git", "commit", "-q", "-m", msg], { cwd: dir, env: { ...GIT, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};

/** What a rebase merge does on the remote: the branch's commits replayed on main's tip, new ids, pushed. `tweak` changes a replayed commit (a conflict resolved on the way). */
function rebaseMerge(dir: string, branch: string, tweak?: (dir: string, subject: string) => void) {
  const back = g(dir, "rev-parse", "--abbrev-ref", "HEAD");
  g(dir, "checkout", "-q", "main");
  // (main moved on meanwhile, so a replay is no fast-forward)
  commit(dir, "other.txt", `other ${Math.random()}\n`, "feat: someone else's work");
  for (const c of g(dir, "rev-list", "--reverse", "--no-merges", `origin/main..${branch}`).split("\n").filter(Boolean)) {
    if (!tweak) {
      g(dir, "cherry-pick", c);
      continue;
    }
    g(dir, "cherry-pick", "-n", c);
    tweak(dir, g(dir, "log", "-1", "--format=%s", c));
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-C", c);
  }
  g(dir, "push", "-q", "origin", "main");
  g(dir, "checkout", "-q", back);
}

describe("unpushed: by patch, not by id", () => {
  test("a real unpushed commit counts, a pushed one doesn't, no remote says -1", () => {
    const { dir } = repo();
    expect(unpushed(dir)).toBe(0);
    g(dir, "checkout", "-q", "-b", "side");
    commit(dir, "work.txt", "work\n", "feat: work");
    expect(unpushed(dir)).toBe(1);
    commit(dir, "more.txt", "more\n", "feat: more");
    expect(unpushed(dir)).toBe(2);
    g(dir, "push", "-q", "origin", "side");
    expect(unpushed(dir)).toBe(0);
    const bare = join(tmp, `bare-${++n}`);
    mkdirSync(bare);
    g(bare, "init", "-q", "-b", "main");
    commit(bare, "a.txt", "a\n", "chore: a");
    expect(unpushed(bare)).toBe(-1);
  });

  test("a commit rebase-merged into the remote's main reads pushed, though its id is not there", () => {
    const { dir } = repo();
    g(dir, "checkout", "-q", "-b", "side");
    commit(dir, "work.txt", "work\n", "feat: work");
    commit(dir, "more.txt", "more\n", "feat: more");
    expect(unpushed(dir)).toBe(2);
    rebaseMerge(dir, "side");
    // (by id they are on no remote: that is the bug this fixes)
    expect(g(dir, "rev-list", "--count", "HEAD", "--not", "--remotes")).toBe("2");
    expect(unpushed(dir)).toBe(0);
    // a new commit after the merge is still the child's own
    commit(dir, "after.txt", "after\n", "feat: after");
    expect(unpushed(dir)).toBe(1);
  });

  test("a patch the rebase changed (a conflict resolved, a squash) still counts", () => {
    const { dir } = repo();
    g(dir, "checkout", "-q", "-b", "side");
    commit(dir, "work.txt", "work\n", "feat: work");
    commit(dir, "more.txt", "more\n", "feat: more");
    rebaseMerge(dir, "side", (d, subject) => {
      if (subject === "feat: more") writeFileSync(join(d, "more.txt"), "more, changed in the rebase\n");
    });
    // work.txt's patch is on main as it was, more.txt's isn't
    expect(unpushed(dir)).toBe(1);
  });

  test("a merge of main into the branch is no work of the child's", () => {
    const { dir } = repo();
    g(dir, "checkout", "-q", "-b", "side");
    commit(dir, "work.txt", "work\n", "feat: work");
    g(dir, "checkout", "-q", "main");
    commit(dir, "main-only.txt", "m\n", "feat: on main");
    g(dir, "push", "-q", "origin", "main");
    g(dir, "checkout", "-q", "side");
    g(dir, "merge", "-q", "--no-ff", "-m", "merge main into side", "main");
    // by id: the work and the merge are on no remote
    expect(g(dir, "rev-list", "--count", "HEAD", "--not", "--remotes")).toBe("2");
    expect(unpushed(dir)).toBe(1);
    rebaseMerge(dir, "side");
    expect(unpushed(dir)).toBe(0);
  });

  test("the window: only commits since the child started", () => {
    const { dir } = repo();
    g(dir, "checkout", "-q", "-b", "side");
    commit(dir, "old.txt", "old\n", "feat: older work", "2026-01-01T10:00:00Z");
    commit(dir, "new.txt", "new\n", "feat: this task's work", "2026-11-15T10:00:00Z");
    expect(unpushed(dir)).toBe(2);
    expect(unpushed(dir, "2026-11-15T09:00:00Z")).toBe(1);
    expect(unpushed(dir, "2026-11-16T00:00:00Z")).toBe(0);
  });

  test("a rebase that moved the context lines (a patch id misses it) still reads pushed, and only the work that is not there counts", () => {
    const { dir } = repo();
    writeFileSync(join(dir, "f.txt"), Array.from({ length: 12 }, (_, i) => `${i + 1}`).join("\n") + "\n");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "chore: a file");
    g(dir, "push", "-q", "origin", "main");
    const edit = (from: string, to: string) => writeFileSync(join(dir, "f.txt"), readFileSync(join(dir, "f.txt"), "utf8").replace(new RegExp(`^${from}$`, "m"), to));
    g(dir, "checkout", "-q", "-b", "side");
    edit("6", "six");
    g(dir, "commit", "-q", "-am", "feat: six");
    g(dir, "checkout", "-q", "main");
    edit("4", "four");
    g(dir, "commit", "-q", "-am", "feat: someone else's four");
    g(dir, "cherry-pick", "side");
    g(dir, "push", "-q", "origin", "main");
    g(dir, "checkout", "-q", "side");
    // git cherry sees another patch (its context has the line main changed): the content is what counts
    expect(g(dir, "cherry", "origin/main", "HEAD")).toStartWith("+");
    expect(absorbedBy(dir, "refs/remotes/origin/main")).toBe(true);
    expect(unpushed(dir)).toBe(0);
    // one more commit of the child's own: not absorbed, and counted
    commit(dir, "own.txt", "own\n", "feat: own");
    expect(absorbedBy(dir, "refs/remotes/origin/main")).toBe(false);
    expect(unpushed(dir)).toBe(1);
  });

  test("a local merge of a branch that was rebase-merged since leaves the child's own older work counted", () => {
    const { dir } = repo();
    g(dir, "checkout", "-q", "-b", "side");
    commit(dir, "a.txt", "a\n", "feat: a, never pushed", "2026-11-15T10:00:00Z");
    g(dir, "checkout", "-q", "main");
    g(dir, "checkout", "-q", "-b", "y");
    commit(dir, "b.txt", "b\n", "feat: b, from another branch", "2026-11-15T11:00:00Z");
    // y is rebase-merged into the remote's main: b is there under another id
    g(dir, "checkout", "-q", "main");
    g(dir, "cherry-pick", "y");
    g(dir, "push", "-q", "origin", "main");
    // the child merges y locally: its history now holds a (its own), b (merged by id elsewhere) and the merge
    g(dir, "checkout", "-q", "side");
    g(dir, "merge", "-q", "--no-ff", "-m", "merge y", "y");
    expect(g(dir, "rev-list", "--count", "HEAD", "--not", "--remotes")).toBe("3");
    // a exists nowhere but here: a close must not read it as pushed
    expect(unpushed(dir)).toBe(1);
  });

  test("an upstream that is a local branch is no remote", () => {
    const { dir } = repo();
    g(dir, "checkout", "-q", "-b", "side", "--track", "main");
    commit(dir, "w.txt", "w\n", "feat: work");
    g(dir, "checkout", "-q", "main");
    g(dir, "merge", "-q", "--ff-only", "side");
    g(dir, "checkout", "-q", "side");
    expect(g(dir, "rev-parse", "--symbolic-full-name", "@{u}")).toBe("refs/heads/main");
    expect(refsToAsk(dir)).toEqual(["refs/remotes/origin/main"]);
    // in the local main, not on any remote: still to push
    expect(unpushed(dir)).toBe(1);
  });

  test("a merge commit alone, carrying what no branch has, is still something to push", () => {
    const { dir } = repo();
    g(dir, "checkout", "-q", "-b", "other");
    commit(dir, "o.txt", "o\n", "feat: other");
    g(dir, "push", "-q", "origin", "other");
    g(dir, "checkout", "-q", "main");
    commit(dir, "m.txt", "m\n", "feat: main");
    g(dir, "push", "-q", "origin", "main");
    // a local merge of the pushed branch into main: every commit of it is on a remote, the merge is on none
    g(dir, "merge", "-q", "--no-ff", "-m", "merge other", "other");
    expect(g(dir, "rev-list", "--count", "HEAD", "--not", "--remotes")).toBe("1");
    expect(unpushed(dir)).toBe(1);
    g(dir, "push", "-q", "origin", "main");
    expect(unpushed(dir)).toBe(0);
  });

  test("the branches asked: the upstream first, then each remote's default branch", () => {
    const { dir } = repo();
    g(dir, "checkout", "-q", "-b", "side");
    commit(dir, "w.txt", "w\n", "feat: w");
    g(dir, "push", "-q", "-u", "origin", "side");
    // no origin/HEAD: main is the default it finds
    expect(refsToAsk(dir)).toEqual(["refs/remotes/origin/side", "refs/remotes/origin/main"]);
    g(dir, "push", "-q", "origin", "main:refs/heads/trunk");
    g(dir, "fetch", "-q", "origin");
    g(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    // origin/HEAD names it, and the others are not asked
    expect(refsToAsk(dir)).toEqual(["refs/remotes/origin/side", "refs/remotes/origin/trunk"]);
    // (a branch with no upstream asks the default alone)
    g(dir, "checkout", "-q", "main");
    expect(refsToAsk(dir)).toEqual(["refs/remotes/origin/trunk"]);
  });
});

describe("worktrees", () => {
  test("parseWorktrees reads git's porcelain blocks, the main checkout first", () => {
    const text = "worktree /p/main\nHEAD aaaa\nbranch refs/heads/main\n\nworktree /p/wt\nHEAD bbbb\nbranch refs/heads/side\n\nworktree /p/loose\nHEAD cccc\ndetached\n\nworktree /p/gone\nHEAD dddd\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n";
    expect(parseWorktrees(text)).toEqual([
      { path: "/p/main", head: "aaaa", branch: "main", prunable: false },
      { path: "/p/wt", head: "bbbb", branch: "side", prunable: false },
      { path: "/p/loose", head: "cccc", prunable: false },
      { path: "/p/gone", head: "dddd", branch: "x", prunable: true },
    ]);
  });

  test("worktreesOf lists the linked ones with their own dirty and unpushed work, a gone one skipped", () => {
    const { dir } = repo();
    expect(worktreesOf(dir)).toEqual([]);
    const wt = join(tmp, `wt-${++n}`);
    g(dir, "worktree", "add", "-q", "-b", "side", wt);
    const gone = join(tmp, `wt-${++n}`);
    g(dir, "worktree", "add", "-q", "-b", "lost", gone);
    rmSync(gone, { recursive: true, force: true });
    commit(wt, "work.txt", "work\n", "feat: work");
    writeFileSync(join(wt, "dirty.txt"), "d\n");
    writeFileSync(join(wt, "dirty2.txt"), "d\n");
    const trees = worktreesOf(dir);
    expect(trees.map((t) => [t.path, t.branch])).toEqual([[wt, "side"]]);
    expect(treeState(trees[0]!)).toMatchObject({ path: wt, branch: "side", dirty: 2, ahead: 1 });
    // the main checkout's own work isn't a worktree's
    writeFileSync(join(dir, "main-dirty.txt"), "x\n");
    expect(treeState(worktreesOf(dir)[0]!)).toMatchObject({ dirty: 2, ahead: 1 });
  });
});
