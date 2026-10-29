/**
 * A review's verdict, kept beside the check stamps: once the reviewer
 * helper has reported, the main session records what it said, and the
 * desktop panel shows it. The reviewer itself stays read-only.
 *
 * The review comes BEFORE the commit and attests a TREE: the working files
 * as they are when it is recorded (the tree the commit will hold, HEAD's own
 * when nothing is uncommitted). Commit those files unchanged and HEAD's tree
 * has the verdict; change them after and it has none.
 *
 *   bun review.ts <repo> "<verdict>"   recorded for the working tree
 *   bun review.ts <repo>               the verdict of HEAD's tree, if any
 *   bun review.ts <repo> --again "<verdict>"   replace that tree's verdict
 *   bun review.ts --push <local> <remote>   pre-push's question (exit 1: not reviewed)
 *
 *   bun review.ts yonder "clean"
 *   bun review.ts yonder "2 findings, fixed before the commit"
 *
 * The file: <git common dir>/harness/review-tree-<tree>, its first line
 * "verdict: <verdict>", then the head it was recorded on, the tree, when,
 * and the packet the reviewer read with its range's base and tip (HEAD's own
 * packet, else the newest one HEAD is built on). When that packet read the
 * working files (`read:` its tree) and the tree now differs, the fixes made
 * since are written down (`edited:`, a shortstat) and said, louder past
 * SMALL_FIX lines: a change that big wants a packet and a review of its own.
 * The panel counts a review only when its base is already on the upstream:
 * the review reached all a push sends. The pre-push hook asks `--push`: the
 * newest unpushed commit with a reviewed tree must be followed only by
 * commits of waived files (docs, TOCs, the kit's copies), and a push of
 * nothing but waived files needs none. Old `review-<head sha>` files still
 * count. The harness's event log gets a line (events.ts).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { logEvent, repoOf } from "./events";
import { packetRange, packetTree } from "./packet";
import { stampDir, workTree } from "./q";
import { loadConfig, repoDir, repoName } from "./config";

function git(cwd: string, ...args: string[]): string | undefined {
  const p = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
}

/** Changed lines since the packet's tree past which a fix is no small one. */
export const SMALL_FIX = 80;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type Review = { verdict: string; head: string; tree?: string; at?: string; packet?: string; base?: string; tip?: string; after?: string[]; edited?: string };

export function parseReview(text: string): Review | undefined {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m && !(m[1] in fields)) fields[m[1]] = m[2].trim();
  }
  return fields.verdict === undefined
    ? undefined
    : {
        verdict: fields.verdict,
        head: fields.head ?? "",
        tree: fields.tree,
        at: fields.at,
        packet: fields.packet,
        base: fields.base,
        tip: fields.tip,
        ...(fields.after ? { after: fields.after.split(" | ") } : {}),
        ...(fields.edited ? { edited: fields.edited } : {}),
      };
}

// The packet the reviewer read: HEAD's own, else the newest whose tip HEAD is
// built on and isn't pushed yet (one from an earlier push read none of what
// this one sends); none when no packet's range was written down (an older packet).
export function packetFor(top: string, head: string): { path: string; base: string; tip: string } | undefined {
  const dir = join(top, ".cache", "review");
  if (!existsSync(dir)) return undefined;
  const sent = git(top, "rev-parse", "--verify", "-q", "@{u}") ? ["@{u}"] : git(top, "remote") ? ["--remotes"] : null;
  const isPushed = (sha: string) => sent !== null && git(top, "rev-list", "--count", sha, "--not", ...sent) === "0";
  const files = readdirSync(dir)
    .filter((f) => /^[0-9a-f]{12}\.md$/.test(f))
    .map((f) => ({ path: join(dir, f), at: statSync(join(dir, f)).mtimeMs, isHead: f === `${head.slice(0, 12)}.md` }))
    .sort((a, b) => Number(b.isHead) - Number(a.isHead) || b.at - a.at);
  for (const f of files) {
    const r = packetRange(readFileSync(f.path, "utf8"));
    if (!r || (isPushed(r.tip) && r.tip !== head)) continue;
    if (r.tip === head || Bun.spawnSync(["git", "merge-base", "--is-ancestor", r.tip, head], { cwd: top, stderr: "ignore" }).exitCode === 0) return { path: f.path, ...r };
  }
  return undefined;
}

