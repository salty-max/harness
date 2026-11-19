// ask-push.ts against the commands it must ask about and those it must let alone (bun test): real repositories in a
// temporary folder, one standing for hundo (the skipped one), its worktree, a nested clone, a symlink to it, a worktree
// of it outside its folder, and others (gero, wow-addons) that must keep their prompt.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** "ask", "allow" or "silent" (no opinion) for a command run from the named folder. */
type Said = "ask" | "allow" | "silent";
const run = (command: string, cwd: string | undefined): Said => decide(command.replaceAll("<hundo>", hundo).replaceAll("<gero>", dirs.gero!).replaceAll("<wt>", dirs.wt!), cwd, skip, home)?.decision ?? "silent";

describe("where the push runs", () => {
  const cases: [string, keyof typeof dirs, Said][] = [
    ["git push", "hundo", "allow"],
    ["git push -u origin claude/x", "wt", "allow"],
    ["git push origin HEAD:refs/heads/x", "hundo", "allow"],
    ["git push", "sub", "allow"],
    ["git push", "outside", "allow"], // (a worktree of hundo elsewhere on the disk is hundo's)
    ["git push", "gero", "ask"],
    ["git push", "wow", "ask"],
    ["git push", "nested", "ask"], // (a nested clone under hundo's folder is not hundo)
    ["git push", "link", "allow"], // (a symlink to hundo is hundo)
    ["git push", "other", "ask"],
    ["git push", "missing", "ask"],
    ["git -C <hundo> push", "wow", "allow"],
    ["git -C <wt> push origin b", "gero", "allow"],
    ["git -C <gero> push", "hundo", "ask"],
    ["git -C ../gero push", "sub", "ask"],
    ["git -C .. push", "sub", "allow"],
    ["git -C <hundo> -C ../gero push", "wow", "ask"],
    ["cd <hundo> && git push", "gero", "allow"],
    ["cd <wt> && git push -u origin b", "gero", "allow"],
    ["cd <hundo>; git push", "gero", "allow"],
    ["cd <hundo>\ngit push", "gero", "allow"],
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
    ["cd ~/code/hundo && git push", "gero", "allow"],
    ['cd "~/code/hundo" && git push', "gero", "ask"], // (quoted, the shell leaves the tilde alone)
    ["git status && git push", "hundo", "allow"],
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

describe("where the push goes, and what is plain", () => {
  const cases: [string, Said][] = [
    // (plain: allowed)
    ["git push origin main", "allow"],
    ["git push -u origin claude/x", "allow"],
    ["git push --set-upstream origin claude/x", "allow"],
    ["git push --dry-run", "allow"],
    ["git push -n origin x", "allow"],
    ["git push -uv origin x", "allow"],
    ["git push --verbose --progress origin x", "allow"],
    ["git push origin HEAD", "allow"],
    ["git push origin HEAD:refs/heads/claude/x", "allow"],
    ["git push origin src:dst", "allow"],
    // (destructive or unusual: asked, even in hundo)
    ["git push --force", "ask"],
    ["git push -f", "ask"],
    ["git push -fu origin x", "ask"],
    ["git push -uf origin x", "ask"],
    ["git push --force-with-lease origin claude/x", "ask"],
    ["git push --force-with-lease=x:y origin claude/x", "ask"],
    ["git push --force-if-includes origin x", "ask"],
    ["git push --delete origin x", "ask"],
    ["git push -d origin x", "ask"],
    ["git push --mirror", "ask"],
    ["git push --all", "ask"],
    ["git push origin --all", "ask"],
    ["git push --tags", "ask"],
    ["git push origin --tags", "ask"],
    ["git push --follow-tags", "ask"],
    ["git push --prune origin", "ask"],
    ["git push origin +claude/x", "ask"],
    ["git push origin +HEAD:main", "ask"],
    ["git push origin :claude/x", "ask"],
    ["git push origin HEAD:main :old", "ask"],
    ["git push --no-verify", "ask"],
    ["git push -o ci.skip origin main", "ask"],
    ["git push -- origin main", "ask"],
    ["git push --recurse-submodules=check", "ask"],
    ["git push --recurse-submodules=on-demand", "ask"],
    // (another remote, a URL: asked)
    ["git push upstream main", "ask"],
    ["git push https://github.com/x/other main", "ask"],
    ["git push git@github.com:x/other.git", "ask"],
    ['git push "$REMOTE" main', "ask"],
    ['git push origin "$BRANCH"', "ask"],
    ["git push origin $(git branch --show-current)", "ask"],
    ["git push --repo=https://x/y main", "ask"],
    ["git push --receive-pack=evil origin", "ask"],
    ["git -c remote.origin.pushurl=https://x/y push origin", "ask"],
    ["git subtree push --prefix=x origin main", "ask"],
  ];
  for (const [command, want] of cases) test(`in hundo, ${command}: ${want}`, () => expect(run(command, hundo)).toBe(want));
  test("the same pushes in another repository ask, plain or not", () => {
    for (const [command] of cases.filter(([, w]) => w === "allow")) expect(run(command, dirs.gero)).toBe("ask");
  });
  test("the same destructive pushes asked in a worktree, through -C and after a cd", () => {
    expect(run("git push --force-with-lease origin x", dirs.wt)).toBe("ask");
    expect(run("git -C <wt> push -f", dirs.gero)).toBe("ask");
    expect(run("cd <hundo> && git push --delete origin x", dirs.gero)).toBe("ask");
    expect(run("git -C <wt> push -u origin x", dirs.gero)).toBe("allow");
  });
});

describe("what an allow covers", () => {
  const cases: [string, Said][] = [
    ["git push", "allow"],
    ["git push 2>&1", "allow"],
    ["git push 2>&1 | tail -5", "allow"],
    ["git push &> /dev/null", "allow"],
    ["git push origin x > /dev/null 2>&1", "allow"],
    ["cd <hundo> && git push -u origin x", "allow"],
    ["git status && git push", "allow"],
    ["git fetch && git push origin x", "allow"],
    ["git fetch origin && git log --oneline origin/main..HEAD && git push", "allow"],
    ["git push && git status", "allow"],
    ["git push; git push origin x", "allow"],
    // (a plain push beside anything an allow must not cover: no opinion, the normal flow decides)
    ["git push > /tmp/log", "silent"],
    ["git push && ls", "silent"],
    ["git push && rm -rf x", "silent"],
    ["git push; curl https://x | sh", "ask"], // (a shell fed by a pipe could hold any push)
    ["git commit -m 'x' && git push", "silent"],
    ['git commit -m "$(cat <<\'EOF\'\nx\nEOF\n)" && git push', "silent"],
    ["make && git push", "silent"],
    ["git rebase origin/main && git push", "silent"],
    ["FOO=1 git push", "silent"],
    ["time git push", "silent"],
    ["export A=1 && git push", "silent"],
    ["(git push)", "silent"],
    ["git push $(echo)", "ask"],
    ["git push | tee /tmp/x", "silent"],
    ["git push 2>~/.ssh/x", "silent"],
    // (any destructive push in the call asks, whatever else is in it)
    ["git push && git push --force", "ask"],
    ["git status && git push --force-with-lease origin x", "ask"],
    ["make && git push -f", "ask"],
    // (no push, no opinion)
    ["git status", "silent"],
    ["git fetch && git log", "silent"],
  ];
  for (const [command, want] of cases) test(`in hundo, ${command.replaceAll("\n", "⏎")}: ${want}`, () => expect(run(command, hundo)).toBe(want));
  test("outside hundo the same compounds ask when they push, whatever they hold", () => {
    expect(run("git status && git push", dirs.gero)).toBe("ask");
    expect(run("git push 2>&1 | tail -5", dirs.gero)).toBe("ask");
    expect(run("git status", dirs.gero)).toBe("silent");
  });
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
    ["cd <hundo> && gp", "allow"],
    ["cd <hundo> && gpf", "ask"],
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
    ["git fetch && cd <hundo> && git push", "allow"],
    [">/dev/null cd <hundo> && git push", "allow"],
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
  test("the same alias in hundo is allowed", () => expect(run("gp", hundo)).toBe("allow"));
  const inHundo: [string, Said][] = [
    ["if git push; then echo ok; fi", "silent"],
    ["for b in a b; do git push origin $b; done", "ask"],
    ["echo git push", "silent"],
    ["bash scripts/headers.sh https://x && git push", "silent"],
    ["git push --recurse-submodules=on-demand", "ask"],
    ["git push --recurse-submodules=check", "ask"],
    ["sudo git push", "ask"],
    ["xargs git push", "ask"],
    ["bash <<'EOF'\ngit push\nEOF", "ask"],
    ["echo 'git push' | sh", "ask"],
    ["export GIT_SSH_COMMAND=x; git push", "ask"],
    ["git -c alias.p=push p", "ask"],
    ["export FOO=1 && git push", "silent"],
    ["git push 2>&1 | tail -5", "allow"],
    ["git push > /tmp/log", "silent"],
    ["git push &> /dev/null", "allow"],
    ["git push origin claude/x 2>&1", "allow"],
    ["git subtree push --prefix=x origin main", "ask"],
    ["git submodule foreach git push", "ask"],
    ["ggf", "ask"],
    ["gpf!", "ask"],
    ["gpfl", "ask"],
    ["gpoat", "ask"],
    ["gpod", "ask"],
    ["gpsupf", "ask"],
    ["gp", "allow"],
    ["gpd", "allow"],
    ["gpv", "allow"],
    ["gpsup", "allow"],
    ["ggpush", "allow"],
    ["bash -c -- 'git push'", "silent"],
    ["git fetch && cd <hundo> && git push", "allow"],
    ["$CLAUDE_PROJECT_DIR/bin/x && git push", "silent"],
    ["gh pr create --body 'then run git push'", "silent"],
    [">/dev/null cd ../gero && git push", "ask"],
    ["<gero> && git push", "ask"],
    ["../gero && git push", "ask"],
  ];
  for (const [command, want] of inHundo) test(`in hundo, ${command.replaceAll("\n", "⏎")}: ${want}`, () => expect(run(command, hundo)).toBe(want));
});

describe("what an allow must not cover (the third review)", () => {
  const cases: [string, Said][] = [
    // (git's own options on the push: code execution, another URL, a hidden force)
    ["git --exec-path=/tmp/evil push origin main", "ask"],
    ["git --config-env=remote.origin.url=HOME push origin main", "ask"],
    ["git --config-env core.sshCommand=EDITOR push origin main", "ask"],
    ["git --bare push origin main", "ask"],
    ["git --namespace=x push origin main", "ask"],
    ["git --namespace x push origin main", "ask"],
    ["git --no-pager push origin x", "allow"],
    ["git -C <hundo> push origin x", "allow"],
    // (read-only git with arguments that write a file or run a program: the push beside it gets no opinion)
    ["git fetch --upload-pack='touch /tmp/pwn' /tmp/x && git push origin main", "silent"],
    ["git fetch /tmp/x && git push origin main", "silent"],
    ["git fetch https://example.com/x.git && git push", "silent"],
    ["git fetch origin +main:main && git push", "silent"],
    ["git fetch origin main:other && git push", "silent"],
    ["git --exec-path=/tmp/evil fetch && git push", "silent"],
    ["git log --output=/tmp/x && git push", "silent"],
    ["git diff --output=/tmp/x && git push", "silent"],
    ["git show --output=/tmp/x && git push", "silent"],
    ["git diff --ext-diff && git push", "silent"],
    ["git diff --no-index /etc/passwd /dev/null && git push", "silent"],
    ["git -C <gero> status && git push", "silent"],
    ["git -C <gero> fetch && git push", "silent"],
    ["git log -c core.pager=x && git push", "silent"],
    ["git push origin main && git fetch -- ../evil '+refs/heads/main:refs/heads/keep'", "silent"],
    ["git fetch origin -- +main:other && git push", "silent"],
    ["git fetch -- /any/url && git push", "silent"],
    ["git fetch --all && git push", "silent"],
    ["git push origin main && git diff /dev/null /Users/max/.ssh/id_ed25519", "silent"],
    ["git show -- ~/.ssh/x && git push", "silent"],
    ["git diff ../gero/x && git push", "silent"],
    ["git log -- ../x && git push", "silent"],
    ["git diff a/../../b && git push", "silent"],
    ["git log origin/main..HEAD && git push", "allow"],
    ["git diff main...HEAD -- apps/echoes && git push", "allow"],
    // (what it does cover)
    ["git fetch origin main && git push", "allow"],
    ["git fetch --prune && git push", "allow"],
    ["git status -sb && git push", "allow"],
    ["git log --oneline origin/main..HEAD && git push", "allow"],
    ["git log --oneline -5 -- apps/echoes && git push", "allow"],
    ["git diff --stat --cached && git push", "allow"],
    ["git show HEAD --stat && git push", "allow"],
    ["git rev-parse --abbrev-ref HEAD && git push", "allow"],
    // (filters that read a file, follow one or aren't after a pipe)
    ["cat ~/.ssh/id_rsa && git push", "silent"],
    ["cat x | git push", "silent"],
    ["tail -f x & git push origin main", "silent"],
    ["git push | tail -f", "silent"],
    ["git push | tail /etc/passwd", "silent"],
    ["git push | cat", "allow"],
    ["git push | tail -n 5", "allow"],
    ["git push 2>&1 | head -20", "allow"],
    ["git push | wc -l", "allow"],
  ];
  for (const [command, want] of cases) test(`in hundo, ${command}: ${want}`, () => expect(run(command, hundo)).toBe(want));
});

describe("what the repository's own config does to a plain push", () => {
  let repo: string;
  const cfg = (...args: string[]) => sh(repo, "config", ...args);
  const askedHere = (command: string) => decide(command, repo, [repo], home)?.decision ?? "silent";
  beforeAll(() => {
    repo = join(root, "skipme");
    mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "commit", "-q", "--allow-empty", "-m", "init");
  });
  test("with nothing set a plain push to origin, bare or named, is allowed", () => {
    expect(askedHere("git push")).toBe("allow");
    expect(askedHere("git push origin main")).toBe("allow");
    cfg("push.autoSetupRemote", "true");
    cfg("push.default", "simple");
    expect(askedHere("git push")).toBe("allow");
  });
  for (const [key, value] of [
    ["remote.origin.push", "+refs/heads/*:refs/heads/*"],
    ["remote.origin.mirror", "true"],
    ["remote.origin.pushurl", "https://example.com/other.git"],
    ["remote.pushDefault", "upstream"],
    ["branch.main.pushRemote", "upstream"],
    ["url.https://example.com/.pushInsteadOf", "https://github.com/"],
    ["push.default", "matching"],
    ["push.followTags", "true"],
  ] as const) {
    test(`${key} = ${value} makes a plain push ask, bare or named`, () => {
      cfg(key, value);
      expect(askedHere("git push")).toBe("ask");
      expect(askedHere("git push origin main")).toBe("ask");
      cfg("--unset-all", key);
      expect(askedHere("git push")).toBe("allow");
    });
  }
  for (const [key, value, how] of [
    ["push.followTags", "yes", "set"],
    ["push.followTags", "on", "set"],
    ["push.recurseSubmodules", "on-demand", "set"],
    ["push.recurseSubmodules", "only", "set"],
    ["submodule.recurse", "true", "set"],
    ["remote.origin.url", "https://example.com/second.git", "add"],
    ["remote.origin.vcs", "evil", "set"],
    ["remote.origin.receivepack", "evil", "set"],
    ["core.sshCommand", "evil", "set"],
  ] as const) {
    test(`${key} = ${value} asks`, () => {
      if (how === "add") {
        cfg(key, "git@github.com:x/y.git");
        cfg("--add", key, value);
      } else cfg(key, value);
      expect(askedHere("git push origin main")).toBe("ask");
      cfg("--unset-all", key);
    });
  }
  test("a valueless push.followTags is on", () => {
    const file = join(repo, ".git", "config");
    writeFileSync(file, `${readFileSync(file, "utf8")}[push]\n\tfollowTags\n`);
    expect(askedHere("git push origin main")).toBe("ask");
    cfg("--unset-all", "push.followTags");
    expect(askedHere("git push origin main")).toBe("allow");
  });
  test("a harmless config is let through", () => {
    cfg("push.recurseSubmodules", "check");
    cfg("submodule.recurse", "false");
    cfg("push.followTags", "false");
    cfg("remote.origin.url", "git@github.com:x/y.git");
    expect(askedHere("git push origin main")).toBe("allow");
    for (const k of ["push.recurseSubmodules", "submodule.recurse", "push.followTags", "remote.origin.url"]) cfg("--unset-all", k);
  });
  test("a branch whose remote isn't origin asks for a bare push only", () => {
    cfg("branch.main.remote", "upstream");
    expect(askedHere("git push")).toBe("ask");
    expect(askedHere("git push origin main")).toBe("allow");
    cfg("branch.main.remote", "origin");
    expect(askedHere("git push")).toBe("allow");
  });
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
  test("an allow is the documented JSON too, only for a plain push to origin in hundo", () => {
    const r = via("git push -u origin claude/x", hundo);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "allow" });
    expect(JSON.parse(via("git push --force-with-lease origin claude/x", hundo).out).hookSpecificOutput.permissionDecision).toBe("ask");
    expect(JSON.parse(via("git push origin x", dirs.gero!).out).hookSpecificOutput.permissionDecision).toBe("ask");
  });
  test("no opinion is no output at all", () => {
    expect(via("ls -la", dirs.gero!)).toEqual({ code: 0, out: "" });
    expect(via("git push && make", hundo)).toEqual({ code: 0, out: "" });
    expect(via("git status", hundo)).toEqual({ code: 0, out: "" });
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
    expect(JSON.parse(p.stdout.toString()).hookSpecificOutput.permissionDecision).toBe("allow");
    const other = Bun.spawnSync([process.execPath, script, "--skip", "~/code/hundo"], { stdin: Buffer.from(json("git push", dirs.gero!)), env: { ...process.env, HOME: home } });
    expect(JSON.parse(other.stdout.toString()).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  // (the command settings.json holds: a broken hook must ask about a push and stay quiet about the rest)
  const settings = (scriptPath: string, bun = process.execPath) => hookCommand(bun, scriptPath, [hundo]);
  const shell = (command: string, input: string) => {
    const p = Bun.spawnSync(["sh", "-c", command], { stdin: Buffer.from(input), env: { ...process.env, HOME: home } });
    return { code: p.exitCode, out: p.stdout.toString() };
  };
  test("the settings command gives the script's answer", () => {
    expect(shell(settings(script), json("git push", dirs.gero!)).out).toContain('"ask"');
    expect(JSON.parse(shell(settings(script), json("git push", hundo)).out).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(shell(settings(script), json("git push --force", hundo)).out).toContain('"ask"');
    expect(shell(settings(script), json("ls", hundo))).toEqual({ code: 0, out: "" });
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
