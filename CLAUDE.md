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
| The tools | `board.ts q.ts hooks.ts review.ts packet.ts each.ts status.ts usage.ts session.ts events.ts`, `githooks/` |
| Adopting, copying, checking (`templates/rules-section.md` is the one source of the generic session rules: `init.ts` writes it into CLAUDE.md, `--section-only` refreshes it alone) | `init.ts`, `harness-sync.ts`, `doctor.ts`, `templates/` |
| The adopt procedure as a skill (link `skills/harness-init` into `~/.claude/skills/`) | `skills/harness-init/SKILL.md` |
| The child skill (open a task in its own session, see it through, the dispatch; link `skills/child` into `~/.claude/skills/`; finds the project's tools dir through `config.ts show`) | `skills/child/SKILL.md` |
| The desktop Harness pane and status line (a Claude Code mod, not vendored; `~/.claude/skills/harness-view` links to it; its tests run in `bun run check`) | `pane/README.md` |
| Tests (not vendored) | `*.test.ts`, `testing.ts` (a family-shaped fixture) |

## Hard rules

- No tool assumes a folder, a repository's name or a command: they come from
  `config.ts` (`repoDir`, `workDir`, `repoName`, `toolCmd`, `loadConfig`).
  `repoDir` is the main checkout (what status, hooks and doctor read); a tool
  that reads or writes a repository's files takes `workDir`, which is the
  worktree the working directory is in when it is that repository's. A name
  that looks like the WoW family's belongs in the family's `harness.toml` or
  its extension modules (`[extensions]`), never here.
- `pane/` is loaded live by every new session through its link in
  `~/.claude/skills/`: a broken edit breaks the pane everywhere. It finds the family by
  its `addon-kit/q.ts` (`projectOf` in `pane/bin/snapshot.ts`) and any other
  project by its `harness.toml`; it never reaches a tool by a path relative
  to its own folder.
- A new tool file goes into `TOOLS` in `harness-sync.ts`; a test or a setup
  script never does.
- Every switch (`[hooks]`, `[session] worktrees`) defaults to what the WoW
  family runs: the lock on, one shared checkout. A message or a line of the
  rules template that speaks of the lock follows `hooks.lock`
  (`{{#lock}}`/`{{^lock}}` blocks in `templates/rules-section.md`, rendered
  by `init.ts`); the family's own section must stay byte for byte what it
  was (`bun init.ts <family root> --section-only --dry-run` says current).
- Commit locally, Conventional Commits, no AI trailers. Ask before a push or
  creating the GitHub repository.
