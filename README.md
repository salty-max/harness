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
- **Planner** (Opus, the tall box on the left): second opinions, eyes that
  didn't write the change, at the family's four moments (CLAUDE.md,
  "Helpers"). Each moment names who it calls (the architect before a plan,
  when the same error comes back, before done; the reviewer before a
  push), a bar of today's Opus calls by moment and their count (◆ once
  called today, ◇ not yet), and its last word: the reviewer's newest
  recorded verdict (its repository, how long ago), the architect's last
  call, or "off in an opus session" (the architect is for a Sonnet
  session: off while Opus builds, unless the settings' model is
  `opusplan`). A running Opus helper lights its moment, its context and
  calls live under it, the box's header saying who is at work. At its foot
  their runs, tokens and time today. Narrower, one line a moment. The
  calls by moment are counted as each starts (`bin/snapshot.ts`,
  `momentOf` in `hooks/format.ts`: the reviewer's is the push, the
  architect's read from its brief).
- **Main session** (dashed): its model, context fill, effort, cost, and the
  helpers running. **Config & limits**: model and mode from the settings,
  the context window, the plan's rate limits as meters (green, amber from
  80%, red from 95%; past 80% the title's mark gives the fullest window
  and when it resets), the ask rules, the subagent model
  (`CLAUDE_CODE_SUBAGENT_MODEL`, else per helper).
- **Gates**: checks fresh (HEAD stamped), reviews current, cards waiting.
- **Helpers**, fanned out from the gates: running ones first, then the
  family's (`.claude/agents/*.md`) and today's, the busiest first (by runs,
  then the latest), the planner's left to it. Each with its model, status,
  its share of today's helper tokens, runs and tokens (or its live context
  and calls).
- **Back to lead** (dashed): the last helper's handback, tokens and time;
  "handing back" while a helper of this session has just finished and the
  shared numbers don't have its figures yet.
