#!/usr/bin/env bun
/**
 * A Claude Code PreToolUse hook for the Bash tool: it makes every `git push` prompt the user, except a plain push to
 * origin in a repository named by --skip (its worktrees too), which it allows.
 *
 *   bun ask-push.ts --skip ~/code/hundo [--skip <repository>…]     reads the hook's JSON on stdin
 *   bun ask-push.ts --command --bun <bun> --skip <repository>…     prints the shell command to put in settings.json
 *
 * Why a hook and not an ask rule: permission rules from every scope merge, and an ask beats an allow, so a user-level
 * `Bash(git push *)` ask would prompt in a project that opted out (`[asks] skip` in its harness.toml) however its own
 * settings read. A hook can look at the folder and at the words of the push; a rule can't. A hook's "ask" works on
 * its own, and its "allow" never overrides an ask or deny rule (code.claude.com/docs/en/permissions, "Precedence
 * among rules, hooks, and mods"), so a project's own `Bash(git *--no-verify*)` still asks.
 *
 * What it reads, {cwd, tool_input.command}: every `git [options] push` in the command (each simple command after
 * && || ; | & and newlines, the bodies of $(…) and backticks, `bash -c '…'` and eval, VAR=x and the wrappers env,
 * command, time, nice, nohup, timeout and stdbuf and the shell's if/then/do/while keywords taken off first, and
 * oh-my-zsh's push aliases: gp, gpf, ggpush…).
 * Each push gets the folder it runs in (the cwd, moved by a `cd` earlier in the same command and by each
 * `git -C <path>`), and that folder's repository is what git says: its common dir, so a worktree anywhere on the
 * disk is its main checkout's, and a nested clone is not.
 *
 * The answer, per call:
 *   ask    a push outside the skipped repositories, or in one but not plain: --force, -f, --force-with-lease,
 *          --force-if-includes, --delete, -d, --mirror, --all, --tags, --prune, a refspec starting with + or :, a
 *          remote other than origin or a URL, --repo, --receive-pack, --exec, `git -c`, --no-verify, -o, a variable
 *          in the arguments, `git subtree push`, `--recurse-submodules=on-demand`
 *   allow  every push is plain (-u -n -v -q, origin or no remote, branch names or src:dst), in a skipped repository,
 *          and the rest of the call is pure: static cds, read-only git (status, fetch, log, diff, show, rev-parse),
 *          tail/head/cat/wc, redirections only to /dev/null or between descriptors. An allow covers the whole call,
 *          so a commit's message, a script or a variable beside the push is not covered: those get no opinion
 *   none   no push, or a plain push beside commands that aren't pure: the normal permission flow decides
 * It fails towards asking: a variable in the path, `cd -`, pushd, a `cd` in a subshell, a pipeline, an if, or before
 * `||`, or after a `&&` the chain has left, --git-dir or GIT_*= (also `export GIT_DIR=…` and a line of its own), a
 * folder that isn't there or isn't a repository, a `git … push` behind a program it doesn't know (sudo, xargs, find
 * -exec), a shell fed by a pipe or a heredoc, `git -c alias.p=push p`, a command it can't read, and, when the
 * script itself can't run, the settings command (`--command`) asks if the call mentions a push and never allows.
 *
 * The repository's own config is read for an allow (`pushConfigOdd`): another push remote, a push URL, a mirror,
 * `pushInsteadOf`, `push.default = matching`, `push.followTags`, and for a bare push a branch whose remote isn't
 * origin, all ask. Git's own options on the push (`--exec-path`, `--config-env`, `--bare`, `--namespace`…) ask, and
 * the read-only git beside a push may carry only the options `READ_ONLY_GIT` lists and paths inside the repository
 * (never `-C`, `--`  for fetch, an absolute path or `..`; fetch takes only origin and branch names).
 *
 * Not modelled: functions, aliases but the push ones above, a heredoc's expansions, a `git push` made by another
 * program (a script, make), what origin's own URL is (a url.<base>.insteadOf), a `git status` or `git fetch` run in
 * a repository other than the one the push is in (after a cd). The ask rules this replaced had the same limits, and
 * matched far fewer forms (`git -c x=y push` and every alias escaped them).
 */
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type Push, ALIASES, gitOptions, mentions, pushes, real, repoOf } from "../pushes";
import { type Word, REDIRECT, bare, parse, unredirected } from "../shell";

