/**
 * The gate behind the helpers' no-kill rule: a Claude Code PreToolUse hook (matcher Bash) that sits in the frontmatter
 * of .claude/agents/reviewer.md and architect.md and refuses any command that kills or signals a process, so a helper
 * can't stop a dev server, an e2e server or a watcher that other sessions share (a reviewer ran `pkill -f
 * scripts/serve.mjs` once and took down every worktree's). The prose rule in the same files (`<!-- harness:rule bash
 * -->`) says it; this makes it so.
 *
 *   bun nokill.ts             reads the hook's JSON on stdin ({tool_name, tool_input.command, cwd, agent_type…}); exit 2
 *                             with the reason on stderr refuses the call, any other exit lets it run
 *   bun nokill.ts --session   the same for a session's own Bash (the project's .claude/settings.json runs it, init.ts
 *                             writes it from templates/settings-hooks.json): a kill of the call's own children passes
 *
 * The frontmatter command is `PATH="$PATH:…" bun "$CLAUDE_PROJECT_DIR/<tools dir>/nokill.ts" || exit 2` (init writes it
 * from templates/agents/): `|| exit 2` turns a script that can't run (bun missing, the file not in this worktree) into
 * a refusal, loud, instead of a call that goes through ungated. CLAUDE_PROJECT_DIR is the worktree in a `--bg
 * --worktree` child (probed 21 Nov 2026), so the copy it runs is that worktree's own.
 *
 * What it refuses, reading the command through shell.ts's splitter (each simple command after && || ; | & and newlines,
 * the bodies of $(…) and backticks, `bash -c '…'` and eval, VAR=x and the wrappers env, command, nohup, time, nice,
 * timeout and stdbuf taken off first):
 *   - a command named kill, pkill, killall, killall5, skill, fkill, kill-port or killport, by any path, and `fuser -k`
 *   - the same behind a runner: xargs, sudo, doas, watch, flock, parallel, setsid, caffeinate, script, su, ssh and
 *     `find -exec/-execdir/-ok/-okdir` and busybox run the command in their arguments, and it is that command that is
 *     judged (the first word after the runner's own options, a bundle like `-rI` taking the next word when its last
 *     letter takes a value), so `xargs -r kill -9` and `ssh host 'pkill vite'` are refused and
 *     `xargs grep kill` and `find . -exec grep -l kill {} +` are not. A word with a space in it there is read as a
 *     command line. npx, bunx, pnpx, `bun x`, `npm exec`, `pnpm exec|dlx` and `yarn exec|dlx` run a package: kill-port
 *   - the verbs that stop a server: launchctl kill|stop|bootout|unload|remove|kickstart -k, systemctl and service
 *     stop|kill|restart|reload, docker/podman/nerdctl (and compose) kill|stop|restart|down, pm2 stop|delete|kill|
 *     restart|reload, tmux kill-* and `send-keys C-c`, screen quit, `trap 'kill …'`, brew services stop|restart|kill
 *   - an interpreter's inline script that names a kill (node/bun/deno/python/ruby/perl/php/lua/awk/osascript with a
 *     word holding a space, a parenthesis or a semicolon that says kill, pkill, killall, kill-port, fuser or a SIG…)
 *   - what it can't read when the command line mentions a kill: a command that is a variable, a shell, interpreter,
 *     at or batch fed by a pipe, a here-document or a here-string, a parse that fails, nesting past 6 levels
 * A kill word as an argument is not one: `grep -rn pkill`, `git log --grep=kill`, `cat kill.ts`, `bun test -t kill`,
 * `command -v pkill` pass, so a reviewer can read code that talks about killing. An inline script that names a kill is
 * refused even when it only reads (`awk '/pkill/ {print}'`, `python3 -c "…count('kill')"`): that is the price of
 * judging scripts by their words, and the refusal says to search text with grep or rg.
 *
 * The session's mode (--session) refuses all of that too but for one thing: `kill` (or `/bin/kill`, behind env, nohup,
 * time or timeout) whose every target is this command's own child, once the same line started a background job before
 * it (an earlier command ending in `&`, outside any `( … )` or `{ … }`): `$!`, `${!}`, a job (`%1`, `%%`), or a
 * variable set once from that `$!` whose name the line uses for nothing but reads (`node serve.js & pid=$!; …; kill
 * $pid`: never `for pid in`, `read pid`, `unset pid`, a second assignment); and `kill -0` or `kill -l`,
 * which signal nothing. Those are the call's own by construction: no guess about whose a pid is. Without a job before
 * it, `$!` is no child: zsh, the Bash tool's shell, expands an unset `$!` to 0, so `kill $!` is `kill 0`, the whole
 * process group. The signal is the first option alone, as the shells read it: `kill -9 -0` is a kill of group 0. A
 * literal pid, any other variable or substitution, a group (`0`, `-1`, `-$pid`), no target at all, or a kill behind a
 * runner (xargs, sudo, ssh, find -exec: its targets come from elsewhere) stays refused, and the refusal names the
 * process a literal pid is and points at TaskStop (a background task of the session's) or a report. A session has to
 * restart what it started; it has no business stopping what another session may share.
 *
 * Not modelled: a script, make target or package script that kills inside (`bun run e2e`, `sh stop.sh`), a program
 * that signals through a library, an alias or function defined elsewhere, a command built from pieces the script can't
 * see (`k=ki; ${k}ll`). It stops a careless helper, not a determined one.
 */
