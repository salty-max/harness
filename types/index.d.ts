/**
 * A repository's last passing check (B's `.git/harness/check-<tree>`):
 * `isFresh` when HEAD's tree is stamped (a push of HEAD passes pre-push),
 * `isWorkFresh` when the working directory as it is now is.
 */
export type CheckStamp = { tree: string; at: number; isFresh: boolean; isWorkFresh: boolean }

/** A repository's last review: a verdict recorded (HEAD's own first), or only the packet. */
export type ReviewMark = {
  sha: string
  at: number
  verdict: string | null
  isCurrent: boolean
  /** HEAD's verdict: the base of the range its reviewer read; null when none was recorded (no packet, or before review.ts kept it). */
  base?: string | null
  /** HEAD's verdict reached all a push sends: its base is already on the upstream (or every remote). */
  covers?: boolean
}

export type RepoRow = {
  name: string
  head: string
  check: CheckStamp | null
  /** The last check run when it failed after the newest stamp (`.cache/logs/check.log`). */
  failed: { at: number; exit: number } | null
  review: ReviewMark | null
  /** The commits a push would send (`@{u}..HEAD`, else those no remote has); null with no remote; absent in an older snapshot. */
  ahead?: number | null
}

/**
 * One line of the panel's log: a tool's line in the harness's events.log
 * (addon-kit/events.ts), or a helper or an answered prompt from today's
 * transcripts. `tone` empty: the panel reads it from the words.
 */
export type HarnessEvent = {
  id?: string
  at: number
  source: string
  tone: 'ok' | 'wait' | 'fail' | 'info' | ''
  repo: string
  text: string
  /** A helper's model, its tokens and how long it ran, when known. */
  model?: string
  tokens?: number
  ms?: number
}

/** One card of the task board (`board/<id>.md`). */
export type BoardCard = {
  id: string
  repo: string
  title: string
  status: string
  session: string
  updated: string
  summary: string
  /** Every repository the task writes (its repo alone when the card names none); held while running or blocked. */
  repos?: string[]
  /** A blocked card's: the card it waits on. */
  waits?: string
  /** A running card's place in each repository's queue (board.ts); absent when read by the fallback parser. */
  since?: Record<string, string>
  /** Its front matter unreadable: it holds nothing. */
  broken?: boolean
}

/** A card named in a repository's lock: whose session runs it, as the Sessions box names it. */
export type LockCard = { id: string; title: string; status: string; session: string; /** The live session's name, else the id's start. */ who: string; /** Its session is not live (a running card still holds). */ gone: boolean }

/**
 * Who works in one repository by the board's lock (board.ts's `holders`): the
 * session whose running card came first, the other sessions' running cards
 * after it (`later`: told to wait), and the cards stopped mid-task there
 * (`stopped`: blocked, or waiting on the user, their commits go out with its next push).
 */
export type RepoLock = { repo: string; holder: LockCard | null; later: LockCard[]; stopped: LockCard[] }

/** A session that wrote in a repository its cards don't hold: board.ts's `mayWrite` said why. */
export type Slip = { session: string; who: string; repo: string; at: number; why: string }

/** Today's tokens of one model, every transcript on this machine. */
export type ModelDay = {
  model: string
  calls: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** A helper the family defines (`.claude/agents/<name>.md`). */
export type HelperDef = { name: string; model: string | null; description: string }

/** A helper's runs today, from the transcripts. */
export type HelperDay = { runs: number; tokens: number; ms: number; lastAt: number; model: string | null }


/**
 * A session running in the family folder, as Claude Code's own registry of
 * live sessions says (`~/.claude/sessions/<pid>.json`, what its agent list
 * and ListAgents read; an internal format), its process alive, with its
 * model and helpers from today's transcripts.
 */
export type LiveSession = {
  /** Its session id: the transcript's, and the board cards' `session`. */
  id: string
  pid: number
  /** Its title (the desktop's, or a derived name). */
  name: string
  /** `busy`, `idle` or `waiting` (on the user: `waitingFor`), as the registry says. */
  status: string
  waitingFor: string | null
  /** When its status last changed. */
  since: number
  /** Where it runs: `claude-desktop`, `cli`, ... */
  entrypoint: string
  /** A background session (`claude --bg`, addon-kit's session.ts): `claude attach` joins it. */
  background?: boolean
  /** The desktop app's link to it (`claude://claude.ai/epitaxy/<id>`), a desktop session's alone. */
  link: string | null
  /** Its main loop's last model today. */
  model: string | null
  /** Its permission mode as the transcript last recorded it: `plan` is planning, anything else building. */
  mode: string | null
  /** Its helpers running: started, no result yet (a background one: no notice of its end yet). */
  helpers: { type: string; at: number }[]
  /** The desktop's id for it (`local_…`), a desktop session's alone. */
  host?: string | null
  /** The session that opened it (its id), when it is live: a child shows under it. */
  parent?: string | null
  /** The skills it used today, oldest first: `by` says whether the session loaded it (a `Skill` call) or the user typed it (`/name`), `at` the last time, `count` how often. */
  skills: { name: string; by: 'user' | 'session'; at: number; count: number }[]
}

/** A q.ts run going on now (addon-kit's events.ts, `running/<pid>.json`): the gates at work. */
export type GateRun = { pid: number; name: string; repo: string; at: number }

/** What `bin/snapshot.ts` prints: the numbers every session shares. */
export type Snapshot = {
  at: number
  repos: RepoRow[]
  board: BoardCard[]
  usage: { day: string; models: ModelDay[]; files: number }
  /** Today's events, newest first. */
  events: HarnessEvent[]
  /** The family's helpers, and each helper's runs today by its type. */
  helpers: HelperDef[]
  helperDay: Record<string, HelperDay>
  /** The live sessions in the family folder; absent when the registry can't be read (or an older snapshot). */
  sessions?: LiveSession[]
  /** The q.ts runs going on, the oldest first; absent in an older snapshot. */
  gates?: GateRun[]
  /** Who works in each repository some card names (board.ts's lock); absent without board.ts or in an older snapshot. */
  locks?: RepoLock[]
  /** Sessions that wrote in a repository their cards don't hold, lately; absent like `locks`. */
  slips?: Slip[]
}

/** The session the panel is drawn in. */
export type SessionFacts = {
  /** This session's id: its row among the live sessions. */
  id: string | null
  model: string
  lastModel: string | null
  contextTokens: number | null
  window: number
  percent: number | null
  costUsd: number | null
  /** The plan's limits as the engine reports them (`five_hour`, `seven_day`, ...). */
  rateLimits: { kind: string; percentUsed: number; resetsAt: number | null }[]
  /** The settings the panel's Config box shows. */
  settings: { model: string | null; mode: string | null; effort: string | null; asks: number; subagentModel: string | null }
}

/** A subagent's model calls, counted as they stream. */
export type AgentSteps = {
  model: string
  steps: number
  context: number
  output: number
}

/** A subagent as the engine lists it, with its counted calls. */
export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  steps: AgentSteps | null
}

/** A helper of this session that just stopped running: its handback, which flows back to the lead a few seconds. */
export type Handback = { at: number; type: string }

/** The main session's turn: running from its start to its end (or abort). */
export type TurnState = { isRunning: boolean; at: number | null }

declare module 'claude-code' {
  interface PluginState {
    'harness-view': {
      snapshot: Snapshot | null
      snapshotError: string | null
      session: SessionFacts | null
      agents: AgentRow[]
      steps: Record<string, AgentSteps>
      tick: number
      turn: TurnState
      handback: Handback | null
    }
  }
}