export { mentions, parse, pushes, repoOf };
export type { Push };


/** The options each read-only git command may carry beside a push in an allowed call: no --output, --upload-pack, --ext-diff, --textconv, --no-index or anything else that writes a file or runs a program. */
const LOG_OPT = /^(-\d+|-n|--oneline|--graph|--decorate|--stat|--shortstat|--numstat|--name-only|--name-status|--no-color|--abbrev-commit|--first-parent|--no-merges|--max-count=\d+|--(pretty|format)=[^`$]*)$/;
const DIFF_OPT = new RegExp(`${LOG_OPT.source.slice(0, -2)}|--cached|--staged|--check|--no-ext-diff|--minimal|-U\\d+|--unified=\\d+)$`);
const READ_ONLY_GIT: Record<string, RegExp> = {
  status: /^(-s|-b|-sb|--short|--branch|--porcelain(=v[12])?)$/,
  fetch: /^(-q|-v|-p|--quiet|--verbose|--prune|--tags)$/,
  log: LOG_OPT,
  diff: DIFF_OPT,
  show: DIFF_OPT,
  "rev-parse": /^(--show-toplevel|--abbrev-ref|--short|--is-inside-work-tree|--git-common-dir|--verify)$/,
};
const PURE_FILTERS = ["tail", "head", "cat", "wc"];
const FILTER_ARGS = /^(-\d+|-n|\d+|-l|-c|-w|-m)$/;

/** A path or revision that leaves the repository: absolute, ~, or with a `..` folder (`a..b` is a range, not a folder). git reads any file given outside the work tree. */
const OUTSIDE = /^[/~]|(^|\/)\.\.(\/|$)/;

/**
 * Whether a read-only git command's arguments are all ones that read: allowed options, revisions and paths inside
 * the repository, and for fetch only origin and branch names (no URL, no `+`, no `:`, no `--`, which would turn
 * what follows into remotes and refspecs).
 */
function readOnly(sub: string, rest: Word[]): boolean {
  const opt = READ_ONLY_GIT[sub];
  if (!opt) return false;
  let paths = false;
  let first = true;
  for (const w of rest) {
    const t = w.text;
    if (t === "--" && !paths) {
      if (sub === "fetch") return false;
      paths = true;
    } else if (OUTSIDE.test(t)) return false;
    else if (paths) continue;
    else if (t.startsWith("-")) {
      if (!opt.test(t)) return false;
    } else if (sub === "fetch") {
      if (first ? t !== "origin" : !/^[A-Za-z0-9._@\/-]+$/.test(t) || t.startsWith("+")) return false;
      first = false;
    } else if (!/^[A-Za-z0-9._@\/~^{}:,=+-]+$/.test(t)) return false;
  }
  return true;
}

/**
 * Whether every command in `src` is one an "allow" may cover together with the pushes: a static cd, a push, a
 * read-only git (status, fetch, log, diff, show, rev-parse: `readOnly`, never `-C`), tail/head/cat/wc after a pipe
 * and with no file to read, redirections only to /dev/null or between descriptors, no substitution, variable,
 * heredoc, grouping, wrapper or assignment. An allow skips the prompt for the whole call, so a commit's message, a
 * script or a variable beside the push would ride along on it; those calls stay silent and go through the normal
 * flow.
 */
export function pure(src: string, home: string): boolean {
  if (src.includes("<<")) return false;
  const { cmds, grouped } = parse(src);
  if (grouped || !cmds.length) return false;
  for (const cmd of cmds) {
    if (cmd.words.some((w) => w.dynamic || w.subs.length)) return false;
    for (let i = 0; i < cmd.words.length; i++) {
      const m = cmd.words[i]!.quoted ? null : REDIRECT.exec(cmd.words[i]!.text);
      if (m && !/^(&\d+|\/dev\/null)$/.test(m[1] === "" ? (cmd.words[++i]?.text ?? "") : m[1]!)) return false;
    }
    const plain = unredirected(cmd.words);
    const { words } = bare(plain);
    const first = words[0];
    if (words.length !== plain.length || first?.quoted) return false;
    if (!first) continue;
    if (first.text === "cd") continue;
    if (first.text === "git") {
      const g = gitOptions(words, 0, undefined, home);
      const sub = g.sub?.text ?? "";
      if (sub === "push") continue;
      if (!g.odd && !g.config && !words.some((w) => w.text === "-C") && readOnly(sub, g.rest)) continue;
      return false;
    }
    if (first.text in ALIASES) continue;
    if (PURE_FILTERS.includes(first.text) && cmd.before === "|" && words.slice(1).every((w) => FILTER_ARGS.test(w.text))) continue;
    return false;
  }
  return true;
}

/**
 * Why a push in `dir`'s repository, written plain, may not go where a plain push to origin goes, from git's own
 * config (every scope): another push remote, a push URL, a second origin URL, a mirror, `pushInsteadOf`,
 * `push.default = matching`, `push.followTags`, `push.recurseSubmodules` or `submodule.recurse` (the submodules'
 * repositories get pushed too); keys that run a program (`remote.*.vcs`, `receivepack`, `core.sshCommand`) when
 * they aren't the user's own (global or system scope); and, for a push naming no remote, the current branch's
 * remote when it isn't origin.
 */
export function pushConfigOdd(dir: string, bare: boolean): string | undefined {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], { env, stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : undefined;
  };
  const all = git("config", "--show-scope", "--get-regexp", "^(remote\\..*\\.(push|mirror|pushurl|url|vcs|receivepack)|remote\\.pushdefault|branch\\..*\\.pushremote|url\\..*\\.pushinsteadof|push\\.(default|followtags|recursesubmodules)|submodule\\.recurse|core\\.sshcommand)$");
  const truthy = (v: string) => v === "" || ["true", "yes", "on", "1"].includes(v.toLowerCase());
  let origins = 0;
  for (const line of (all ?? "").split("\n").filter(Boolean)) {
    const m = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) return "git config printed a line this couldn't read";
    const [, scope = "", key = "", value = ""] = m;
    if (key === "push.default") {
      if (value === "matching") return "push.default is matching";
    } else if (key === "push.followtags") {
      if (truthy(value)) return "push.followTags is on";
    } else if (key === "push.recursesubmodules") {
      if (["on-demand", "only"].includes(value.toLowerCase())) return `push.recurseSubmodules is ${value}`;
    } else if (key === "submodule.recurse") {
      if (truthy(value)) return "submodule.recurse is on, so a push also pushes the submodules";
    } else if (key === "remote.origin.url") {
      if (++origins > 1) return "origin has more than one url";
    } else if (/^remote\..*\.url$/.test(key)) {
      continue;
    } else if (/^(remote\..*\.(vcs|receivepack)|core\.sshcommand)$/.test(key)) {
      if (scope !== "global" && scope !== "system") return `the repository's config sets ${key}, which runs a program`;
    } else return `the repository's config sets ${key}`;
  }
  if (bare) {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    const remote = branch && branch !== "HEAD" ? git("config", "--get", `branch.${branch}.remote`) : undefined;
    if (remote && remote !== "origin") return `branch ${branch} pushes to ${remote}, not origin`;
  }
  return undefined;
}