import { basename } from "node:path";
import { type Word, assign, bare, parse, unredirected } from "./shell";

/** What a command line must not name when this can't read it: a kill, by any of its usual names, or a signal. */
export const MENTION = /(?<![A-Za-z0-9])(p?kill|killall5?|killpg|kill-?port|fuser|SIG(KILL|TERM|INT|HUP|QUIT|STOP|USR[12]))(?![A-Za-z0-9])/;
const KILLERS = new Set(["kill", "pkill", "killall", "killall5", "skill", "fkill", "fkill-cli", "kill-port", "killport"]);
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];
/** The interpreters, each with the option that gives it a script in the next word (awk takes its program as a word of its own). */
const INTERPRETERS: [name: RegExp, inline: RegExp | undefined][] = [
  [/^(node|nodejs|bun|deno)$/, /^(-[a-zA-Z]*[ep]|--eval|--print)$/],
  [/^python[\d.]*$/, /^-[a-zA-Z]*c$/],
  [/^(ruby|perl)[\d.]*$/, /^-[a-zA-Z]*[eE]$/],
  [/^php[\d.]*$/, /^-[a-zA-Z]*r$/],
  [/^(lua|luajit|osascript)[\d.]*$/, /^-e$/],
  [/^(awk|gawk|mawk)$/, undefined],
  [/^(tclsh|expect)[\d.]*$/, /^-c$/],
];
/** A word that is a script rather than an option or a name: it has a space, a parenthesis, a semicolon or a brace. */
const INLINE = /[\s();{}]/;
/** A number or a duration (`watch -n 2`, `xargs -n 1`), the `{}` of xargs and find: never the command. */
const FILLER = /^(\d+(\.\d+)?[smhd]?|\{\})$/;

