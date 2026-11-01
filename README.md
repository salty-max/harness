# harness-view

Piece D of the family's harness (`addon-kit/docs/harness.md`): a live pane
and one status line showing the harness at work. A Claude Code mod (function
hooks), no router, nothing sent anywhere.

## Projects

The pane reads one or more projects (2 November 2026): the family folder
and standalone repositories with their own harness, today
`~/code/warcraft-puzzles`. `bin/snapshot.ts` resolves the folders (`resolveRoots`),
the family first, whatever the order named:

1. `--root <dir>` (repeat it), else
2. `HARNESS_ROOTS`, colon-separated, else
3. `~/.config/wow-addons/harness-roots`, one folder a line (`#` comments, `~`), else
4. the family (`WOW_ADDONS_ROOT` or `~/code/wow-addons`) and, when nothing
   named the family and the folder is a repository, `~/code/warcraft-puzzles`.
   A `WOW_ADDONS_ROOT` is the family alone.

A **family** root (it has `addon-kit/q.ts`) is a folder of repositories: its
tools are `addon-kit/`, its board `board/`, its log
`.cache/harness/events.log`. Any other root is **one repository**, the root
itself (a row named as the folder), its tools, board and log where its
`harness.toml` says (`[tools] dir`, default `harness`; `[state] dir`, `board`,
`cache`, default `.harness`, `.harness/board`, `.harness/cache/events.log`).
Its q.ts and board.ts must export the readers the pane needs, else the rows
fall back to HEAD alone and the plain card parser. The repository names are
the pane's keys: two projects never share one.

Every row of the snapshot (repository, card, event, session, gate, lock,
slip) carries its `project`; `projects` lists them when there are several.
What the pane draws of it: the title (`HARNESS · WOW-ADDONS + WARCRAFT-PUZZLES`),
`SESSIONS · 5 live in 2 projects`, and a session of another project than
the family's is prefixed with it. The rest is one list across projects (the
gates, the board, the repositories, the log): a standalone project's repository
and its cards already say its name. Each project's lock is its own board's.
The family's own parts (the kit, the addons) are the family's repositories
and appear as before; nothing in the pane is drawn for a project that
has no such thing. Each read keeps the folders in `~/.cache/harness-view/roots.json`
(`snapshot.ts --roots` prints them too): the mod reads it with `cat` to know which
sessions show the pane and which logs and boards to watch, so a session outside
every project starts no bun. A root added during the day makes that day's
transcripts read again (the cache is keyed by the roots).

## What it shows

The flow diagram of the mock-up the user shared (an "opusplan" dashboard in
a video, 20 October 2026), drawn in text with this family's numbers. Boxes
in each model's colour (Opus lavender, Sonnet orange, Haiku blue, the gates
green), the main session's boxes dashed, connectors and arrows between
them, bars of block characters with a checkered rest, statuses ok green,
waiting amber, failed red. The mock-up's "JEV router" is not ours: its place
holds the gates, the part of the harness that runs in code.

- **Header** (no box, a rule under it, 25 October 2026): the harness's
  name, when the numbers last changed and Refresh, then the plan's rate
  limits as meters (green, amber from 80%, red from 95%), each with its
  reset; past 80% the title names the fullest window (`· seven day at
  86%`). They stack where they don't fit side by side (a bar of 8 at
  least), and under 64 columns, named `5h` and `7d`. The
  settings' model, mode, context window, ask rules and subagent model were
  rows of a box until 25 October 2026: the settings are one file away.
- **Main session** (dashed, its model's colour), laid out as the other
  boxes: `PLANNING` or `BUILDING` and the model of its last call, the
  session's title after it (cut first), its state on the right (idle,
  working, the helpers running); the context as a meter to the box's
  edge; the effort, and the cost on the right (the state on a line of its
  own under 64 columns). The phase is the
  transcript's permission mode, the last one its transcript records
  (`bin/snapshot.ts`): a `permission-mode` row (written again most turns),
  or the `permissionMode` field of a main-loop user record, whichever comes
  last; a mode naming `plan` is planning, anything else building. A
  `claude -p --permission-mode plan` probe (25 October 2026) wrote no row,
  only `"permissionMode":"plan"` on its user record, hence both.
  Interactive plan mode (Shift+Tab, opusplan) has not been caught in a
  transcript yet: it is read from the same row and field, the one
  inference left. Under the settings' `opusplan` a session planning on
  another model than Opus says `WANT OPUS` in red (`stance` in
  `hooks/format.ts`). Building on Opus is not flagged, the plain model is
  there to read: the settings can't tell a code session meant for Sonnet
  from a prose one meant for Opus (`--model opus` never reaches them).
  Until 25 October 2026 the phase sat in the header and the box was
  narrower than the rest.
