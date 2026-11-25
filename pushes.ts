/**
 * The pushes in a command line, and the folder each runs in: the reader claude-hooks/ask-push.ts (the user's push ask,
 * not vendored) and outgoing.ts (what a push sends and how the gates will judge it, vendored) share, moved out of
 * ask-push.ts the way shell.ts was, so a fix here reaches both.
 *
 * Every `git [options] push` in the command (each simple command after && || ; | & and newlines, the bodies of $(…)
 * and backticks, `bash -c '…'` and eval, VAR=x and the wrappers taken off first, and oh-my-zsh's push aliases: gp,
 * gpf, ggpush…). Each push gets the folder it runs in (the cwd, moved by a `cd` earlier in the same command and by
 * each `git -C <path>`), undefined when that can't be told (a variable, cd -, a subshell, --git-dir…), whether its
 * target isn't plainly origin, whether its words are all plain, and its words after `push` (an alias's own remote
 * first), for a reader that resolves the refs it sends.
 */
import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { type Word, bare, gitEnv, parse, unredirected } from "./shell";

export type State = { dir: string | undefined; gitVar?: boolean; maybe?: boolean };
/** A push found: the folder it runs in (undefined: can't be told), why its target isn't plainly origin (undefined: it is), whether its words are all plain (no force, delete, --all, --tags, +/: refspec, other remote or option), and whether it names no remote (a bare push goes where the repository's config says). */
export type Push = { dir: string | undefined; odd?: string; plain?: boolean; bare?: boolean; args?: string[]; alias?: string };

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
export const ALIASES: Record<string, [remote: string, plain: boolean]> = {
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

const isDir = (p: string | undefined) => {
  try {
    return !!p && statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** What a `git` word's options come to: the folder `-C` moves to, where the subcommand is, and what makes the remote unusual. */
export function gitOptions(words: Word[], at: number, dir: string | undefined, home: string): { dir: string | undefined; sub: Word | undefined; rest: Word[]; odd?: string; config: boolean } {
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
        out.push({ dir: moved ? undefined : g.dir, odd, plain: !odd && plainArgs(g.rest), bare: !g.rest.some((w) => !w.text.startsWith("-")), args: g.rest.some((w) => w.dynamic) ? undefined : g.rest.map((w) => w.text) });
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
      out.push({ dir: moved ? undefined : state.dir, odd, plain: !moved && !odd && plain && plainArgs(words.slice(1)), bare: !remote && !words.slice(1).some((w) => !w.text.startsWith("-")), args: words.slice(1).some((w) => w.dynamic) ? undefined : [...(remote ? [remote] : []), ...words.slice(1).map((w) => w.text)], alias: name });
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

export const real = (p: string): string | undefined => {
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
