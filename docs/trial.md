# The second-project trial (29 October 2026)

A throwaway repository shaped like the geoguessr project (`geoguessr-web/`:
bun, `bun test` as its only check, no addons, one repository whose folder
name is not the project's), in the session's scratchpad. Nothing real was
created. What `bun init.ts <dir> --name geoguessr` did and what then held:

1. **init**: harness.toml (check "bun run test"), 28 vendored files stamped
   with the harness commit, hooks installed, 13 permission asks merged, the
   reviewer and architect helpers, a CLAUDE.md section, `.gitignore`. `doctor`
   said "nothing wrong".
2. **The lock**: a commit by a Claude session with no card was refused ("this
   session has no card: its first write is its card"). After
   `board.ts add geoguessr "Adopt the harness"` it went in. `board.ts held` showed
   the card holding `geoguessr` (the project's name, not the folder's).
3. **commit-msg** refused a `Co-Authored-By: Claude` trailer and logged it.
4. **q**: `check: ok · stamped`, and a failing command printed one verdict line
   with its exit code passed through (3).
5. **pre-push** refused, in order: a push with no review behind it; a reviewed
   tree with no passing check; then, when the check really failed (the trial's
   own stray line broke `src/score.ts`), it kept refusing. After the fix commit,
   `q check`, `packet.ts` and `review.ts`, the push went through.
6. **A worktree** of the repository resolved the same root, the same board and
   the same repository name (`bun harness/config.ts root|repo-name`).
7. **The event log** held every refusal and verdict under
   `.harness/cache/events.log`.

Not covered: the `claude --bg` session path (`session.ts`) needs a real Claude
CLI, the reviewer helper was stood in for by hand, and `usage.ts` needs a
board with finished cards and transcripts.
