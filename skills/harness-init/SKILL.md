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
4. `.claude/settings.json`: asks before push, release, deploy (any path,
   any runner), a production or project change on Vercel, a write through
   `gh api` or `vercel api`, a repository created, edited or deleted,
   secrets, `core.hooksPath` and `--no-verify`, merged in, never replacing
   a key (`doctor.ts` names the template's asks a project lacks), less the
   ones `[asks] skip` names (below); and the session's no-kill gate, a
   PreToolUse hook on Bash running the vendored `nokill.ts --session`
   (`templates/settings-hooks.json`: a kill by name, port or group refused in
   the session's own Bash, its command's own children let through; when the
   gate can't run, a call that mentions a kill is refused and the others warn).
   `doctor.ts` names it missing, not the template's, or running a `nokill.ts`
   the project lacks
5. `.claude/agents/reviewer.md` and `architect.md`, where there are none; a
   copy that is there is the project's and is kept, and `doctor.ts` names one
   that lacks a rule of the template (a block marked `<!-- harness:rule NAME -->`,
   such as `bash`: what the helper's Bash is for and never does) or the gate
   behind it (a `hooks:` PreToolUse block on Bash in the frontmatter that runs
   the vendored `nokill.ts`, which refuses a kill; `doctor.ts` also names a
   hook whose `nokill.ts` the project lacks, which would refuse every Bash call
   of the helper). Add the block by hand, reworded as the copy likes, the mark
   kept, and the hook's `{{TOOLS}}` your tools dir. The hook is skipped in an
   untrusted folder: accept the workspace trust where the helpers run
6. a Harness block in `CLAUDE.md` between `<!-- harness:start -->` and
   `<!-- harness:end -->`: a later run replaces only the block
7. `.gitignore`: `.harness/` and `.cache/`

A vendored copy is never hand-edited: change the tool in `$HARNESS`, commit,
then `bun harness-sync.ts <project>` (`--check` fails on a hand edit).

A project whose every child session works in a git worktree of its own (a
branch each, the work meeting in pull requests) says so in `harness.toml`:

```toml
[hooks]
lock = false        # nothing is shared to queue for: the board is a list
[session]
worktrees = true    # session.ts and the child skill open every child in one
decisions = "opener"  # only if the user takes every decision in the dispatch session:
                      # a child asks them nothing, it sends each question and go to its opener
[checks]
queue = true        # optional: one check at a time on the machine, the others wait
# queue_limit = 30  # minutes a queued run may take before q stops it (0: none); `q.ts --limit <min>` for one run
[asks]
# skip = ["Bash(git push *)"]   # asks of the template this project leaves out, exact strings: only when its own
                                # safeguards stand in (a protected main). init.ts then neither merges nor keeps them.
                                # A user-level ask is the user's: harness/claude-hooks/ask-push.ts keeps it per folder
```

and renders its Harness block again (`bun init.ts <project> --section-only`):
the lock's words go, the worktree rules come, and with `decisions = "opener"`
the questions and the go are the opener's. `doctor.ts` names a block that no
longer matches the config. Install the hooks from the main checkout only
(`hooks.ts install .` refuses a worktree: `core.hooksPath` is the
repository's, every worktree's, and what it writes is the absolute path of the
main checkout's githooks, so a worktree's own copy of the tools never replaces
them).

Given a worktree of the project, `init.ts`, `harness-sync.ts` and `doctor.ts`
write and judge that worktree's own files (its copies, `CLAUDE.md`,
`.claude/settings.json`, the config text a branch changed), never the main
checkout's; `init.ts` leaves the hooks to the main checkout and says so.

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
