// queue.ts: the check queue, driven with fake pids and clocks, then q.ts end to end (bun test).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliveSince, acquire, holderOf, inside, queueDir, takeAway, waitingLine, type Holder } from "./queue";
import { parse } from "./q";
import { loadConfig } from "./config";
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

  const q = (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawn(["bun", join(KIT, "q.ts"), ...args], { cwd, env: { ...process.env, HARNESS_ROOT: root, WOW_ADDONS_ROOT: root, HARNESS_EVENTS: "off", CLAUDE_CODE_SESSION_ID: "", HARNESS_QUEUE_HELD: "", ...env }, stdout: "pipe", stderr: "pipe" });
    return p.exited.then(async (code) => ({ code, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() }));
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

  test("the flags before the name", () => {
    expect(parse(["--queue", "test", "--", "x"])).toEqual({ name: "test", command: ["x"], queue: true });
    expect(parse(["--no-queue", "check", "--", "x"])).toEqual({ name: "check", command: ["x"], queue: false });
    expect(parse(["check", "--", "x"])).toEqual({ name: "check", command: ["x"] });
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
});
