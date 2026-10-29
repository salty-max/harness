// What the tests share (never vendored): a project root shaped like the
// WoW family's, so the assertions the family's tools always had keep holding
// under a harness.toml.
import { afterAll, beforeAll, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

export const FAMILY_TOML = `[project]
name = "family"
term = "family"

[state]
board = "board"
cache = ".cache/harness"

[tools]
dir = "addon-kit"

[extensions]
packet = "addon-kit/packet-extras.ts"

[review]
waive = ['(^|/)(README|CLAUDE|CURSEFORGE)\\.md$', '^docs/', '\\.toc$']

[review.copies]
patterns = ['^addon/[^/]+/(Kit\\.lua|Media/)|(^|/)wowmock\\.lua$|^scripts/(root\\.(ts|py)|locales-lib\\.ts|package-lib\\.ts)$|^i18n/kit/|^(wow\\.yml|stylua\\.toml)$']
except = ["addon-kit"]
`;

export const DUMMY_PACKET_EXTENSION = `export function extras(c) {
  return { lines: ["", "## Extra", "files: " + c.files.join(",")], count: c.files.length };
}
`;

/** harness.toml of a family-shaped root, and addon-kit/ beside where its extension lives. */
export function writeFamilyConfig(root: string) {
  mkdirSync(join(root, "addon-kit"), { recursive: true });
  writeFileSync(join(root, "harness.toml"), FAMILY_TOML);
  writeFileSync(join(root, "addon-kit", "packet-extras.ts"), DUMMY_PACKET_EXTENSION);
}

/** Names `root` as the project for the rest of a test (HARNESS_ROOT, the alias cleared); the returned function puts both back. */
export function scopedRoot(root: string): () => void {
  const prev = { h: process.env.HARNESS_ROOT, w: process.env.WOW_ADDONS_ROOT };
  process.env.HARNESS_ROOT = root;
  delete process.env.WOW_ADDONS_ROOT;
  return () => {
    for (const [k, v] of [["HARNESS_ROOT", prev.h], ["WOW_ADDONS_ROOT", prev.w]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * A family-shaped root for the parts of a test file that ask the config without making a root of their own:
 * HARNESS_ROOT for the file's tests only, never for the files run after it.
 */
export function useFixtureRoot() {
  let dir = "";
  let restore = () => {};
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-fixture-"));
    writeFamilyConfig(dir);
    restore = scopedRoot(dir);
  });
  afterAll(() => {
    restore();
    rmSync(dir, { recursive: true, force: true });
  });
}

/**
 * No test writes a card into the real board (the one the checkout's own project finds, family folder or not):
 * a card the tests' sessions (s-lock, s-other, s0, s1...) wrote there during the file fails it in afterAll, naming the card.
 * Other sessions' cards coming and going don't count.
 */
export function useBoardGuard() {
  let board: string | undefined;
  let start = 0;
  beforeAll(() => {
    start = Date.now() - 1000;
    const saved = { h: process.env.HARNESS_ROOT, w: process.env.WOW_ADDONS_ROOT };
    delete process.env.HARNESS_ROOT;
    delete process.env.WOW_ADDONS_ROOT;
    try {
      board = loadConfig(import.meta.dir).boardDir;
    } catch {
      board = undefined;
    } finally {
      if (saved.h !== undefined) process.env.HARNESS_ROOT = saved.h;
      if (saved.w !== undefined) process.env.WOW_ADDONS_ROOT = saved.w;
    }
  });
  afterAll(() => {
    if (!board || !existsSync(board)) return;
    const leaked = readdirSync(board)
      .filter((f) => f.endsWith(".md") && statSync(join(board!, f)).mtimeMs >= start)
      .filter((f) => /^session: (s-[a-z]+|s\d+)$/m.test(readFileSync(join(board!, f), "utf8")));
    expect(leaked).toEqual([]);
  });
}
