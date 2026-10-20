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
  review: ReviewMark | null
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

/** What `bin/snapshot.ts` prints: the numbers every session shares. */
export type Snapshot = {
  at: number
  repos: RepoRow[]
  board: BoardCard[]
  usage: { day: string; models: ModelDay[]; files: number }
}

/** The session the panel is drawn in. */
export type SessionFacts = {
  model: string
  lastModel: string | null
  contextTokens: number | null
  window: number
  percent: number | null
  costUsd: number | null
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

declare module 'claude-code' {
  interface PluginState {
    'harness-view': {
      snapshot: Snapshot | null
      snapshotError: string | null
      session: SessionFacts | null
      agents: AgentRow[]
      steps: Record<string, AgentSteps>
    }
  }
}
