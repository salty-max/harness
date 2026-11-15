// hooks.ts from a worktree: which folder core.hooksPath names as the harness's own (bun test).
// core.hooksPath is one setting for a repository and every worktree of it, and `install` writes the
// main checkout's githooks: a worktree's own copy of the tools has to read that as ours.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
// (no project named by the environment: the config is found from the folder asked about)
const BARE = { ...GIT, HARNESS_ROOT: "", WOW_ADDONS_ROOT: "", CI: "" } as Record<string, string>;
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "hooks-test-")));
const g = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: GIT, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};
const hooks = (copy: string, cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["bun", join(copy, "harness", "hooks.ts"), ...args], { cwd, env: BARE, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

const vendor = (dir: string) => {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "harness-sync.ts"), "--dirty", dir], { env: BARE, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
};
function repo() {
  const main = temp();
  g(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "harness.toml"), '[tools]\ndir = "harness"\n[hooks]\nlock = false\n');
  writeFileSync(join(main, "CLAUDE.md"), "# P\n");
  return main;
}
const worktree = (main: string, branch: string) => {
  const wt = join(temp(), branch);
  g(main, "worktree", "add", "-q", "-b", branch, wt);
  return wt;
};

/** A one-repository project with the harness vendored and committed on main, and a linked worktree of it (so its own copy of the tools). */
function project() {
  const main = repo();
  vendor(main);
  g(main, "add", "-A");
  g(main, "commit", "-q", "-m", "chore: start");
  const wt = worktree(main, "side");
  return { main, wt, mainHooks: join(main, "harness", "githooks"), wtHooks: join(wt, "harness", "githooks") };
}

describe("hooks status from a worktree's own copy of the tools", () => {
  test("the main checkout's githooks, which install wrote, read as ours from either copy", () => {
    const { main, wt, mainHooks } = project();
    expect(hooks(main, main, "install", main).out).toContain("installed");
    expect(g(main, "config", "core.hooksPath")).toBe(mainHooks);
    const own = hooks(main, main, "status", main);
    expect([own.code, own.out]).toEqual([0, expect.stringContaining("hooks ✓")]);
    const kid = hooks(wt, wt, "status", main);
    expect([kid.code, kid.out]).toEqual([0, expect.stringContaining("hooks ✓")]);
    // (and the worktree itself, asked about by its path)
    const self = hooks(wt, wt, "status", wt);
    expect([self.code, self.out]).toEqual([0, expect.stringContaining("hooks ✓")]);
  });

  test("a hooks path that isn't the harness's still reads as not ours, from the worktree's copy too", () => {
    const { main, wt } = project();
    const foreign = join(temp(), "foreign-hooks");
    mkdirSync(foreign);
    for (const h of ["pre-push", "commit-msg"]) {
      writeFileSync(join(foreign, h), "#!/bin/sh\nexit 0\n");
      chmodSync(join(foreign, h), 0o755);
    }
    // (main's harness/ itself is a near miss: the folder above the hooks, with none of the gates in it)
    for (const path of [foreign, ".husky/_", join(main, "harness"), join(temp(), "no-such-hooks")]) {
      g(main, "config", "core.hooksPath", path);
      for (const [copy, cwd] of [[main, main], [wt, wt]]) {
        const s = hooks(copy, cwd, "status", main);
        expect(s.code).toBe(1);
        expect(s.out).not.toContain("hooks ✓");
      }
    }
  });

  test("a plain checkout's copy accepts its own githooks only: another copy's folder is not ours", () => {
    const { main, wt, wtHooks } = project();
    // a worktree's own copy named by hand (the old reading, kept: ours until the worktree goes)
    g(main, "config", "core.hooksPath", wtHooks);
    expect(hooks(wt, wt, "status", main).out).toContain("hooks ✓");
    // the main checkout is no worktree: a copy of the hooks somewhere else is not its own
    const fromMain = hooks(main, main, "status", main);
    expect(fromMain.code).toBe(1);
    expect(fromMain.out).not.toContain("hooks ✓");
  });
});

