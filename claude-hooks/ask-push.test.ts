// ask-push.ts against the commands it must ask about and those it must let alone (bun test): real repositories in a
// temporary folder, one standing for hundo (the skipped one), its worktree, a nested clone, a symlink to it, a worktree
// of it outside its folder, and others (gero, wow-addons) that must keep their prompt.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, hookCommand, parse } from "./ask-push";

let root: string;
let home: string;
let hundo: string;
let skip: string[];
const dirs: Record<string, string> = {};

const sh = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hook-fixture-")));
  home = join(root, "home");
  const code = join(home, "code");
  mkdirSync(code, { recursive: true });
  for (const n of ["hundo", "gero", "hundo-other", "wow-addons"]) {
    mkdirSync(join(code, n));
    sh(join(code, n), "init", "-q", "-b", "main");
  }
  hundo = join(code, "hundo");
  skip = [hundo];
  sh(hundo, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(hundo, ".claude", "worktrees"), { recursive: true });
  sh(hundo, "worktree", "add", "-q", join(hundo, ".claude", "worktrees", "prompts"), "-b", "claude/prompts");
  sh(hundo, "worktree", "add", "-q", "--detach", join(root, "outside-worktree"));
  mkdirSync(join(hundo, "nested"));
  sh(join(hundo, "nested"), "init", "-q", "-b", "main");
  symlinkSync(hundo, join(code, "link-hundo"));
  Object.assign(dirs, {
    hundo,
    sub: join(hundo, "apps"),
    wt: join(hundo, ".claude", "worktrees", "prompts"),
    outside: join(root, "outside-worktree"),
    nested: join(hundo, "nested"),
    link: join(code, "link-hundo"),
    gero: join(code, "gero"),
    other: join(code, "hundo-other"),
    wow: join(code, "wow-addons"),
    missing: join(code, "nowhere"),
  });
  mkdirSync(dirs.sub!);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** "silent" or "ask" for a command run from the named folder. */
const run = (command: string, cwd: string | undefined) => (decide(command.replaceAll("<hundo>", hundo).replaceAll("<gero>", dirs.gero!).replaceAll("<wt>", dirs.wt!), cwd, skip, home) ? "ask" : "silent");

describe("where the push runs", () => {
  const cases: [string, keyof typeof dirs, "silent" | "ask"][] = [
    ["git push", "hundo", "silent"],
    ["git push -u origin claude/x", "wt", "silent"],
    ["git push origin HEAD:refs/heads/x", "hundo", "silent"],
    ["git push", "sub", "silent"],
    ["git push", "outside", "silent"], // (a worktree of hundo elsewhere on the disk is hundo's)
    ["git push", "gero", "ask"],
    ["git push", "wow", "ask"],
    ["git push", "nested", "ask"], // (a nested clone under hundo's folder is not hundo)
    ["git push", "link", "silent"], // (a symlink to hundo is hundo)
    ["git push", "other", "ask"],
    ["git push", "missing", "ask"],
    ["git -C <hundo> push", "wow", "silent"],
    ["git -C <wt> push origin b", "gero", "silent"],
    ["git -C <gero> push", "hundo", "ask"],
    ["git -C ../gero push", "sub", "ask"],
    ["git -C .. push", "sub", "silent"],
    ["git -C <hundo> -C ../gero push", "wow", "ask"],
    ["cd <hundo> && git push", "gero", "silent"],
    ["cd <wt> && git push -u origin b", "gero", "silent"],
    ["cd <hundo>; git push", "gero", "silent"],
    ["cd <hundo>\ngit push", "gero", "silent"],
    ["cd <gero> && git push", "hundo", "ask"],
    ["cd <hundo> && cd <gero> && git push", "wow", "ask"],
    ["cd ../gero && git push", "sub", "ask"],
    ["cd /nowhere/at/all && git push", "hundo", "ask"],
    ["cd <hundo> || git push", "gero", "ask"], // (it runs where it started when the cd fails)
    ["cd <hundo> | git push", "gero", "ask"],
    ["cd <hundo> & git push", "gero", "ask"],
    ["(cd <hundo> && git push)", "gero", "ask"],
    ["{ cd <hundo> && git push; }", "gero", "ask"],
    ["cd - && git push", "hundo", "ask"],
    ["pushd <hundo> && git push", "gero", "ask"],
    ["cd $HOME && git push", "hundo", "ask"],
    ["cd ~/code/hundo && git push", "gero", "silent"],
    ['cd "~/code/hundo" && git push', "gero", "ask"], // (quoted, the shell leaves the tilde alone)
    ["git status && git push", "hundo", "silent"],
    ["git status && git push", "gero", "ask"],
    ["git push && git status", "gero", "ask"],
    ["git -C <hundo> push && git -C <gero> push", "hundo", "ask"],
    ['git -C "$DIR" push', "hundo", "ask"],
    ["git --git-dir=<gero>/.git push", "hundo", "ask"],
    ["git --git-dir <gero>/.git push", "hundo", "ask"],
    ["GIT_DIR=<gero>/.git git push", "hundo", "ask"],
    ["env GIT_WORK_TREE=/x git push", "hundo", "ask"],
    ["git push", undefined as unknown as keyof typeof dirs, "ask"],
  ];
  for (const [command, from, want] of cases) test(`${command.replaceAll("\n", "⏎")} in ${String(from)}: ${want}`, () => expect(run(command, dirs[from])).toBe(want));
});