- **Sessions**: every session running in the family folder, this one
  among them (below).
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
  findings), else the newest packet in `.cache/review/`. A dot before a
  name says who holds it (`addon-kit/board.ts`'s lock): `●` cyan while a
  running card names it (a session is at work there), `○` amber while
  only cards stopped mid-task do (blocked, or waiting on the user: their
  commits go out with its next push); the header counts the held ones.
- **Sessions**: one row a live session, waiting on you first, then busy,
  then idle: its status (a spinner while busy, amber while it waits on
  you, with what for: "permission prompt"), its title, its main loop's
  last model and its helpers running, its newest open card's status,
  how long since its status changed, and **Open** for a desktop session:
  the press hands the desktop app the session's own link
  (`/usr/bin/open claude://claude.ai/epitaxy/<its desktop id>`; the
  pane's links follow `https:` alone on the desktop, a button's press
  runs anything). This session's row says "this", a terminal one
  "terminal" (no window to bring up from here). Read from Claude Code's
  registry of live sessions, `~/.claude/sessions/<pid>.json` (what its
  agent list and ListAgents read: an internal format, read only, so the
  box says when it can't read it): each file a session's id, folder,
  title, status and desktop id, its fields checked before use, kept if
  its folder is the family's and its process lives (`/bin/ps` in the C
  locale, one call: the start it prints is the one the registry wrote,
  `procStart` in UTC, to two seconds, so a pid reused since is left out).
  Its model and helpers come from today's transcripts: an Agent call is
  open until its result (a background one: until the notice of its end,
  a user row or, mid-turn, a `queued_command` attachment), a helper's
  own calls aside, six hours at most. The Board says "session gone" on a
  running card whose session (an id, as `board.ts` writes it; an older
  card's name matches nothing) isn't live: it still holds its
  repositories until the user moves it. The status line counts the
  other sessions waiting on you.
- **Today**: tokens by model from every transcript under
  `~/.claude/projects/**/*.jsonl` (each assistant message once, by its id,
  local day), with the share of cache reads.
- **Board**: the cards in `~/code/wow-addons/board/*.md`, written by
  `addon-kit/board.ts` and read with its own parser. Waiting and
  ready-to-push cards first, then blocked ones, then running, done cards
  only from today. Each card's repositories (`wow-data+yonder`), its status
  in its colour (waiting on you amber, running cyan, blocked red, done
  green); a blocked card says the repositories it waits for (those of its
  own another session's running card holds; that card is on the board
  too), or "free now" once nothing holds them. The header counts what waits on you,
  what runs and what is blocked.
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
Boxes side by side stand two columns apart, stacked ones a row apart,
except where a line of the diagram joins them.

**Motion.** Spinners, figures, a new line's blink and the live beat are
`hooks/motion.tsx`, a `Client` surface module drawn on the drawing thread
(about twelve frames a second, an instance drawn again only when it looks
different). On the desktop, the bars and the diagram's lines are vector
(`hooks/vector.ts`, an `Svg` the page draws as an image, SMIL for the
motion: Chromium runs it in an image, where the engine's `SvgProps` promises
it only in an `isInteractive` frame, seen with headless Chrome at several
moments of `--virtual-time-budget`); in the terminal they are characters
the motion module lights, in the editor and the phone characters standing
still (no `Client` there, and only the desktop's renderer was read). The
pane itself redraws only when a number moved. It moves when work does:

- a pulse runs down the diagram's lines while the main session's turn runs
  (session → gates), on out along the fan-out to the running helpers'
  boxes alone while one runs (the lines to the idle ones stay dark), and
  back from a helper's box to the lead once it is done, for six seconds
  (`HANDBACK_MS`: a helper of this session seen running, then not, and a
  `$.clock.after` that turns it off); never back before one is done, back
  and out at once when one is done and others still run. A dot on the
  desktop, the line's heavy strokes in the terminal; the planner's arrow
  while an Opus helper runs. Only the lines that are on make up the
  pulse's cycle. On the desktop each line's pulse starts at the wall
  clock's phase of its cycle, so a redraw doesn't make it jump;
- a box at work wears a running border: the main session's while its turn
  runs, the gates' while work flows through them (the turn, or a helper),
  a helper's while it runs, the planner's while an Opus helper does, the
  lead's while a handback comes in.
  On the desktop every box's border is four vector edges (rounded strips
  top and bottom cut to the box's width, sides the row stretches to its
  height, the main session's dashed), standing still at rest; at work they
  breathe brighter and fainter while a comet laps them, top, right, bottom,
  left, on the wall clock's phase. One frame at rest and at work, so a box
  keeps its size as work starts (measured: `HARNESS_PAINT_IDLE=1` paints
  the pane at rest beside the busy one); in the terminal the box keeps
  the terminal's own border, dimmed at work, and its top and bottom edges
  are laid over it (`edgeText`, on a plain Box at top 0 and bottom 0), a
  comet on each, a bold heavy head and a heavy tail of four: the top's
  left to right, the bottom's right to left, so the pair turns the box
  round, a cell a frame, then a pause as long as the sides. The motion
  module draws them: the pane doesn't redraw for them (it did every 450 ms
  for the beat that blinked the whole border before, 21 October 2026);
- the spinners (braille) turn while what they stand for works: the gates
  and the session in a turn, a helper while it runs, the planner while an
  Opus helper runs;
- bars and figures (Today, the context, the gates' meters, the helpers'
  shares, the planner's runs and tokens) roll to a new value in half a
  second, and up from nothing as the pane opens;
- a new log line blinks its mark for six seconds;
- the live beat in the log's header pulses always, and the header counts
  the seconds since the numbers last changed.

Idle, everything else stands still. The editor and the phone draw no
`Client`: the same parts stand still there.

What the pane can't draw: no pixels (bars and meters are block
characters, an eighth of a cell at best), no charts or trends, no
background of its own (the mock-up's navy is the app's background here),
connectors only as text between boxes in the terminal, no smooth motion
there (a frame is a cell's change, twelve a second). The desktop's paint of borders
(dashed among them), colours and the `Client` regions is the desktop page's
own and was checked in tests only: the terminal's was seen (a `claude
--plugin-dir` session, and the whole pane painted with Ink, the motion's
regions mid-pulse included), the desktop app can't be captured from here. A prompt shows in the log once answered. Helpers, prompts and
their day totals are today's only.

The status line under the prompt (`$.ui.status`) says what claude-hud does
not: cards waiting, agents running, repositories a push of HEAD would pass,
today's tokens by model family. One line, beside claude-hud, which is left
untouched. `/harness` opens the pane again once closed.

The mod stays silent in a session whose project root is outside
`~/code/wow-addons` (or `WOW_ADDONS_ROOT`), and reads nothing in a run
that draws nowhere (`claude -p`) until a surface attaches. The root is read
again when a surface attaches and at each prompt, not only at the start:
the desktop starts a session in a spare folder of its own
(`~/.claude/spares/`) and moves it to the folder picked afterwards, with no
new start, so `/harness` and the pane come with the first prompt there.

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
The mod runs it through `$.process.run` every 2 seconds while the pane is
shown (`$.ui.panes()`: open and in front), every 30 seconds otherwise for
the status line; a snapshot under 2 seconds old is shared by every open
session through `~/.cache/harness-view/snapshot.json`. Each second it stats
the event log and the board's folder: a line there (a check, a review, a
card, a hook's refusal) reads every number anew at once (`--fresh`, the
repositories' rows too: a stamp or a verdict rewritten in place moves no
mark), so it shows within a second of its tool writing it. Refresh does the
same. A read that changed nothing but its own time draws nothing again; the
ages (12m, 3h) are drawn again every half minute while the pane is shown.
The session's own facts come from `$` every second, at each model call and
at the turn's start and end.

Most of a read's time is the repositories (git, the stamps: 0.85 s for
eleven). Their rows are kept in `~/.cache/harness-view/repos.json` and read
again only when one moved (HEAD, its log, the index, `.git/harness`, q's
log, a packet) or after 20 seconds, for edits in a working tree: a read
with nothing moved takes 0.04 s. Transcripts are read incrementally:
offsets, seen ids, the Bash calls waiting for an answer and the day's
events in `~/.cache/harness-view/usage-<day>.json` (a cache of an older
version is read again whole).

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

The tests hold the tree to each surface's elements, never the paint. Four
ways to look before calling a visual change done (the desktop app itself
can't be captured from a session):

- The terminal in motion: `zsh bin/terminal-paint.sh [from to step]` runs a
  claude session with this mod (`--plugin-dir`) in a pty in the family
  folder, `/harness`, one prompt that needs no tool (a turn runs, a few
  cents), rebuilds its screen frame by frame with pyte (a venv in `.cache/`;
  pyte drops faint, kept here) and screenshots the pane's columns at each
  moment with headless Chrome: `.cache/paint/terminal.png`, and every frame
  as text in `terminal.txt` to measure columns and steps (`22 22.8 0.08`:
  each 80 ms frame). The file tree's pane is turned off for that session.
  It is a real session: run from a terminal, its turn lands in
  `~/.claude/projects` and in the pane's Today (from inside a session it
  saves no transcript), and it shows in the Sessions box while it runs. It
  caught the beat's blink, which a still can't.

- The desktop's paint: `zsh bin/desktop-paint.sh` mounts the pane on the
  desktop surface (this machine's last snapshot, mid-turn, a helper
  running), turns the trees into HTML by the desktop renderer's own rules
  (`bin/desktop-paint.ts`) and screenshots 110, 80 and 48 columns with
  headless Chrome into `.cache/paint/` (`HARNESS_PAINT_IDLE=1` at rest,
  `HARNESS_PAINT_AGENT=reviewer` with an Opus helper at work). Its design tokens (padding, radius,
  fonts) are guesses; the layout is the page's. Look at it after any change
  to the drawing: the desktop was broken where the terminal was fine.
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

**The desktop's paint** (its renderer read from the page's cached bundle,
20 October 2026). Box is a flex `div`, Text a `span`:

- widths are `ch` of the page's proportional font; vertical margins, padding
  and gaps are half a line each (a `Client`'s inside: a whole line); a
  bordered Box adds the design system's padding;
- a Text with `wrap="truncate-end"` is an ellipsed inline-block, any other a
  wrapping span, even inside a cut one: the pane's `Text` cuts by default,
  and styled runs are texts side by side (`runs()`), never nested (a run
  inside a text sits off the baseline);
- a shrinking Box needs `minWidth={0}`, or its text won't let it shrink;
- a centred column takes its widest line's width, uncut: a centred box's
  lines sit on a `width="100%"` layer, and `<>` won't do, the engine makes
  a fragment a column Box of its own;
- block characters are wider than a cell (bars overflow): bars and lines
  are `Svg` there, an image the page cuts to its cell;
- every surface's element table names every element (the missing ones draw
  nothing): `Client` and `Svg` are chosen by `e.surface`.
