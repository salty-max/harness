#!/usr/bin/env bun
/**
 * A Claude Code PreToolUse hook for the Bash tool: it makes every `git push` prompt the user, except a push in a
 * repository named by --skip (its worktrees too) to its own origin.
 *
 *   bun ask-push.ts --skip ~/code/hundo [--skip <repository>…]     reads the hook's JSON on stdin
 *   bun ask-push.ts --command --bun <bun> --skip <repository>…     prints the shell command to put in settings.json
 *
 * Why a hook and not an ask rule: permission rules from every scope merge, and an ask beats an allow, so a user-level
 * `Bash(git push *)` ask would prompt in a project that opted out (`[asks] skip` in its harness.toml) however its own
 * settings read. A hook's "ask" works on its own and can look at the folder; a rule can't. It never answers "allow",
 * so a push in a skipped repository goes on through the normal permission flow (a hook's allow doesn't override ask
 * or deny rules in any case: code.claude.com/docs/en/permissions, "Precedence among rules, hooks, and mods").
 *
 * What it reads, {cwd, tool_input.command}: every `git [options] push` in the command (each simple command after
 * && || ; | & and newlines, the bodies of $(…) and backticks, `bash -c '…'` and eval, VAR=x and the wrappers env,
 * command, time, nice, nohup, timeout and stdbuf and the shell's if/then/do/while keywords taken off first, and
 * oh-my-zsh's push aliases: gp, gpf, ggpush…).
 * Each push gets the folder it runs in (the cwd, moved by a `cd` earlier in the same command and by each
 * `git -C <path>`), and that folder's repository is what git says: its common dir, so a worktree anywhere on the
 * disk is its main checkout's, and a nested clone is not. A push is let alone only when its repository is a skipped
 * one and it goes to origin: no other remote, no URL, no --repo, --receive-pack or --exec, no `git -c`.
 *
 * It fails towards asking: a variable in the path, `cd -`, pushd, a `cd` in a subshell, a pipeline or before `||`,
 * --git-dir or GIT_*= (also `export GIT_DIR=…` and a line of its own), a folder that isn't there or isn't a
 * repository, a `git … push` behind a program it doesn't know (sudo, xargs, find -exec), a shell fed by a pipe or a
 * heredoc, `git -c alias.p=push p`, `--recurse-submodules=on-demand`, a command it can't read. A command with no
 * push prints nothing (exit 0 with no
 * output is "no opinion"), and so does an allowed push.
 *
 * Not modelled: functions, aliases but the push ones above, a heredoc's expansions, a `git push` made by another
 * program (a script, make), a push URL set in the repository's own config. The ask rules this replaced had the same
 * limits, and matched far fewer forms (`git -c x=y push` and every alias escaped them).
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

type Word = { text: string; dynamic: boolean; quoted: boolean; subs: string[] };
type Sep = "&&" | "||" | ";" | "|" | "&" | "\n" | "";
type Cmd = { words: Word[]; before: Sep; after: Sep };
type State = { dir: string | undefined; gitVar?: boolean };
/** A push found: the folder it runs in (undefined: can't be told) and why its target isn't plainly origin (undefined: it is). */
export type Push = { dir: string | undefined; odd?: string };

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

/** oh-my-zsh's git aliases that push, with the remote each names (""): they have no `git` or `push` in them for a rule to match. */
const ALIASES: Record<string, string> = { gp: "", gpd: "", gpf: "", "gpf!": "", gpfl: "", gpv: "", gpsup: "origin", gpsupf: "origin", ggpush: "origin", ggp: "origin", gpoat: "origin", gpod: "origin", gpu: "upstream" };

const SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];
const GIT_WITH_ARG = ["-C", "--namespace", "--exec-path", "--super-prefix", "--config-env", "--attr-source"];
const EXPORTERS = ["export", "declare", "typeset", "readonly", "local"];
/** Whether a command line may hold a push at all: the word, or one of the push aliases. */
export const mentions = (s: string): boolean => s.includes("push") || /(^|[^\w-])(gp[a-z!]*|ggp[a-z]*)(?![\w-])/.test(s);

/** What a `git` word's options come to: the folder `-C` moves to, where the subcommand is, and what makes the repository or remote unusual. */
function gitOptions(words: Word[], at: number, dir: string | undefined, home: string): { dir: string | undefined; sub: string | undefined; rest: Word[]; odd?: string; config: boolean } {
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
    } else if (GIT_WITH_ARG.includes(t)) i++;
    else if (t.startsWith("-")) continue;
    else break;
  }
  return { dir, sub: words[i]?.text, rest: words.slice(i + 1), odd, config };
}