describe("where the push goes", () => {
  const cases: [string, "silent" | "ask"][] = [
    ["git push origin main", "silent"],
    ["git push -u origin claude/x", "silent"],
    ["git push --force-with-lease origin claude/x", "silent"],
    ["git push --dry-run", "silent"],
    ["git push upstream main", "ask"],
    ["git push https://github.com/x/other main", "ask"],
    ["git push git@github.com:x/other.git", "ask"],
    ['git push "$REMOTE" main', "ask"],
    ["git push --repo=https://x/y main", "ask"],
    ["git push --receive-pack=evil origin", "ask"],
    ["git -c remote.origin.pushurl=https://x/y push origin", "ask"],
    ["git push -o ci.skip origin main", "silent"],
    ["git push -- origin main", "silent"],
  ];
  for (const [command, want] of cases) test(`${command}: ${want}`, () => expect(run(command, hundo)).toBe(want));
  test("the same pushes to another remote ask in any repository", () => expect(run("git push origin main", dirs.gero)).toBe("ask"));
});

describe("what counts as a push", () => {
  const cases: [string, "silent" | "ask"][] = [
    ["git commit -m 'docs: git push is not run here'", "silent"],
    ['git commit -m "feat: push notifications" && git status', "silent"],
    ["git commit -F - <<'EOF'\nfeat: x\n\ngit push origin main\nEOF", "silent"],
    ["git commit -F - <<EOF\ngit push\nEOF\ngit push", "ask"],
    ["git log --grep push", "silent"],
    ["git help push", "silent"],
    ["git stash push -m x", "silent"],
    ["git checkout -b feat/push-ask", "silent"],
    ["git subtree push --prefix=x origin main", "ask"],
    ["echo 'git push'", "silent"],
    ["# git push", "silent"],
    ["ls", "silent"],
    ["git pull && git push", "ask"],
    ["git push; git push", "ask"],
    ["git push | cat", "ask"],
    ["git push 2>&1", "ask"],
    ["git push &> /dev/null", "ask"],
    ["echo $(git push)", "ask"],
    ["echo `git push`", "ask"],
    ['echo "$(git push)"', "ask"],
    ["time git push", "ask"],
    ["env FOO=1 git push", "ask"],
    ["FOO=1 git push", "ask"],
    ["command git push", "ask"],
    ["/usr/bin/git push", "ask"],
    ["nice -n 5 git push", "ask"],
    ["timeout 60 git push", "ask"],
    ["bash -c 'git push'", "ask"],
    ["bash -lc 'git status && git push'", "ask"],
    ["sh -c 'cd <hundo> && git push'", "silent"],
    ["bash -c \"git push $x\"", "ask"],
    ["eval 'git push'", "ask"],
    ["eval git push", "ask"],
    ["sudo git push", "ask"],
    ["xargs git push", "ask"],
    ["find . -exec git push {} ;", "ask"],
    ["git -c core.x=y push", "ask"],
    ["git --no-pager push", "ask"],
    ["git -p push", "ask"],
    ["gp", "ask"],
    ["gpf!", "ask"],
    ["ggpush", "ask"],
    ["gpsup", "ask"],
    ["gpu", "ask"],
    ["gpoat", "ask"],
    ["cd <hundo> && gp", "silent"],
    ["cd <hundo> && gpf", "silent"],
    ["cd <hundo> && gpu", "ask"], // (upstream is another remote)
    ["gpg --version", "silent"],
    ["gsta", "silent"],
    // (what the review found: a git behind a shell keyword or a program this doesn't know, a shell fed by a pipe or a heredoc)
    ["for d in a b; do git -C $d push; done", "ask"],
    ["if true; then git -C ../gero push; fi", "ask"],
    ["while true; do git push; done", "ask"],
    ["sudo git -C ../gero push", "ask"],
    ["xargs -I{} git -C {} push", "ask"],
    ["find . -name x -exec git -C {} push ;", "ask"],
    ["bash <<'EOF'\ncd ../gero && git push\nEOF", "ask"],
    ["echo 'git -C ../gero push' | sh", "ask"],
    ["echo 'git push' | bash -s", "ask"],
    ["bash scripts/headers.sh && git status", "silent"],
    ["echo git push", "silent"],
    ['"cd" ../gero && git push', "ask"],
    ["\\cd ../gero && git push", "ask"],
    ["export GIT_DIR=<gero>/.git; git push", "ask"],
    ["export GIT_WORK_TREE=/x\ngit push", "ask"],
    ["GIT_DIR=<gero>/.git\ngit push", "ask"],
    ["declare -x GIT_DIR=<gero>/.git && git push", "ask"],
    ["git -c alias.p=push p", "ask"],
    ["git -c core.pager=cat log", "silent"],
    // (the second review: pushes by other names, a cd that may not have run, shells and expansions it must read)
    ["git push 2>&1 | tail -5", "ask"],
    ["git subtree push --prefix=x origin main", "ask"],
    ["git send-pack https://example.com/x.git main", "ask"],
    ["git submodule foreach git push", "ask"],
    ["git rebase -x 'git push' main", "ask"],
    ["ggf", "ask"],
    ["ggfl", "ask"],
    ["ggpnp", "ask"],
    ["grename old new", "ask"],
    ["false && cd <hundo>; git push", "ask"],
    ["git fetch && cd <hundo>; git push", "ask"],
    ["if true; then cd <hundo>; fi; git push", "ask"],
    ["for d in x; do cd <hundo>; done; git push", "ask"],
    ["git fetch && cd <hundo> && git push", "silent"],
    [">/dev/null cd <hundo> && git push", "silent"],
    ["sudo sh -c 'git push'", "ask"],
    ["xargs sh -c 'git push'", "ask"],
    ["bash -c -- 'git push'", "ask"],
    ["bash -c -x 'git push'", "ask"],
    ["bash /dev/stdin <<'EOF'\ngit push\nEOF", "ask"],
    ["bash <<< 'git push'", "ask"],
    ["env -S 'git push'", "ask"],
    ["watch 'git push'", "ask"],
    ["flock /tmp/x -c 'git push'", "ask"],
    ["$(echo git) push", "ask"],
    ["$G push", "ask"],
    ["git $(echo push)", "ask"],
    ["git {push,origin}", "ask"],
    ["=git push", "ask"],
    ["gh pr create --body 'then run git push to share it'", "silent"],
    ["echo $HOME/x | wc -l", "silent"],
  ];
  for (const [command, want] of cases) test(`${command.replaceAll("\n", "⏎")}: ${want}`, () => expect(run(command, dirs.gero)).toBe(want));
  test("the same alias in hundo is let alone", () => expect(run("gp", hundo)).toBe("silent"));
  const inHundo: [string, "silent" | "ask"][] = [
    ["if git push; then echo ok; fi", "silent"],
    ["for b in a b; do git push origin $b; done", "silent"],
    ["echo git push", "silent"],
    ["bash scripts/headers.sh https://x && git push", "silent"],
    ["git push --recurse-submodules=on-demand", "ask"],
    ["git push --recurse-submodules=check", "silent"],
    ["sudo git push", "ask"],
    ["xargs git push", "ask"],
    ["bash <<'EOF'\ngit push\nEOF", "ask"],
    ["echo 'git push' | sh", "ask"],
    ["export GIT_SSH_COMMAND=x; git push", "ask"],
    ["git -c alias.p=push p", "ask"],
    ["export FOO=1 && git push", "silent"],
    ["git push 2>&1 | tail -5", "silent"],
    ["git push > /tmp/log", "silent"],
    ["git push &> /dev/null", "silent"],
    ["git push origin claude/x 2>&1", "silent"],
    ["git subtree push --prefix=x origin main", "silent"],
    ["git submodule foreach git push", "ask"],
    ["ggf", "silent"],
    ["bash -c -- 'git push'", "silent"],
    ["git fetch && cd <hundo> && git push", "silent"],
    ["$CLAUDE_PROJECT_DIR/bin/x && git push", "silent"],
    ["gh pr create --body 'then run git push'", "silent"],
    [">/dev/null cd ../gero && git push", "ask"],
    ["<gero> && git push", "ask"],
    ["../gero && git push", "ask"],
  ];
  for (const [command, want] of inHundo) test(`in hundo, ${command.replaceAll("\n", "⏎")}: ${want}`, () => expect(run(command, hundo)).toBe(want));
});

