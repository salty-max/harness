---
name: child
description: Open a task in a session of its own (a child) instead of doing it here, and see it through to closing: from the desktop app with its own session tool (the child shows in the sidebar), from a CLI session with the project's session.ts; with no task, make this session the dispatch, every new task after it opened as a child. Use when the user types /child, or says to open a task in its own session or to make this session the dispatch.
---

# /child

The user picks, not the session: `/child <task>` opens that task as a child
of this session, whatever this session is doing. `/child` alone makes this
session the dispatch. Without either, the project's own rule holds (a
session with a task of its own opens a new one, a fresh session does the
task).

## 0. Find the project's tools

This skill is linked from `~/.claude/skills/child`; the harness checkout is
two folders above its real path (`realpath` the link), call it `$HARNESS`.
From the project's folder (the working directory):

```bash
bun $HARNESS/config.ts show
```

Read `root`, `toolsDir`, `term`, `session.rules` and `session.models` (the
model by kind, `code` and `prose`). Every command below is `bun
<toolsDir>/<tool>.ts` from `root` (the tools folder is a project's choice:
`addon-kit`, `harness`, ...). The guards, before anything else:

- A non-zero exit of `config.ts show` means no harness found a project
  here: stop, say so, and offer `harness-init`.
- Unless `HARNESS_ROOT` (or `WOW_ADDONS_ROOT`) is set in the environment,
  which names the project and wins over the working directory, `root` must
  contain the working directory. If it doesn't, the finder fell back to its
  own checkout's project, not this one: stop, say so, offer `harness-init`.
- `<root>/<toolsDir>/session.ts` must exist. If not, the project has no
  harness: say so and offer `harness-init`. Do not improvise the child's
  prompt or its card.

A project may have addendum skills for this one (its rules file or its
`CLAUDE.md` names them, usually `<project>-child`): load them. A project may
also have its own dispatch skill (a lead with roles, briefs and a lock): it
decides the roles and the brief's content, this skill opens and closes the
session. Load it when it exists.

## `/child <task>`: open it

Write nothing for the task here: no card, no file, no helper.

1. Settle, from the task and what this session knows, without asking:
   - the **title**: short, the task's own (the child's name and its card's);
   - **repos**: every repository it will write, the main one first (the
     project's rules file and its repository table; read a map when
     unsure);
   - **kind**: `code` for code and mechanical work, `prose` for voices,
     translations, design and players' text (a project may map both kinds
     to one model);
   - **plan** only when a design must be settled first: the opener's
     call, never a question for the user.
2. Write the task: the user's words, then what this session knows that the
   child needs (files, findings, decisions, what not to touch). Never "as
   discussed": the child starts cold.
3. Its first words come from `session.ts` (the maps, its card first, its
   model, the task, the report to this session). For a desktop child:

   ```bash
   bun <toolsDir>/session.ts "<title>" --repos a,b --kind code [--plan] --desktop -- "<the task>"
   ```

   prints the prompt alone and starts nothing.

   A `note:` that a repository is held means the child will block on it:
   say so.
4. Open it:
   - **In the desktop app** (this session has the `start_session` tool):
     `start_session` with `initiation: "user_asked"`, `context: "fresh"`,
     `use_worktree: false`, the title, a short `name`, `prompt` what
     `--desktop` printed (all of it), `background` one line on the
     project's harness and where this task comes from. The model, from
     `session.models[kind]`: `sonnet` and `opusplan` start on Sonnet
     (`claude-sonnet-5-5`), `opus` on Opus (`claude-opus-5-5`); a plan
     child starts on Opus with `permission_mode: "plan"`, and once the
     child says its plan is approved, `set_session_model` moves it to the
     kind's model (Sonnet for `opusplan`). The tool takes only this
     session's model or a cheaper one: after an Opus start, `get_session`
     on the child, and if it isn't on Opus, `set_session_model` to the Opus
     id (the app asks the user: say why in a line). A project that sets its
     models in `.claude/settings.json` needs no model passed, but passing
     the same one does no harm. It shows in the sidebar under this
     session. The app starts one only on a turn the user typed (`/child`
     always is): on a turn another session's message or an event began, it
     refuses, so propose it instead (`initiation: "own_initiative"`, the
     same brief) and tell the user it waits on their click.
   - **From a CLI session** (no `start_session`): the same command without
     `--desktop`. It runs `claude --bg`: in `claude agents` and the panel,
     never in the desktop sidebar.
