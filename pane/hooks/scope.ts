import type { LiveSession, Snapshot } from '../types'

/** The project a pane shows: the one of its own session, else the one whose folder holds the session's root. Undefined: a single project, nothing to scope. */
export function ownProject(snap: Snapshot | null, selfId: string | null, root?: string | null): string | undefined {
  const projects = snap?.projects
  if (!snap || !projects || projects.length < 2) return undefined
  const mine = selfId ? snap.sessions?.find(x => x.id === selfId)?.project : undefined
  if (mine && projects.some(p => p.name === mine)) return mine
  // (a session the registry doesn't list yet, a desktop spare being moved: by its folder)
  if (root) return projects.find(p => p.dir && (root === p.dir || root.startsWith(`${p.dir}/`)))?.name
  return undefined
}

/** The snapshot as one project's pane draws it: that project's rows alone, its own usage and helpers' days, and no `projects` (the other projects are `summariseOthers`'). */
export function scopeSnapshot(snap: Snapshot, project: string | undefined): Snapshot {
  if (!project || !snap.projects?.some(p => p.name === project)) return snap
  const mine = <T extends { project?: string }>(rows: T[]): T[] => rows.filter(r => r.project === undefined || r.project === project)
  const { projects: _projects, ...rest } = snap
  return {
    ...rest,
    repos: mine(snap.repos),
    board: mine(snap.board),
    events: mine(snap.events),
    sessions: snap.sessions ? mine(snap.sessions) : undefined,
    gates: snap.gates ? mine(snap.gates) : undefined,
    locks: snap.locks ? mine(snap.locks) : undefined,
    slips: snap.slips ? mine(snap.slips) : undefined,
    usage: { ...snap.usage, models: snap.usage.byProject?.[project] ?? [] },
    helperDay: snap.helperDayBy?.[project] ?? {},
  }
}

/** Whether a session loaded the child skill, or the user typed it: the mark of a dispatch. */
const hasChildSkill = (x: LiveSession) => x.skills?.some(s => s.name === 'child') ?? false

/**
 * The session a project's work is dispatched from, among its live ones: this session's own opener chain's root when
 * `selfId` has one, else a session nobody opened that used the child skill (the user's typed one first), else the one
 * nobody opened with the most live children. None when no session opened another or used the skill.
 */
export function dispatcherOf(sessions: LiveSession[], selfId: string | null = null): LiveSession | null {
  const byId = new Map(sessions.map(x => [x.id, x]))
  if (selfId) {
    let at = byId.get(selfId)
    const seen = new Set<string>()
    while (at?.parent && byId.has(at.parent) && !seen.has(at.id)) {
      seen.add(at.id)
      at = byId.get(at.parent)
    }
    if (at && at.id !== selfId) return at
  }
  const kids = (x: LiveSession) => sessions.filter(k => k.parent === x.id).length
  const isRoot = (x: LiveSession) => !x.parent || x.parent === x.id || !byId.has(x.parent)
  const typed = (x: LiveSession) => x.skills?.some(s => s.name === 'child' && s.by === 'user') ?? false
  const candidates = sessions.filter(x => isRoot(x) && (kids(x) > 0 || hasChildSkill(x)))
  candidates.sort((a, b) => Number(typed(b)) - Number(typed(a)) || kids(b) - kids(a) || b.since - a.since)
  return candidates[0] ?? null
}

/** One other project, as the block lists it. */
export type OtherProject = {
  name: string
  live: number
  waiting: number
  /** Cards waiting on the user (test, review, a push's go). */
  cards: number
  dispatcher: LiveSession | null
}

/** The projects the pane doesn't show, each with what is going on there (from the whole snapshot). */
export function summariseOthers(snap: Snapshot | null, own: string | undefined, isWaitingCard: (status: string) => boolean): OtherProject[] {
  if (!snap?.projects || !own) return []
  return snap.projects
    .filter(p => p.name !== own)
    .map(p => {
      const sessions = (snap.sessions ?? []).filter(x => x.project === p.name)
      return {
        name: p.name,
        live: sessions.length,
        waiting: sessions.filter(x => x.status === 'waiting').length,
        cards: snap.board.filter(c => c.project === p.name && isWaitingCard(c.status)).length,
        dispatcher: dispatcherOf(sessions),
      }
    })
}
