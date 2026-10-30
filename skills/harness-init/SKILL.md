---
name: harness-init
description: Set the harness up in any project: init.ts from the harness repository (harness.toml, vendored tools, git hooks, permission asks, reviewer and architect helpers, a Harness block in CLAUDE.md, .gitignore), then check it took and commit it. Use when the user wants the harness, its hooks, the task board or the review gates in a repository or a folder of repositories that lacks them, in the WoW family or outside it.
---

# The harness in a project

`init.ts` lives in the harness repository. This skill is linked from
`~/.claude/skills/`, so the checkout is two folders above this file's real
path (`realpath` the link). Call it `$HARNESS` below. Needs bun and git,
nothing else. Design and reasons: `$HARNESS/docs/design.md`.

`init.ts` is idempotent (what is there is kept, a second run only brings the
copies up to date) and commits nothing.

## 1. Look first

- Is the target a git repository, or a folder of them? Both work. No `.git`
  yet: `git init`, local only. Creating a GitHub repository or pushing is the
  user's go.
- Its check: `package.json`'s `check`, else `test`, else `bun test`. The push
  gate refuses a tree with no passing check stamp, so if the project's check
  is something else (make, go, cargo, pytest), pass it with `--check`.
- Already inside the WoW family (`~/code/wow-addons/<repo>`)? Then also load
  `wow-harness-init`: the family carries one stamped copy, not one per repo.

## 2. Run it

```bash
(cd $HARNESS && bun init.ts <project> --dry-run)
(cd $HARNESS && bun init.ts <project> [--name n] [--check "<cmd>"] [--tools dir])
```

It writes:

1. `harness.toml`: the shape and the check it found
2. the tools and githooks, vendored and stamped into `harness/` (`--tools`
   to rename the folder)
3. the hooks installed in each repository
4. `.claude/settings.json`: asks before push, release, deploy, secrets,
   `core.hooksPath` and `--no-verify`, merged in, never replacing a key
5. `.claude/agents/reviewer.md` and `architect.md`, where there are none
6. a Harness block in `CLAUDE.md` between `<!-- harness:start -->` and
   `<!-- harness:end -->`: a later run replaces only the block
7. `.gitignore`: `.harness/` and `.cache/`

A vendored copy is never hand-edited: change the tool in `$HARNESS`, commit,
then `bun harness-sync.ts <project>` (`--check` fails on a hand edit).

## 3. Check it took

```bash
(cd $HARNESS && bun doctor.ts <project>)     # exit 1 lists what is wrong
bun harness/q.ts check -- <the check>        # in the project: the first stamp
```

Then prove a gate once: a commit message with a "generated with" line is
refused, and `bun harness/hooks.ts status` shows the hooks and HEAD's check.
Nothing is pushed for the test. Two known traps: husky's `prepare` can take
`core.hooksPath` back on `bun install` (run `hooks.ts install .` after it),
and a check that isn't `bun run check` needs `git config harness.check`.

## 4. Commit

- Read the whole diff. The project's own `.claude/settings.json` keys and
  `CLAUDE.md` text must be intact: the project's own rules go above or below
  the Harness block, never inside it.
- One local commit, Conventional Commits, no AI trailers:
  `chore: the harness at <sha>` (the copies carry the harness repository's
  commit). Vendored copies and hooks are waived by the review gate, anything
  hand-written in the same commit isn't.
- The project's first task opens its card (`bun harness/board.ts add …`):
  the commit hook refuses a Claude session's commit without a running card.

## What it does not do

No GitHub repository, no CI, no secrets, no push. No model choice (that is
the project's `.claude/settings.json`). It doesn't write the project's
`CLAUDE.md` map: the block it adds points to it for the project's own rules.