export type Decision = { decision: "ask" | "allow"; reason: string };

/**
 * What the hook says about a command, or undefined for no opinion. "ask": a push outside the skipped repositories,
 * a push in one that isn't plain (force, delete, --all, --tags, a +/: refspec, another remote, an unusual option), a
 * push whose folder can't be told, a command it can't read. "allow": every push is plain, to origin, in a skipped
 * repository, and the rest of the command is pure (a hook's allow covers the whole call). No push: no opinion, and a
 * plain push beside commands that aren't pure: no opinion too.
 */
export function decide(command: string, cwd: string | undefined, skip: string[], home: string = homedir()): Decision | undefined {
  if (!mentions(command)) return undefined;
  const ask = (reason: string): Decision => ({ decision: "ask", reason });
  let found: Push[];
  try {
    found = pushes(command, { dir: cwd ? resolve(cwd) : undefined }, home);
  } catch {
    return ask("git push: the command couldn't be read, so its folder is unknown");
  }
  const repos = skip.map((s) => real(join(resolve(s), ".git")) ?? join(resolve(s), ".git"));
  for (const p of found) {
    if (!p.dir) return ask("git push: its folder can't be told from the command (a variable, cd -, a subshell, --git-dir…)");
    const at = repoOf(p.dir);
    if (!at) return ask(`git push: ${p.dir} isn't in a git repository`);
    if (!repos.includes(at)) return ask(`git push in ${at.replace(/\/\.git$/, "")}`);
    if (p.odd) return ask(`${p.odd}: only a plain push to origin skips the prompt`);
    if (!p.plain) return ask("git push with more than a plain push to origin (force, delete, --all, --tags, a +/: refspec, an option or a variable): confirm");
    const config = pushConfigOdd(p.dir, !!p.bare);
    if (config) return ask(`git push: ${config}, so a plain push may not be one`);
  }
  if (!found.length) return undefined;
  try {
    return pure(command, home) ? { decision: "allow", reason: "a plain git push to origin in a repository this hook skips" } : undefined;
  } catch {
    return undefined;
  }
}

