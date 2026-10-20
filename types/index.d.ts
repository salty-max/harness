/**
 * A repository's last passing check (B's `.git/harness/check-<tree>`):
 * `isFresh` when HEAD's tree is stamped (a push of HEAD passes pre-push),
 * `isWorkFresh` when the working directory as it is now is.
 */
export type CheckStamp = { tree: string; at: number; isFresh: boolean; isWorkFresh: boolean }

/** A repository's last review: a verdict recorded, or only the packet. */
export type ReviewMark = {
  sha: string
  at: number
  verdict: string | null
  isCurrent: boolean
}

export type RepoRow = {
  name: string
  head: string
  check: CheckStamp | null
  /** The last check run when it failed after the newest stamp (`.cache/logs/check.log`). */
  failed: { at: number; exit: number } | null
  review: ReviewMark | null
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
}

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
}

/** The session the panel is drawn in. */
export type SessionFacts = {
  model: string
  lastModel: string | null
  contextTokens: number | null
  window: number
  percent: number | null
  costUsd: number | null
  /** The plan's limits as the engine reports them (`five_hour`, `seven_day`, ...). */
  rateLimits: { kind: string; percentUsed: number }[]
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
      turn: TurnState
    }
  }
}