/** What a program that runs another command skips before it: its options that take a value, and how many positionals (a host, a lock file) come first. */
const RUNNERS: Record<string, { opts: string[]; positional?: number; flag?: string[] }> = {
  xargs: { opts: ["-I", "-J", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "-R", "-S"] },
  sudo: { opts: ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "-T"] },
  doas: { opts: ["-u", "-C"] },
  watch: { opts: ["-n", "-d"] },
  flock: { opts: ["-w", "-E"], positional: 1, flag: ["-c", "--command"] },
  parallel: { opts: ["-j", "-n", "-N", "-P", "-a", "-S", "-I"] },
  setsid: { opts: [] },
  caffeinate: { opts: ["-t", "-w"] },
  script: { opts: ["-t", "-F"], positional: 1 },
  su: { opts: ["-g", "-G", "-s"], flag: ["-c", "--command"] },
  ssh: { opts: ["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-E", "-e", "-I", "-m", "-O", "-S", "-W", "-w", "-B", "-Q"], positional: 1 },
  // (these run a package, whose name is the command)
  npx: { opts: ["-p", "--package", "-c"] },
  bunx: { opts: ["-p", "--package"] },
  pnpx: { opts: [] },
  // (a multi-call binary: the applet is the command)
  busybox: { opts: [] },
  toybox: { opts: [] },
};
/** `<program> <word>` that runs a package: bun x, npm exec, pnpm exec|dlx, yarn exec|dlx. */
const PACKAGE_RUNNERS: Record<string, string[]> = { bun: ["x"], npm: ["exec", "x"], pnpm: ["exec", "dlx"], yarn: ["exec", "dlx"] };
/** The programs that read a script from their stdin, a pipe or a here-document, with no file given. */
const STDIN_FED = ["at", "batch"];

/**
 * What a judgement needs beyond the words: the command line the hook was given, the session's mode, and where the
 * command being judged stands in it: whether a background job was started before it (`bg`) and the variables set from
 * that job's `$!` before it (`own`).
 */
type Ctx = { whole: string; session: boolean; bg: boolean; own: Set<string> };

/**
 * Whether a variable's name appears in the whole command line only as one assignment of `$!` and as plain reads
 * (`$name`, `${name}`): any other appearance can change it where a reading in order can't see (`for name in …`,
 * `read name`, `let`, `printf -v name`, `unset name`, `name+=`, `${name:=…}`, a second assignment, one later in a loop
 * body or a trap's handler, a word holding the name), so the variable is no child of the call's.
 */
export function soleAssignment(whole: string, name: string): boolean {
  let assigns = 0;
  for (const m of whole.matchAll(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "g"))) {
    const at = m.index!;
    const after = whole.slice(at + name.length);
    if (whole[at - 1] === "$") continue;
    if (whole.slice(at - 2, at) === "${") {
      if (after.startsWith("}")) continue;
      return false;
    }
    if (/^=("?)\$(!|\{!\})\1(?![^\s;&|)])/.test(after)) {
      assigns++;
      continue;
    }
    return false;
  }
  return assigns === 1;
}

/**
 * Where each top-level command of a line stands: a background job started before it (an earlier command ended with `&`,
 * the line not grouped: a `&` inside `( … )` or `{ … }` is another shell's, or may be), and the variables set from `$!`
 * before it, after such a job (`pid=$!` before a command or alone, `export pid=$!`, `local`, `declare`, `readonly`,
 * `typeset`), whose name the whole line (`whole`) uses for nothing else (`soleAssignment`). Without a job, `$!` is no
 * child: zsh, the Bash tool's shell, expands it to 0 (`kill $!` is `kill 0`, the whole process group), bash to nothing.
 */
export function standing(src: string, seed?: { bg: boolean; own: Set<string> }, whole: string = src): { bg: boolean; own: Set<string> }[] {
  const sole = new Map<string, boolean>();
  const isSole = (name: string) => sole.get(name) ?? (sole.set(name, soleAssignment(whole, name)), sole.get(name)!);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(src);
  } catch {
    return [];
  }
  const out: { bg: boolean; own: Set<string> }[] = [];
  let bg = seed?.bg ?? false;
  const vars = new Map<string, boolean>([...(seed?.own ?? [])].map((name) => [name, true]));
  for (const cmd of parsed.cmds) {
    out.push({ bg, own: new Set([...vars].filter(([, own]) => own).map(([name]) => name)) });
    const note = (w: Word) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(w.text);
      if (m) vars.set(m[1]!, bg && /^\$(!|\{!\})$/.test(m[2]!) && isSole(m[1]!));
    };
    let i = 0;
    while (cmd.words[i] && assign.test(cmd.words[i]!.text)) note(cmd.words[i++]!);
    if (["export", "local", "declare", "readonly", "typeset"].includes(cmd.words[i]?.text ?? "")) for (const w of cmd.words.slice(i + 1)) note(w);
    if (cmd.after === "&" && !parsed.grouped) bg = true;
  }
  return out;
}