export function reviewOfTree(dir: string, tree: string | undefined, head?: string): Review | undefined {
  const stamps = stampDir(dir);
  if (!stamps || !tree) return undefined;
  for (const name of [`review-tree-${tree}`, ...(head && git(dir, "rev-parse", `${head}^{tree}`) === tree ? [`review-${head}`] : [])]) {
    const file = join(stamps, name);
    if (existsSync(file)) return parseReview(readFileSync(file, "utf8"));
  }
  return undefined;
}

/** The verdict of a commit's tree (HEAD's by default). */
export function reviewOf(dir: string, sha?: string): Review | undefined {
  const head = git(dir, "rev-parse", "--verify", "-q", `${sha ?? "HEAD"}^{commit}`);
  return head ? reviewOfTree(dir, git(dir, "rev-parse", `${head}^{tree}`), head) : undefined;
}

export function record(dir: string, verdict: string, again = false): Review | string {
  const head = git(dir, "rev-parse", "--verify", "-q", "HEAD");
  const stamps = stampDir(dir);
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (!head || !stamps || !top) return `${dir}: not a repository with a commit`;
  const one = verdict.replace(/\s+/g, " ").trim();
  if (!one) return "the verdict is empty";
  // The tree the commit will hold: the working files (untracked ones too, as q's check stamps them).
  const tree = workTree(top) ?? git(dir, "rev-parse", "HEAD^{tree}");
  if (!tree) return "no tree to record the verdict on";
  const old = reviewOfTree(dir, tree, head);
  if (old && !again) return `this tree already has a verdict (${old.verdict}): --again to overwrite it`;
  const p = packetFor(top, head);
  const after = p && p.tip !== head ? (git(top, "log", "--format=%h %s", `${p.tip}..${head}`) ?? "").split("\n").filter(Boolean) : [];
  const read = p ? packetTree(readFileSync(p.path, "utf8")) : undefined;
  const edited = read && read !== tree ? git(top, "diff", "--shortstat", read, tree) || "paths only" : undefined;
  const r: Review = {
    verdict: one,
    head,
    tree,
    at: new Date().toISOString(),
    packet: p?.path,
    base: p?.base,
    tip: p?.tip,
    ...(after.length ? { after } : {}),
    ...(edited ? { edited } : {}),
  };
  mkdirSync(stamps, { recursive: true });
  const lines = [
    `verdict: ${r.verdict}`,
    `head: ${r.head}`,
    `tree: ${r.tree}`,
    `at: ${r.at}`,
    ...(p ? [`packet: ${p.path}`, `base: ${p.base}`, `tip: ${p.tip}`] : []),
    ...(read ? [`read: ${read}`] : []),
    ...(after.length ? [`after: ${after.join(" | ")}`] : []),
    ...(edited ? [`edited: ${edited}`] : []),
  ];
  writeFileSync(join(stamps, `review-tree-${tree}`), lines.join("\n") + "\n");
  logEvent("review", "", repoOf(dir), `${head.slice(0, 7)} ${r.verdict}`);
  return r;
}

/** Lines changed in a `--shortstat` line. */
export const changedIn = (stat: string) => (stat.match(/(\d+) (?:insertion|deletion)/g) ?? []).reduce((n, s) => n + Number.parseInt(s), 0);

// ── pre-push's question ─────────────────────────────────────────────────────
// Files a push may carry with no review of their own: harness.toml [review] waive (docs by default) and, outside the repositories it excepts, the vendored copies it names (the family's: the kit's copies in an addon, never in addon-kit where they are the sources).
export function waived(file: string, repo: string, from?: string): boolean {
  const { waive, copies } = loadConfig(from).review;
  return waive.some((r) => r.test(file)) || (!copies.except.includes(repo) && copies.patterns.some((r) => r.test(file)));
}

