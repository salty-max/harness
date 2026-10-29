/**
 * The harness's event log: one line for each thing a tool did that the
 * desktop panel's log shows (harness-view). The tools whose own files keep
 * only the latest state append here as they act: q.ts (a run's verdict, the
 * stamp), review.ts (a verdict), board.ts (a card added or moved), and the
 * git hooks (a refusal, written by the shell). Helpers and the push or
 * release prompts the user answered come from the transcripts instead.
 *
 *   <ISO time>\t<source>\t<tone>\t<repo>\t<text>
 *
 *   tone   ok, wait, fail, info, or empty: the panel reads it from the words
 *
 *   bun events.ts [n]     the last n events (10), newest last
 *
 * The file: <cache dir>/events.log (harness.toml [state]; HARNESS_EVENTS:
 * another file, "off": none), trimmed to its last 500 lines past 256 KB
 * (a line another tool appends while the trim rewrites the file is lost:
 * rare, and only a line of the log). Writing it never fails the tool that
 * writes.
 *
 * Beside it, the gates at work: a q.ts run going on has a file of its own,
 * running/<pid>.json ({ pid, name, repo, at }), written as it starts and
 * removed before its verdict reaches the log. The panel lights its gates
 * only while one is there and its process lives. A run killed before its
 * end leaves its file: the next run's start sweeps those whose process is
 * gone.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { eventsFile, repoName } from "./config";

export type Tone = "ok" | "wait" | "fail" | "info" | "";

const MAX_BYTES = 256 * 1024;
const KEEP_LINES = 500;

export const eventsPath = eventsFile;

// One field of a line: no tab, no line break.
const field = (text: string) => text.replace(/[\t\r\n]+/g, " ").trim();

export function eventLine(source: string, tone: Tone, repo: string, text: string, at = new Date()): string {
  return `${[at.toISOString(), field(source), tone, field(repo), field(text)].join("\t")}\n`;
}

export function logEvent(source: string, tone: Tone, repo: string, text: string): void {
  const file = eventsPath();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, eventLine(source, tone, repo, text));
    if (statSync(file).size > MAX_BYTES) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      writeFileSync(file, `${lines.slice(-KEEP_LINES).join("\n")}\n`);
    }
  } catch {}
}

// The runs going on: the log's folder's running/ (none when the log is off).
export function runsDir(): string | undefined {
  const file = eventsPath();
  return file ? join(dirname(file), "running") : undefined;
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// A run starts: its file written (the dead ones' swept first); the function
// it returns removes it. Neither ever fails the run.
export function startRun(name: string, repo: string): () => void {
  const dir = runsDir();
  if (!dir) return () => {};
  const file = join(dir, `${process.pid}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      const pid = Number(/^(\d+)\.json$/.exec(f)?.[1]);
      if (pid && !isAlive(pid)) rmSync(join(dir, f), { force: true });
    }
    const tmp = join(dir, `.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, name: field(name), repo: field(repo), at: Date.now() })}\n`);
    renameSync(tmp, file);
  } catch {}
  return () => {
    try {
      rmSync(file, { force: true });
    } catch {}
  };
}

// A repository by its configured name (its main checkout's folder name by default), a worktree's too.
export const repoOf = repoName;

if (import.meta.main) {
  const n = Number(process.argv[2] ?? 10);
  const file = eventsPath();
  if (!file || !existsSync(file)) console.log("no events yet");
  else console.log(readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n"));
}