/** The variables set from a background job's `$!` by the end of the line, for a test. */
export const ownVars = (whole: string): Set<string> => {
  const s = standing(`${whole}\n:`);
  return s.length ? s[s.length - 1]!.own : new Set();
};

/** Whether a kill target is the call's own child: `$!`, `${!}` or a job spec once a background job started, or a variable set from that `$!`. */
const ownTarget = (w: Word, ctx: Ctx): boolean => {
  if (!ctx.bg) return false;
  if (w.text === "$!" || w.text === "${!}" || (!w.dynamic && /^%([%+-]|\d+)$/.test(w.text))) return true;
  const v = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(w.text);
  return !!v && ctx.own.has((v[1] ?? v[2])!);
};

/**
 * Whether a session's `kill` stops only what its own command started: every target its own child, or a signal of 0
 * (`-0`, `-s 0`, `-n 0`: a check that sends nothing), or `-l`/`-L` (a list of the signals). The signal is the first
 * option alone, as bash, zsh and /bin/kill read it: every word after it is a target (`kill -9 -0` is a kill of
 * process group 0, refused). No target is no pass: a runner may be feeding it pids.
 */
function ownKill(args: Word[], ctx: Ctx): boolean {
  let signal: string | undefined;
  let i = 0;
  const first = args[0];
  if (first && first.text === "--") i = 1;
  else if (first && !first.dynamic && /^-[lL]$/.test(first.text)) return true;
  else if (first && ["-s", "-n", "--signal"].includes(first.text)) {
    signal = args[1]?.dynamic ? "?" : (args[1]?.text ?? "?");
    i = 2;
  } else if (first && !first.dynamic && /^-[A-Za-z0-9]+$/.test(first.text)) {
    signal = first.text.slice(1);
    i = 1;
  }
  if (signal !== undefined && args[i]?.text === "--") i++;
  const targets = args.slice(i);
  if (signal === "0") return true;
  return targets.length > 0 && targets.every((t) => ownTarget(t, ctx));
}

const dyn = (w: Word | undefined) => !!w && w.dynamic && !w.text.includes("/");
const words = (ws: Word[]) => ws.map((w) => w.text);

/**
 * Whether an option word takes the NEXT word as its value: a listed option alone (`-I`, `--signal`), or a bundle of short
 * ones whose first value-taking letter is its last (`-rI`, `-nu`), but not one with the value attached (`-n1`, `-uroot`).
 */
function valueNext(opts: string[], t: string): boolean {
  if (t.startsWith("--")) return opts.includes(t);
  for (let k = 1; k < t.length; k++) if (opts.includes(`-${t[k]}`)) return k === t.length - 1;
  return false;
}

/** The words of a runner's arguments after its own options (and its positionals), the command it runs and that command's arguments. */
function runs(name: string, args: Word[]): Word[] {
  const rule = RUNNERS[name]!;
  // (`su -c 'cmd'`, `flock file -c 'cmd'`: the command is the word after the flag)
  const f = rule.flag ? args.findIndex((w) => rule.flag!.includes(w.text)) : -1;
  if (f >= 0 && args[f + 1]) return [args[f + 1]!];
  let i = 0;
  let positional = rule.positional ?? 0;
  while (i < args.length) {
    const w = args[i]!;
    if (w.text === "--") {
      i++;
      break;
    }
    if (w.text.startsWith("-") && w.text.length > 1) i += valueNext(rule.opts, w.text) ? 2 : 1;
    else if (FILLER.test(w.text) || assign.test(w.text)) i++;
    else if (positional > 0) {
      positional--;
      i++;
    } else break;
  }
  return args.slice(i);
}

