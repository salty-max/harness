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
| Adopting, copying, checking | `init.ts`, `harness-sync.ts`, `doctor.ts`, `templates/` |
| Tests (not vendored) | `*.test.ts`, `testing.ts` (a family-shaped fixture) |

## Hard rules

- No tool assumes a folder, a repository's name or a command: they come from
  `config.ts` (`repoDir`, `repoName`, `toolCmd`, `loadConfig`). A name that
  looks like the WoW family's belongs in the family's `harness.toml` or its
  extension modules (`[extensions]`), never here.
- A new tool file goes into `TOOLS` in `harness-sync.ts`; a test or a setup
  script never does.
- Commit locally, Conventional Commits, no AI trailers. Ask before a push or
  creating the GitHub repository.