/** Why a push of `local` past `remote` (a sha, or zeros: none) has no review, or undefined when it has one. */
export function pushProblem(dir: string, local: string, remote: string): string | undefined {
  const tip = git(dir, "rev-parse", "--verify", "-q", `${local}^{commit}`);
  if (!tip) return undefined;
  const known = /[^0]/.test(remote) ? git(dir, "rev-parse", "--verify", "-q", `${remote}^{commit}`) : undefined;
  const sent = (known ? git(dir, "rev-list", `${known}..${tip}`) : git(dir, "rev-list", tip, "--not", "--remotes"))?.split("\n").filter(Boolean) ?? [];
  if (!sent.length) return undefined;
  const repo = repoName(dir);
  const unwaived = (from: string) => (git(dir, "diff", "--name-only", from, tip) ?? "").split("\n").filter((f) => f && !waived(f, repo, dir));
  // (the verdict's packet must have read all that is sent: its base already on the remote, as the panel counts it)
  const reads = (r: Review) => r.base === EMPTY_TREE || (!!r.base && git(dir, "rev-list", "--count", r.base, ...(known ? ["--not", known] : ["--not", "--remotes"])) === "0");
  // (newest first: the first reviewed tree found, the commits above it must change waived files only)
  for (const c of sent) {
    const review = reviewOfTree(dir, git(dir, "rev-parse", `${c}^{tree}`), c);
    if (!review) continue;
    if (!reads(review)) return `${c.slice(0, 7)} is reviewed, but by a packet that began past what the remote has: make the packet over everything this push sends`;
    const rest = unwaived(c);
    return rest.length ? `${c.slice(0, 7)} is reviewed, but the commits after it change ${rest.slice(0, 4).join(", ")}${rest.length > 4 ? "…" : ""}` : undefined;
  }
  const oldest = sent[sent.length - 1]!;
  const files = unwaived(git(dir, "rev-parse", "--verify", "-q", `${oldest}^`) ?? EMPTY_TREE);
  return files.length ? `no commit it sends has a review (${files.slice(0, 4).join(", ")}${files.length > 4 ? "…" : ""})` : undefined;
}

if (import.meta.main) {
  const [repo, ...rest] = process.argv.slice(2);
  if (repo === "--push") {
    const problem = pushProblem(process.cwd(), rest[0] ?? "", rest[1] ?? "");
    if (problem) console.error(problem);
    process.exit(problem ? 1 : 0);
  }
  const again = rest.includes("--again");
  const words = rest.filter((w) => w !== "--again");
  if (!repo) {
    console.error('usage: bun review.ts <repo> [--again] ["<verdict>"]');
    process.exit(2);
  }
  const dir = isAbsolute(repo) || repo.startsWith(".") ? resolve(repo) : repoDir(repo);
  if (!words.length) {
    const r = reviewOf(dir);
    console.log(r ? `${r.verdict} (${r.at ?? "?"})` : "no verdict for HEAD");
  } else {
    const r = record(dir, words.join(" "), again);
    if (typeof r === "string") {
      console.error(r);
      process.exit(1);
    }
    console.log(`${repo} ${r.head.slice(0, 7)}: ${r.verdict}`);
    if (r.edited) {
      console.error(`note: the files changed since the packet the reviewer read: ${r.edited}`);
      if (changedIn(r.edited) > SMALL_FIX) console.error("not a small fix: make a packet again (packet.ts) and have the reviewer read it before the commit");
    }
    if (r.after?.length) {
      console.error(`note: ${r.after.length} commit${r.after.length > 1 ? "s" : ""} after the packet the reviewer read (${r.tip?.slice(0, 7)}):`);
      for (const c of r.after) console.error(`  ${c}`);
      const others = r.after.filter((c) => !/^\w+ (fix|docs|style|test|chore)(\(|!|:)/.test(c));
      if (others.length) console.error("not fixes among them: make a packet again (packet.ts) and have the reviewer read them before the push");
    }
  }
}