/** The command `find` runs for -exec, -execdir, -ok and -okdir (its words up to the `;` or `+` that ends them), or none. */
function execOf(args: Word[]): Word[] {
  const at = args.findIndex((w) => /^-(exec|execdir|ok|okdir)$/.test(w.text));
  if (at < 0) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((w) => w.text === ";" || (w.text === "+" && !w.quoted));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The verbs that stop a server, per program: the reason, or undefined when the words don't. */
function stops(name: string, args: Word[]): string | undefined {
  const all = words(args);
  const plain = all.filter((t) => !t.startsWith("-"));
  const has = (...verbs: string[]) => verbs.find((v) => plain.includes(v));
  let v: string | undefined;
  switch (name) {
    case "launchctl":
      v = plain[0] && ["kill", "stop", "bootout", "unload", "remove"].includes(plain[0]) ? plain[0] : plain[0] === "kickstart" && all.some((t) => /^-\w*k/.test(t)) ? "kickstart -k" : undefined;
      break;
    case "systemctl":
    case "service":
      v = has("stop", "kill", "restart", "reload", "try-restart", "reload-or-restart", "force-reload");
      break;
    case "docker":
    case "podman":
    case "nerdctl":
    case "docker-compose":
      v = has("kill", "stop", "restart", "down");
      break;
    case "pm2":
      v = has("stop", "delete", "kill", "restart", "reload");
      break;
    case "tmux":
      // (send-keys C-c is a SIGINT to what runs in the pane)
      v = plain.find((t) => t.startsWith("kill-")) ?? (plain.includes("send-keys") && plain.some((t) => /^C-[c\\]$/.test(t)) ? "send-keys C-c" : undefined);
      break;
    case "screen":
      v = has("quit");
      break;
    case "brew":
      v = plain.includes("services") ? has("stop", "restart", "kill") : undefined;
      break;
  }
  return v ? `${name} ${v}` : undefined;
}

/** A shell's `-c` body, undefined when it has none; `piped` when it reads a script from stdin (no file, no body). */
function shellBody(ws: Word[]): { body: Word | undefined; piped: boolean } {
  const k = ws.findIndex((w, n) => n > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text));
  let b = k + 1;
  while (k > 0 && ws[b]?.text.startsWith("-")) b++;
  const body = k > 0 ? ws[b] : undefined;
  return { body, piped: !body && !ws.slice(1).some((w) => !w.text.startsWith("-") && !w.text.startsWith("/dev/")) };
}

/**
 * Why one simple command (its words, wrappers and redirections taken off) kills or stops a process, or undefined. `ctx.whole`
 * is the command line the hook was given, for what a piece can't tell on its own; `direct` is false for a command a runner
 * (xargs, sudo, ssh, find -exec) runs, whose arguments may come from elsewhere.
 */
