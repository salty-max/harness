/**
 * What a `git push` would send, and how the pre-push hook will judge it: the push pane reads it while Claude Code holds
 * the push for the user's answer, and an opener quotes its one line in a push question. It reads, and runs nothing that
 * writes: no fetch, no push, no hook.
 *
 *   bun outgoing.ts                                  the hook's JSON on stdin ({cwd, tool_input.command}, or {cwd, command}); JSON out
 *   bun outgoing.ts --cwd <dir> --command "<cmd>"    the same from arguments
 *   bun outgoing.ts --text [--dir <repo>] [--command "<cmd>"]   one line per ref sent; --dir alone is a plain `git push` there
 *
 * The pushes are the ones ask-push's reader finds (pushes.ts: every `git push` of the command line and the folder it runs
 * in). Each refspec is resolved here: the remote (named, else the branch's push remote, else origin), the local commit,
 * the remote ref (the branch's upstream for a bare push under push.default simple or upstream, else the same name), and
 * the remote's side **as of the last fetch** (its tracking ref; FETCH_HEAD's age said): pre-push judges against the
 * real remote, which this never asks. The commits it sends are the tracking ref's to the local one, else those no remote
 * has (as pre-push counts them). A force push lists what it would drop.
 *
 * The gates are judged by **the target repository's own** harness files, the ones its pre-push hook runs: core.hooksPath's
 * `../config.ts hook <gate>` (a gate switched off says so), `../review.ts --push <local> <remote>`, `_ai` on each
 * commit's message, and the stamp file `<git common dir>/harness/check-<tree>`. So this and the hook agree by
 * construction, a push into another project is judged by that project's copy, and a repository whose hooks aren't the
 * harness's says so. The gates are judged on every ref the push changes (a new branch at a commit the remote has
 * too), as pre-push does; `--no-verify` (pre-push skipped) and `git -c` (it can turn the hooks off) are said instead
 * of any gate. What it doesn't measure says so too: --all, --mirror, --tags, push.default matching, a detached HEAD, a
 * folder it can't tell, a refspec it can't resolve.
 */
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type Push, pushes } from "./pushes";

/** A gate as pre-push will judge it: off, passing, failing (`why`), or `partial`: not read in full here, so not judged. */
export type Gate = { on: boolean; ok: boolean; why?: string; partial?: true };
export type Commit = { sha: string; subject: string };
export type RefReport = {
  local: string;
  sha: string;
  remoteRef: string;
  remoteSha?: string;
  force: boolean;
  /** The local commit is behind the remote's as last fetched: nothing to send, and git refuses the rewind without force. */
  behind?: true;
  commits: Commit[];
  count: number;
  dropped: Commit[];
  gates?: { stamp: Gate; review: Gate; trailers: Gate };
};
export type PushReport = { dir?: string; repo?: string; remote?: string; fetched?: number; refs: RefReport[]; note?: string; harness?: boolean; skipped?: string };
export type Report = { pushes: PushReport[] };

/** How many commits a report lists (the count is all of them), and how many messages the trailer gate reads (pre-push reads them all; the pane has 3 s). */
const LIST = 50;
const TRAILERS = 50;
const ZEROS = "0".repeat(40);

