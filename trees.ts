/**
 * What a repository's trees hold: the commits no remote has, and the linked
 * worktrees beside the main checkout with what each carries. session.ts
 * (whether a child may close) and status.ts read it; the desktop pane reads
 * it too, through the project's own copy.
 *
 * Unpushed is counted by content, never by id. A branch rebase-merged into the
 * remote's (a project that merges pull requests by rebase) keeps its own
 * commits, new ids on the other side: by id they read unpushed for good. So,
 * of the commits of HEAD that no remote has by id (a commit that changes
 * nothing has nothing to lose, so a branch of such commits alone is 0 too):
 *   1. none is left when merging HEAD into the remote's branch changes nothing
 *      (`git merge-tree --write-tree` gives that branch's own tree): its work is
 *      there, whatever the rebase did to the commits, their order or their
 *      context lines (a patch id, `git cherry`, takes the context in and misses
 *      those). Merge commits are no work of their own: a merge of the main
 *      branch into a child's, or a merged pull request's, is absorbed with the rest;
 *   2. else the commits are counted: the oldest ones that merging into the
 *      branch changes nothing for are set aside (the same test, commit by
 *      commit, newest first), then those whose patch a remote branch has
 *      (`git cherry`, a `-` line), so a branch half merged counts its other half. A patch changed on the way (a conflict resolved
 *      differently, a squash) has another id and counts: the safe side. A merge
 *      commit alone, carrying a resolution no branch has, is one.
 * The branches asked are HEAD's upstream (when it is a remote-tracking branch) and each remote's default branch
 * (what a pull request merges into): few, and the ones a merge reaches. A
 * remote not fetched since the merge still reads unpushed: fetch first.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Commits asked one by one whether a branch has them already, at most (a long stack of unmerged work isn't walked). */
const MAX_PROBES = 12;

const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore" });
const lines = (r: { stdout: Buffer | Uint8Array | string }) =>
  r.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const first = (r: ReturnType<typeof git>) => (r.exitCode === 0 ? lines(r)[0] : undefined);

/** The remote-tracking branches a merge would have reached: HEAD's upstream, then each remote's default branch (its HEAD, else main or master where it has one). */
export function refsToAsk(dir: string): string[] {
  const out: string[] = [];
  const add = (r?: string) => {
    if (r && !out.includes(r)) out.push(r);
  };
  // (an upstream that is a local branch is no remote: only remote-tracking branches say what is pushed)
  const upstream = first(git(dir, "rev-parse", "--symbolic-full-name", "@{u}"));
  if (upstream?.startsWith("refs/remotes/")) add(upstream);
  for (const remote of lines(git(dir, "remote"))) {
    const head = first(git(dir, "symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`));
    if (head) add(head);
    else for (const b of ["main", "master"]) if (git(dir, "rev-parse", "--verify", "-q", `refs/remotes/${remote}/${b}`).exitCode === 0) add(`refs/remotes/${remote}/${b}`);
  }
  return out;
}

/** Whether merging `rev` (HEAD) into `ref` changes nothing there: its work is in `ref` already. Older git (no merge-tree --write-tree) answers no. */
export function absorbedBy(dir: string, ref: string, rev = "HEAD"): boolean {
  const merged = git(dir, "merge-tree", "--write-tree", "--no-messages", ref, rev);
  const tree = git(dir, "rev-parse", `${ref}^{tree}`);
  return merged.exitCode === 0 && tree.exitCode === 0 && lines(merged)[0] === lines(tree)[0];
}

/**
 * The commits of HEAD that no remote has (see above), committed since `since`
 * when given (a child's start: older ones are not its own). -1: no remote to
 * compare with, or git couldn't say.
 */
export function unpushed(dir: string, since?: string): number {
  const remote = git(dir, "remote");
  if (remote.exitCode !== 0 || lines(remote).length === 0) return -1;
  const window = since ? [`--since=${since}`] : [];
  const all = git(dir, "rev-list", ...window, "HEAD", "--not", "--remotes");
  if (all.exitCode !== 0) return -1;
  if (lines(all).length === 0) return 0;
  const refs = refsToAsk(dir);
  if (refs.some((ref) => absorbedBy(dir, ref))) return 0;
  const work = lines(git(dir, "rev-list", "--reverse", "--no-merges", ...window, "HEAD", "--not", "--remotes"));
  let left = work;
  for (const ref of refs) {
    // (the newest commit `ref` has already, and its own ancestors with it: not every commit dated before it, a merged side branch sits among them)
    for (let k = left.length - 1, probes = 0; k >= 0 && probes < MAX_PROBES; k--, probes++) {
      if (absorbedBy(dir, ref, left[k]!)) {
        const below = new Set(lines(git(dir, "rev-list", "--no-merges", left[k]!, "--not", "--remotes")));
        left = left.filter((c) => !below.has(c));
        break;
      }
    }
    if (left.length === 0) break;
    const cherry = git(dir, "cherry", ref, "HEAD");
    if (cherry.exitCode !== 0) continue;
    const there = new Set(lines(cherry).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()));
    left = left.filter((c) => !there.has(c));
  }
  // (only merges were on no remote, and what they brought isn't anywhere: still something to push)
  return left.length > 0 ? left.length : work.length === 0 ? 1 : 0;
}

/** A linked worktree: where it is, its branch (none when detached) and HEAD. */
export type Tree = { path: string; head: string; branch?: string };
/** What a worktree carries: the files changed in it and not committed, the commits no remote has (-1: no remote). */
export type TreeState = Tree & { dirty: number; ahead: number };

/** `git worktree list --porcelain`'s blocks, the main checkout first. */
export function parseWorktrees(text: string): (Tree & { prunable: boolean })[] {
  const out: (Tree & { prunable: boolean })[] = [];
  let cur: (Tree & { prunable: boolean }) | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), head: "", prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line.startsWith("prunable")) cur.prunable = true;
  }
  return out;
}

/** The linked worktrees of the repository whose main checkout is `dir`, the ones whose folder is still there (a gone one is git's to prune). */
export function worktreesOf(dir: string): Tree[] {
  // (a checkout whose .git is a folder with no worktrees in it has none: no git to spawn for it, for every repository of every read)
  const own = join(dir, ".git");
  if (existsSync(own) && statSync(own).isDirectory() && !existsSync(join(own, "worktrees"))) return [];
  const run = git(dir, "worktree", "list", "--porcelain");
  if (run.exitCode !== 0) return [];
  return parseWorktrees(run.stdout.toString())
    .slice(1)
    .filter((t) => !t.prunable && existsSync(t.path))
    .map(({ path, head, branch }) => ({ path, head, ...(branch ? { branch } : {}) }));
}

/** One worktree's own state: its changed files and its commits on no remote. */
export function treeState(t: Tree): TreeState {
  return { ...t, dirty: lines(git(t.path, "status", "--porcelain")).length, ahead: unpushed(t.path) };
}