function judge(ws: Word[], ctx: Ctx, depth: number, direct = true): string | undefined {
  const { whole } = ctx;
  const first = ws[0];
  if (!first) return undefined;
  const name = basename(first.text);
  const rest = ws.slice(1);
  if (dyn(first) || first.text.startsWith("=")) return MENTION.test(whole) ? "a command that is a variable or a substitution, on a line that mentions a kill" : undefined;
  if (/\s/.test(first.text)) return scan(words(ws).join(" "), ctx, depth + 1, null);
  // (a session may stop its own command's children: `kill $!`, `kill %1`, a variable set from $!, once a job started)
  if (name === "kill" && ctx.session && direct && ownKill(rest, ctx)) return undefined;
  if (KILLERS.has(name)) return name;
  if (name === "fuser") return rest.some((w) => /^-[a-zA-Z]*k|^--kill$/.test(w.text)) ? "fuser -k" : undefined;
  const stop = stops(name, rest);
  if (stop) return stop;
  if (SHELLS.includes(name)) {
    const { body, piped } = shellBody(ws);
    // (a new shell: no job of this one's is its)
    if (body) return scan(body.text, ctx, depth + 1, null);
    return piped && MENTION.test(whole) ? `${name} fed by a pipe or a here-document, on a line that mentions a kill` : undefined;
  }
  if (name === "eval") return scan(words(rest).join(" "), ctx, depth + 1, ctx);
  // (`trap 'kill 0' EXIT`: the handler is a command line)
  if (name === "trap") {
    const handler = rest.find((w) => !w.text.startsWith("-"));
    return handler ? scan(handler.text, ctx, depth + 1, ctx) : undefined;
  }
  if (STDIN_FED.includes(name)) return MENTION.test(whole) ? `${name} reads its script from stdin, on a line that mentions a kill` : undefined;
  if (name === "find") {
    const cmd = execOf(rest);
    return cmd.length ? judge(unredirected(bare(cmd).words), ctx, depth + 1, false) : undefined;
  }
  if (name in RUNNERS) {
    const cmd = runs(name, rest);
    // (npx and the rest: the package is the command; ssh and the rest: a word with a space is a command line)
    const got = cmd.length ? judge(unredirected(bare(cmd).words), ctx, depth + 1, false) : undefined;
    return got ? `${name} ${got}` : undefined;
  }
  if (name in PACKAGE_RUNNERS) {
    const at = rest.findIndex((w) => !w.text.startsWith("-"));
    if (at >= 0 && PACKAGE_RUNNERS[name]!.includes(rest[at]!.text)) {
      const pkg = rest.slice(at + 1).find((w) => !w.text.startsWith("-") && !FILLER.test(w.text));
      if (pkg && KILLERS.has(basename(pkg.text))) return `${name} ${rest[at]!.text} ${basename(pkg.text)}`;
    }
  }
  const interp = INTERPRETERS.find(([n]) => n.test(name));
  if (interp) {
    // (the script is the word after -e, -c, -r…, or after deno's `eval`, or `--eval=…`; awk's is any word that looks like one)
    const scripts = rest.filter((w, i) => (interp[1] ? interp[1].test(rest[i - 1]?.text ?? "") || (name === "deno" && rest[i - 1]?.text === "eval") || /^--(eval|print)=/.test(w.text) : INLINE.test(w.text)));
    if (scripts.some((w) => MENTION.test(w.text) || (name === "osascript" && /\bquit\b/.test(w.text)))) return `${name} with an inline script that names a kill (refused even to read: search text with grep or rg)`;
    // (`node -`, `python3 - <<EOF`, `echo '…' | bun`: no file and no inline script, so the script is on stdin)
    const given = rest.some((w) => !w.text.startsWith("-") && !w.text.startsWith("/dev/"));
    if (!given && MENTION.test(whole)) return `${name} reading its script from stdin, on a line that mentions a kill`;
  }
  return undefined;
}

/**
 * Why a piece of the command line kills or stops a process (the first thing found), or undefined. `seed` is the standing
 * the piece starts from (a subshell, an eval or a trap's handler inherits the shell's jobs; a new shell, null, has none).
 */
function scan(src: string, ctx: Ctx, depth: number, seed: { bg: boolean; own: Set<string> } | null): string | undefined {
  if (depth > 6) return MENTION.test(ctx.whole) ? "nested too deep to read, on a line that mentions a kill" : undefined;
  const { cmds } = parse(src);
  const stand = ctx.session ? standing(src, seed ?? undefined, ctx.whole) : [];
  for (const [i, cmd] of cmds.entries()) {
    const here: Ctx = { ...ctx, bg: stand[i]?.bg ?? false, own: stand[i]?.own ?? new Set() };
    for (const w of cmd.words) for (const sub of w.subs) {
      const got = scan(sub, here, depth + 1, here);
      if (got) return got;
    }
    const plain = unredirected(cmd.words);
    // (`command -v pkill` looks a program up, it doesn't run it)
    if (basename(plain[0]?.text ?? "") === "command" && /^-[a-zA-Z]*[vV]/.test(plain[1]?.text ?? "")) continue;
    const got = judge(bare(plain).words, here, depth);
    if (got) return got;
  }
  return undefined;
}