const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))) as Record<string, string>;
function git(dir: string, ...args: string[]): string | undefined {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { env: env(), stderr: "ignore" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
}
const conf = (dir: string, key: string) => git(dir, "config", "--get", key) || undefined;

/** A `git log` range as commits, newest first. */
function log(dir: string, ...range: string[]): Commit[] {
  const out = git(dir, "log", "--format=%H%x09%s", ...range);
  return (out ? out.split("\n") : []).map((l) => ({ sha: l.slice(0, 40), subject: l.slice(41) }));
}

/** A push's words read for what it sends: the remote, the refspecs, and the options that change it. */
export function readArgs(args: string[]): { remote?: string; specs: string[]; force: boolean; del: boolean; broad?: string; noVerify?: true } {
  const r: { remote?: string; specs: string[]; force: boolean; del: boolean; broad?: string; noVerify?: true } = { specs: [], force: false, del: false };
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!;
    if (options && t === "--") options = false;
    else if (options && t.startsWith("--")) {
      if (t === "--force" || t.startsWith("--force-with-lease")) r.force = true;
      else if (t === "--no-verify") r.noVerify = true;
      else if (t === "--delete") r.del = true;
      else if (["--all", "--branches", "--mirror", "--tags", "--prune"].includes(t)) r.broad = t;
      else if (t.startsWith("--repo=")) r.remote = t.slice(7);
      else if (t === "--repo" || t === "--push-option" || t === "--receive-pack" || t === "--exec") {
        if (t === "--repo") r.remote = args[i + 1];
        i++;
      }
    } else if (options && t.startsWith("-") && t.length > 1) {
      if (t.includes("f")) r.force = true;
      if (t.includes("d")) r.del = true;
      if (t === "-o") i++;
    } else if (r.remote === undefined) r.remote = t;
    else r.specs.push(t);
  }
  return r;
}

/** The ref a refspec's source names, in full (`refs/heads/main`, `refs/tags/v1`), or undefined for a bare commit. */
const fullName = (dir: string, src: string): string | undefined => {
  const n = git(dir, "rev-parse", "--symbolic-full-name", src);
  return n && n.startsWith("refs/") ? n : undefined;
};

/** Where a ref the remote calls `dst` sits on `remote` as last fetched: its tracking ref, for a branch of a named remote. */
const tracking = (dir: string, remote: string, dst: string): string | undefined =>
  dst.startsWith("refs/heads/") ? git(dir, "rev-parse", "--verify", "-q", `refs/remotes/${remote}/${dst.slice(11)}^{commit}`) : undefined;

/** The harness's files a repository's pre-push runs, or undefined when its hooks aren't the harness's. */
export function harnessOf(dir: string): string | undefined {
  const top = git(dir, "rev-parse", "--show-toplevel");
  const hp = conf(dir, "core.hooksPath");
  if (!hp || !top) return undefined;
  const hooks = isAbsolute(hp) ? hp : resolve(top, hp);
  const tools = resolve(hooks, "..");
  return existsSync(join(hooks, "pre-push")) && existsSync(join(tools, "review.ts")) && existsSync(join(tools, "config.ts")) ? hooks : undefined;
}

