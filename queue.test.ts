// queue.ts: the check queue, driven with fake pids and clocks, then q.ts end to end (bun test).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliveSince, acquire, DEFAULT_LIMIT, holderOf, inside, queueDir, status, statusLines, takeAway, waitingLine, type Holder } from "./queue";
import { limitMinutes, parse, parsePs, sameStart, stampOf, treeOf, verdict, workTree } from "./q";
import { loadConfig, parseConfig } from "./config";
import { scopedRoot, useBoardGuard } from "./testing";

useBoardGuard();

const KIT = import.meta.dir;
let tmp: string;
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "queue-test-")));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const dir = join(tmp, `q-${++n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** A clock the test moves, and a wait that only yields (a short real sleep, so the other waiters run). */
const clock = (start = Date.now()) => {
  let t = start;
  return { now: () => t, move: (ms: number) => (t += ms) };
};
const base = { name: "check", repo: "hundo", where: "/w/a", poll: 1, sleep: (ms: number) => Bun.sleep(ms) };
/** Waits (up to 5 s) for what a waiter's poll loop does on its own time. */
const until = async (done: () => boolean) => {
  for (let i = 0; i < 250 && !done(); i++) await Bun.sleep(20);
};

describe("queue: the folder and the processes", () => {
  test("HARNESS_QUEUE names the folder or turns the queue off, else the user's cache", () => {
    expect(queueDir({ HARNESS_QUEUE: "off" })).toBeUndefined();
    expect(queueDir({ HARNESS_QUEUE: "/q" })).toBe("/q");
    expect(queueDir({ XDG_CACHE_HOME: "/c" })).toBe("/c/harness/queue");
    expect(queueDir({})).toMatch(/\/\.cache\/harness\/queue$/);
  });

  test("a process is alive when its pid answers and it started no later than its file (a reused pid started after)", () => {
    const at = 1_800_000_000_000;
    expect(aliveSince(process.pid, at, () => at - 5_000)).toBe(true);
    // (ps's start is cut to the second: the same second counts)
    expect(aliveSince(process.pid, at, () => at + 900)).toBe(true);
    expect(aliveSince(process.pid, at, () => at + 5_000)).toBe(false);
    // no such pid
    expect(aliveSince(2147483000, at, () => at - 5_000)).toBe(false);
    // ps can't say: the pid's answer is all there is
    expect(aliveSince(process.pid, at, () => null)).toBe(true);
    expect(aliveSince(process.pid, at, () => undefined)).toBe(false);
  });

  test("inside a holder's command, the queue is skipped, a holder gone is no excuse", () => {
    expect(inside({}, () => true)).toBe(false);
    expect(inside({ HARNESS_QUEUE_HELD: "abc" }, () => true)).toBe(false);
    expect(inside({ HARNESS_QUEUE_HELD: "123" }, () => true)).toBe(true);
    expect(inside({ HARNESS_QUEUE_HELD: "123" }, () => false)).toBe(false);
  });

  test("the waiting line names who runs, where, for how long, and how many are ahead", () => {
    const h: Holder = { pid: 42, at: 1000, name: "check", repo: "yonder", where: "/p/yonder" };
    const line = waitingLine("check", h, 2, 1000 + 41_000);
    expect(line).toContain("check: waiting for yonder's check in /p/yonder (pid 42, running 41s)");
    expect(line).toContain("2 more waiting ahead of this one");
    expect(line).toContain("a tool call that times out loses its place");
    expect(waitingLine("check", undefined, 0, 0)).toContain("waiting for the check ahead of it");
  });

  test("the waiting line says the holder's limit and what is left of it, or how far past it", () => {
    const h: Holder = { pid: 42, at: 0, name: "shots", repo: "hundo", where: "/p/hundo", limit: 1800 };
    expect(waitingLine("check", h, 0, 8 * 60_000)).toContain("hundo's shots in /p/hundo (pid 42, running 8min, limit 30min, 22min left)");
    expect(waitingLine("check", h, 0, 52 * 60_000)).toContain("(pid 42, running 52min, limit 30min, 22min past it)");
    // a repeat is short, and says it is still so; the first says where to see the whole line
    expect(waitingLine("check", h, 1, 8 * 60_000, { again: true })).toBe("check: still waiting for hundo's shots in /p/hundo (pid 42, running 8min, limit 30min, 22min left), 1 more waiting ahead of this one");
    expect(waitingLine("check", h, 0, 0, { status: "bun harness/q.ts --queue-status" })).toContain("The whole line: bun harness/q.ts --queue-status");
  });

  test("the lock's limit is a number of seconds, or it is none (an older q wrote none)", () => {
    const dir = fresh();
    const lock = (extra: object) => writeFileSync(join(dir, "lock.json"), `${JSON.stringify({ pid: 5, at: 1, name: "check", repo: "r", where: "/x", ...extra })}\n`);
    lock({});
    expect(holderOf(dir)).toEqual({ pid: 5, at: 1, name: "check", repo: "r", where: "/x" });
    lock({ limit: 1800 });
    expect(holderOf(dir)?.limit).toBe(1800);
    for (const bad of ["soon", -3, 0, null]) {
      lock({ limit: bad });
      expect(holderOf(dir)?.limit).toBeUndefined();
      expect(holderOf(dir)?.pid).toBe(5);
    }
  });
});

describe("queue: the status", () => {
  test("holder and waiters are read, a dead one marked, and nothing is swept or taken away", () => {
    const dir = fresh();
    mkdirSync(join(dir, "waiting"));
    writeFileSync(join(dir, "lock.json"), `${JSON.stringify({ pid: 42, at: 1000, name: "shots", repo: "hundo", where: "/w/x", limit: 1800 })}\n`);
    const ticket = (pid: number, at: number, name: string) => writeFileSync(join(dir, "waiting", `${String(at).padStart(13, "0")}-${pid}.json`), `${JSON.stringify({ pid, at, name, repo: "hundo", where: `/w/${name}` })}\n`);
    ticket(43, 2000, "check");
    ticket(44, 3000, "lint");
    writeFileSync(join(dir, "waiting", "0000000004000-45.json.45.tmp"), "{");
    const s = status(dir, (pid) => pid !== 44);
    expect(s.holder).toMatchObject({ pid: 42, alive: true });
    expect(s.waiting.map((t) => [t.pid, t.alive])).toEqual([[43, true], [44, false]]);
    const lines = statusLines(s, 1000 + 52 * 60_000);
    expect(lines).toEqual([
      `queue: ${dir}`,
      "holder: hundo's shots in /w/x (pid 42, running 52min, limit 30min, 22min past it)",
      "waiting (the first goes next):",
      "  1. hundo's check in /w/check (pid 43, waiting 52min)",
      "  2. hundo's lint in /w/lint (pid 44, waiting 52min) · gone: swept at the next look",
    ]);
    // read only
    expect(readdirSync(join(dir, "waiting")).sort()).toEqual(["0000000002000-43.json", "0000000003000-44.json", "0000000004000-45.json.45.tmp"]);
    expect(holderOf(dir)?.pid).toBe(42);
    // a dead holder is said, and left for the next waiter
    expect(statusLines(status(dir, () => false), 2000).some((l) => l.includes("pid 42 is gone: the next waiter takes the place"))).toBe(true);
    expect(statusLines(status(fresh()))).toEqual([expect.stringContaining("queue: "), "holder: none, the next run takes the place at once", "waiting: none"]);
  });
});

describe("queue: acquire and release", () => {
  const alive = () => true;

  test("the first takes the lock at once, and giving it up frees it", async () => {
    const dir = fresh();
    const said: string[] = [];
    const a = await acquire({ ...base, dir, pid: 1001, alive, say: (l) => said.push(l) });
    expect(said).toEqual([]);
    expect(holderOf(dir)).toMatchObject({ pid: 1001, name: "check", repo: "hundo", where: "/w/a" });
    expect(readdirSync(join(dir, "waiting"))).toEqual([]);
    a.release();
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
  });

  test("a release leaves a lock that is no longer its own", async () => {
    const dir = fresh();
    const a = await acquire({ ...base, dir, pid: 1001, alive });
    // (taken over meanwhile: another's lock stands)
    writeFileSync(join(dir, "lock.json"), `${JSON.stringify({ pid: 1002, at: 1, name: "check", repo: "r", where: "/x" })}\n`);
    a.release();
    expect(holderOf(dir)?.pid).toBe(1002);
  });

  test("the others wait, one line each, and go in the order they came", async () => {
    const dir = fresh();
    const a = await acquire({ ...base, dir, pid: 1001, alive });
    const order: number[] = [];
    const said: string[][] = [[], []];
    const t = clock();
    const wait = (pid: number, i: number) =>
      acquire({ ...base, dir, pid, alive, now: t.now, say: (l) => said[i]!.push(l) }).then((lease) => {
        order.push(pid);
        return lease;
      });
    t.move(10);
    const b = wait(1002, 0);
    await Bun.sleep(20);
    t.move(10);
    const c = wait(1003, 1);
    await Bun.sleep(40);
    expect(order).toEqual([]);
    expect(said[0]).toHaveLength(1);
    expect(said[0]![0]).toContain("waiting for hundo's check in /w/a (pid 1001");
    expect(said[1]![0]).toContain("1 more waiting ahead of this one");
    a.release();
    const lb = await b;
    expect(order).toEqual([1002]);
    expect(holderOf(dir)?.pid).toBe(1002);
    await Bun.sleep(20);
    expect(order).toEqual([1002]);
    lb.release();
    const lc = await c;
    expect(order).toEqual([1002, 1003]);
    lc.release();
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
    expect(readdirSync(join(dir, "waiting"))).toEqual([]);
    // still one line each, however long it took
    expect(said[0]).toHaveLength(1);
    expect(said[1]).toHaveLength(1);
  });

  test("a lock whose holder is gone is taken over and said", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "lock.json"), `${JSON.stringify({ pid: 777, at: 5, name: "check", repo: "ghost", where: "/g" })}\n`);
    const said: string[] = [];
    const lease = await acquire({ ...base, dir, pid: 1001, alive: (p) => p !== 777, say: (l) => said.push(l) });
    expect(lease.tookOver).toMatchObject({ pid: 777, repo: "ghost" });
    expect(said.some((l) => l.includes("ghost's check (pid 777) is gone: taking its place"))).toBe(true);
    expect(holderOf(dir)?.pid).toBe(1001);
    lease.release();
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
  });

  test("an unreadable lock file is taken over too", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "lock.json"), "{ not json");
    const said: string[] = [];
    const lease = await acquire({ ...base, dir, pid: 1001, alive, say: (l) => said.push(l) });
    expect(said.some((l) => l.includes("unreadable"))).toBe(true);
    expect(holderOf(dir)?.pid).toBe(1001);
    lease.release();
  });

  test("a waiter's own ticket is never swept, and written again when it goes missing", async () => {
    const dir = fresh();
    const a = await acquire({ ...base, dir, pid: 1001, alive: () => true });
    // (every ticket judged dead, its own too, as a clock that stepped back would have it)
    const next = acquire({ ...base, dir, pid: 1002, alive: (p) => p === 1001 });
    await Bun.sleep(20);
    // (and its file taken away by another's sweep)
    for (const f of readdirSync(join(dir, "waiting"))) rmSync(join(dir, "waiting", f));
    await Bun.sleep(20);
    expect(readdirSync(join(dir, "waiting")).filter((f) => f.endsWith("-1002.json"))).toHaveLength(1);
    a.release();
    const lease = await next;
    expect(holderOf(dir)?.pid).toBe(1002);
    lease.release();
  });

  test("a waiter that died is swept and never blocks the ones behind it", async () => {
    const dir = fresh();
    const a = await acquire({ ...base, dir, pid: 1001, alive: () => true });
    // (a ticket older than the next waiter's, of a pid that is gone)
    mkdirSync(join(dir, "waiting"), { recursive: true });
    writeFileSync(join(dir, "waiting", `${String(1_000_000_000_000).padStart(13, "0")}-888.json`), `${JSON.stringify({ pid: 888, at: 1_000_000_000_000, name: "check", repo: "r", where: "/x" })}\n`);
    const next = acquire({ ...base, dir, pid: 1002, alive: (p) => p !== 888 });
    await Bun.sleep(20);
    a.release();
    const lease = await next;
    expect(holderOf(dir)?.pid).toBe(1002);
    expect(existsSync(join(dir, "waiting", `${String(1_000_000_000_000).padStart(13, "0")}-888.json`))).toBe(false);
    lease.release();
  });

  test("a holder past the limit is wedged: the head waiter takes its place, the one behind it still waits", async () => {
    const dir = fresh();
    const t = clock();
    const wedged = await acquire({ ...base, dir, pid: 1001, alive: () => true, now: t.now, maxHold: 60 });
    t.move(61_000);
    const order: number[] = [];
    const said: string[] = [];
    const go = (pid: number) => acquire({ ...base, dir, pid, alive: () => true, now: t.now, maxHold: 60, say: (l) => said.push(l) }).then((l) => (order.push(pid), l));
    const first = go(1002);
    await Bun.sleep(10);
    t.move(5);
    const second = go(1003);
    const lease = await first;
    await Bun.sleep(30);
    expect(order).toEqual([1002]);
    expect(lease.tookOver?.pid).toBe(1001);
    expect(said.some((l) => l.includes("past 1 minutes: taking its place"))).toBe(true);
    expect(holderOf(dir)?.pid).toBe(1002);
    // the wedged one finishing late leaves the lock alone
    wedged.release();
    expect(holderOf(dir)?.pid).toBe(1002);
    lease.release();
    (await second).release();
    expect(order).toEqual([1002, 1003]);
  });

  test("a waiter says again who it waits for every few minutes, with the holder's time so far, and never more often", async () => {
    const dir = fresh();
    const t = clock();
    const a = await acquire({ ...base, dir, pid: 1001, alive, now: t.now, limit: 1800 });
    expect(holderOf(dir)?.limit).toBe(1800);
    const said: string[] = [];
    const b = acquire({ ...base, dir, pid: 1002, alive, now: t.now, remind: 300_000, say: (l) => said.push(l) });
    await Bun.sleep(30);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("check: waiting for hundo's check in /w/a (pid 1001, running 0.0s, limit 30min, 30min left)");
    t.move(299_000);
    await Bun.sleep(30);
    expect(said).toHaveLength(1);
    t.move(2_000);
    await until(() => said.length >= 2);
    expect(said).toHaveLength(2);
    expect(said[1]).toBe("check: still waiting for hundo's check in /w/a (pid 1001, running 5min, limit 30min, 25min left)");
    await Bun.sleep(30);
    expect(said).toHaveLength(2);
    t.move(26 * 60_000);
    await until(() => said.length >= 3);
    expect(said).toHaveLength(3);
    expect(said[2]).toContain("past it");
    a.release();
    (await b).release();
  });

  test("a limit above the hour is not taken over at the hour, one with no limit is, and a holder past its limit and the slack is", async () => {
    const dir = fresh();
    const t = clock();
    const long = await acquire({ ...base, dir, pid: 1001, alive: () => true, now: t.now, maxHold: 60, limit: 7200 });
    t.move(61_000);
    const said: string[] = [];
    let got = false;
    const next = acquire({ ...base, dir, pid: 1002, alive: () => true, now: t.now, maxHold: 60, say: (l) => said.push(l) }).then((l) => ((got = true), l));
    await Bun.sleep(40);
    expect(got).toBe(false);
    expect(holderOf(dir)?.pid).toBe(1001);
    t.move(7_300_000);
    const lease = await next;
    expect(lease.tookOver?.pid).toBe(1001);
    expect(said.some((l) => l.includes("past 122 minutes: taking its place"))).toBe(true);
    long.release();
    lease.release();
  });

  test("a live holder's lock stands, and the waiter waits until it is gone", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "lock.json"), `${JSON.stringify({ pid: 999, at: Date.now(), name: "check", repo: "live", where: "/l" })}\n`);
    const next = acquire({ ...base, dir, pid: 1001, alive: (p) => p === 999 || p === 1001 });
    await Bun.sleep(30);
    expect(holderOf(dir)?.pid).toBe(999);
    rmSync(join(dir, "lock.json"));
    const lease = await next;
    expect(holderOf(dir)?.pid).toBe(1001);
    lease.release();
  });

  test("a lock replaced while it was being taken away goes back to its holder", () => {
    const dir = fresh();
    const stale: Holder = { pid: 777, at: 1, name: "check", repo: "ghost", where: "/g" };
    const live: Holder = { pid: 999, at: 2, name: "check", repo: "live", where: "/l" };
    // (the head read 777's lock, but 999's is what it finds to take away: not its to take, put back)
    writeFileSync(join(dir, "lock.json"), `${JSON.stringify(live)}\n`);
    expect(takeAway(dir, stale)).toBe(false);
    expect(holderOf(dir)).toEqual(live);
    expect(readdirSync(dir).filter((f) => f.endsWith(".stale"))).toEqual([]);
    // the one it meant: gone
    writeFileSync(join(dir, "lock.json"), `${JSON.stringify(stale)}\n`);
    expect(takeAway(dir, stale)).toBe(true);
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
    // nothing there: nothing taken
    expect(takeAway(dir, stale)).toBe(false);
  });
});

describe("q: the queue end to end", () => {
  // two repositories, a project that queues, a check that records when it ran
  let root = "";
  let restore = () => {};
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  const repos: string[] = [];
  beforeAll(() => {
    root = join(tmp, "project");
    mkdirSync(root);
    writeFileSync(join(root, "harness.toml"), '[checks]\nqueue = true\n[state]\ncache = ".cache/harness"\n');
    for (const name of ["a", "b"]) {
      const dir = join(root, name);
      mkdirSync(dir);
      git(dir, "init", "-q", "-b", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "chore: first");
      repos.push(dir);
    }
    restore = scopedRoot(root);
  });
  afterAll(() => restore());

  // (bun's own executable, not the `bun` a version manager's shim puts in front of it: a signal sent to the shim stops the shim and leaves q running)
  const qSpawn = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    Bun.spawn([process.execPath, join(KIT, "q.ts"), ...args], { cwd, env: { ...process.env, HARNESS_ROOT: root, WOW_ADDONS_ROOT: root, HARNESS_EVENTS: "off", CLAUDE_CODE_SESSION_ID: "", HARNESS_QUEUE_HELD: "", ...env }, stdout: "pipe", stderr: "pipe" });
  const q = (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const p = qSpawn(cwd, args, env);
    return p.exited.then(async (code) => ({ code, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() }));
  };
  // (a project that queues and limits every check to 1.8 s, one repository)
  let limited = "";
  let limitedRepo = "";
  beforeAll(() => {
    limited = join(tmp, "limited");
    limitedRepo = join(limited, "r");
    mkdirSync(limitedRepo, { recursive: true });
    writeFileSync(join(limited, "harness.toml"), '[checks]\nqueue = true\nqueue_limit = 0.03\n[state]\ncache = ".cache/harness"\n');
    git(limitedRepo, "init", "-q", "-b", "main");
    git(limitedRepo, "commit", "-q", "--allow-empty", "-m", "chore: first");
  });
  const inLimited = { HARNESS_ROOT: "", WOW_ADDONS_ROOT: "" };
  const logOfVerdict = (cwd: string, out: string) => join(cwd, out.split("\n")[0]!.split(" · ").at(-1)!);
  const gone = async (pid: number) => {
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await Bun.sleep(50);
    }
    return false;
  };

  test("the config switch is read, off by default and strict", () => {
    expect(loadConfig(root).checks.queue).toBe(true);
    const plain = join(tmp, "plain-conf");
    mkdirSync(plain);
    writeFileSync(join(plain, "harness.toml"), "");
    const typo = join(tmp, "typo");
    mkdirSync(typo);
    writeFileSync(join(typo, "harness.toml"), '[checks]\nqueue = "yes"\n');
    // (the project is named by the environment: each named in turn)
    const back = scopedRoot(plain);
    try {
      expect(loadConfig().checks.queue).toBe(false);
      scopedRoot(typo);
      expect(() => loadConfig()).toThrow('[checks] queue is true or false, not "yes"');
    } finally {
      back();
      scopedRoot(root);
    }
  });

  test("[checks] queue_limit is a number of minutes, 0 or more, unset by default", () => {
    const at = (checks: object) => parseConfig(tmp, { checks }).checks.queueLimit;
    expect(loadConfig(root).checks.queueLimit).toBeUndefined();
    expect(at({ queue: true })).toBeUndefined();
    expect(at({ queue_limit: 45 })).toBe(45);
    expect(at({ queue_limit: 0.5 })).toBe(0.5);
    expect(at({ queue_limit: 0 })).toBe(0);
    for (const bad of ["soon", -1, true, "30"]) expect(() => at({ queue_limit: bad })).toThrow(`[checks] queue_limit is a number of minutes (0: no limit), not ${JSON.stringify(bad)}`);
  });

  test("the flags before the name", () => {
    expect(parse(["--queue", "test", "--", "x"])).toEqual({ name: "test", command: ["x"], queue: true });
    expect(parse(["--no-queue", "check", "--", "x"])).toEqual({ name: "check", command: ["x"], queue: false });
    expect(parse(["check", "--", "x"])).toEqual({ name: "check", command: ["x"] });
    // --limit, in minutes with decimals, either side of --queue
    expect(parse(["--limit", "45", "--queue", "shots", "--", "x"])).toEqual({ name: "shots", command: ["x"], queue: true, limit: 45 });
    expect(parse(["--queue", "--limit", "0.5", "shots", "--", "x"])).toEqual({ name: "shots", command: ["x"], queue: true, limit: 0.5 });
    expect(parse(["--limit", "0", "check", "--", "x"])).toEqual({ name: "check", command: ["x"], limit: 0 });
    for (const bad of [["--limit", "check", "--", "x"], ["--limit", "-1", "check", "--", "x"], ["--limit", "", "check", "--", "x"], ["--limit"], ["--limit", "NaN", "a", "--", "x"]]) expect(parse(bad)).toBeString();
    expect(parse(["--queue-status"])).toEqual({ status: true });
    expect(parse(["--queue-status", "check", "--", "x"])).toBeString();
  });

  test("the limit: --limit first, then the project's, then the default, only for a run that holds a place", () => {
    expect(DEFAULT_LIMIT).toBe(30);
    expect(limitMinutes({ leased: true })).toBe(30);
    expect(limitMinutes({ leased: true, config: 45 })).toBe(45);
    expect(limitMinutes({ leased: true, config: 45, flag: 10 })).toBe(10);
    expect(limitMinutes({ leased: true, config: 0 })).toBeUndefined();
    expect(limitMinutes({ leased: true, flag: 0, config: 45 })).toBeUndefined();
    // no place in the line (not queued, or inside a queued command): none unless it asks
    expect(limitMinutes({ leased: false })).toBeUndefined();
    expect(limitMinutes({ leased: false, config: 45 })).toBeUndefined();
    expect(limitMinutes({ leased: false, flag: 5 })).toBe(5);
  });

  test("the process table: the command and everything below it, a pid reused is another process", () => {
    const rows = parsePs([
      "    1     0 Mon Nov 19 08:00:00 2026",
      "  100     1 Thu Nov 19 17:00:00 2026",
      "  200   100 Thu Nov 19 17:00:01 2026",
      "  300   200 Thu Nov 19 17:00:02 2026",
      "  310   1   Thu Nov 19 17:00:03 2026",
      "  400   300 Thu Nov 19 17:00:09 2026",
      "garbage",
    ].join("\n"));
    expect(rows).toHaveLength(6);
    expect([...treeOf(rows, 200)]).toEqual([[200, "Thu Nov 19 17:00:01 2026"], [300, "Thu Nov 19 17:00:02 2026"], [400, "Thu Nov 19 17:00:09 2026"]]);
    expect(treeOf(rows, 999).size).toBe(0);
    // (from several survivors at once: what a process whose parent died, and so no longer below the root, started since)
    expect([...treeOf(rows, [310, 300]).keys()]).toEqual([310, 300, 400]);
    expect(treeOf(rows, [999, 200]).size).toBe(3);
    // (a start read twice, a second apart on Linux, is one process; another time or another word is another)
    expect(sameStart("Thu Nov 19 17:00:01 2026", "Thu Nov 19 17:00:01 2026")).toBe(true);
    expect(sameStart("Thu Nov 19 17:00:02 2026", "Thu Nov 19 17:00:01 2026")).toBe(true);
    expect(sameStart("Thu Nov 19 17:00:09 2026", "Thu Nov 19 17:00:01 2026")).toBe(false);
    expect(sameStart(undefined, "Thu Nov 19 17:00:01 2026")).toBe(false);
    expect(sameStart("x", "y")).toBe(false);
    expect(verdict("check", 124, 1_800_000, 1_800_000)).toBe("check: FAILED (timed out after 30min, exit 124)");
    expect(verdict("check", 1, 1_800_000)).toBe("check: FAILED (exit 1, 1800s)");
  });

  test("two checks in two repositories never overlap, the second says it waits, both pass as ever", async () => {
    const dir = fresh();
    const log = join(dir, "ran.log");
    const cmd = ["sh", "-c", `echo start $$ >> ${log}; sleep 2; echo end $$ >> ${log}`];
    const env = { HARNESS_QUEUE: dir };
    const first = q(repos[0]!, ["check", "--", ...cmd], env);
    // (the second only after the first holds the lock)
    for (let i = 0; i < 600 && !existsSync(join(dir, "lock.json")); i++) await Bun.sleep(50);
    expect(existsSync(join(dir, "lock.json"))).toBe(true);
    const second = q(repos[1]!, ["check", "--", ...cmd], env);
    const [x, y] = await Promise.all([first, second]);
    expect([x.code, y.code]).toEqual([0, 0]);
    expect(x.out).toContain("check: ok");
    expect(y.out).toContain("check: ok");
    expect(x.err).toBe("");
    expect(y.err).toContain("check: waiting for a's check");
    expect(y.err.trim().split("\n")).toHaveLength(1);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
    expect(lines).toEqual(["start", "end", "start", "end"]);
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
  }, 60_000);

  test("another name doesn't queue unless it asks, --no-queue steps out, a failure passes through", async () => {
    const dir = fresh();
    const env = { HARNESS_QUEUE: dir };
    // a lock held by a live process (this one): a plain `test` run ignores it
    const stub = { pid: process.pid, at: Date.now() - 2000, name: "check", repo: "x", where: "/x" };
    writeFileSync(join(dir, "lock.json"), `${JSON.stringify(stub)}\n`);
    expect((await q(repos[0]!, ["test", "--", "true"], env)).code).toBe(0);
    expect((await q(repos[0]!, ["--no-queue", "check", "--", "true"], env)).code).toBe(0);
    const failing = await q(repos[0]!, ["--no-queue", "check", "--", "sh", "-c", "exit 3"], env);
    expect(failing.code).toBe(3);
    expect(holderOf(dir)?.repo).toBe("x");
    rmSync(join(dir, "lock.json"));
    // a failing queued check still frees the place
    const queued = await q(repos[0]!, ["check", "--", "sh", "-c", "exit 4"], env);
    expect(queued.code).toBe(4);
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
    // and `--queue` brings another name in line
    const named = await q(repos[0]!, ["--queue", "lint", "--", "true"], env);
    expect(named.code).toBe(0);
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
  }, 60_000);

  test("a queued check that runs a queued check doesn't wait for itself", async () => {
    const dir = fresh();
    const inner = `bun ${join(KIT, "q.ts")} check -- true`;
    const run = await Promise.race([q(repos[0]!, ["check", "--", "sh", "-c", inner], { HARNESS_QUEUE: dir }), Bun.sleep(40_000).then(() => "hung" as const)]);
    expect(run).not.toBe("hung");
    if (run !== "hung") {
      expect(run.code).toBe(0);
      expect(run.err).not.toContain("waiting");
    }
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
  }, 60_000);

  test("HARNESS_QUEUE=off: no queue at all, a project that doesn't ask neither waits nor holds", async () => {
    const dir = fresh();
    writeFileSync(join(dir, "lock.json"), `${JSON.stringify({ pid: process.pid, at: Date.now() - 2000, name: "check", repo: "x", where: "/x" })}\n`);
    expect((await q(repos[0]!, ["check", "--", "true"], { HARNESS_QUEUE: "off" })).code).toBe(0);
    const plain = join(tmp, "plain");
    mkdirSync(join(plain, "r"), { recursive: true });
    git(join(plain, "r"), "init", "-q", "-b", "main");
    const res = await q(join(plain, "r"), ["check", "--", "true"], { HARNESS_QUEUE: dir, HARNESS_ROOT: plain, WOW_ADDONS_ROOT: plain });
    expect(res.code).toBe(0);
    expect(holderOf(dir)?.repo).toBe("x");
  }, 60_000);

  test("a run past its limit is stopped, says so, and frees the place for the one waiting behind it", async () => {
    const dir = fresh();
    const env = { HARNESS_QUEUE: dir, HARNESS_QUEUE_GRACE: "2" };
    const first = q(repos[0]!, ["--queue", "--limit", "0.05", "hang", "--", "sleep", "60"], env);
    for (let i = 0; i < 600 && !existsSync(join(dir, "lock.json")); i++) await Bun.sleep(50);
    expect(holderOf(dir)).toMatchObject({ name: "hang", repo: "a", limit: 3 });
    const second = q(repos[1]!, ["--queue", "after", "--", "true"], env);
    const [x, y] = await Promise.all([first, second]);
    expect(x.code).toBe(124);
    const verdictLine = x.out.split("\n")[0]!;
    expect(verdictLine).toStartWith("hang: FAILED (timed out after 3.0s, exit 124) · ");
    expect(verdictLine).toMatch(/ · \S+\.log$/);
    expect(readFileSync(logOfVerdict(repos[0]!, x.out), "utf8")).toContain("[timed out after 3.0s: ended on SIGTERM]");
    // the second waited, was told whom for and how long it has, and ran once the first was stopped
    expect(y.code).toBe(0);
    expect(y.err).toContain("after: waiting for a's hang in ");
    expect(y.err).toContain("limit 3.0s");
    expect(y.out).toContain("after: ok");
    expect(existsSync(join(dir, "lock.json"))).toBe(false);
  }, 60_000);

  test("a check that times out stamps nothing and takes no stamp back from an earlier pass; the project's own limit applies", async () => {
    git(limitedRepo, "config", "harness.check", "sleep 60");
    try {
      const run = await q(limitedRepo, ["check", "--", "sleep", "60"], { ...inLimited, HARNESS_ROOT: limited, WOW_ADDONS_ROOT: limited, HARNESS_QUEUE: fresh(), HARNESS_QUEUE_GRACE: "2" });
      expect(run.code).toBe(124);
      expect(run.out).toContain("check: FAILED (timed out after 1.8s, exit 124)");
      expect(run.out).not.toContain("stamped");
      expect(stampOf(limitedRepo, workTree(limitedRepo))).toBeUndefined();
    } finally {
      git(limitedRepo, "config", "--unset", "harness.check");
    }
  }, 60_000);

  test("a config with a bad value is said once, and the run goes on without the queue; no config at all is no news", async () => {
    const bad = join(tmp, "bad-limit");
    mkdirSync(join(bad, "r"), { recursive: true });
    writeFileSync(join(bad, "harness.toml"), '[checks]\nqueue = true\nqueue_limit = "soon"\n');
    git(join(bad, "r"), "init", "-q", "-b", "main");
    const res = await q(join(bad, "r"), ["check", "--", "true"], { HARNESS_ROOT: bad, WOW_ADDONS_ROOT: bad, HARNESS_QUEUE: fresh() });
    expect(res.code).toBe(0);
    expect(res.err).toBe('check: harness.toml: [checks] queue_limit is a number of minutes (0: no limit), not "soon": running without the queue\n');
    expect(res.out).toContain("check: ok");
  }, 60_000);

  test("--limit 0 and a run with no place in the line have no limit, and a run inside a queued command is not limited twice", async () => {
    const env = { HARNESS_ROOT: limited, WOW_ADDONS_ROOT: limited, HARNESS_QUEUE: fresh(), HARNESS_QUEUE_GRACE: "2" };
    // (3 s, past the project's 1.8 s)
    expect((await q(limitedRepo, ["--limit", "0", "check", "--", "sleep", "3"], env)).code).toBe(0);
    expect((await q(limitedRepo, ["--no-queue", "check", "--", "sleep", "3"], env)).code).toBe(0);
    expect((await q(limitedRepo, ["other", "--", "sleep", "3"], env)).code).toBe(0);
    // the outer holds the place (18 s: room for a loaded machine); the inner check, which the project would stop at 1.8 s, runs its 3 s
    const nested = await q(limitedRepo, ["--queue", "--limit", "0.3", "outer", "--", "bun", join(KIT, "q.ts"), "check", "--", "sleep", "3"], env);
    expect(nested.code).toBe(0);
    expect(nested.out).toContain("outer: ok");
    expect(nested.err).not.toContain("waiting");
    expect(readFileSync(logOfVerdict(limitedRepo, nested.out), "utf8")).toContain("check: ok");
  }, 60_000);

  test("the whole tree goes: what ignores SIGTERM is killed after the grace, and a grandchild that left the process group with it", async () => {
    const dir = fresh();
    const pids = join(dir, "pids");
    // (both children ignore SIGTERM, and the second is in a session of its own: no group kill reaches it)
    const script = `trap '' TERM; sleep 61 & echo $! >> ${pids}; perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "62"' & echo $! >> ${pids}; wait`;
    const started = performance.now();
    const run = await q(repos[0]!, ["--limit", "0.05", "tree", "--", "sh", "-c", script], { HARNESS_QUEUE: dir, HARNESS_QUEUE_GRACE: "1" });
    expect(run.code).toBe(124);
    expect(run.out).toContain("tree: FAILED (timed out after 3.0s, exit 124)");
    expect(readFileSync(logOfVerdict(repos[0]!, run.out), "utf8")).toMatch(/\[timed out after 3\.0s: SIGKILL to \d+\]/);
    expect(performance.now() - started).toBeLessThan(30_000);
    const left = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    expect(left).toHaveLength(2);
    for (const pid of left) expect(await gone(pid)).toBe(true);
  }, 60_000);

  test("q stopped by a signal passes it on, SIGKILLs the tree after the grace, and stopped again kills at once", async () => {
    const dir = fresh();
    const pidFile = join(dir, "pid");
    const p = qSpawn(repos[0]!, ["stubborn", "--", "sh", "-c", `trap '' TERM; sleep 61 & echo $! > ${pidFile}; echo ready; wait`], { HARNESS_QUEUE: dir, HARNESS_QUEUE_GRACE: "120" });
    const log = join(repos[0]!, ".cache", "logs", "stubborn.log");
    for (let i = 0; i < 400 && !(existsSync(log) && readFileSync(log, "utf8").includes("ready") && existsSync(pidFile)); i++) await Bun.sleep(50);
    const child = Number(readFileSync(pidFile, "utf8"));
    p.kill("SIGTERM");
    await Bun.sleep(1500);
    // (within the grace: it ignored the first, and q waits for it)
    expect(p.exitCode).toBeNull();
    p.kill("SIGTERM");
    expect(await Promise.race([p.exited, Bun.sleep(20_000).then(() => "hung" as const)])).toBe(137);
    expect(await gone(child)).toBe(true);
  }, 60_000);

  test("--queue-status prints the holder and the waiters and changes nothing; off says so", async () => {
    const dir = fresh();
    mkdirSync(join(dir, "waiting"));
    writeFileSync(join(dir, "lock.json"), `${JSON.stringify({ pid: process.pid, at: Date.now() - 90_000, name: "shots", repo: "hundo", where: "/w/x", limit: 1800 })}\n`);
    writeFileSync(join(dir, "waiting", `${String(Date.now() - 30_000).padStart(13, "0")}-2147483000.json`), `${JSON.stringify({ pid: 2147483000, at: Date.now() - 30_000, name: "check", repo: "hundo", where: "/w/y" })}\n`);
    const res = await q(repos[0]!, ["--queue-status"], { HARNESS_QUEUE: dir });
    expect(res.code).toBe(0);
    expect(res.out).toContain(`holder: hundo's shots in /w/x (pid ${process.pid}, running 9`);
    expect(res.out).toContain("limit 30min, 28min left)");
    expect(res.out).toContain("1. hundo's check in /w/y (pid 2147483000, waiting 3");
    expect(res.out).toContain("gone: swept at the next look");
    expect(readdirSync(join(dir, "waiting"))).toHaveLength(1);
    expect(holderOf(dir)?.pid).toBe(process.pid);
    expect((await q(repos[0]!, ["--queue-status"], { HARNESS_QUEUE: "off" })).out).toBe("queue: off (HARNESS_QUEUE=off)\n");
  }, 60_000);
});
