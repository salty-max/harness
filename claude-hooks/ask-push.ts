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
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

type Word = { text: string; dynamic: boolean; quoted: boolean; subs: string[] };
type Sep = "&&" | "||" | ";" | "|" | "&" | "\n" | "";
type Cmd = { words: Word[]; before: Sep; after: Sep };
type State = { dir: string | undefined; gitVar?: boolean; maybe?: boolean };
/** A push found: the folder it runs in (undefined: can't be told), why its target isn't plainly origin (undefined: it is), whether its words are all plain (no force, delete, --all, --tags, +/: refspec, other remote or option), and whether it names no remote (a bare push goes where the repository's config says). */
export type Push = { dir: string | undefined; odd?: string; plain?: boolean; bare?: boolean };

/** The index of the `)` closing a `$(` whose body starts at `from`. */
function closing(src: string, from: number): number {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'") i = src.indexOf("'", i + 1) < 0 ? src.length : src.indexOf("'", i + 1);
    else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return src.length;
}

/** The simple commands of a command line, each a list of words (quotes taken off), with what ran before and after it. */
export function parse(src: string): { cmds: Cmd[]; grouped: boolean } {
  const cmds: Cmd[] = [];
  let words: Word[] = [];
  let cur: Word | undefined;
  let lastSep: Sep = "";
  let grouped = false;
  const heredocs: { tag: string; dash: boolean }[] = [];
  const word = () => (cur ??= { text: "", dynamic: false, quoted: false, subs: [] });
  const endWord = () => {
    if (cur) words.push(cur);
    cur = undefined;
  };
  const endCmd = (sep: Sep) => {
    endWord();
    if (words.length) cmds.push({ words, before: lastSep, after: sep });
    words = [];
    lastSep = sep;
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else {
        word().text += src[i + 1] ?? "";
        word().quoted = true;
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      word().text += src.slice(i + 1, end);
      word().quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const w = word();
      w.quoted = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < src.length) {
          w.text += src[i + 1];
          i += 2;
        } else if (src.startsWith("$(", i)) {
          const j = closing(src, i + 2);
          w.subs.push(src.slice(i + 2, j));
          w.dynamic = true;
          w.text += src.slice(i, j + 1);
          i = j + 1;
        } else if (src[i] === "`") {
          const j = src.indexOf("`", i + 1);
          const end = j < 0 ? src.length : j;
          w.subs.push(src.slice(i + 1, end));
          w.dynamic = true;
          w.text += src.slice(i, end + 1);
          i = end + 1;
        } else {
          if (src[i] === "$") w.dynamic = true;
          w.text += src[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (src.startsWith("$(", i)) {
      const j = closing(src, i + 2);
      const w = word();
      w.subs.push(src.slice(i + 2, j));
      w.dynamic = true;
      w.text += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      const end = j < 0 ? src.length : j;
      const w = word();
      w.subs.push(src.slice(i + 1, end));
      w.dynamic = true;
      w.text += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === "$" || c === "*" || c === "?" || c === "[") {
      word().dynamic = true;
      word().text += c;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    if (c === "#" && !cur) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      i++;
      // (a heredoc's body: its lines, up to the one holding its tag, are text, not commands)
      for (const h of heredocs.splice(0)) {
        while (i < src.length) {
          const nl = src.indexOf("\n", i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if ((h.dash ? line.trim() : line) === h.tag) break;
        }
      }
      endCmd("\n");
      continue;
    }
    if (c === "<" && src.startsWith("<<", i) && !src.startsWith("<<<", i)) {
      const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(src.slice(i));
      if (m) {
        heredocs.push({ tag: m[2] ?? m[3] ?? m[4] ?? "", dash: m[1] === "-" });
        i += m[0].length;
        continue;
      }
    }
    const op = (["&&", "||", "|&", ";", "|", "&"] as const).find((o) => src.startsWith(o, i) && !(o === "&" && (/[<>]/.test(src[i - 1] ?? "") || src[i + 1] === ">")));
    if (op) {
      endCmd(op === "|&" ? "|" : op);
      i += op.length;
      continue;
    }
    if (c === "(" || c === ")") {
      grouped = true;
      endCmd("");
      i++;
      continue;
    }
    if ((c === "{" || c === "}") && !cur && /^([\s;]|$)/.test(src[i + 1] ?? "")) {
      grouped = true;
      endCmd("");
      i++;
      continue;
    }
    word().text += c;
    i++;
  }
  endCmd("");
  return { cmds, grouped };
}

const assign = /^[A-Za-z_][A-Za-z0-9_]*=/;
const gitEnv = /^GIT_[A-Z_]*=/;

/** The words of a command with its leading assignments and wrappers taken off, and whether one of them is a GIT_ variable (it may move the repository or the remote). */
function bare(words: Word[]): { words: Word[]; gitVar: boolean } {
  let i = 0;
  let gitVar = false;
  for (;;) {
    const w = words[i];
    if (!w) break;
    if (assign.test(w.text)) {
      gitVar ||= gitEnv.test(w.text);
      i++;
      continue;
    }
    const b = basename(w.text);
    if (!w.quoted && ["if", "then", "do", "else", "elif", "while", "until", "!"].includes(w.text)) i++;
    else if (["command", "builtin", "exec", "nohup", "time"].includes(b)) {
      i++;
      while (words[i]?.text.startsWith("-")) i++;
    } else if (b === "env") {
      i++;
      while (words[i] && (words[i]!.text.startsWith("-") || assign.test(words[i]!.text))) gitVar ||= gitEnv.test(words[i++]!.text);
    } else if (b === "nice") {
      i++;
      if (words[i]?.text === "-n") i += 2;
      else if (/^-\d+$/.test(words[i]?.text ?? "")) i++;
    } else if (b === "timeout") {
      i++;
      while (words[i]?.text.startsWith("-")) i++;
      i++;
    } else if (b === "stdbuf") {
      i++;
      while (/^-[ioe]/.test(words[i]?.text ?? "")) i += words[i]!.text.length > 2 ? 1 : 2;
    } else break;
  }
  return { words: words.slice(i), gitVar };
}

/** A path word made absolute against `from`, or undefined when it can't be told (a variable, a glob, ~user, nothing to resolve against). */
function place(w: Word, from: string | undefined, home: string): string | undefined {
  if (w.dynamic) return undefined;
  let t = w.text;
  if (!w.quoted && (t === "~" || t.startsWith("~/"))) t = home + t.slice(1);
  else if (!w.quoted && t.startsWith("~")) return undefined;
  if (t.startsWith("/")) return resolve(t);
  return from ? resolve(from, t) : undefined;
}

/** Why a push's arguments don't plainly go to origin, or undefined when they do: no remote, or origin. */
function target(args: Word[], remote?: string): string | undefined {
  let named = remote;
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.text;
    if (t === "--") {
      if (args[k + 1]) named ??= args[k + 1]!.dynamic ? "$…" : args[k + 1]!.text;
      break;
    }
    if (["--repo", "--receive-pack", "--exec"].some((o) => t === o || t.startsWith(`${o}=`))) return `git push ${t.split("=")[0]}`;
    if (/^--recurse-submodules=(on-demand|only)$/.test(t)) return `git push ${t} (it pushes the submodules' repositories too)`;
    if (t === "-o" || t === "--push-option") k++;
    else if (!t.startsWith("-")) named ??= args[k]!.dynamic ? "$…" : t;
  }
  return named === undefined || named === "origin" ? undefined : `git push to ${named}, not origin`;
}

const PLAIN_LONG = ["--set-upstream", "--dry-run", "--verbose", "--quiet", "--progress", "--no-progress", "--porcelain", "--atomic"];
const REFSPEC = /^[A-Za-z0-9._@\/-]+(:[A-Za-z0-9._@\/-]+)?$/;
/**
 * Whether a push's arguments are plain: the options -u -n -v -q (alone or together) and PLAIN_LONG, the remote origin
 * (or none), and branch names or `src:dst` refspecs with no `+` or `:` in front. Anything else (--force, -f,
 * --force-with-lease, --force-if-includes, --delete, -d, --mirror, --all, --tags, --prune, --no-verify, -o, another
 * remote, a variable) isn't, and in a skipped repository it asks.
 */
function plainArgs(args: Word[]): boolean {
  let remote = false;
  for (const w of args) {
    const t = w.text;
    if (w.dynamic) return false;
    if (t.startsWith("--")) {
      if (!PLAIN_LONG.includes(t)) return false;
    } else if (t.startsWith("-")) {
      if (!/^-[uvnq]+$/.test(t)) return false;
    } else if (!remote) {
      if (t !== "origin") return false;
      remote = true;
    } else if (!REFSPEC.test(t) || t.startsWith(":")) return false;
  }
  return true;
}

/** oh-my-zsh's git aliases and functions that push (the Bash tool's shell snapshot carries them), with the remote each names (""): they have no `git` or `push` in them for a rule to match. */
const ALIASES: Record<string, [remote: string, plain: boolean]> = {
  gp: ["", true],
  gpd: ["", true],
  gpv: ["", true],
  gpsup: ["origin", true],
  ggpush: ["origin", true],
  ggp: ["origin", true],
  gpf: ["", false],
  "gpf!": ["", false],
  gpfl: ["", false],
  gpsupf: ["origin", false],
  ggpnp: ["origin", false],
  ggf: ["origin", false],
  ggfl: ["origin", false],
  grename: ["origin", false],
  gpoat: ["origin", false],
  gpod: ["origin", false],
  gpu: ["upstream", false],
};

const SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];
const GIT_WITH_ARG = ["-C", "--namespace", "--exec-path", "--super-prefix", "--config-env", "--attr-source"];
const EXPORTERS = ["export", "declare", "typeset", "readonly", "local"];
/** Programs that run the rest of their line as a command: a `git push` quoted into one of their words counts. */
const RUNNERS = ["sudo", "doas", "su", "xargs", "watch", "flock", "parallel", "ssh", "script", "find", "setsid", "caffeinate"];
/** A `git … push` written out in one string. */
const TEXT = /(^|[\s;&|(`])git(\s+\S+)*?\s+push(?=\s|$|[;&|)])/;
/** Whether a command line may hold a push at all: the word, or one of the push aliases and functions. */
export const mentions = (s: string): boolean => s.includes("push") || s.includes("send-pack") || /(^|[^\w-])(gp[a-z!]*|ggp[a-z]*|ggf[a-z]*|grename)(?![\w-])/.test(s);

/** A redirection (`2>&1`, `> file`, `&>`, `<<<`) is no argument and no command; one that names no file takes the word after it. */
const REDIRECT = /^(?:\d*|&)(?:>>?|<>?|<<<?|>&|<&)(.*)$/;
function unredirected(words: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = words[i]!.quoted ? null : REDIRECT.exec(words[i]!.text);
    if (!m) out.push(words[i]!);
    else if (m[1] === "") i++;
  }
  return out;
}

const isDir = (p: string | undefined) => {
  try {
    return !!p && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** What a `git` word's options come to: the folder `-C` moves to, where the subcommand is, and what makes the remote unusual. */
function gitOptions(words: Word[], at: number, dir: string | undefined, home: string): { dir: string | undefined; sub: Word | undefined; rest: Word[]; odd?: string; config: boolean } {
  let odd: string | undefined;
  let config = false;
  let i = at + 1;
  for (; i < words.length; i++) {
    const t = words[i]!.text;
    if (t === "-C") {
      const arg = words[++i];
      dir = arg ? place(arg, dir, home) : undefined;
    } else if (t === "-c") {
      odd ??= "git -c";
      // (a config value can make an alias of push: `git -c alias.p=push p`)
      if (/push/.test(words[++i]?.text ?? "")) config = true;
    } else if (t === "--git-dir" || t === "--work-tree" || t.startsWith("--git-dir=") || t.startsWith("--work-tree=")) {
      dir = undefined;
      if (!t.includes("=")) i++;
    } else if (GIT_WITH_ARG.includes(t)) {
      // (--exec-path runs another git-remote-*, --config-env sets any config, --namespace and the rest change what git does)
      odd ??= `git ${t}`;
      i++;
    } else if (t.startsWith("-")) {
      if (t !== "--no-pager") odd ??= `git ${t.split("=")[0]}`;
    } else break;
  }
  return { dir, sub: words[i], rest: words.slice(i + 1), odd, config };
}

/** How a command line moves the count of open if/while/until/for/case blocks: a cd inside one may not run. */
function blockDelta(words: Word[]): number {
  let i = 0;
  let n = 0;
  while (words[i] && !words[i]!.quoted && ["if", "then", "do", "else", "elif", "while", "until", "!"].includes(words[i]!.text)) if (["if", "while", "until"].includes(words[i++]!.text)) n++;
  const f = words[i];
  if (f && !f.quoted) {
    if (["for", "case", "select"].includes(f.text)) n++;
    else if (["fi", "done", "esac"].includes(f.text)) n--;
  }
  return n;
}

/** Every push in `src`, with the folder it runs in, `state` being the folder the command starts in (moved by its cd). */
export function pushes(src: string, state: State, home: string, out: Push[] = [], depth = 0): Push[] {
  if (depth > 6) {
    out.push({ dir: undefined });
    return out;
  }
  const { cmds, grouped } = parse(src);
  let block = 0;
  for (const cmd of cmds) {
    for (const w of cmd.words) for (const sub of w.subs) pushes(sub, { ...state }, home, out, depth + 1);
    const plain = unredirected(cmd.words);
    block = Math.max(0, block + blockDelta(plain));
    // (a cd that ran only after `&&` may not have: what follows the chain doesn't know where it is)
    if (state.maybe && cmd.before !== "&&") state = Object.assign(state, { dir: undefined, maybe: false });
    const { words, gitVar } = bare(plain);
    const first = words[0];
    if (!first) {
      // (`GIT_DIR=x` alone on a line sets it for the commands after it)
      if (plain.some((w) => gitEnv.test(w.text))) state.gitVar = true;
      continue;
    }
    const name = basename(first.text);
    const moved = gitVar || state.gitVar;
    const hidden = (first.dynamic && !first.text.includes("/")) || first.text.startsWith("=");
    if (hidden) {
      // (a command that is a variable, a substitution or zsh's =git: `$G push`)
      if (mentions(src)) out.push({ dir: undefined });
    } else if (name === "cd") {
      // (quoting stops an alias, not the builtin: "cd" and \cd move the shell too)
      let j = 1;
      while (["-P", "-L", "-e", "-@", "--"].includes(words[j]?.text ?? "")) j++;
      const arg = words[j];
      const to = !arg ? home : arg.text === "-" ? undefined : place(arg, state.dir, home);
      // (a cd that runs in a subshell, a pipeline, the background or only when the one before failed doesn't move the shell that follows)
      const lasts = ["", "&&", ";", "\n"].includes(cmd.after) && ["", "&&", ";", "\n"].includes(cmd.before);
      state.dir = lasts && !grouped && !block ? to : undefined;
      if (cmd.before === "&&" || cmd.before === "||") state.maybe = true;
    } else if (["pushd", "popd", "chdir"].includes(name)) state.dir = undefined;
    else if (EXPORTERS.includes(name)) {
      if (words.some((w) => gitEnv.test(w.text))) state.gitVar = true;
    } else if (name === "git") {
      const g = gitOptions(words, 0, state.dir, home);
      const sub = g.sub?.text;
      const next = g.rest.find((w) => !w.text.startsWith("-"));
      if (sub === "push") {
        const odd = moved ? "a GIT_ variable" : g.odd ?? target(g.rest);
        out.push({ dir: moved ? undefined : g.dir, odd, plain: !odd && plainArgs(g.rest), bare: !g.rest.some((w) => !w.text.startsWith("-")) });
      }
      else if (sub === "subtree" && next?.text === "push") out.push({ dir: moved ? undefined : g.dir, odd: moved ? "a GIT_ variable" : g.odd ?? target(g.rest.slice(g.rest.indexOf(next) + 1)) });
      else if (sub === "send-pack" || sub === "http-push" || g.config) out.push({ dir: undefined });
      else if (sub && /[${]|^=/.test(sub)) {
        // (a subcommand that is a variable or a brace list: `git $(echo push)`)
        if (mentions(src)) out.push({ dir: undefined });
      } else if (["submodule", "rebase", "bisect", "filter-branch"].includes(sub ?? "") && TEXT.test(g.rest.map((w) => w.text).join(" "))) out.push({ dir: undefined });
    } else if (name in ALIASES && !first.quoted) {
      const [remote, plain] = ALIASES[name]!;
      const odd = target(words.slice(1), remote || undefined);
      out.push({ dir: moved ? undefined : state.dir, odd, plain: !moved && !odd && plain && plainArgs(words.slice(1)), bare: !remote && !words.slice(1).some((w) => !w.text.startsWith("-")) });
    } else if (SHELLS.includes(name)) {
      const k = words.findIndex((w, n) => n > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text));
      let b = k + 1;
      while (k > 0 && words[b]?.text.startsWith("-")) b++;
      const body = k > 0 ? words[b] : undefined;
      // (a script read from /dev/stdin or a process substitution is a pipe's or a heredoc's, which this can't see into)
      const piped = !body && !words.slice(1).some((w) => !w.text.startsWith("-") && !w.text.startsWith("/dev/"));
      if (body && !/\$/.test(body.text)) pushes(body.text, { ...state }, home, out, depth + 1);
      else if (body && mentions(body.text)) out.push({ dir: undefined });
      else if (piped && mentions(src)) out.push({ dir: undefined });
    } else if (name === "eval") {
      const rest = words.slice(1);
      const body = rest.map((w) => w.text).join(" ");
      if (rest.some((w) => w.dynamic)) {
        if (mentions(body)) out.push({ dir: undefined });
      } else pushes(body, state, home, out, depth + 1);
    } else if (/\s/.test(first.text)) {
      // (`env -S 'git push'` splits its word into a command)
      pushes(words.map((w) => w.text).join(" "), { ...state }, home, out, depth + 1);
    } else if (!["echo", "printf"].includes(name)) {
      // (zsh's autocd: a word that is a folder moves the shell there)
      if (/^(\.|~|\/)/.test(first.text) && isDir(place(first, state.dir, home))) state.dir = undefined;
      // (a git behind a program this doesn't know: sudo, xargs, find -exec; and a command line quoted into a runner's word)
      const g = words.findIndex((w) => basename(w.text) === "git");
      if (g > 0) {
        const o = gitOptions(words, g, undefined, home);
        if (o.sub?.text === "push" || o.sub?.text === "subtree" || o.config) out.push({ dir: undefined });
      }
      if (RUNNERS.includes(name) && words.slice(1).some((w) => TEXT.test(w.text))) out.push({ dir: undefined });
    }
  }
  return out;
}

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/** The repository `dir` is in, as its common git dir (a worktree's is its main checkout's), or undefined: not a folder, not in a repository. */
export function repoOf(dir: string): string | undefined {
  if (!real(dir)) return undefined;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const p = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { env, stderr: "ignore" });
  return p.exitCode === 0 ? real(p.stdout.toString().trim()) : undefined;
}

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
