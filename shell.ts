/**
 * The shell-words splitter the harness hooks share: a command line cut into its simple commands (each a list of words,
 * quotes taken off, with what ran before and after it), the bodies of $(…) and backticks kept on the word that holds
 * them, a heredoc's body skipped as text, and the wrappers (env, command, nice, timeout…) and redirections a command may
 * carry taken off. claude-hooks/ask-push.ts (the user's git push ask, not vendored) and nokill.ts (the helpers' gate on
 * killing a process, vendored) both read a command through it, so a fix here reaches both.
 */
import { basename } from "node:path";

export type Word = { text: string; dynamic: boolean; quoted: boolean; subs: string[] };
export type Sep = "&&" | "||" | ";" | "|" | "&" | "\n" | "";
export type Cmd = { words: Word[]; before: Sep; after: Sep };

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

export const assign = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const gitEnv = /^GIT_[A-Z_]*=/;

/** The words of a command with its leading assignments and wrappers taken off, and whether one of them is a GIT_ variable (it may move the repository or the remote). */
export function bare(words: Word[]): { words: Word[]; gitVar: boolean } {
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

/** A redirection (`2>&1`, `> file`, `&>`, `<<<`) is no argument and no command; one that names no file takes the word after it. */
export const REDIRECT = /^(?:\d*|&)(?:>>?|<>?|<<<?|>&|<&)(.*)$/;
export function unredirected(words: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = words[i]!.quoted ? null : REDIRECT.exec(words[i]!.text);
    if (!m) out.push(words[i]!);
    else if (m[1] === "") i++;
  }
  return out;
}