5. Tell the user in a line: its name and where to find it (the sidebar, or
   `claude attach <id>`), and the plan's wait when there is one.

## Seeing it through

The child reports here by SendMessage each time its card stops running
and once its commits are pushed (by this session, on its quoted go: the
child never pushes; a desktop child's turns also reach this session as the
app's notes).

- **Waiting on the user** (a test, a review, a push's go): relay in one
  line "child X waits for your <test|review|go>" and where (its name, the
  sidebar or `claude attach <id>`). Never ask the user the child's go here:
  the child asks it in its own session and the user answers there. It stays
  open.
- **A go reported**: the child's report quotes the user's words and says
  what they cover (repository, sha range, push only). Verify before
  pushing: the quote says go, its scope names this repository and range
  (what is on origin/main..<sha> is that range, nothing more), and it
  does not reach a deploy or a release (each its own go, never implied by
  a push go). No quote, or a doubtful one: SendMessage the child to quote
  it, never push on its summary alone. A go the user gave in this very
  session is valid too. Then `git -C <repo> log --oneline
  origin/main..<sha>` first, and if commits of another card sit below the
  child's, name them to the user before pushing (they go out too). Then
  `git -C <repo> push origin <sha>:main` and tell the child to set its
  card done.
- **Pushed**: check its work before closing it:
  - its card is done: `bun <toolsDir>/board.ts list --all`;
  - the range is on origin: `git -C <repo> log --oneline @{u} -5` (its
    branch's upstream, main as a rule);
  - CI: `bun <toolsDir>/status.ts`;
  - the change's shape: `git -C <repo> show --stat <range>`.

  Then close it, and one line to the user:
  - a desktop child: `bun <toolsDir>/session.ts check <local_id>`, then
    `archive_session` once `list_sessions` with `linked: true` shows it
    `startedBy` this session (check can't tell whose it is). Outside auto
    mode the app asks the user to approve the archive: say so in the
    line;
  - a CLI child: `bun <toolsDir>/session.ts close <id>`.

  Refused as busy (it has just sent its report): a desktop child's end of
  turn reaches this session as the app's note, close on it (SendMessage's
  `notify_when_idle` doesn't reach desktop sessions); a CLI child:
  SendMessage to it with `notify_when_idle: true` and close on the notice.
  Refused for anything else: tell the user why. `--force` (or an archive
  past a refusal) only on the user's word.
- **Dropped** (its card done, nothing pushed, the user's call): check its
  repositories hold nothing of it (`git -C <repo> status`, no commits of it
  on no remote), then close it. Anything left is the user's to keep or
  throw away.
- Before wrapping up a turn: `list_sessions` with `linked: true` and `bun
  <toolsDir>/session.ts children`, for a finished child not closed yet.

## `/child` alone: the dispatch

Say in a line that this session is the dispatch now. From then on, every
new task the user asks here is opened as a child (above), and the session
writes nothing of its own.

The dispatch runs on Sonnet: its turns are relays, checks, pushes and
archives, and on Opus that overhead was measurable. A session can't change
its own model: if this one isn't on Sonnet (`opusplan` counts: it is Sonnet
outside plan mode), say so in the same line and ask the user to switch it
in the model menu (desktop) or with `/model sonnet` (terminal). From a
Sonnet dispatch an Opus id is ignored, not refused (the tool never starts a
child above its opener): the prose or plan child starts at Sonnet, and
`set_session_model` moves it to Opus as step 4 says, the app asking the
user for each one, so name the child and the reason in the line. A plan
child then goes back to Sonnet once its plan is approved, a second
approval. A follow-up to a child's task goes to that child (SendMessage,
its name), a question about where things stand is answered here (the
children, the board, `status.ts`). It lasts until the user says otherwise.