/** Every push in `src`, with the folder it runs in, `state` being the folder the command starts in (moved by its cd). */
export function pushes(src: string, state: State, home: string, out: Push[] = [], depth = 0): Push[] {
  if (depth > 6) {
    out.push({ dir: undefined });
    return out;
  }
  const { cmds, grouped } = parse(src);
  for (const cmd of cmds) {
    for (const w of cmd.words) for (const sub of w.subs) pushes(sub, { ...state }, home, out, depth + 1);
    const { words, gitVar } = bare(cmd.words);
    const first = words[0];
    if (!first) {
      // (`GIT_DIR=x` alone on a line sets it for the commands after it)
      if (cmd.words.some((w) => gitEnv.test(w.text))) state.gitVar = true;
      continue;
    }
    const name = basename(first.text);
    if (name === "cd") {
      // (quoting stops an alias, not the builtin: "cd" and \cd move the shell too)
      let j = 1;
      while (["-P", "-L", "-e", "-@", "--"].includes(words[j]?.text ?? "")) j++;
      const arg = words[j];
      const to = !arg ? home : arg.text === "-" ? undefined : place(arg, state.dir, home);
      // (a cd that runs in a subshell, a pipeline, the background or only when the one before failed doesn't move the shell that follows)
      const lasts = ["", "&&", ";", "\n"].includes(cmd.after) && ["", "&&", ";", "\n"].includes(cmd.before);
      state.dir = lasts && !grouped ? to : undefined;
    } else if (["pushd", "popd", "chdir"].includes(name)) state.dir = undefined;
    else if (EXPORTERS.includes(name)) {
      if (words.some((w) => gitEnv.test(w.text))) state.gitVar = true;
    } else if (name === "git") {
      const g = gitOptions(words, 0, state.dir, home);
      const moved = gitVar || state.gitVar;
      if (g.sub === "push") out.push({ dir: moved ? undefined : g.dir, odd: moved ? "a GIT_ variable" : g.odd ?? target(g.rest) });
      else if (g.config) out.push({ dir: undefined });
    } else if (name in ALIASES && !first.quoted) out.push({ dir: gitVar || state.gitVar ? undefined : state.dir, odd: target(words.slice(1), ALIASES[name] || undefined) });
    else if (SHELLS.includes(name)) {
      const k = words.findIndex((w, n) => n > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text));
      const body = k > 0 ? words[k + 1] : undefined;
      if (body && !/\$/.test(body.text)) pushes(body.text, { ...state }, home, out, depth + 1);
      else if (body && mentions(body.text)) out.push({ dir: undefined });
      // (a shell with no -c and no script reads its commands from a pipe or a heredoc, which this can't see into)
      else if (!body && !words.slice(1).some((w) => !w.text.startsWith("-")) && mentions(src)) out.push({ dir: undefined });
    } else if (name === "eval") {
      const rest = words.slice(1);
      const body = rest.map((w) => w.text).join(" ");
      if (rest.some((w) => w.dynamic)) {
        if (mentions(body)) out.push({ dir: undefined });
      } else pushes(body, state, home, out, depth + 1);
    } else if (!["echo", "printf"].includes(name)) {
      // (a git behind a program this doesn't know: sudo, xargs, find -exec)
      const g = words.findIndex((w) => basename(w.text) === "git");
      if (g > 0) {
        const o = gitOptions(words, g, undefined, home);
        if (o.sub === "push" || o.config) out.push({ dir: undefined });
      }
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

/** Why this command needs the user's say, or undefined: it has no push, or only pushes to origin in a skipped repository. */
export function decide(command: string, cwd: string | undefined, skip: string[], home: string = homedir()): string | undefined {
  if (!mentions(command)) return undefined;
  let found: Push[];
  try {
    found = pushes(command, { dir: cwd ? resolve(cwd) : undefined }, home);
  } catch {
    return "git push: the command couldn't be read, so its folder is unknown";
  }
  const repos = skip.map((s) => real(join(resolve(s), ".git")) ?? join(resolve(s), ".git"));
  for (const p of found) {
    if (!p.dir) return "git push: its folder can't be told from the command (a variable, cd -, a subshell, --git-dir…)";
    const at = repoOf(p.dir);
    if (!at) return `git push: ${p.dir} isn't in a git repository`;
    if (!repos.includes(at)) return `git push in ${at.replace(/\/\.git$/, "")}`;
    if (p.odd) return `${p.odd}: a push skips the prompt only to origin`;
  }
  return undefined;
}

const answer = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } });

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * The shell command for settings.json's hook: this script, and when it fails (bun gone, the script moved, a crash)
 * an "ask" if the call mentions a push, nothing otherwise, so a broken hook neither lets a push through nor prompts
 * for every command. `skip` are the repositories it leaves alone.
 */
export function hookCommand(bun: string, script: string, skip: string[]): string {
  const failed = JSON.stringify(answer("git push: the ask-push hook failed, so it asks"));
  return `inp=$(cat); out=$(printf '%s' "$inp" | ${quote(bun)} ${quote(script)} ${skip.map((s) => `--skip ${quote(s)}`).join(" ")} 2>/dev/null) || case "$inp" in *push*|*gp*) out=${quote(failed)};; *) out=;; esac; printf '%s' "$out"`;
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
        const why = decide(command, input.cwd, skip);
        if (why) console.log(JSON.stringify(answer(why)));
      }
    } catch {
      // (no JSON to read: nothing to judge, unless it mentions a push)
      if (text.includes("push")) console.log(JSON.stringify(answer("git push: the hook's input couldn't be read")));
    }
  }
}
