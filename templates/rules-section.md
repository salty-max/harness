## Harness

This project runs under a small harness (`harness.toml`, tools in `{{TOOLS}}/`). The rules
below are checked by git hooks or by tools, so they are not advice.

- **One task, one session, one card.** A session's first write is its card:
  `bun {{TOOLS}}/board.ts add <repo> "<title>" --repos <repo> --try "…" --committed "(none yet)" --left "…"`.
  It holds the repositories it names, and a commit by a Claude session is refused unless
  its running card names the repository (`board.ts held` says who got there first). Move
  the card at each stop
  (`board.ts set <id> --status waiting-test|waiting-review|ready-to-push|done`).
- **Checks go through q**: `bun {{TOOLS}}/q.ts check -- <the check>`. One verdict line,
  the log in `.cache/logs/`, the tree stamped. A push is refused for a tree with no
  passing check. Never pipe a check into `tail`; anything long goes to a file.
- **The board is the lock.** A `held:` line means another card got there first: drop
  that repository from yours (`set <id> --repos …` without it) and go on with the rest,
  or commit what you have, `set <id> --on <holder>` and write nothing. A card whose
  session is gone still holds until the user moves it.
- **Review before the commit**: `bun {{TOOLS}}/packet.ts <repo>` on the uncommitted files,
  the `reviewer` helper reads the packet, fix what it finds, then
  `bun {{TOOLS}}/review.ts <repo> "<verdict>"`, then one commit. A push is refused for a
  change no review stands behind (docs are waived).
- **Commits**: Conventional Commits, lowercase subjects, no AI co-author or "generated
  with" line (the commit-msg hook refuses them).
- Ask before any push, release or deploy.
- Rules this project keeps beyond these: `{{RULES}}`.

How sessions work together (behaviour: no hook checks these):

- **A new task asked in a session that has its own is opened as a child** (the `child`
  skill): tell the user its name and where to find it, write nothing for it here. A
  small follow-up of the same thread stays.
- **Questions go through the question tool** (`AskUserQuestion`, or `wrap_up`'s ask),
  the recommended answer first and marked "(Recommended)". Never a question buried in
  prose.
- **A go belongs to the session that asks it.** A child asks its own go in its own
  session and never pushes. Its opener pushes only on a go the user gave in the opener,
  or on the child's quote of the user's words with their scope (repository, sha range,
  push only). A push go never covers a deploy or a release: each is asked again.
- **Close a finished child yourself**: its work pushed (or dropped) and its card done,
  then `bun {{TOOLS}}/session.ts check <local_id>` and archive it (desktop) or
  `session.ts close` (CLI). Never wait to be told. Never one that waits on the user,
  holds an open card or has a follow-up on its way.
- **Pick each child's model from its task**: the project's default for mechanical work
  from a written brief, a stronger model at higher effort for judgment (prose, voice,
  security, design, a plan the user must approve). Set it when the child starts (a plan
  child once its plan is approved) and say the choice in one line.
- **A problem found along the way gets fixed now**, under its own card, or handed to a
  new session at once. Never only mentioned in the report.
- **Review your own work before saying it is done**: read the diff, grep for leftovers,
  check each claim in the report, see CI's verdict. Chain a commit after the check with
  `&&`, never `;`.
- **"Can't" is a research task first**: the docs, the code that does the same thing, the
  web. Say what was checked, and "not verified" with the probe that would settle it,
  never "impossible" on a guess.