/** Why a command line kills or stops a process (the first thing found), or undefined. `whole` is the line the hook was given; `session`, the session's mode (its own command's children may be stopped). */
export function kills(src: string, whole: string = src, depth = 0, session = false): string | undefined {
  return scan(src, { whole, session, bg: false, own: new Set() }, depth, null);
}

/** The reason a Bash command is refused, or undefined to let it run. It never throws: what it can't read is refused when the line mentions a kill. */
export function refusal(command: string, session = false): string | undefined {
  try {
    return kills(command, command, 0, session);
  } catch {
    return MENTION.test(command) ? "a command line this can't read, and it mentions a kill" : undefined;
  }
}

/** The literal pids a refused command line gives `kill` (its words after a kill, numbers not options), for the refusal to name. */
export function literalPids(command: string): number[] {
  const out = new Set<number>();
  for (const m of command.matchAll(/(?<![A-Za-z0-9-])kill\b([^;&|\n)]*)/g)) for (const n of m[1]!.matchAll(/(?<![-\w$])(\d+)(?![\w.])/g)) if (Number(n[1]) > 1) out.add(Number(n[1]));
  return [...out].slice(0, 5);
}

/** What each pid is, one `ps` line each (`<pid> <ppid> <started> <command>`), or that no such process runs. */
function described(pids: number[]): string[] {
  return pids.map((pid) => {
    const p = Bun.spawnSync(["ps", "-o", "pid=,ppid=,lstart=,command=", "-p", String(pid)], { stderr: "ignore" });
    const line = p.exitCode === 0 ? p.stdout.toString().trim().replace(/\s+/g, " ") : "";
    return line ? `  ${line.slice(0, 200)}` : `  ${pid}: no such process`;
  });
}

/** What the gate says on stderr when it refuses, for a helper or for a session. */
export function refusalText(why: string, command: string, session: boolean): string {
  if (!session) return `Refused (the no-kill gate): ${why}. A helper never kills, signals or stops a process, since other sessions share the servers and watchers. Report what it would have fixed as a finding instead.`;
  const pids = literalPids(command);
  return [
    `Refused (the no-kill gate): ${why}. A session stops only what its own command started: a job it put in the background with & earlier in the same command, by \`kill $!\`, \`kill %1\` or a variable set from that $!. A background task of yours stops with TaskStop, a preview with preview_stop. Anything else may be another session's server or watcher: report it (to your opener, or the user) instead of stopping it.`,
    ...(/inline script|stdin|a pipe|can't read|variable|nested/.test(why) ? ["A script that only mentions a kill (an edit, a search): put it in a file and run that, or search with grep or rg."] : []),
    ...(pids.length ? ["What that pid is:", ...described(pids)] : []),
  ].join("\n");
}

if (import.meta.main) {
  const session = process.argv.includes("--session");
  const text = await Bun.stdin.text();
  let why: string | undefined;
  let command = "";
  try {
    const input = JSON.parse(text) as { tool_name?: string; tool_input?: { command?: unknown } };
    const c = input.tool_input?.command;
    if ((input.tool_name === undefined || input.tool_name === "Bash") && typeof c === "string") why = refusal((command = c), session);
  } catch {
    why = MENTION.test(text) ? "the hook's input couldn't be read, and it mentions a kill" : undefined;
  }
  if (why) {
    console.error(refusalText(why, command, session));
    process.exit(2);
  }
}
