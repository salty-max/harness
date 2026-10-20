# harness-view

Piece D of the family's harness (`addon-kit/docs/harness.md`): a live pane
and one status line showing the harness at work. A Claude Code mod (function
hooks), no router, nothing sent anywhere.

## What it shows

The flow diagram of the mock-up the user shared (an "opusplan" dashboard in
a video, 20 October 2026), drawn in text with this family's numbers. Boxes
in each model's colour (Opus lavender, Sonnet orange, Haiku blue, the gates
green), the main session's boxes dashed, connectors and arrows between
them, bars of block characters with a checkered rest, statuses ok green,
waiting amber, failed red. The mock-up's "JEV router" is not ours: its place
holds the gates, the part of the harness that runs in code.

- **Header**: the harness, the planner's model, the model building now
  (the last call's: opusplan's Sonnet), a legend of the colours.
- **Planner** (Opus, the tall box on the left): the Opus helpers at their
  moments: the architect before a plan, when the same error comes back,
  before a big change is done, the reviewer before a push (its last
  verdict). The moment a running Opus helper is at is lit. Their runs and
  tokens today, the main session's context.
- **Main session** (dashed): its model, context fill, effort, cost, and the
  helpers running. **Config & limits**: model and mode from the settings,
  the context window, the plan's rate limits (percent used), the ask rules,
  the subagent model (`CLAUDE_CODE_SUBAGENT_MODEL`, else per helper).
- **Gates**: checks fresh (HEAD stamped), reviews current, cards waiting.
- **Helpers**, fanned out from the hand-off: running ones first, then the
  family's (`.claude/agents/*.md`) and today's, the busiest first (by runs,
  then the latest), the planner's left to it. Each with its model, status,
  its share of today's helper tokens, runs and tokens (or its live context
  and calls).
- **Back to lead** (dashed): the last helper's handback, tokens and time.
- **Today**, **Board**: tokens by model, the board's cards (below).
- **Repositories**: each family repository's newest check stamp
  (`.git/harness/check-<tree>`, read through `addon-kit/q.ts`) and review.
  `✓ 12m`: HEAD's tree is stamped, so a push of HEAD passes pre-push.
  `✓ 12m +edits`: the same, with edits made after the check. `◐ 12m commit`:
  the working directory as it is was checked but not committed yet.
  `· 2d old`: the last check was on something else. `✗ 3m exit 1`: the
  last check run (q.ts's `.cache/logs/check.log`) failed after the newest
  stamp. The review is the
  verdict `addon-kit/review.ts` records as `.git/harness/review-<sha>` (its
  first line, the `verdict:` prefix dropped; green when clean, amber with
  findings), else the newest packet in `.cache/review/`.
- **Today**: tokens by model from every transcript under
  `~/.claude/projects/**/*.jsonl` (each assistant message once, by its id,
  local day), with the share of cache reads.
- **Board**: the cards in `~/code/wow-addons/board/*.md`, written by
  `addon-kit/board.ts` and read with its own parser. Waiting and
  ready-to-push cards first, done cards only from today.
- **Session log**: today's last 10 events, newest first: the time, the
  source in its colour (a helper as `opus:reviewer`), the repository and
  what happened, a figure on the right in its status's colour (stamped,
  failed, spawn, 86k tok, allowed). Under it the prompt line and a status
  bar: helpers active, Opus runs, gates, cards waiting, today's tokens.
  - `check` (or a q.ts run of another name): the verdict line and the
    stamp, written by `addon-kit/q.ts`;
  - `hook`: a git hook refusing a commit or a push (`githooks/_event`);
  - `review`: a verdict recorded by `review.ts`;
  - `board`: a card added or moved to another status (`board.ts`);
  - `helper`: a helper starting and finishing, in its model's colour, with
    its model, tokens and time (the Agent call and its result in the
    transcripts of sessions in the family folder);
  - `ask`: a push or release prompt the user answered, allowed or refused
    (a Bash result whose `permissionDecision` came from the user).

  The tools append to `~/code/wow-addons/.cache/harness/events.log`
  (`addon-kit/events.ts`; `HARNESS_EVENTS` names another file, `off`
  none); the transcripts' events are read with the usage, incrementally.

The layout follows the pane's width: the mock-up's three columns from 96
columns, two from 64, one below; every column truncates rather than wraps.
The spinners turn once a second while a helper runs, and stand still
otherwise.

What the pane can't draw: no pixels (bars and meters are block
characters, an eighth of a cell at best), no charts or trends, no
background of its own (the mock-up's navy is the app's background here),
connectors only as text between boxes. The desktop's paint of borders
(dashed among them) and colours is the desktop page's own and was checked
in tests only: the terminal's was seen (a `claude --plugin-dir` session,
and the whole pane painted with Ink), the desktop app can't be captured
from here. A prompt shows in the log once answered. Helpers, prompts and
their day totals are today's only.

The status line under the prompt (`$.ui.status`) says what claude-hud does
not: cards waiting, agents running, repositories a push of HEAD would pass,
today's tokens by model family. One line, beside claude-hud, which is left
untouched. `/harness` opens the pane again once closed.

The mod stays silent in a session whose project root is outside
`~/code/wow-addons` (or `WOW_ADDONS_ROOT`), and reads nothing in a run
that draws nowhere (`claude -p`) until a surface attaches.

## Where it loads from

`~/.claude/skills/harness-view` is a link to this folder, `addon-kit/harness-view`
(the user's pick, 20 October 2026; moved from the root's `.claude/mods/` into
addon-kit in E, for commits and checks): Claude Code adopts a plugin from the
user's skills folder, never from a project's `.claude/skills`. Edits here
reach each new session. A fresh machine links it again:

```bash
ln -sfn ~/code/wow-addons/addon-kit/harness-view ~/.claude/skills/harness-view
```

## How it works

`bin/snapshot.ts` (Bun) reads the shared numbers and the events and prints one JSON object.
The mod runs it every 30 seconds through `$.process.run` (Refresh reads
anew; otherwise a snapshot under 15 seconds old is shared by every open
session through `~/.cache/harness-view/snapshot.json`) and reads the
session's own facts from `$` every 5 seconds and after each model call.
Transcripts are read incrementally: offsets, seen ids, the Bash calls
waiting for an answer and the day's events in
`~/.cache/harness-view/usage-<day>.json` (a cache of an older version is
read again whole).

## Checks

All three run in addon-kit's `bun run check` (`bun test` there leaves out
`hooks/`, whose tests need Claude Code's own runtime):

```bash
bun test bin/
```

```bash
claude plugin test .
```

```bash
claude plugin validate .
```

## Seeing the paint

The tests hold the tree to each surface's elements, never the paint. Two
ways to look before calling a visual change done (the desktop app itself
can't be captured from a session):

- Claude Code's own terminal renderer: from `~/code/wow-addons`, run
  `claude --no-chrome --plugin-dir <this folder> /harness` in a terminal
  tab and read the screen. It is text only, the inline pane shows its top,
  and it reloads on edits. It caught what the next way can't: a Box placed
  at `top={-1}` inside a bordered Box isn't drawn.
- The whole pane in colour: print `await ui.drawn()` from a throwaway
  `*.test.tsx` that mounts the Pane with a real snapshot, paint the tree
  with upstream Ink in a scratch folder, and screenshot it with headless
  Chrome. Upstream Ink ignores `top`/`left` and the `dashed` style (map it
  to a custom border).

Fixed columns are `flexShrink={0}` with widths from `fit()`: `flexShrink`
on them breaks alignment as soon as a row's last text is long. A fragment
holds no array or `null` in this API: wrap a `.map` in a column Box.
