# harness-view

Piece D of the family's harness (`addon-kit/docs/harness.md`): a live pane
and one status line showing the harness at work. A Claude Code mod (function
hooks), no router, nothing sent anywhere.

## What it shows

A dashboard of text, after the mock-up the user shared: each section a
rounded box in its own colour, its title a coloured label on the top
border; per-model bars of block characters (eighths of a cell) with the
numbers beside them; Opus purple, Sonnet orange, Haiku blue; statuses ok
green, waiting amber, failed red. Top to bottom:

- **Session**: the model, the last call's model when it differs (opusplan),
  the context window's fill, the session's cost.
- **Subagents**: every agent the engine lists, with the model, its status
  (running amber, done green, failed red), context and output tokens
  counted from its own model calls as they stream.
- **Board**: the cards in `~/code/wow-addons/board/*.md`, written by
  `addon-kit/board.ts` and read with its own parser (the first line under
  `## Try` as summary, else the lead before any section). Waiting and ready-to-push cards
  first, done cards only from today.
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
- **Board**: as above, under Today (the mock-up's order).
- **Log**: today's last 10 events, newest first: the time, the source in
  its colour, the repository, what happened in its status's colour.
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

What the pane can't draw: no pixels (bars and the context fill are block
characters, so a bar's last cell is an eighth at best), no charts or
trends, no border title of its own (the label is a Box placed over the
border row). The desktop's paint of borders, background colours and the
placed label is the desktop page's own and was checked in tests only, not
by eye: the terminal's was seen (a `claude --plugin-dir` session), the
desktop app can't be captured from here. A prompt shows in the log once
answered: the transcript records the answer, not the prompt. Helpers and
prompts are today's only (the transcripts are read by day).

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