describe("hooks install from a worktree's own copy of the tools", () => {
  test("writes the main checkout's githooks, never the worktree's own", () => {
    const { main, wt, mainHooks } = project();
    const out = hooks(wt, wt, "install", main).out;
    expect(out).toContain("installed");
    expect(g(main, "config", "core.hooksPath")).toBe(mainHooks);
    expect(hooks(wt, wt, "install", main).out).toContain("already");
    expect(hooks(main, main, "install", main).out).toContain("already");
  });

  test("a worktree's own copy named by hand is written over with the main checkout's", () => {
    const { main, wt, mainHooks, wtHooks } = project();
    g(main, "config", "core.hooksPath", wtHooks);
    expect(hooks(wt, wt, "install", main).out).toContain("installed");
    expect(g(main, "config", "core.hooksPath")).toBe(mainHooks);
    // the folder it was is not chained to itself
    expect(Bun.spawnSync(["git", "config", "--get", "harness.chain"], { cwd: main, env: GIT }).exitCode).not.toBe(0);
  });

  test("another worktree's copy is not ours: neither the main checkout's nor the reader's own", () => {
    const { main, wt } = project();
    const other = worktree(main, "other");
    g(main, "config", "core.hooksPath", join(other, "harness", "githooks"));
    const s = hooks(wt, wt, "status", main);
    expect(s.code).toBe(1);
    expect(s.out).not.toContain("hooks ✓");
    expect(hooks(other, other, "status", main).out).toContain("hooks ✓");
  });

  test("refuses when the main checkout has no githooks of its own to name", () => {
    const main = repo();
    g(main, "add", "-A");
    g(main, "commit", "-q", "-m", "chore: start");
    const wt = worktree(main, "side");
    vendor(wt);
    const out = hooks(wt, wt, "install", main).out;
    expect(out).toContain("linked worktree");
    expect(out).toContain("no githooks/ of its own");
    expect(Bun.spawnSync(["git", "config", "--get", "core.hooksPath"], { cwd: main, env: GIT }).exitCode).not.toBe(0);
    // (status has no main copy to prefer: the worktree's own folder, named by hand, still reads as ours)
    g(main, "config", "core.hooksPath", join(wt, "harness", "githooks"));
    expect(hooks(wt, wt, "status", main).out).toContain("hooks ✓");
  });

  test("a folder of the main checkout at that path that isn't the harness's is not taken for it", () => {
    const main = repo();
    g(main, "add", "-A");
    g(main, "commit", "-q", "-m", "chore: start");
    const wt = worktree(main, "side");
    vendor(wt);
    // gates of somebody else's, where the worktree's copy has its own githooks
    const there = join(main, "harness", "githooks");
    mkdirSync(there, { recursive: true });
    for (const h of ["pre-push", "commit-msg"]) {
      writeFileSync(join(there, h), "#!/bin/sh\nexit 0\n");
      chmodSync(join(there, h), 0o755);
    }
    g(main, "config", "core.hooksPath", there);
    const s = hooks(wt, wt, "status", main);
    expect(s.code).toBe(1);
    expect(s.out).not.toContain("hooks ✓");
    expect(hooks(wt, wt, "install", main).out).toContain("no githooks/ of its own");
    expect(g(main, "config", "core.hooksPath")).toBe(there);
  });

  test("a bare repository's worktree has no main checkout to name: install refuses and says so", () => {
    const main = repo();
    g(main, "add", "-A");
    g(main, "commit", "-q", "-m", "chore: start");
    const bare = join(temp(), "bare.git");
    g(main, "clone", "-q", "--bare", main, bare);
    const wt = join(temp(), "kid");
    g(bare, "worktree", "add", "-q", "-b", "side", wt);
    vendor(wt);
    const out = hooks(wt, wt, "install", main).out;
    expect(out).toContain("no main checkout to name");
    expect(Bun.spawnSync(["git", "config", "--get", "core.hooksPath"], { cwd: main, env: GIT }).exitCode).not.toBe(0);
    // status still reads the copy's own folder, as before
    g(main, "config", "core.hooksPath", join(wt, "harness", "githooks"));
    expect(hooks(wt, wt, "status", main).out).toContain("hooks ✓");
  });
});
