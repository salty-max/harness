## Harness

This project runs under a small harness (`harness.toml`, tools in `{{TOOLS}}/`).
The rules below are checked by git hooks or by tools, so they are not advice.

- **One task, one session, one card.** A session's first write is its card:
  `bun {{TOOLS}}/board.ts add <repo> "<title>" --repos <repo> --try "…" --committed "(none yet)" --left "…"`.
  It holds the repositories it names, and a commit by a Claude session is
  refused unless its running card names the repository (`board.ts held`
  says who got there first). Move the card at each stop (`board.ts set <id>
  --status waiting-test|waiting-review|ready-to-push|done`).
- **Checks go through q**: `bun {{TOOLS}}/q.ts check -- <the check>`. One verdict
  line, the log in `.cache/logs/`, the tree stamped. A push is refused for a
  tree with no passing check.
- **Review before the commit**: `bun {{TOOLS}}/packet.ts <repo>` on the uncommitted
  files, the `reviewer` helper reads the packet, fix what it finds, then
  `bun {{TOOLS}}/review.ts <repo> "<verdict>"`, then one commit. A push is refused for a
  change no review stands behind (docs are waived).
- **Commits**: Conventional Commits, lowercase subjects, no AI co-author or
  "generated with" line (the commit-msg hook refuses them).
- Ask before any push, release or deploy.
- Rules this project keeps beyond these: `{{RULES}}`.
