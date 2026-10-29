# harness

A small harness for working with Claude Code sessions on a project, extracted
from the WoW addons family's (25 files of bun/TypeScript and git hooks, no
dependencies). What it gives a project:

- **a task board** (`board.ts`): one Markdown card per task, and the board is
  the lock: a Claude session's commit is refused unless its running card names
  the repository and nobody else's card came to hold it first
- **a quiet runner** (`q.ts`): one verdict line, the log in a file, the tree
  stamped when the check passes; **git hooks**: no AI trailers, no push of an
  unchecked or unreviewed tree
- **a review packet and a verdict** (`packet.ts`, `review.ts`): the reviewer
  reads the packet, the verdict attests the tree, before the commit
- **status, each, usage, events, session**: every repository at a glance, one
  command in each, the cost of a card, the event log, sessions opened by sessions

Design and the reasoning: `docs/design.md`. Config: `harness.toml`.

## Adopt it

From this repository, against a project folder (a git repository, or a folder
of them):

```bash
bun init.ts ~/code/my-project --dry-run     # what it would write
bun init.ts ~/code/my-project               # writes harness.toml, vendors the tools into harness/, installs hooks,
                                            # merges the permission asks, adds the reviewer helper and a CLAUDE.md section
```

Nothing is committed: read the diff. The copies are stamped with this
repository's commit; `bun harness-sync.ts <project>` brings them up to date,
`--check` fails on a hand edit, `bun doctor.ts <project>` lists what is wrong.

## Develop it

`bun test` (or `bun run check`). The tools run on their own
(`bun board.ts list`) or through `bun harness.ts <tool>`. Edit a tool here,
commit, then sync the projects: a copy in a project is never edited.
`testing.ts` and the `*.test.ts` files stay here and are not vendored.