- **Gates**: what waits to be pushed (the repositories with commits their
  upstream lacks, or no remote has on a branch never pushed, `to push 6`): how many of them are stamped (`fresh`,
  pre-push lets them through) and reviewed (`current`, a verdict on HEAD
  whose reviewer read all the push sends: its packet's base already on the
  upstream and its tip not yet, the commits after the tip its findings'
  fixes),
  amber while one isn't; with nothing to push the box is its title and
  `nothing to push`, no meters. At work only while a
  q.ts run goes on, in any session, the run named under the meters (`q
  check · yonder`, `+1` for more).
- **Helpers**, fanned out from the gates (up to four from 100 columns,
  three from 66): running ones first, then the family's that worked today,
  the busiest first (by runs, then the latest), the Opus ones (the
  reviewer, the architect) among them; a helper that never ran today isn't
  drawn. Each with its model, status, runs and tokens (or its live context
  and calls). A running Opus helper says the moment it was called at
  beside its name (`reviewer · before a push`: `momentOf` in
  `hooks/format.ts`, the reviewer's the push, the architect's read from
  its brief). A run is summed as it ends: its result for a helper in the
  foreground, the notice of its end (`<task-notification>`: status,
  tokens, time) for one in the background, which every helper is now (its
  result only says `async_launched`; until 25 October 2026 those were
  never summed and the fan-out stayed empty). Not summed: a helper
  resumed after its first notice (SendMessage: the call is closed by then,
  and the end's event is once a call) and a run that ended before the day
  began (a call open at midnight stays open, its end counts in the new day, when the day before was read). With none running or
  worked, and nothing handing back, the diagram ends at the gates.
  The planner, a tall Opus box of today's calls by moment, went on 25
  October 2026: two of its four moments were nearly always 0, and its one
  live part, an Opus helper at work, is what the fan-out draws.
- **Back to lead** (dashed, one row): the last helper's handback, tokens and time;
  "handing back" while a helper of this session has just finished and the
  shared numbers don't have its figures yet. Drawn with the helpers only.
- **Repositories**: each family repository's newest check stamp
  (`.git/harness/check-<tree>`, read through `addon-kit/q.ts`) and review.
  `✓ 12m`: HEAD's tree is stamped, so a push of HEAD passes pre-push.
  `✓ 12m +edits`: the same, with edits made after the check. `◐ 12m commit`:
  the working directory as it is was checked but not committed yet.
  `· 2d old`: the last check was on something else. `✗ 3m exit 1`: the
  last check run (q.ts's `.cache/logs/check.log`) failed after the newest
  stamp. The review is HEAD's verdict, else the newest, as
  `addon-kit/review.ts` records it in `.git/harness/review-<sha>` (its
  first line, the `verdict:` prefix dropped; green when clean, amber with
  findings), else the newest packet in `.cache/review/`. Said before it,
  why it doesn't count: `older` (on another commit), and where something
  waits to be pushed, `partial` (its packet's range starts after the
  upstream, or ended with an earlier push: the push sends commits its
  reviewer didn't read) or `no packet` (no range recorded with it). A dot before a
  name says who holds it (`addon-kit/board.ts`'s lock): `●` cyan while a
  running card names it (a session is at work there), `○` amber while
  only cards stopped mid-task do (blocked, or waiting on the user: their
  commits go out with its next push); the header counts the held ones.
  A quiet repository (stamped with no edits since, nothing to push, not held, no failed
  check) isn't a row: "12 more stamped, nothing to push".
- **Sessions**: one row a live session, waiting on you first, then busy,
  then idle: its status (a spinner while busy, amber while it waits on
  you, with what for: "permission prompt"), its title, its main loop's
  last model with `plan` or `build` before it (the mode its transcript
  last recorded) and its helpers running, its newest open card's status (else its newest done one, dim),
  how long since its status changed, and **Open** for a desktop session:
  the press hands the desktop app the session's own link
  (`/usr/bin/open claude://claude.ai/epitaxy/<its desktop id>`; the
  pane's links follow `https:` alone on the desktop, a button's press
  runs anything). This session's row says "this", a terminal one
  "terminal" (no window to bring up from here), a background one (`claude
  --bg`, addon-kit's `session.ts`; the registry's `kind: "bg"`) "bg":
  `claude attach` joins it by its name. Read from Claude Code's
  registry of live sessions, `~/.claude/sessions/<pid>.json` (what its
  agent list and ListAgents read: an internal format, read only, so the
  box says when it can't read it): each file a session's id, folder,
  title, status and desktop id, its fields checked before use, kept if
  its folder is the family's and its process lives (`/bin/ps` in the C
  locale, one call: the start it prints is the one the registry wrote,
  `procStart` in UTC, to two seconds, so a pid reused since is left out).
  A session that used skills today has a second line under its row, a dim label and the names in violet:
  `skills child (typed), wow-releasing ×2` (see "Skills" below).
  Its model, skills and helpers come from its transcript, whatever the day (the day's cache starts from the one before, 26 October 2026, so a session past midnight keeps them): an Agent call is
  open until its result (a background one: until the notice of its end,
  a user row or, mid-turn, a `queued_command` attachment), a helper's
  own calls aside, six hours at most. The Board says "session gone" on a
  running card whose session (an id, as `board.ts` writes it; an older
  card's name matches nothing) isn't live: it still holds its
  repositories until the user moves it. The status line counts the
  other sessions waiting on you.
  Under a session's row sit the sessions it opened (26 October 2026), each
  indented behind `└`: from `addon-kit/session.ts`'s records
  (`.cache/harness/opened/<short id>.json`: the short id starts the child's
  session id, the record names its opener), else the desktop's own file of
  the session (`~/Library/Application Support/Claude/claude-code-sessions/
  <account>/<org>/<local id>.json`, an internal format, read only, its
  `spawnedFrom.sessionId` kept in `~/.cache/harness-view/spawned.json`). A
  child whose opener isn't live stands alone.
- **Locks** (26 October 2026): who works where, by the board's own lock. The
  snapshot's `locks` (`readLocks` in `bin/snapshot.ts`) are `board.ts`'s
  `holders`, not a copy of its rules: per repository the session whose
  running card came first (cyan, `(session gone)` when it isn't live: it
  still holds), the other sessions' running cards after it (`then …`, red:
  told to wait), and the cards stopped mid-task there (`stopped …`, amber:
  blocked, or waiting on the user). A session's own later cards hold with it
  and are not queued. One row per held repository, the others (stopped cards
  only) folded into one line. Without `board.ts` there is no `locks`: the
  box says so and the Repositories' dots remain. **Off the lock** (red
  `⚠`): the snapshot's `slips`, a session that wrote lately (20 minutes) in
  a repository where `board.ts`'s `mayWrite` refuses it, its words kept: no
  running card of its own names it, or another session's came to hold it
  first. A write is an Edit, Write or NotebookEdit call in the transcripts
  under a family repository (a helper's rows carry its session's id, so a
  builder sent into a held repository is its session's slip). Not a dirty
  tree: that can't say who wrote it.
- **Today**: tokens by model from every transcript under
  `~/.claude/projects/**/*.jsonl` (each assistant message once, by its id,
  local day), with the share of cache reads. It counts on its own, not
  through `addon-kit/usage.ts` (25 October 2026): usage.ts answers what a
  card or a commit cost, in dollars, from one session's transcripts and
  too slow to run each two seconds; this is a live figure by model. Both
  read the same transcripts and count each message once by its id.
- **Board**: the cards in `~/code/wow-addons/board/*.md` (and each other project's board), written by
  `addon-kit/board.ts` and read with its own parser. Waiting and
  ready-to-push cards first, then blocked ones, then running, done cards
  only the newest three (the rest a count). Each card's repositories (`wow-data+yonder`), its status
  in its colour (waiting on you amber, running cyan, blocked red, done
  green); a blocked card says the repositories it waits for (those of its
  own another session's running card holds; that card is on the board
  too), or "free now" once nothing holds them. The header counts what waits on you,
  what runs and what is blocked.
- **Session log**: the last 6 events of today, or of the last 12 hours until midday (just after midnight it isn't blank), newest first: the time, the
  source in its colour (a helper as `opus:reviewer`), the repository and
  what happened, a figure on the right in its status's colour (stamped,
  failed, spawn, 86k tok, allowed).
  - `check` (or a q.ts run of another name): the verdict line and the
    stamp, written by `addon-kit/q.ts`;
  - `hook`: a git hook refusing a commit or a push (`githooks/_event`);
  - `review`: a verdict recorded by `review.ts`;
  - `board`: a card added or moved to another status (`board.ts`);
  - `skill`: a skill used, in violet: `child loaded` (the session called the
    `Skill` tool) or `wow-releasing typed` (the user typed `/wow-releasing`),
    so a skill that was meant to run can be seen running (see "Skills");
  - `helper`: a helper starting and finishing, in its model's colour, with
    its model, tokens and time (the Agent call and its result in the
    transcripts of sessions in the family folder);
  - `ask`: a push or release prompt the user answered, allowed or refused
    (a Bash result whose `permissionDecision` came from the user).

  The tools append to `~/code/wow-addons/.cache/harness/events.log`
  (`addon-kit/events.ts`; `HARNESS_EVENTS` names another file, `off`
  none); the transcripts' events are read with the usage, incrementally.
  Beside the log, `running/<pid>.json` is a q.ts run going on (written
  as it starts, removed before its verdict is logged): the snapshot's
  `gates`, those whose process lives and started no later than the run.

### Skills

To be sure a skill is actually used, not only installed. Two traces in a
transcript, both read with the usage: a `Skill` tool call (`input.skill`:
the session loaded it itself, `by: session`), and a user row holding
`<command-name>/name</command-name>` (the user typed it, `by: user`). Each
is one `skill` line in the log and one entry in its session's list (once a
name and starter, with a count). A typed command counts only when `name` is
a folder holding a `SKILL.md` in `~/.claude/skills/` or the family folder's
`.claude/skills/`, so `/model` or `/harness` stay out.

What it can't see: a skill whose `SKILL.md` was read with Read or cat
(the instructions were seen, nothing was loaded: no trace, no line); a
plugin's skill typed as `/plugin:skill` (not in those folders: loaded by the
session it shows, typed it doesn't); a skill the instructions were followed
from memory without loading; a skill a helper loaded (its rows are a
sidechain): a log line, but not on its session's list, which says what the
session itself used. And a line says a skill was loaded, never that
its steps were followed.

Every box of the diagram is the pane's width, one column at every width
(the mock-up's three columns, then two, until 25 October 2026); the width
decides only the header's limits (side by side from 64), the helpers'
count, Today beside the Board from 80 and the repositories' two columns
from 96. Every column truncates rather than wraps.
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
  desktop, the line's heavy strokes in the terminal. Only the lines that are on make up the
  pulse's cycle. On the desktop each line's pulse starts at the wall
  clock's phase of its cycle, so a redraw doesn't make it jump;
- a box at work wears a running border: the main session's while its turn
  runs, the gates' while a q.ts run goes on (the turn's pulse comes down
  to them all the same, but a turn or a helper isn't theirs),
  a helper's while it runs, the
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
  while a q.ts run goes on, the session in a turn, a helper while it runs;
- bars and figures (Today, the context, the gates' meters, the helpers'
  shares) roll to a new value in half a
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
their day totals are today's only (the tokens, the helpers' runs: the rows and the log are not).

The status line under the prompt (`$.ui.status`) says what claude-hud does
not: this session's phase and model first (`planning opus 5.5`, `building
sonnet 5.5`, `(want opus)` after a wrong one), then cards waiting, agents running, the repositories with something to
push that are ready (stamped and reviewed, `ready to push 0/6`; nothing
when none waits), today's tokens by model family. One line, beside claude-hud, which is left
untouched. `/harness` opens the pane again once closed.

The mod stays silent in a session whose project root is outside
`~/code/wow-addons` (or `WOW_ADDONS_ROOT`) and every other project above, and reads nothing in a run
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
the event log, the runs' folder beside it and the board's folder: a line
there (a check, a review, a card, a hook's refusal, a run starting or
ending) reads every number anew at once (`--fresh`, the
repositories' rows too: a stamp or a verdict rewritten in place moves no
mark), so it shows within a second of its tool writing it. Refresh does the
same. A read that changed nothing but its own time draws nothing again; the
ages (12m, 3h) are drawn again every half minute while the pane is shown.
The session's own facts come from `$` every second, at each model call and
at the turn's start and end.

Most of a read's time is the repositories (git, the stamps: 0.85 s for
eleven). Their rows are kept in `~/.cache/harness-view/repos.json` and read
again only when one moved (HEAD, its log, the index, the upstream's log
on a push or a fetch, `.git/harness`, q's log, a packet) or after 20
seconds, for edits in a working tree: a read with nothing moved takes
0.04 s. Transcripts are read incrementally:
offsets, seen ids, the Bash calls waiting for an answer and the day's
events in `~/.cache/harness-view/usage-<day>.json` (a cache of an older
version is read again whole). A new day's cache starts from the newest older one of this version (its file offsets, events, sessions' skills and open helpers, pending calls and ids known), and keeps the figures of the day alone (tokens, helpers' day) fresh; events are read from an hour before the day starts, once by their ids. events.log's times are UTC and read as instants: "today" is the local day.

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
