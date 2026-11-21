## Harness

This project runs under a small harness (`harness.toml`, tools in `{{TOOLS}}/`). The rules
below are checked by git hooks or by tools, so they are not advice.

- **One task, one session, one card.** A session's first write is its card:
  `bun {{TOOLS}}/board.ts add <repo> "<title>" --repos <repo> --try "…" --committed "(none yet)" --left "…"`.
{{#lock}}
  It holds the repositories it names, and a commit by a Claude session is refused unless
  its running card names the repository (`board.ts held` says who got there first). Move
  the card at each stop
{{/lock}}
{{^lock}}
  It names the repositories the task writes. Nothing refuses a commit for want of it
  (`[hooks] lock = false`): keeping it is the session's own rule. Move the card at each
  stop
{{/lock}}
  (`board.ts set <id> --status waiting-test|waiting-review|ready-to-push|done`).
- **Checks go through q**: `bun {{TOOLS}}/q.ts check -- <the check>`. One verdict line,
  the log in `.cache/logs/`, the tree stamped. A push is refused for a tree with no
  passing check. Never pipe a check into `tail`; anything long goes to a file.
{{#lock}}
- **The board is the lock.** A `held:` line means another card got there first: drop
  that repository from yours (`set <id> --repos …` without it) and go on with the rest,
  or commit what you have, `set <id> --on <holder>` and write nothing. A card whose
  session is gone still holds until the user moves it.
{{/lock}}
{{^lock}}
- **The board is a list, not a lock.** A `note:` that another card is running in a
  repository only says who else is there: keep to your own files and talk to that
  session by its id, don't wait for it. `board.ts held` shows who runs where. A card
  can still be `blocked --on` another, as a choice.
{{/lock}}
{{#worktrees}}
- **Each child works in a worktree of its own**, on a branch of its own
  (`[session] worktrees = true`): commit there, never in the main checkout. The board,
  its cards and the check stamps are shared by every worktree, and `{{TOOLS}}/packet.ts`,
  `review.ts` and `session.ts check` act on the worktree they are run from or asked
  about. The git hooks run from the main checkout (`core.hooksPath` is the absolute
  path `hooks.ts install` wrote there, so a worktree's own copy of the tools is never
  the one that runs) and the tools read `harness.toml` from it: install the hooks
  there (`bun {{TOOLS}}/hooks.ts install .`), never from a worktree.
{{/worktrees}}
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
{{#opener}}
- **Every decision is taken in the opener, never in a child**
  (`[session] decisions = "opener"`). A child asks the user nothing: it sends each
  question (a push, a merge, any choice) to its opener with the options and its
  recommendation, and stops. The opener asks the user through the question tool
  (`AskUserQuestion`, or `wrap_up`'s ask), the recommended answer first and marked
  "(Recommended)". Never a question buried in prose.
- **A go is the user's, asked in the opener.** A child never pushes and never asks
  for a go: its report says what is committed and what a push would send
  (repository, sha range, push only). The opener asks the user, then pushes on their
  answer or relays it to the child quoted. A push go never covers a deploy or a
  release: each is asked again.
{{/opener}}
{{^opener}}
- **Questions go through the question tool** (`AskUserQuestion`, or `wrap_up`'s ask),
  the recommended answer first and marked "(Recommended)". Never a question buried in
  prose.
- **A go belongs to the session that asks it.** A child asks its own go in its own
  session and never pushes. Its opener pushes only on a go the user gave in the opener,
  or on the child's quote of the user's words with their scope (repository, sha range,
  push only). A push go never covers a deploy or a release: each is asked again.
{{/opener}}
- **Close a finished child yourself**: its work pushed (or dropped) and its card done,
  then `bun {{TOOLS}}/session.ts check <local_id>` and archive it (desktop) or
  `session.ts close` (CLI). Never wait to be told. Never one that waits on the user,
  holds an open card or has a follow-up on its way.
- **Pick each child's model from its task**: the project's default for mechanical work
  from a written brief, a stronger model at higher effort for judgment (prose, voice,
  security, design, a plan the user must approve). Set it when the child starts (a plan
  child once its plan is approved) and say the choice in one line.
- **Never kill or signal a process another session may share.** A dev server, an e2e
  server or a watcher may be another session's: stop only what this session started,
  by the pid it was given, never `pkill -f` or `killall` by name, nor `lsof … | xargs
  kill` by port. The helpers' Bash is gated on it, a session's is not: this is on you.
- **A problem found along the way gets fixed now**, under its own card, or handed to a
  new session at once. Never only mentioned in the report.
- **Review your own work before saying it is done**: read the diff, grep for leftovers,
  check each claim in the report, see CI's verdict. Chain a commit after the check with
  `&&`, never `;`.
- **"Can't" is a research task first**: the docs, the code that does the same thing, the
  web. Say what was checked, and "not verified" with the probe that would settle it,
  never "impossible" on a guess.
