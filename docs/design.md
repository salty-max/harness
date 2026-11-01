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
`glossary.py`, `subzones.py`, `coldread.ts` (languages), all `wow-*` skills,
the `child` skill (it carries the desktop path), `data-scout`, `prose-reader`,
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
lock      = true                  # pre-commit: a Claude session's commit wants its running card
stamp     = true                  # pre-push: a passing check on the tree
review    = true                  # pre-push backstop: a recorded review (review.ts --push)

[review]
waive = ['^docs/', '(^|/)(README|CLAUDE)\.md$']   # files a push may carry unreviewed
                                                    # (the family adds .toc and the kit's copies)
[extensions]                      # module paths from the root, each optional
# packet = "addon-kit/packet-extras.ts"   # export extras(ctx): string[] (lines for the packet)
# status = "addon-kit/status-extras.ts"   # export columns(repo): { label, value }[]

[session]                         # session.ts
rules  = "CLAUDE.md"              # what a child reads first
models = { code = "opusplan", prose = "opus" }
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
5. writes `.claude/settings.json` asks (push, release, deploy, secrets:
   merged into an existing file, never replacing a key) and
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
  tool) stay in addon-kit, which wraps the harness's session module; a
  project without the desktop simply doesn't use them. If this proves too
  tangled in slice 2 the whole of `session.ts` stays out of v1 and is listed
  as not extracted. (Decide when the code is open.)
- **The panel** (`harness-view`) moved into this repository as `pane/` on 1
  November 2026 (it was addon-kit's, frozen by the audit). It reads the
  board, stamps and the event log by path; after slice 3 those paths are the
  same files, so it works unchanged.
- **Skills.** The harness ships no skills in v1 (the family's are procedures
  of the WoW work). A generic `child` skill can come later from the desktop
  split above.
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