/** The three gates of pre-push on what a ref sends, judged by the repository's own harness files (`hooks` is its githooks folder). */
export function judge(dir: string, hooks: string, sha: string, remoteSha: string | undefined, sent: string[]): { stamp: Gate; review: Gate; trailers: Gate } {
  const tools = resolve(hooks, "..");
  const run = (args: string[], stdin?: string) => {
    const p = Bun.spawnSync(args, { cwd: dir, env: env(), stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };
  // (the switches as the hook asks them: anything but "off" is on)
  const on = (gate: string) => run(["bun", join(tools, "config.ts"), "hook", gate]).out !== "off";
  const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const tree = git(dir, "rev-parse", `${sha}^{tree}`);
  const stamped = !!common && !!tree && existsSync(join(common, "harness", `check-${tree}`));
  const stamp: Gate = on("stamp") ? { on: true, ok: stamped, why: stamped ? undefined : `no passing check on ${sha.slice(0, 7)}'s tree` } : { on: false, ok: true };
  let review: Gate = { on: false, ok: true };
  if (on("review")) {
    const r = run(["bun", join(tools, "review.ts"), "--push", sha, remoteSha ?? ZEROS]);
    review = { on: true, ok: r.code === 0, why: r.code === 0 ? undefined : r.err || r.out || `review.ts exited ${r.code}` };
  }
  let trailers: Gate = { on: false, ok: true };
  if (on("trailers")) {
    const bad: string[] = [];
    // (the messages in one read, each then through the hook's own _ai)
    const read = sent.slice(0, TRAILERS);
    const msgs = read.length ? (git(dir, "log", "--no-walk=unsorted", "--format=%H%x00%B%x1e", ...read) ?? "").split("\x1e").map((m) => m.replace(/^\n/, "")).filter(Boolean) : [];
    for (const m of msgs) {
      const [c, msg] = [m.slice(0, 40), m.slice(41)];
      if (run([join(hooks, "_ai")], msg).code !== 0) bad.push(c.slice(0, 7));
    }
    trailers = bad.length
      ? { on: true, ok: false, why: `an AI trailer in ${bad.slice(0, 4).join(", ")}${bad.length > 4 ? "…" : ""}` }
      : sent.length > TRAILERS
        ? { on: true, ok: false, partial: true, why: `the first ${TRAILERS} of ${sent.length} read, none with one: pre-push reads them all` }
        : { on: true, ok: true };
  }
  return { stamp, review, trailers };
}

/** One push measured: its refs, their commits and gates, or a note saying what it couldn't measure. */
export function measure(p: Push): PushReport {
  if (!p.dir) return { refs: [], note: "its folder can't be told from the command" };
  const dir = p.dir;
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (!top) return { dir, refs: [], note: `${dir} isn't in a git repository` };
  const base: PushReport = { dir, repo: basename(top), refs: [] };
  if (!p.args) return { ...base, note: "its words hold a variable: not measured" };
  if (p.alias && p.plain === false) return { ...base, note: `the alias ${p.alias} isn't a plain push: not measured` };
  const a = readArgs(p.args);
  const current = git(dir, "symbolic-ref", "-q", "--short", "HEAD");
  const remote = a.remote ?? (current && (conf(dir, `branch.${current}.pushRemote`) ?? conf(dir, "remote.pushDefault") ?? conf(dir, `branch.${current}.remote`))) ?? "origin";
  const common = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const fetchHead = common && join(common, "FETCH_HEAD");
  const out: PushReport = { ...base, remote, fetched: fetchHead && existsSync(fetchHead) ? statSync(fetchHead).mtimeMs : undefined };
  if (a.broad) return { ...out, note: `${a.broad} sends more than a ref: not measured, pre-push checks each` };
  // (--no-verify skips pre-push, and `git -c` can turn the hooks off: no gate is judged, and the pane says so)
  if (a.noVerify) out.skipped = "--no-verify skips pre-push: no gate runs";
  else if (p.odd === "git -c") out.skipped = "git -c can change the hooks: the gates aren't judged";
  if (a.del) return { ...out, note: "a delete sends no commit" };
  // (what each refspec sends: src's commit to dst on the remote)
  const pairs: { src: string; dst: string; force: boolean }[] = [];
  if (!a.specs.length) {
    const mode = conf(dir, "push.default") ?? "simple";
    if (!current) return { ...out, note: "HEAD is detached: a bare push sends nothing" };
    if (mode === "matching") return { ...out, note: "push.default is matching: every matching branch, not measured" };
    if (mode === "nothing") return { ...out, note: "push.default is nothing: a bare push sends nothing" };
    const merge = conf(dir, `branch.${current}.merge`);
    const up = (mode === "simple" || mode === "upstream") && merge && conf(dir, `branch.${current}.remote`) === remote ? merge : undefined;
    pairs.push({ src: current, dst: up ?? `refs/heads/${current}`, force: a.force });
  } else
    for (const spec of a.specs) {
      const force = a.force || spec.startsWith("+");
      const s = spec.replace(/^\+/, "");
      const [src, dst0] = s.includes(":") ? [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)] : [s, undefined];
      if (!src) return { ...out, note: `${spec} deletes ${dst0}: no commit sent` };
      const full = fullName(dir, src);
      const dst = dst0 ? (dst0.startsWith("refs/") ? dst0 : full?.startsWith("refs/tags/") ? `refs/tags/${dst0}` : `refs/heads/${dst0}`) : full;
      if (!dst) return { ...out, note: `${spec}: where it goes on the remote can't be told` };
      pairs.push({ src, dst, force });
    }
  const hooks = out.skipped ? undefined : harnessOf(dir);
  out.harness = !!hooks;
  for (const { src, dst, force } of pairs) {
    const sha = git(dir, "rev-parse", "--verify", "-q", `${src}^{commit}`);
    if (!sha) return { ...out, note: `${src} is no commit here` };
    const remoteSha = tracking(dir, remote, dst);
    const range = remoteSha ? [`${remoteSha}..${sha}`] : [sha, "--not", "--remotes"];
    const all = (git(dir, "rev-list", ...range) ?? "").split("\n").filter(Boolean);
    const ref: RefReport = {
      local: src,
      sha,
      remoteRef: dst.replace(/^refs\/(heads|tags)\//, ""),
      remoteSha,
      force,
      commits: log(dir, "-n", String(LIST), ...range),
      count: all.length,
      dropped: force && remoteSha ? log(dir, "-n", String(LIST), `${sha}..${remoteSha}`) : [],
    };
    if (remoteSha && remoteSha !== sha && !all.length) ref.behind = true;
    // (pre-push judges every ref the push changes, a new branch at a commit the remote has included; an up-to-date ref,
    // or a rewind git refuses without force, never reaches it)
    if (hooks && sha !== remoteSha && !(ref.behind && !force)) ref.gates = judge(dir, hooks, sha, remoteSha, all);
    out.refs.push(ref);
  }
  return out;
}

/** Every push of a command line run in `cwd`, measured. */
export function outgoing(command: string, cwd: string, home = process.env.HOME ?? "/"): Report {
  let found: Push[];
  try {
    found = pushes(command, { dir: resolve(cwd) }, home);
  } catch {
    return { pushes: [{ refs: [], note: "the command couldn't be read" }] };
  }
  return { pushes: found.map(measure) };
}

const mark = (g: Gate | undefined, name: string) => (!g ? "" : !g.on ? `${name} off` : g.ok ? `${name} ✓` : g.partial ? `${name} ? (${g.why})` : `${name} ✗ (${g.why})`);
const age = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`);

/** One line per ref a report's pushes send (or the note that says why not): what an opener quotes in a push question. */
export function text(r: Report, now = Date.now()): string[] {
  const lines: string[] = [];
  for (const p of r.pushes) {
    const who = [p.repo, p.remote].filter(Boolean).join(" → ");
    if (p.note || !p.refs.length) {
      lines.push(`${who || "git push"}: ${p.note ?? "nothing to send"}`);
      continue;
    }
    for (const f of p.refs) {
      const what = f.count ? `${f.count} commit${f.count > 1 ? "s" : ""} (${f.remoteSha ? `${f.remoteSha.slice(0, 7)}..` : "new, "}${f.sha.slice(0, 7)})` : f.behind ? `nothing new (${f.sha.slice(0, 7)} is behind the remote's ${f.remoteSha!.slice(0, 7)})` : "nothing new";
      const drop = f.force ? (f.dropped.length ? `, force: drops ${f.dropped.length}` : ", force") : "";
      const gates = p.skipped ? `, ${p.skipped}` : f.gates ? `, ${[mark(f.gates.stamp, "check"), mark(f.gates.review, "review"), mark(f.gates.trailers, "trailers")].join(", ")}` : f.count && !p.harness ? ", no harness gates here" : "";
      const fetched = p.fetched ? ` [remote as fetched ${age(now - p.fetched)} ago]` : " [never fetched]";
      lines.push(`${p.repo} ${f.local} → ${p.remote}/${f.remoteRef}: ${what}${drop}${gates}${fetched}`);
    }
  }
  return lines;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let command = opt("--command");
  let cwd = opt("--cwd") ?? opt("--dir");
  if (command === undefined && cwd !== undefined) command = "git push";
  if (command === undefined) {
    const input = (await Bun.stdin.text()).trim();
    try {
      const j = JSON.parse(input) as { cwd?: string; command?: unknown; tool_input?: { command?: unknown } };
      const c = j.tool_input?.command ?? j.command;
      command = typeof c === "string" ? c : "";
      cwd ??= j.cwd;
    } catch {
      console.error("outgoing: stdin isn't the hook's JSON ({cwd, tool_input: {command}})");
      process.exit(2);
    }
  }
  const report = outgoing(command, cwd ?? process.cwd());
  if (args.includes("--text")) console.log(text(report).join("\n") || "no git push in that command");
  else console.log(JSON.stringify(report));
}
