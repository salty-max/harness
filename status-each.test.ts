// status.ts's and each.ts's pure parts (bun test).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argvOf, parse, pick, unknown } from "./each";
import { scopedRoot, useBoardGuard } from "./testing";
import { attention, latestPerWorkflow, slugOf, type Repo, type Run } from "./status";

useBoardGuard();

describe("status", () => {
  test("a GitHub remote, ssh or https", () => {
    expect(slugOf("git@github.com:salty-max/palaver.git")).toBe("salty-max/palaver");
    expect(slugOf("https://github.com/salty-max/wow-data")).toBe("salty-max/wow-data");
    expect(slugOf("https://example.com/x/y.git")).toBeUndefined();
  });

  test("each workflow's newest run", () => {
    const run = (workflow: string, conclusion: string, sha: string): Run => ({ workflow, status: "completed", conclusion, sha, at: "" });
    const latest = latestPerWorkflow([run("CI", "failure", "b"), run("Game data", "success", "b"), run("CI", "success", "a")]);
    expect(latest.map((r) => `${r.workflow} ${r.conclusion}`)).toEqual(["CI failure", "Game data success"]);
  });

  test("what wants a hand", () => {
    const r: Repo = {
      name: "palaver",
      branch: "main",
      upstream: "origin/main",
      ahead: 2,
      behind: 0,
      dirty: 1,
      head: "",
      runs: [{ workflow: "CI", status: "completed", conclusion: "failure", sha: "1234567890", at: "" }],
      prs: [{ number: 8, title: "chore: players' facts" }],
      extra: { column: "zip −1", attention: ["test build Palaver-x.zip is 1 commit behind HEAD"] },
    };
    expect(attention(r)).toEqual([
      "1 file uncommitted",
      "2 commits to push",
      "CI: failure (1234567)",
      "pull request #8 open: chore: players' facts",
      "test build Palaver-x.zip is 1 commit behind HEAD",
    ]);
    expect(attention({ ...r, ahead: 0, dirty: 0, runs: [], prs: [], extra: undefined })).toEqual([]);
    expect(attention({ ...r, upstream: undefined, ahead: 0, dirty: 0, runs: [], prs: [], extra: undefined })).toEqual([
      "no upstream (local only)",
    ]);
  });
});

describe("each", () => {
  const names = ["addon-kit", "keyring", "palaver", "wow-data"];
  const groups: Record<string, string[]> = { addons: ["keyring", "palaver"], kit: ["palaver"] };
  const test_ = (g: string, n: string) => groups[g]?.includes(n) ?? false;

  test("the command after --", () => {
    expect(parse(["--kit", "--", "bun", "run", "check"])).toMatchObject({ which: "kit", command: ["bun", "run", "check"] });
    // (the words as given, no shell between; one word alone a shell line)
    expect(argvOf(["printf", "[%s]", "two words"])).toEqual(["printf", "[%s]", "two words"]);
    expect(argvOf(["git status && git log -1"])).toEqual(["/bin/sh", "-c", "git status && git log -1"]);
    const o = parse(["--only", "yonder,yondr", "--", "x"]) as Exclude<ReturnType<typeof parse>, string>;
    expect(unknown(["yonder", "keyring"], o)).toEqual(["yondr"]);
    expect(parse(["--kit"])).toBe("give the command after --");
    expect(parse(["--nope", "--", "x"])).toBe("unknown option --nope");
    expect(parse(["--only", "--", "x"])).toBe("--only takes folder names, a,b");
  });

  test("which repositories", () => {
    const o = (argv: string[]) => parse([...argv, "--", "x"]) as Exclude<ReturnType<typeof parse>, string>;
    expect(pick(names, o([]), test_)).toEqual(["keyring", "palaver"]);
    expect(pick(names, o(["--kit"]), test_)).toEqual(["palaver"]);
    expect(pick(names, o(["--group", "kit"]), test_)).toEqual(["palaver"]);
    expect(pick(names, o(["--all", "--skip", "wow-data"]), test_)).toEqual(["addon-kit", "keyring", "palaver"]);
    expect(pick(names, o(["--only", "wow-data,nope"]), test_)).toEqual(["wow-data"]);
  });
});


describe("hints", () => {
  test("the q command a hint names is typed inside the repository: its path from there", () => {
    const root = mkdtempSync(join(tmpdir(), "hint-test-"));
    mkdirSync(join(root, "palaver", ".git"), { recursive: true });
    writeFileSync(join(root, "harness.toml"), '[tools]\ndir = "addon-kit"\n');
    const restore = scopedRoot(root);
    try {
      const r: Repo = { name: "palaver", branch: "main", upstream: "origin/main", ahead: 1, behind: 0, dirty: 0, head: "", checked: false, check: "bun run check" };
      expect(attention(r)).toEqual(["1 commit to push", "no passing check on HEAD's tree (bun ../addon-kit/q.ts check -- bun run check)"]);
    } finally {
      restore();
    }
  });
});
