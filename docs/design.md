# Harness, standalone: the design (29 October 2026, draft 2, after the architect's look)

The family's harness (addon-kit: board, q, hooks, packet, review, status, each,
usage, events, session) as a thing any project can adopt in one command. First
customer: the geoguessr web game (one repository, bun, a test command, no
addons, no kit). The WoW family stays the second user and must not change
behaviour. Nothing here is built yet: the user approves this file first.

## 1. What is generic, what is not (grepped, 29 October 2026)

Hard-coded family names are few: `grep` over the tools finds them in `board.ts`
(1: `familyPath("board")`), `packet.ts` (8: wow-data's `card.ts`, Yonder's
riddle files), `review.ts` (2: `repo !== "addon-kit"`, the COPIES regex),
`status.ts` (iCloud test builds, Ravenpost, `gh`), `each.ts` (what an "addon"
and a "kit" repository are), `hooks.ts` and `root.ts` (the family folder is the
one holding `addon-kit/` and `wow-data/`), `session.ts` (the CLAUDE.md path and
`bun addon-kit/board.ts …` in the child's prompt), and the git hooks' wording
("the family's rule") plus `_event`'s `WOW_ADDONS_ROOT`. Everything else is
already generic. Per file:

| File | Verdict | What changes |
|---|---|---|
| `q.ts` | generic | none: it already reads `harness.check` (git config) or `package.json` |
| `events.ts` | generic | log path from config instead of `familyPath` |
| `board.ts` | generic | board dir from config; `repo` names come from config |
| `githooks/*` | generic | messages say the project's name; `_event` finds the root by walking up to `harness.toml`; `pre-commit` takes the repo's name from config, not `basename` |
| `hooks.ts` | generic | repo list from config; hooks folder = the vendored copy's `githooks/` |
| `review.ts` | generic but for the waiver | `DOCS`/`COPIES` regexes move to config (`review.waive`), default = docs only |
| `packet.ts` | generic but for riddle cards | the cards section becomes an extension (`packet.extras`); the family's lives in addon-kit |
| `each.ts` | generic but for "addon"/"kit" | groups come from config (`[groups]`); `--all` and `--only` unchanged |
| `status.ts` | half | the table (ahead/behind, dirty, stamp, hooks, board cards, workflows, PRs) is generic; iCloud builds and Ravenpost are an extension (`status.extras`) |
| `usage.ts` | generic | the transcripts dir is derived from the project root, already so |
| `session.ts` | generic in the `claude --bg` path | prompt text from config (`[session]`); the desktop-only paths stay in addon-kit (see 6) |
| `root.ts` | rewritten | finds `harness.toml`, not the family (see 3). The old `root.ts` stays in addon-kit untouched: the addons carry copies of it for their own scripts |
| `harness.test.ts`, `tools.test.ts`, `session.test.ts`, `usage.test.ts` | move with the tools | the cases that name family folders get fixture names |

Not in the harness, stays in addon-kit: `Kit.lua` and everything the kit syncs,
`preflight.ts`, `release.sh`, `store.ts`, `store-ui.ts`, `sync.ts`,
`regional.ts`, `locales-lib.ts`, `package-lib.ts`, `ids.ts`, `secret.ts`,
`glossary.py`, `subzones.py`, `coldread.ts` (languages), all `wow-*` skills
(`wow-child` among them: the family's addendum to the harness's `child`), `data-scout`, `prose-reader`,
the family's CLAUDE.md rules.

The harness's own prose rules (what it enforces) live in the project's rules
file; the harness has no opinion about them. The reviewer enforces "the rules
file", whatever it is.

## 2. `harness.toml`

At the project root. Every key optional except the file's existence; the
defaults are for a one-repository project.

```toml
[project]
name = "geoguessr"                # used in messages and card ids

[state]                           # local state, never committed
dir   = ".harness"                # board/, cache/ (events log, opened children) inside
# board = "board"                 # override one piece (the family: board/)
# cache = ".cache/harness"        # (the family keeps its path)

[tools]
dir = "harness"                   # where the vendored copy lives (the family: addon-kit/harness)

[repos]                           # default: the root itself when it is a git repo,
                                  # else every directory under it with a .git
# hearthtale = { path = "hearthtale", check = "bun run check", rules = "CLAUDE.md" }
# any key a repo omits falls back to [defaults]
[defaults]
check = "bun run check"           # the fallback: q.ts takes git config harness.check, then a repo's own check here, then package.json's check, then this
rules = "CLAUDE.md"               # the file the reviewer's standard is; packet names it

[groups]                          # for each.ts: --kit, --addons ...
# kit    = { has_script = "kit:sync" }       # a package.json script
# addons = { has_file = "addon/*/*.toc" }    # a glob
# core   = ["hearthtale", "yonder"]          # or a list

[hooks]
trailers  = true                  # refuse AI co-author / "generated with" trailers
lock      = true                  # pre-commit: a Claude session's commit wants its running card, and the board queues who writes where
                                  # false: the board is a list (every child has a worktree of its own), the notes, `held` and `may` say who runs where and refuse nothing
stamp     = true                  # pre-push: a passing check on the tree
review    = true                  # pre-push backstop: a recorded review (review.ts --push)

[review]
waive = ['^docs/', '(^|/)(README|CLAUDE)\.md$']   # files a push may carry unreviewed
                                                    # (the family adds .toc and the kit's copies)
[extensions]                      # module paths from the root, each optional
# packet = "addon-kit/packet-extras.ts"   # export extras(ctx): string[] (lines for the packet)
# status = "addon-kit/status-extras.ts"   # export columns(repo): { label, value }[]

[checks]
queue = false                     # true: one `check` at a time on this machine, the others wait (queue.ts, below)

[session]                         # session.ts
rules  = "CLAUDE.md"              # what a child reads first
models = { code = "opusplan", prose = "opus" }
worktrees = false                 # true: every child works in a git worktree of its own (see "Worktrees" below)
decisions = "child"               # "opener": a child asks the user nothing, it sends each question and go to its opener
```

The reader (`config.ts`), in this order: `HARNESS_ROOT` (and `WOW_ADDONS_ROOT`
as its alias, first, since the existing tests and tools set it); a
`harness.toml` upward from the working directory; then upward from git's
common dir; last, upward from the tool file itself (`import.meta.dir`, the
old `root.ts` fallback). When the toml sits inside a repository (a one-repo
project), a worktree resolves the root from the main checkout (the common
dir's parent), never from its own copy of the file, so every worktree shares
one board and one lock. `include = "<path>"` lets a root file point at a
versioned one. It validates and fills
defaults, returns one typed object, and every tool takes its paths and names
from it. Parsed with bun's built-in TOML import (`Bun.TOML.parse`): no
dependency. One schema check (`harness doctor`) lists unknown keys and
missing paths.

**Worktrees** (15 November 2026, found by hundo, the first project to give
every child session a worktree and a branch). Two switches say so, and every
default is the shared checkout the family keeps: `[hooks] lock = false` (the
board is a list: `board.ts`'s `held:` lines become `note: … running too`,
`held` never exits 1, `may` never refuses, pre-commit asks nobody, and the
generated Harness section drops the lock's words) and `[session] worktrees =
true` (`session.ts`'s prompt tells the child it works in a worktree, a CLI
child gets `--worktree <name>`, the `child` skill passes `use_worktree: true`,
and the section adds the worktree rules). Both are read by `init.ts` when it
renders the section (`doctor.ts` names a section that no longer matches), and
a switch that is not `true` or `false` is an error, never the default.

A tool given a repository's name works on the worktree the working directory
is in when that is one of the repository's (`config.ts` `workDir`, `packet.ts`
and `review.ts` say which folder they read), else on its main checkout
(`repoDir`: what `status`, `hooks` and `doctor` want, the hooks path and the
board being the repository's). `session.ts check|close|children` read a child
in its own worktree: the `worktree:` its card names (`board.ts` writes it when
the card's own session adds or sets it from a linked worktree), else its live
session's `cwd`, else the main checkout, said when the repository has other
worktrees (a pushed, unmerged branch has no unpushed commits: the PR carries
it); in a project with `worktrees = true` that note is a refusal (`--force`,
on the user's word, goes past it), because the main checkout of such a project
is clean whatever its children did. `worktrees = true` is for a project that
is one repository: `claude --bg --worktree` makes the worktree of the
repository it starts in, so a root of many repositories gets none asked
(`doctor.ts` says so). `hooks.ts install` refuses in a linked worktree: `core.hooksPath` is
shared by all of them, and what install writes is the absolute path of the
main checkout's githooks, so a worktree's own copy of the tools is never the
hooks that run (a relative one, husky's `.husky/_`, is resolved from each
worktree). The copy of the tools in a worktree (a one-repository project's
branch carries its own) reads and writes it the same way: `hooks.ts status`
takes the main checkout's copy of its `githooks/` as ours beside its own (so
`status.ts` and `hooks.ts status` run from a worktree don't call installed hooks
missing), and `install` run from such a copy writes the main checkout's folder,
or refuses when the main checkout has none (the tools not merged yet) or there
is no main checkout to name (a bare repository's worktree, a separate git dir):
never a path that goes with the worktree. Another worktree's copy is neither.
A plain checkout, the family's, reads and writes its own folder only, as
before, and so does `status` in a worktree with no main checkout to name. A config the hooks can't read is said on stderr by
`config.ts hook` (answering `on`: every gate stays on, none quietly off).

*Leftovers* (15 November 2026, the same project using it):

- A tool that writes the project's own files given a worktree writes that worktree's:
  `config.ts`'s `projectTree` (the linked worktree of the root's repository `from`
  is in, else the root), `toolsPath` and `treeConfig` (the worktree's own
  `harness.toml`, for what is rendered into it: a branch may change a switch).
  `harness-sync.ts` writes and checks the worktree's copies, `init.ts` adopts the worktree
  (the hooks left to the main checkout), `doctor.ts` judges its tools, `CLAUDE.md`
  section, settings and config text, and the hooks as the repository has them. The
  board, the lock and the stamps stay the shared config's. A root that is no
  repository (the family's) has no worktree of it: nothing changes there.
- *Unpushed* (`trees.ts`, used by `session.ts check|close|children`) is counted
  by content, not by id: a project that merges by rebase leaves a child's
  commits with new ids on the remote's branch, which read unpushed for good. Of
  the commits of HEAD on no remote by id, none is left when `git merge-tree
  --write-tree` of HEAD into the upstream or the remote's default branch is that
  branch's own tree (its work is there, however the rebase moved the context
  lines: `git cherry`'s patch id, which takes context in, misses those); else
  the oldest ones that are, then those a `git cherry` `-` line says the branch has,
  are set aside, and the rest counted. A patch changed on the way counts: the
  safe side. A merge commit alone, with something no branch has, is 1. A commit
  that changes nothing is nothing to lose. The remote as last fetched: a branch
  merged since reads unpushed until `git fetch` (the close message says so).
- `status.ts` and the pane read each repository's linked worktrees (`worktreesOf`,
  only where `.git/worktrees` exists): a worktree with uncommitted files or commits
  no remote has is a row under its repository and wants a hand; the pane's
  Repositories box draws it, never `held` for a project whose lock is off
  (`running`), nor a lock's "on X" on its blocked cards; its Gates box says a check
  waits in the queue.
- `[session] decisions = "opener"` is for a project whose user takes every
  decision in the dispatch session, never in a child (hundo). `session.ts`'s
  prompt then tells the child it asks the user nothing: each question or go (a
  push, a merge, any choice) goes to its opener with the options and its
  recommendation, and it stops; the opener asks, then pushes on the answer or
  relays it quoted. One exception, said in the prompt of a `--plan` child:
  leaving plan mode asks the user in the child's own session, and nothing routes
  that to the opener. The rules template's two bullets on questions and the go follow
  the switch (`{{#opener}}`/`{{^opener}}`), and the `child` skill describes both
  modes. The default is the family's: the question tool in the child, and the go
  asked there.

**The check queue** (15 November 2026, asked for by hundo: several child
sessions in parallel worktrees each ran a heavy `check` at once, the load
reached 86 to 140 and tests timed out at their 5 s). `queue.ts` is a lock for
`check` on the machine: `[checks] queue = true` in harness.toml makes every
`check` of the project wait its turn, whatever worktree or repository it runs
in (`q.ts --queue <name>` queues another run, `--no-queue` skips it once,
`HARNESS_QUEUE=off` is the escape hatch, `HARNESS_QUEUE=<folder>` another
folder than `~/.cache/harness/queue`). It is off by default, the family's
setting too (its sessions share checkouts and its checks overlap about one time
in ten, so it is the user's call: a waiting `check` can outlive an agent tool
call's timeout and be killed, losing its place). The lock is a link made whole
(as a card is), taken only by the oldest living waiter (tickets under
`waiting/`, first come first served); a holder or a ticket whose process is
gone, or whose pid was reused (started after its file), is dead, and a dead
holder or one past an hour (a wedged check) is taken over by the head waiter
alone. A waiting run says so in one line on stderr and takes its place before
its log, its panel file (so the panel lights only the check that runs) and the
tree it stamps are looked at; the verdict, stamp, event log and exit code are
what they are without it. The command a holder runs has `HARNESS_QUEUE_HELD`,
so a q run inside it (the harness's own tests drive q) never waits for its
own holder. Not covered: a holder killed with SIGKILL leaves its command
running while the lock looks stale, and a Mac that sleeps through the hour
makes a healthy holder look wedged (two checks overlap, load and never a
wrong stamp); a queue orders q's runs and nothing
else (a bare `bun test`, a check parallel inside itself, the sessions' own
work); the panel says a check waits (under the run, never lit) but lights
only what runs.

**The time limit** (19 November 2026, after a Playwright probe run as
`q.ts --queue shots -- node …` hung 52 minutes on a fetch that never answered,
held the one place, and kept two other sessions' runs waiting for 40 of
them; the dispatcher found it with `ps`). The queue frees a place only when
its holder dies, and a live but hung holder never does, so q now stops a run
that holds a place when it has run for 30 minutes (`DEFAULT_LIMIT` in
`queue.ts`: the family's longest check ran 9, hundo's whole Lighthouse job
about 15; a limit is what a hung run costs everyone behind it, and a false kill
costs a full rerun and another wait, so it sits at two or three times the
longest real run). `[checks] queue_limit = <minutes>` in harness.toml moves it
for a project (0: none, strict like the other switches), `--limit <minutes>`
for one run (decimals allowed, 0: none, and it applies to a run that holds no
place too: that run has no limit otherwise). A job that is known to run long
passes its own (hundo's Lighthouse job over many guides asks 45). The clock
starts with the command, not with the wait. Past it q sends SIGTERM to the
command and **every process below it as `ps` shows them** (found by parent pid,
not by process group: the command shares q's group, so a group kill would stop
q too, and `detached` would let the command outlive a group kill of q; and a
browser a Playwright script launched, in a group of its own, is still below the
script), SIGKILL after 10 seconds (`GRACE`, `HARNESS_QUEUE_GRACE` for tests) to
the ones still the same processes (the start `ps` gave is kept: a pid reused
meanwhile is left alone), waits up to 10 more seconds for them to go, gives the
place up, and ends with `check: FAILED (timed out after 30min, exit 124)` and
the log's path (124 is timeout(1)'s; the log's last lines print as for any
failure, where it stopped is the best clue to the hang). A `check` that times
out stamps nothing. A run inside a queued command (`HARNESS_QUEUE_HELD`) holds
no place and gets no limit of its own: its holder's covers it, killing its
tree. q stopped by a signal passes it to the command alone, as it always did
(the terminal's Ctrl-C has already reached the whole group, and a runner that
takes a second SIGINT for "force quit" must not get one), then SIGKILLs what is
left of the tree after the same grace (it used to wait for the command forever),
and a second signal kills everything at once. A config with a bad value is said
once (`check: harness.toml: [checks] queue_limit is …: running without the
queue`), not run on in silence. The holder writes its limit into `lock.json` (`limit`, seconds;
an older q's lock has none): a waiter's wedged-holder test is the hour or the
holder's limit and two minutes, whichever is longer, so the takeover stays what
it was (the backstop for a q that cannot stop its command, with the Mac-asleep
caveat above) and a limit above an hour is not pre-empted by it. A waiting
run's line names who holds the place (`hundo's shots in <folder> (pid 4821,
running 52min, limit 30min, 22min past it)`), says where to see the whole line
(`q.ts --queue-status`: the holder and the waiters in order, read and nothing
else, a dead one marked and left to a waiter's own sweep), and says it again
every 5 minutes, shorter, while it waits, so a session reading its own output
sees a stuck holder without `ps`. Not covered: a command that spawns a
process which escapes the tree before the limit (a double fork, reparented to
launchd) is not found; whether Bun's timer counts the time a Mac sleeps was not
checked.

A one-repository project: root = the repository; the repo's name is
`project.name`; the lock's unit (a card's `repos`) is that name. The name need
not be the folder's: `config.ts` exports `repoDir(name)` and `repoName(dir)`,
and every tool (`board.strangers`, `review`, `packet`, `session`, `usage`,
`hooks.target`, `events.repoOf`) and the shell hooks (`pre-commit`,
`_event`, which call `bun config.ts repo-name`) use those two, never
`join(root, name)` or `basename`. Discovery skips the harness source
folder (`[repos] ignore`, default `["harness"]` when it sits under the root). A family:
root = the folder above the repositories. Both are the same code.

## 3. Layout and how a project consumes it

Source repository: `harness/` next to the others (local git only until the
user's go to create GitHub). Same file names as addon-kit's today
(`board.ts`, `q.ts`, …) plus:

```
harness/
  config.ts  root finder, schema, defaults          init.ts  harness init
  sync.ts    copy into a project / --check          doctor.ts
  harness.ts dispatcher: `harness board|q|hooks|…`  githooks/ board.ts q.ts … *.test.ts
  templates/ rules-section.md  settings.json  agents/{reviewer,architect}.md
  docs/      design.md  README.md  (CLAUDE.md for the harness repo itself)
```

**Consumption: a vendored, stamped copy (the kit's pattern).** `harness sync`
copies the tool files and `githooks/` into the project's `[tools] dir`. Each
copy's first line stamps the harness commit it came from; `harness sync
--check` fails on a hand edit (the copy differs from the file at the stamped
sha) and *warns*, never fails, when the harness has moved on (the audit's
incident 1: a check that goes red because a sibling repository moved makes
no tree stampable. Staleness is measured against origin/main once the
harness has a remote, else its local HEAD). Why vendored, not a reference to
the harness folder: CI, a worktree on another disk, another machine and a
clone by someone else all work with nothing but the repository; the cost is
one `sync` and a commit per update, which the family already pays for the
kit.

**`harness init` (one command)**, run from the harness source against a
project: `bun ~/code/wow-addons/harness/init.ts [dir] [--name n] [--check
"<cmd>"] [--dry-run] [--yes]`. It prints what it will write, then, idempotently:

1. detects the shape (root a git repo → one repository; else the child
   repositories) and the check command (package.json `check`, else `test`
   as `bun run test`, else it asks);
2. writes `harness.toml`;
3. vendors the tools into `harness/` (stamped);
4. installs the git hooks in each repository (`hooks install`, chaining a
   husky folder as today);
5. writes `.claude/settings.json` asks (push, release, deploy, GitHub and
   Vercel writes, secrets: merged into an existing file, never replacing a
   key; `templates/settings-asks.json`, tested by `asks.test.ts`) and
   `.claude/agents/{reviewer,architect}.md` with the project's rules file
   named;
6. appends a marked "Harness" section (about 250 words: one task per
   session, the card first, `q` for checks, packet and review before the
   commit) to CLAUDE.md between `<!-- harness:start -->` and `<!-- harness:end -->`
   markers so a later `sync` replaces only that block;
7. adds `.harness/` and `.cache/` to `.gitignore`;
8. prints the first command: `bun harness/board.ts add <repo> "<title>"`.

Nothing is committed by `init`; the user reviews the diff.

**The family becomes a user (changed after the architect's look).** The
harness is vendored into `addon-kit/` *at today's paths*: `[tools] dir =
"addon-kit"`. No shims, no symlink, no moved hooks folder. The generic tool
files in addon-kit (`board.ts`, `q.ts`, `githooks/*`, …) become the stamped
copies, so `bun addon-kit/board.ts …`, `bun ../addon-kit/q.ts …`, every
repository's `core.hooksPath`, `import.meta.dir`, the panel's dynamic imports
(it needs `parseCard`, `holders`, `mayWrite` and the stamp functions as real
exports) and every skill path stay exactly as they are. The family's own
code leaves the generic files and goes into extension modules in addon-kit
(`packet-extras.ts`: the riddle cards; `status-extras.ts`: iCloud builds).
`harness.toml` carries the WoW specifics: the repositories with their checks
(Ravenpost's, wow-locker's), `[groups]`, `[review].waive` (`.toc`, the kit's
copies), `[extensions]`, `[state] board = "board"`, `cache =
".cache/harness"`. The file is versioned in `addon-kit/harness.toml`, and
`~/code/wow-addons/harness.toml` is a one-line pointer to it (`include =
"addon-kit/harness.toml"`): the waivers pre-push enforces must survive a
fresh clone.

What is vendored: the tool files, `githooks/`, nothing else. Not vendored:
tests (they run in `harness/` only, so a project's own `bun test`, lint and
typecheck never see them), and `sync.ts`/`init.ts`/`doctor.ts` (they stay in
`harness/`, named `harness-sync.ts` there to never clash with the kit's
`sync.ts`). Stamp line: line 1 of a `.ts` copy (`// harness@<sha>, a copy:
edit it in harness/`), line 2 of a shell hook, after its `#!/bin/sh`.

## 4. Policies

All four of the audit's "make it a check, not a paragraph" ideas apply here
as defaults, not as code of the family: a policy is a boolean or a regex in
`harness.toml` and the hook enforces it. The family's CLAUDE.md prose about
them is out of scope (the audit's change 5 is its own task).

## 5. Tests and the no-behaviour-change proof

Slice 2 moves the tools and their tests together; the tests are the same
files, run from `harness/`. Slice 3 runs the old `addon-kit` suite against
the vendored files (the same assertions), addon-kit's own `check`, and the checks of
two addons; `board.ts list`, `status.ts --no-fetch` and `hooks.ts status`
output is diffed before and after on the real family (same text, same
exit). The extension hooks are exercised with the family's own extension
modules, lifted verbatim from `packet.ts` and `status.ts`.

## 6. Kept out, and the edges

- **Desktop vs background sessions.** `session.ts`'s `claude --bg` path and
  its registry reads go over as they are, flagged experimental in the
  README (the registry is an undocumented format). `--desktop`, `check
  <local_id>` and the `child` skill (they lean on Claude Desktop's session
  tool) went over too, flagged the same; a project without the desktop
  simply doesn't use them. If this proves too
  tangled in slice 2 the whole of `session.ts` stays out of v1 and is listed
  as not extracted. (Decide when the code is open.)
- **The panel** (`harness-view`) moved into this repository as `pane/` on 1
  November 2026 (it was addon-kit's, frozen by the audit). It reads the
  board, stamps and the event log by path; after slice 3 those paths are the
  same files, so it works unchanged.
- **Skills.** `skills/harness-init` and `skills/child` (1 November 2026: the
  generic `child` moved here from addon-kit, finding the project's tools
  through `config.ts show`; the family's rules for it are `wow-child` in
  addon-kit). The family's other skills are procedures of the WoW work.
- **Platform.** macOS and Linux, bun, git. No Windows (`sh` hooks), as today.
- **License and name.** For the user to choose (below).

## 7. The user's choices

1. **Name** of the thing (folder stays `harness/` as asked). Candidates:
   `harness` (plain), or something with a face. Recommendation: `harness`
   while it is private, rename on publication.
2. **How the family and projects consume it**: vendored stamped copy
   (recommended), a reference by path to the source folder (no copies, breaks
   CI and other machines), or a package installed from GitHub (needs the
   public repository first).
3. **License** (it has no remote yet): MIT as addon-kit (recommended, same
   author, nothing in it is secret), or keep it unlicensed until published.
4. **Board location in a one-repository project**: `.harness/board/` ignored
   by git (recommended: cards are local task state, and worktrees of the same
   clone share it), or committed so the board travels.

## 8. Slices

1. This file. User's approval.
2. Extract into `harness/`: `config.ts` first (root order, `repoDir`,
   `repoName`, include), then events, board, q, hooks and `githooks/`,
   review, packet, each, status, usage, session, each with its tests (same
   assertions; fixtures keep `WOW_ADDONS_ROOT` working through the alias);
   `harness-sync.ts`, `init.ts`, `doctor.ts`. Every path that used
   `import.meta.dir` for state (usage's cache, `--baseline`'s doc, the
   packet's printed `q.ts` path) goes through config. `bun test` green in
   `harness/` after each commit.
3. The family consumes it:
   - 3a: the vendored copy over addon-kit's generic files at today's paths,
     the extension modules, `addon-kit/harness.toml` and the pointer, the
     proofs (old `harness.test.ts` assertions against the vendored files,
     addon-kit's check, two addons' checks, `board.ts list`, `status.ts
     --no-fetch`, `hooks.ts status` diffed before and after).
   - 3b: the hook files last, committed in one go while `board.ts list`
     shows no running card but this one (every repository's hooks folder *is*
     addon-kit's working tree: a half-written `githooks/` refuses someone's
     commit).
4. The trial in a throwaway folder shaped like the geoguessr project
   (`init`, a card, `q check`, a refused trailer, an unstamped push refused,
   a packet and a review). Also a worktree of it, to prove one shared board.
   Nothing real is created.

## 9. Decided (the user, 29 October 2026)

Name `harness`; consumption a vendored, stamped copy; license MIT; a
one-repository project's board in `.harness/board/`, git-ignored. Waiting:
the user's approval of this design before slice 2.
