# harness

The standalone harness (README.md). Local git only until the user's go; MIT.
In the WoW family it sits beside the other repositories and `addon-kit/`
carries its stamped copy at today's paths; any other project takes a copy
with `bun init.ts <project>`.

## Where things are

| What | Where |
|---|---|
| The design and the decisions | `docs/design.md` |
| The config and the root finder (every tool reads it) | `config.ts` |
| The tools | `board.ts q.ts queue.ts trees.ts hooks.ts review.ts packet.ts each.ts status.ts usage.ts session.ts events.ts`, `githooks/` (`trees.ts`: what a repository's worktrees hold, and the commits no remote has, counted by content) |
| The user-level push ask: a PreToolUse hook that asks for a `git push` except in the repositories a project opted out of with `[asks] skip` (the user's `~/.claude/settings.json` runs it; not vendored, `docs/design.md` "Asks a project leaves out") | `claude-hooks/ask-push.ts`, `claude-hooks/ask-push.test.ts` |
| Adopting, copying, checking (`templates/rules-section.md` is the one source of the generic session rules: `init.ts` writes it into CLAUDE.md, `--section-only` refreshes it alone; the helpers in `templates/agents/` are written once and then the project's, a rule they must keep carries a `<!-- harness:rule NAME -->` mark that `doctor.ts` looks for in the copies) | `init.ts`, `harness-sync.ts`, `doctor.ts`, `templates/` |
| The adopt procedure as a skill (link `skills/harness-init` into `~/.claude/skills/`) | `skills/harness-init/SKILL.md` |
| The child skill (open a task in its own session, see it through, the dispatch; link `skills/child` into `~/.claude/skills/`; finds the project's tools dir through `config.ts show`) | `skills/child/SKILL.md` |
| The desktop Harness pane and status line (a Claude Code mod, not vendored; `~/.claude/skills/harness-view` links to it; its tests run in `bun run check`) | `pane/README.md` |
| Tests (not vendored) | `*.test.ts`, `testing.ts` (a family-shaped fixture) |

## Hard rules

- No tool assumes a folder, a repository's name or a command: they come from
  `config.ts` (`repoDir`, `workDir`, `repoName`, `toolCmd`, `loadConfig`).
  `repoDir` is the main checkout (what status, hooks and doctor read); a tool
  that reads or writes a repository's files takes `workDir`, which is the
  worktree the working directory is in when it is that repository's. What a
  tool writes into the project's own files (the vendored copies, CLAUDE.md,
  `.claude/settings.json`) takes `projectTree`/`toolsPath`/`treeConfig`: the
  worktree it is given, never `root` (that is the main checkout). A name
  that looks like the WoW family's belongs in the family's `harness.toml` or
  its extension modules (`[extensions]`), never here.
- `pane/` is loaded live by every new session through its link in
  `~/.claude/skills/`: a broken edit breaks the pane everywhere. It finds the family by
  its `addon-kit/q.ts` (`projectOf` in `pane/bin/snapshot.ts`) and any other
  project by its `harness.toml`; it never reaches a tool by a path relative
  to its own folder.
- A new tool file goes into `TOOLS` in `harness-sync.ts`; a test or a setup
  script never does. `claude-hooks/` is the user's, not a project's: never in
  `TOOLS`.
- `[asks] skip` (the asks a project leaves out of the template) is the one
  switch read outside `config.ts`: in `init.ts` (`askSkip`) and `doctor.ts`,
  which are not vendored, so a project's copy of `config.ts` doesn't move for
  it. A new ask in the template that a project's skip should cover is the
  project's to add to its list; doctor says it as a missing ask.
- Every switch (`[hooks]`, `[session] worktrees`, `[session] decisions`,
  `[checks] queue`) defaults to what the WoW family runs: the lock on, one shared
  checkout, a decision asked of the user in the child, no queue (`[checks] queue_limit`,
  the minutes a queued run may take, is a number with the queue's own default, 30). A message or a line of the
  rules template that speaks of the lock follows `hooks.lock`
  (`{{#lock}}`/`{{^lock}}` blocks in `templates/rules-section.md`, rendered
  by `init.ts`); the family's own section must stay byte for byte what it
  was (`bun init.ts <family root> --section-only --dry-run` says current).
- Commit locally, Conventional Commits, no AI trailers. Ask before a push or
  creating the GitHub repository.