const answer = (reason: string, decision: "ask" | "allow" = "ask") => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * The shell command for settings.json's hook: this script, and when it fails (bun gone, the script moved, a crash)
 * an "ask" if the call mentions a push, nothing otherwise, so a broken hook neither lets a push through nor prompts
 * for every command. `skip` are the repositories it leaves alone.
 */
export function hookCommand(bun: string, script: string, skip: string[]): string {
  const failed = JSON.stringify(answer("git push: the ask-push hook failed, so it asks"));
  return `inp=$(cat); out=$(printf '%s' "$inp" | ${quote(bun)} ${quote(script)} ${skip.map((s) => `--skip ${quote(s)}`).join(" ")} 2>/dev/null) || case "$inp" in *push*|*send-pack*|*gp*|*ggf*|*grename*) out=${quote(failed)};; *) out=;; esac; printf '%s' "$out"`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const skip: string[] = [];
  let bun = "bun";
  let print = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--skip" && args[i + 1]) skip.push(args[++i]!.replace(/^~(?=\/|$)/, homedir()));
    else if (args[i] === "--bun" && args[i + 1]) bun = args[++i]!;
    else if (args[i] === "--command") print = true;
  }
  if (print) console.log(hookCommand(bun, resolve(import.meta.path), skip));
  else {
    const text = await Bun.stdin.text();
    try {
      const input = JSON.parse(text) as { tool_name?: string; cwd?: string; tool_input?: { command?: unknown } };
      const command = input.tool_input?.command;
      if ((input.tool_name === undefined || input.tool_name === "Bash") && typeof command === "string") {
        const d = decide(command, input.cwd, skip);
        if (d) console.log(JSON.stringify(answer(d.reason, d.decision)));
      }
    } catch {
      // (no JSON to read: nothing to judge, unless it mentions a push)
      if (text.includes("push")) console.log(JSON.stringify(answer("git push: the hook's input couldn't be read")));
    }
  }
}