describe("the parser", () => {
  test("splits on every operator and keeps quoted text whole", () => {
    const { cmds } = parse(`a && b || c; d | e & f\ng 'h && i' "j; k"`);
    expect(cmds.map((c) => c.words.map((w) => w.text).join(" "))).toEqual(["a", "b", "c", "d", "e", "f", "g h && i j; k"]);
    expect(cmds.map((c) => c.before)).toEqual(["", "&&", "||", ";", "|", "&", "\n"]);
  });
  test("marks variables and substitutions dynamic and finds their bodies", () => {
    const [c] = parse('git -C "$D/$(pwd)" push').cmds;
    expect(c!.words[2]!.dynamic).toBe(true);
    expect(c!.words[2]!.subs).toEqual(["pwd"]);
  });
});

describe("the hook as Claude Code runs it", () => {
  const script = join(import.meta.dir, "ask-push.ts");
  const json = (command: string, cwd: string) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } });
  const via = (command: string, cwd: string, input?: string) => {
    const p = Bun.spawnSync([process.execPath, script, "--skip", hundo], { stdin: Buffer.from(input ?? json(command, cwd)), env: { ...process.env, HOME: home } });
    return { code: p.exitCode, out: p.stdout.toString() };
  };
  test("an ask is the documented JSON, and exit 0", () => {
    const r = via("git push", dirs.gero!);
    expect(r.code).toBe(0);
    const o = JSON.parse(r.out);
    expect(o.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(o.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(o.hookSpecificOutput.permissionDecisionReason).toContain("gero");
  });
  test("no opinion is no output at all", () => {
    expect(via("git push", hundo)).toEqual({ code: 0, out: "" });
    expect(via("ls -la", dirs.gero!)).toEqual({ code: 0, out: "" });
  });
  test("another tool is none of its business", () => {
    expect(via("", "", JSON.stringify({ tool_name: "Edit", cwd: dirs.gero, tool_input: { command: "git push" } })).out).toBe("");
  });
  test("input it can't read asks only when it mentions a push", () => {
    expect(via("", "", "git push (not json)").out).toContain('"ask"');
    expect(via("", "", "(not json)").out).toBe("");
  });
  test("~ in --skip is the home folder", () => {
    const p = Bun.spawnSync([process.execPath, script, "--skip", "~/code/hundo"], { stdin: Buffer.from(json("git push", hundo)), env: { ...process.env, HOME: home } });
    expect(p.stdout.toString()).toBe("");
  });

  // (the command settings.json holds: a broken hook must ask about a push and stay quiet about the rest)
  const settings = (scriptPath: string, bun = process.execPath) => hookCommand(bun, scriptPath, [hundo]);
  const shell = (command: string, input: string) => {
    const p = Bun.spawnSync(["sh", "-c", command], { stdin: Buffer.from(input), env: { ...process.env, HOME: home } });
    return { code: p.exitCode, out: p.stdout.toString() };
  };
  test("the settings command gives the script's answer", () => {
    expect(shell(settings(script), json("git push", dirs.gero!)).out).toContain('"ask"');
    expect(shell(settings(script), json("git push", hundo))).toEqual({ code: 0, out: "" });
  });
  for (const what of ["the script moved", "bun gone"]) {
    test(`${what}: a push still asks, anything else is left alone`, () => {
      const command = what === "bun gone" ? settings(script, join(root, "no-bun")) : settings(join(root, "nowhere.ts"));
      const ask = shell(command, json("git push", hundo));
      expect(ask.code).toBe(0);
      expect(JSON.parse(ask.out).hookSpecificOutput.permissionDecision).toBe("ask");
      expect(shell(command, json("ls", hundo))).toEqual({ code: 0, out: "" });
    });
  }
  test("--command prints that same command", () => {
    const p = Bun.spawnSync([process.execPath, script, "--command", "--bun", "/b/bun", "--skip", "/h/hundo"]);
    expect(p.stdout.toString().trim()).toBe(hookCommand("/b/bun", script, ["/h/hundo"]));
  });
});
