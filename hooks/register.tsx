import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentRow, AgentSteps, BoardCard, CheckStamp, HarnessEvent, LiveSession, LockCard, ModelDay, RepoLock, RepoRow, SessionFacts, Snapshot } from '../types'
import { ago, bar, FRESH_MS, type Moment, momentOf, stance, tokens } from './format'
import type { MotionProps } from './motion'
import { BAR_PX, barSvg, EDGE_PX, edgeSvg, LINE_PX, lineSvg, SIDE_PX } from './vector'

export { ago, bar, stance, tokens }

const PANE = 'harness'
const TITLE = 'Harness'
// The shared numbers: this often while the pane is shown, at the slow pace
// (the status line's) while it is closed or behind another tab.
const LIVE_MS = 2_000
const SNAPSHOT_MS = 30_000
// The event log and the board looked at (a stat each): a line there reads anew at once.
const WATCH_MS = 1_000
const SESSION_MS = 1_000
const LOG_LINES = 6
const AGES_MS = 30_000
// The gaps between the boxes: a row between stacked ones, two columns beside.
const GAP_Y = 1
const GAP_X = 2

const snapshot = atom({ plugin: 'harness-view', key: 'snapshot' } as const, null)
const snapshotError = atom({ plugin: 'harness-view', key: 'snapshotError' } as const, null)
const session = atom({ plugin: 'harness-view', key: 'session' } as const, null)
const agents = atom({ plugin: 'harness-view', key: 'agents' } as const, [])
const steps = atom({ plugin: 'harness-view', key: 'steps' } as const, {})
// Bumped every half minute while the pane is shown: the ages (12m, 3h) drawn again.
const tick = atom({ plugin: 'harness-view', key: 'tick' } as const, 0)
// The main session's turn: the diagram's lines pulse while it runs.
const turn = atom({ plugin: 'harness-view', key: 'turn' } as const, { isRunning: false, at: null })
// A helper of this session just done: the diagram's way back to the lead lights up this long, then goes dark.
const handback = atom({ plugin: 'harness-view', key: 'handback' } as const, null)
const HANDBACK_MS = 6_000
let handbackTimer: { cancel: () => void } | null = null
// A running box's comets in the terminal: the head and this many cells of trail.
const COMET_TAIL = 4

/** A box's top or bottom edge as the terminal draws it: Ink's single style, or its dashed one (the corners blank). */
export function edgeText(w: number, isDashed: boolean, side: 'top' | 'bottom'): string {
  if (w < 2) return ''
  if (isDashed) return ` ${'╌'.repeat(w - 2)} `
  return side === 'top' ? `┌${'─'.repeat(w - 2)}┐` : `└${'─'.repeat(w - 2)}┘`
}

// --- numbers as the panel says them ---------------------------------------

/** `claude-opus-5-5` is `opus 5.5`, `claude-haiku-4-5-20251001` is `haiku 4.5`. */
export function modelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model)
  return m ? `${m[1]} ${m[2]}.${m[3]}` : model.replace(/^claude-/, '')
}

/** How long a helper ran: `42s`, `8m 24s`, `1h 3m`. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** How long until a limit resets: `3d 2h`, `2h 10m`, `12m`. */
export function resetIn(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}

const total = (d: ModelDay) => d.input + d.cacheRead + d.cacheWrite + d.output

// --- colours ----------------------------------------------------------------

/** The mock-up's palette, sampled from its frames. */
export const PALETTE = {
  opus: '#b4b0e8',
  sonnet: '#e8915c',
  haiku: '#38bcfc',
  gate: '#74e49c',
  ok: '#74e49c',
  wait: '#e8c45c',
  fail: '#f07070',
  ask: '#5ce0e0',
  plain: 'text',
} as const

/** Each model family its own: Opus lavender, Sonnet orange, Haiku blue. */
export function modelColor(model: string | null | undefined): string {
  const m = (model ?? '').toLowerCase()
  if (m.includes('opus')) return PALETTE.opus
  if (m.includes('sonnet')) return PALETTE.sonnet
  if (m.includes('haiku')) return PALETTE.haiku
  return 'inactive'
}

/** A model's family: `opus`, `sonnet`, `haiku`, or the name as it is. */
export function family(model: string | null | undefined): string {
  const m = (model ?? '').toLowerCase()
  return ['opus', 'sonnet', 'haiku'].find(f => m.includes(f)) ?? m.replace(/^claude-/, '')
}

// A source of the log: the gates (q's runs, the hooks) green as in the mock-up's router, a review the reviewer's.
const SOURCE: Record<string, string> = {
  hook: PALETTE.gate,
  skill: PALETTE.opus,
  review: PALETTE.opus,
  board: PALETTE.wait,
  ask: PALETTE.ask,
}

export function sourceColor(e: Pick<HarnessEvent, 'source' | 'model'>): string {
  if (e.source === 'helper') return modelColor(e.model)
  return SOURCE[e.source] ?? PALETTE.gate
}

/** A log line's source as the mock-up says one: a helper as `family:type`. */
export function sourceLabel(e: Pick<HarnessEvent, 'source' | 'model' | 'text'>): string {
  if (e.source !== 'helper') return e.source
  const type = e.text.split(' ')[0] ?? 'helper'
  return e.model ? `${family(e.model)}:${type}` : type
}

/** A status: ok green, waiting amber, failed red. */
export function toneColor(tone: HarnessEvent['tone'], text = ''): string {
  if (tone === 'ok') return PALETTE.ok
  if (tone === 'wait') return PALETTE.wait
  if (tone === 'fail') return PALETTE.fail
  if (tone === 'info') return PALETTE.plain
  return verdictColor(text)
}

/**
 * A recorded verdict: a clean one (one that says so first, its fixed
 * findings after it, too) ok, findings or a failure waiting on a fix. A log
 * line's verdict may lead with the commit.
 */
export function verdictTone(verdict: string | null): 'none' | 'ok' | 'wait' | 'plain' {
  if (verdict === null) return 'none'
  if (/^\W*([0-9a-f]{7,40}\s+)?((no|zero|0) (findings?|issues?)|clean|lgtm|approved?)\b/i.test(verdict)) return 'ok'
  if (/\b[1-9]\d* (findings?|issues?)\b|fail|block|reject|\bnot\b/i.test(verdict)) return 'wait'
  if (/\b(ok|pass(ed)?|approved?)\b/i.test(verdict)) return 'ok'
  return 'plain'
}

export function verdictColor(verdict: string | null): string {
  const tone = verdictTone(verdict)
  return tone === 'ok' ? PALETTE.ok : tone === 'wait' ? PALETTE.wait : tone === 'none' ? 'inactive' : PALETTE.plain
}

/** A subagent's status: running amber, done green, failed or stopped red. */
export function agentColor(status: string): string {
  if (status === 'running') return PALETTE.wait
  if (status === 'completed' || status === 'done') return PALETTE.ok
  if (/fail|kill|error|stop|cancel/.test(status)) return PALETTE.fail
  return 'inactive'
}

/** A card's status: what waits on the user amber, done green. */
/** A card's status: waiting on the user amber, a session at work cyan, waiting on another card red, done green. */
export function cardColor(status: string): string {
  if (status.startsWith('waiting') || status === 'ready-to-push') return PALETTE.wait
  if (status === 'done') return PALETTE.ok
  if (status === 'running') return PALETTE.ask
  if (status === 'blocked') return PALETTE.fail
  return PALETTE.plain
}

/** A running card holds its repositories (board.ts's lock); a stopped one, blocked or waiting on the user, only has unpushed work there. */
export const HOLDS = (c: BoardCard) => c.status === 'running'
const STOPPED = (c: BoardCard) => WAITING(c) || c.status === 'blocked'
const reposOf = (c: BoardCard) => c.repos ?? [c.repo]

/** The repositories as the board's row says them: `yonder`, `wow-data+yonder`, past two `wow-data +2` (the Repositories box has the rest). */
export function where(c: BoardCard): string {
  const others = reposOf(c).filter(r => r !== c.repo)
  return others.length === 0 ? c.repo : others.length === 1 ? `${c.repo}+${others[0]}` : `${c.repo} +${others.length}`
}

/**
 * Each repository's mark in the Repositories box: `held` while a running
 * card names it (a session is at work there), `pending` while only cards
 * stopped mid-task do (blocked, or waiting on the user: their commits go
 * out with its next push).
 */
export function holds(board: BoardCard[]): Map<string, 'held' | 'pending'> {
  const out = new Map<string, 'held' | 'pending'>()
  for (const c of board) {
    const kind = HOLDS(c) ? 'held' : STOPPED(c) ? 'pending' : null
    if (!kind) continue
    for (const r of reposOf(c)) if (kind === 'held' || !out.has(r)) out.set(r, kind)
  }
  return out
}

/**
 * The sessions as the Sessions box lists them: each one's children right under it, indented a step. The rest keep
 * the order they came in (waiting first, then busy, then idle). A child whose opener isn't live stands alone, and
 * so does one in a cycle (a session never sits under itself).
 */
export function groupSessions(live: LiveSession[]): { session: LiveSession; depth: number }[] {
  const ids = new Set(live.map(x => x.id))
  const out: { session: LiveSession; depth: number }[] = []
  const seen = new Set<string>()
  const add = (x: LiveSession, depth: number) => {
    if (seen.has(x.id)) return
    seen.add(x.id)
    out.push({ session: x, depth })
    for (const kid of live.filter(k => k.parent === x.id)) add(kid, depth + 1)
  }
  for (const x of live) if (!x.parent || x.parent === x.id || !ids.has(x.parent)) add(x, 0)
  // (whatever a cycle kept out of reach)
  for (const x of live) add(x, 0)
  return out
}

/** A card's session as the lock names it, once: the session's name, else the card. */
const whoOf = (c: LockCard) => c.who || c.id

/** The sessions waiting behind a lock, each named once. */
export function lockNames(cards: LockCard[]): string {
  return [...new Set(cards.map(whoOf))].join(', ')
}

/**
 * A check stamp as the panel says it: a push of HEAD passes (✓), edits made
 * since were not checked (+edits), the checked state is not committed yet
 * (commit), the last check was on something else (old), or the last run
 * failed after the newest stamp (✗).
 */
export function checkMark(check: CheckStamp | null, now: number, failed: RepoRow['failed'] = null): { text: string; color: string } {
  if (failed) return { text: `✗ ${ago(failed.at, now)} exit ${failed.exit}`, color: PALETTE.fail }
  if (!check) return { text: 'no stamp', color: 'inactive' }
  const age = ago(check.at, now)
  if (check.isFresh) return { text: check.isWorkFresh ? `✓ ${age}` : `✓ ${age} +edits`, color: PALETTE.ok }
  if (check.isWorkFresh) return { text: `◐ ${age} commit`, color: PALETTE.wait }
  return { text: `· ${age} old`, color: 'inactive' }
}

/** The skills a session used, as one line: `child (typed), wow-releasing ×2` (a skill the user typed says so, the session's own loads don't). */
export function skillsText(skills: LiveSession['skills']): string {
  return skills.map(u => `${u.name}${u.by === 'user' ? ' (typed)' : ''}${u.count > 1 ? ` ×${u.count}` : ''}`).join(', ')
}

/** A log line's words: a helper's model, tokens and time after what it did. */
export function eventText(e: HarnessEvent): string {
  const more = [e.model && e.ms !== undefined ? modelName(e.model) : '', e.tokens ? `${tokens(e.tokens)} tok` : '', e.ms ? duration(e.ms) : '']
  return [e.text, ...more.filter(Boolean)].join(' · ')
}

/** A log line's figure on the right, the mock-up's last column. */
export function eventFigure(e: HarnessEvent): string {
  if (e.source === 'helper') return e.text.endsWith(' started') || e.text.includes(' started:') ? 'spawn' : e.tokens ? `${tokens(e.tokens)} tok` : (e.text.split(' ')[1] ?? '')
  if (e.source === 'skill') return e.text.split(' ').at(-1) ?? ''
  if (e.source === 'ask') return e.text.endsWith(' refused') ? 'refused' : 'allowed'
  if (e.source === 'hook') return 'refused'
  if (e.source === 'board') return e.text.split(' ').at(-1) ?? ''
  if (e.source === 'review') return verdictTone(e.text) === 'ok' ? 'clean' : verdictTone(e.text) === 'wait' ? 'findings' : 'noted'
  if (e.tone === 'fail') return 'failed'
  return / stamped /.test(e.text) ? 'stamped' : / not stamped/.test(e.text) ? 'unstamped' : e.tone === 'ok' ? 'ok' : ''
}

/** A log line's time: `14:02:07`, local. */
export function clockTime(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

/**
 * Fixed columns that leave the last one at least `min` cells of `room`:
 * as asked when they fit, narrower in step when they don't, so rows stay
 * aligned at any width.
 */
export function fit(widths: number[], room: number, min = 8): number[] {
  const sum = widths.reduce((a, b) => a + b, 0)
  const free = Math.max(widths.length, room - min)
  if (sum <= free) return widths
  return widths.map(w => Math.max(1, Math.floor((w * free) / sum)))
}

// --- the diagram's lines ------------------------------------------------------

/** `text` centred in `width` cells (cut when longer). */
export function centre(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, Math.max(0, width))
  const left = Math.floor((width - text.length) / 2)
  return ' '.repeat(left) + text + ' '.repeat(width - text.length - left)
}

/** A row of `width` cells with `ch` at each of `xs`. */
export function marks(width: number, xs: number[], ch: string): string {
  const row = Array.from({ length: Math.max(0, width) }, () => ' ')
  for (const x of xs) if (x >= 0 && x < row.length) row[x] = ch
  return row.join('')
}

// A joint by the strokes it has: up, down, left, right.
const JOINTS: Record<string, string> = {
  lr: '─', ud: '│', u: '│', d: '│', '': ' ',
  dr: '┌', dl: '┐', ur: '└', ul: '┘',
  dlr: '┬', ulr: '┴', udr: '├', udl: '┤', udlr: '┼',
  l: '─', r: '─',
}

/**
 * The fan-out from one line at `from` down to boxes centred at `xs`, or the
 * merge back up from them (`isMerge`): `┌──┴──┐` / `└──┬──┘`, each joint
 * drawn by the strokes it has, a box under the line's own end included.
 */
export function branch(width: number, from: number, xs: number[], isMerge = false): string {
  const row = Array.from({ length: Math.max(0, width) }, () => ' ')
  if (xs.length === 0) return row.join('')
  const lo = Math.min(from, ...xs)
  const hi = Math.max(from, ...xs)
  for (let x = lo; x <= hi && x < row.length; x++) {
    const isBox = xs.includes(x)
    const isStem = x === from
    const up = isMerge ? isBox : isStem
    const down = isMerge ? isStem : isBox
    const key = `${up ? 'u' : ''}${down ? 'd' : ''}${x > lo ? 'l' : ''}${x < hi ? 'r' : ''}`
    row[x] = JOINTS[key] ?? '─'
  }
  return row.join('')
}

/** Box centres of `n` boxes of `w` cells, `gap` apart. */
export const centres = (n: number, w: number, gap: number) => Array.from({ length: n }, (_, i) => i * (w + gap) + Math.floor(w / 2))

/**
 * The steps a pulse takes along one line of the diagram (motion.tsx lights
 * one a frame): a row of marks all at once (`down`); out from the stem at
 * `from` to both ends of a fan-out (`out`); in from the ends to the stem on a
 * merge (`in`), `speed` cells a step along the line.
 */
export function pulsePath(text: string, from: number, how: 'down' | 'out' | 'in', speed = 3): number[][] {
  const cells = [...text].flatMap((ch, x) => (ch === ' ' ? [] : [x]))
  if (cells.length === 0) return []
  if (how === 'down') return [cells]
  const reach = Math.max(...cells.map(x => Math.abs(x - from)))
  const out = Array.from({ length: Math.floor(reach / speed) + 1 }, (_, j) => cells.filter(x => Math.floor(Math.abs(x - from) / speed) === j))
  return how === 'out' ? out : out.reverse()
}

/** The moments the family calls an Opus helper at (CLAUDE.md, "Helpers"): a running one's box names its own. */
export const MOMENT_TITLES: Record<Moment, string> = {
  plan: 'before a plan',
  error: 'same error twice',
  push: 'before a push',
  done: 'before done',
}

/** A limit's name: long in the header, short where the pane is narrow. */
export function limitName(kind: string, isShort = false): string {
  const names: Record<string, [string, string]> = { five_hour: ['five hour', '5h'], seven_day: ['seven day', '7d'], spend_limit: ['spend', 'spend'] }
  return names[kind]?.[isShort ? 1 : 0] ?? kind.replace(/_/g, ' ')
}

const WAITING = (c: BoardCard) => c.status.startsWith('waiting') || c.status === 'ready-to-push'

/**
 * What the gates stand before: the repositories a push would send commits
 * from, how many of them are stamped (pre-push lets them through), reviewed
 * (a verdict on HEAD whose reviewer read all the push sends) and both. One
 * with nothing to push asks nothing of them.
 */
export function toPush(repos: RepoRow[]): { repos: RepoRow[]; fresh: number; reviewed: number; ready: number } {
  const waiting = repos.filter(r => (r.ahead ?? 0) > 0)
  const isFresh = (r: RepoRow) => r.check?.isFresh === true
  const isReviewed = (r: RepoRow) => !!r.review?.verdict && r.review.isCurrent && r.review.covers === true
  return {
    repos: waiting,
    fresh: waiting.filter(isFresh).length,
    reviewed: waiting.filter(isReviewed).length,
    ready: waiting.filter(r => isFresh(r) && isReviewed(r)).length,
  }
}

/** The one status line: what claude-hud does not already say. */
export function statusLine(snap: Snapshot | null, running: number, self: string | null = null, mine: { model: string | null; setting: string | null } | null = null): string {
  const parts: string[] = []
  // First, what this session is doing and on which model: planning on Opus, building on Sonnet (opusplan), a wrong one flagged.
  if (mine?.model) {
    const mode = snap?.sessions?.find(x => x.id === self)?.mode ?? null
    const { phase, wrong } = stance(mine.model, mode, mine.setting)
    parts.push(`${phase} ${modelName(mine.model)}${wrong ? ` (want ${wrong})` : ''}`)
  }
  if (snap) {
    // Another session stuck on a prompt first: it waits on the user, and nothing else says so.
    const asking = (snap.sessions ?? []).filter(x => x.status === 'waiting' && x.id !== self).length
    if (asking > 0) parts.push(`${asking} session${asking > 1 ? 's' : ''} waiting`)
    const waiting = snap.board.filter(WAITING).length
    const blocked = snap.board.filter(c => c.status === 'blocked').length
    if (waiting > 0) parts.push(`board ${waiting} waiting`)
    if (blocked > 0) parts.push(`${blocked} blocked`)
  }
  if (running > 0) parts.push(`${running} agent${running > 1 ? 's' : ''}`)
  if (snap) {
    const push = toPush(snap.repos)
    if (push.repos.length > 0) parts.push(`ready to push ${push.ready}/${push.repos.length}`)
    // One figure a family (haiku 4.5 and 5.5 together): the pane has the versions.
    const families = new Map<string, number>()
    for (const d of snap.usage.models) {
      const family = modelName(d.model).split(' ')[0] ?? d.model
      families.set(family, (families.get(family) ?? 0) + total(d))
    }
    const models = [...families].sort((a, b) => b[1] - a[1]).slice(0, 3)
    if (models.length > 0) parts.push(`today ${models.map(([f, n]) => `${f} ${tokens(n)}`).join(' ')}`)
  }
  return parts.length === 0 ? 'harness: reading' : `harness · ${parts.join(' · ')}`
}

// --- reading -----------------------------------------------------------------

// The module's own: a reload starts them over.
let bun: string | null = null
let isReading = false
let isFreshWanted = false
let isActive = false
let isShown = false
let slowAt = 0
let watched = ''
// Each vector bar's last value, so its next drawing slides from it.
const barsShown = new Map<string, number>()
let timers: { cancel: () => void }[] = []
const written = new Map<string, string>()

/** Whether `value` differs from what was last written under `key`, so the panel redraws only when a number moved. */
function isChanged(key: string, value: unknown): boolean {
  const text = JSON.stringify(value)
  if (written.get(key) === text) return false
  written.set(key, text)
  return true
}

async function familyRoot($: EngineInterface): Promise<{ home: string; root: string }> {
  const home = (await $.env.get('HOME')) ?? ''
  return { home, root: (await $.env.get('WOW_ADDONS_ROOT')) ?? `${home}/code/wow-addons` }
}

const isUnder = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`)

/** The other projects' folders (`snapshot.ts --roots`: the config file, HARNESS_ROOTS, the default), read at most every half minute. */
type ProjectDirs = { dir: string; board?: string; events?: string }
let otherRoots: { at: number; dirs: ProjectDirs[] } = { at: 0, dirs: [] }
async function projectRoots($: EngineInterface): Promise<ProjectDirs[]> {
  if (Date.now() - otherRoots.at < 30_000) return otherRoots.dirs
  otherRoots = { at: Date.now(), dirs: [] }
  const { home } = await familyRoot($)
  const parse = (text: string) => {
    const found = (JSON.parse(text) as { roots?: Partial<ProjectDirs>[] }).roots
    return (Array.isArray(found) ? found : []).flatMap(r => (typeof r.dir === 'string' ? [{ dir: r.dir, board: r.board, events: r.events }] : []))
  }
  // The list the last snapshot kept (cat: no bun starts in a session outside the projects); bun only when no snapshot has run yet.
  try {
    const ran = await $.process.run(['/bin/cat', `${home}/.cache/harness-view/roots.json`], { timeoutMs: 3_000 })
    if (ran.exitCode === 0) {
      otherRoots.dirs = parse(ran.stdout)
      return otherRoots.dirs
    }
  } catch {}
  for (const candidate of bun ? [bun] : ['bun', `${home}/.volta/bin/bun`, `${home}/.bun/bin/bun`, '/opt/homebrew/bin/bun']) {
    try {
      const ran = await $.process.run([candidate, `${$.plugin.root}/bin/snapshot.ts`, '--roots'], { timeoutMs: 10_000 })
      if (ran.exitCode !== 0) continue
      otherRoots.dirs = parse(ran.stdout)
      break
    } catch {}
  }
  return otherRoots.dirs
}

/** Only a session working in the family folder, or in another project the pane reads, shows the harness. */
async function isFamilySession($: EngineInterface): Promise<boolean> {
  const [{ root }, project] = await Promise.all([familyRoot($), $.session.root()])
  if (isUnder(root, project)) return true
  return (await projectRoots($)).some(p => isUnder(p.dir, project))
}

async function runSnapshot($: EngineInterface, isFresh: boolean): Promise<Snapshot> {
  const { home } = await familyRoot($)
  // (the projects are the snapshot's to resolve: --root here would name the family alone)
  const named = await $.env.get('WOW_ADDONS_ROOT')
  const script = `${$.plugin.root}/bin/snapshot.ts`
  const candidates = bun ? [bun] : ['bun', `${home}/.volta/bin/bun`, `${home}/.bun/bin/bun`, '/opt/homebrew/bin/bun']
  let lastError = 'bun not found'
  for (const candidate of candidates) {
    try {
      const argv = [candidate, script, ...(named ? ['--root', named] : []), ...(isFresh ? ['--fresh'] : [])]
      const ran = await $.process.run(argv, { timeoutMs: 60_000 })
      bun = candidate
      if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').slice(-1)[0] || `exit ${ran.exitCode}`)
      return JSON.parse(ran.stdout) as Snapshot
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (bun === candidate) break
    }
  }
  throw new Error(lastError)
}

async function refreshSnapshot($: EngineInterface, isFresh = false) {
  // A fresh read asked for during another (a Refresh, a line in the log) runs once that one is done.
  if (isReading) {
    isFreshWanted ||= isFresh
    return
  }
  isReading = true
  try {
    // A headless run (claude -p) never draws: no snapshot until a surface attaches.
    if ((await $.session.surfaces()).length === 0) return
    const snap = await runSnapshot($, isFresh)
    // A read that changed nothing but its own time draws nothing again (the motion would restart on the desktop).
    if (isChanged('snapshot', { ...snap, at: 0 })) await update($, snapshot, () => snap)
    if (isChanged('snapshotError', null)) await update($, snapshotError, () => null)
  } catch (error) {
    const text = error instanceof Error ? error.message.slice(0, 200) : String(error)
    if (isChanged('snapshotError', text)) await update($, snapshotError, () => text)
  } finally {
    isReading = false
  }
  await refreshStatus($)
  if (isFreshWanted) {
    isFreshWanted = false
    await refreshSnapshot($, true)
  }
}

/** A session's row pressed: the desktop app opens it from its own link (`open` hands it the claude: URL). */
async function openSession($: EngineInterface, link: string) {
  if (!/^claude:\/\/claude\.ai\/epitaxy\/[\w-]+$/.test(link)) return
  await $.process.run(['/usr/bin/open', link], { timeoutMs: 10_000 })
}

/** Whether the pane is drawn in front: the live pace's condition. */
async function refreshShown($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => [])
  isShown = panes.some(p => p.id === PANE && p.isShown && p.isPlaced)
  return isShown
}

/** The shared numbers at the live pace while the pane is shown, at the slow one while it is not. */
async function pace($: EngineInterface) {
  const now = await $.clock.now()
  if (!(await refreshShown($)) && now - slowAt < SNAPSHOT_MS) return
  slowAt = now
  await refreshSnapshot($)
}

/**
 * The event log (every check, review, card and hook refusal appends to it),
 * the q.ts runs going on beside it (`running/`, a file each) and the board's
 * folder, a stat each: a change reads every number anew at once, the
 * repositories' rows too (a stamp or a verdict rewritten in place moves no
 * mark the shared reads look at), so the pane shows it within a second of
 * its tool writing it.
 */
async function watch($: EngineInterface) {
  if (!isShown) return
  const [{ root }, events] = await Promise.all([familyRoot($), $.env.get('HARNESS_EVENTS')])
  if (events === 'off') return
  const log = events || `${root}/.cache/harness/events.log`
  const watching = (file: string) => [file, `${file.slice(0, file.lastIndexOf('/'))}/running`]
  // (the other projects' own logs and boards, once their folders are known: `--roots`, read when the pane opens)
  const others = (await projectRoots($)).filter(p => p.dir !== root)
  const paths = [log, `${log.slice(0, log.lastIndexOf('/'))}/running`, `${root}/board`, ...others.flatMap(p => [...watching(p.events ?? `${p.dir}/.harness/cache/events.log`), p.board ?? `${p.dir}/.harness/board`])]
  const seen = (await Promise.all(paths.map(path => $.fs.stat(path).then(s => `${s.size}:${s.mtimeMs}`, () => '-')))).join('|')
  if (seen === watched) return
  const isFirst = watched === ''
  watched = seen
  if (!isFirst) await refreshSnapshot($, true)
}

async function setTurn($: EngineInterface, isRunning: boolean) {
  const at = isRunning ? await $.clock.now() : null
  if (isChanged('turn', isRunning)) await update($, turn, () => ({ isRunning, at }))
}

async function refreshSession($: EngineInterface, lastModel?: string, lastEffort?: string) {
  const [id, model, usage, previous, settings, subagentModel] = await Promise.all([
    $.session.id().catch(() => null),
    $.session.model(),
    $.session.usage(),
    read($, session),
    $.settings.read().catch(() => ({}) as Record<string, unknown>),
    $.env.get('CLAUDE_CODE_SUBAGENT_MODEL'),
  ])
  const s = settings as { model?: unknown; effortLevel?: unknown; permissions?: { defaultMode?: unknown; ask?: unknown } }
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const facts: SessionFacts = {
    id,
    model,
    lastModel: lastModel ?? previous?.lastModel ?? null,
    contextTokens: usage.context.tokens ?? null,
    window: usage.context.window,
    percent: usage.context.percent ?? null,
    costUsd: usage.cost?.usd ?? null,
    rateLimits: (usage.rateLimits ?? []).map(l => {
      const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : Number.NaN
      return { kind: l.kind, percentUsed: l.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
    }),
    settings: {
      model: text(s.model),
      mode: text(s.permissions?.defaultMode),
      // The last main-loop call's effort, else the settings' (none: the model's default).
      effort: lastEffort ?? previous?.settings?.effort ?? text(s.effortLevel),
      asks: Array.isArray(s.permissions?.ask) ? s.permissions.ask.length : 0,
      subagentModel: text(subagentModel),
    },
  }
  if (isChanged('session', facts)) await update($, session, () => facts)
}

async function refreshAgents($: EngineInterface) {
  const [list, counted, was] = await Promise.all([$.agent.list(), read($, steps), read($, agents)])
  const rows: AgentRow[] = list.map(a => ({
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status,
    steps: counted[a.id] ?? null,
  }))
  if (isChanged('agents', rows)) await update($, agents, () => rows)
  // A helper that was running and isn't now (done, failed, stopped, gone) hands back to the lead.
  const back = was.find(a => a.status === 'running' && rows.find(r => r.id === a.id)?.status !== 'running')
  if (back) {
    const at = await $.clock.now()
    await update($, handback, () => ({ at, type: back.type }))
    handbackTimer?.cancel()
    handbackTimer = $.clock.after(HANDBACK_MS, () => void update($, handback, () => null).catch(() => {}))
  }
  await refreshStatus($)
}

async function refreshStatus($: EngineInterface) {
  const [snap, rows, facts] = await Promise.all([read($, snapshot), read($, agents), read($, session)])
  const line = statusLine(snap, rows.filter(a => a.status === 'running').length, facts?.id ?? null, facts ? { model: facts.lastModel ?? facts.model, setting: facts.settings.model } : null)
  if (isChanged('status', line)) $.ui.status(line)
}

/**
 * Starts the mod's work in a family session and stops it anywhere else; true
 * when it started now. Read again after the start: the desktop starts a
 * session in a spare folder of its own (`~/.claude/spares/`) and moves it to
 * the folder picked afterwards, with no new start.
 */
async function gate($: EngineInterface, isStart = false): Promise<boolean> {
  const isFamily = await isFamilySession($).catch(() => false)
  if (isFamily === isActive && !isStart) return false
  // Decided and the timers swapped with no await between, so two reads at once start them once.
  isActive = isFamily
  for (const timer of timers) timer.cancel()
  timers = []
  handbackTimer?.cancel()
  handbackTimer = null
  // (a handback whose timer was just cancelled would stay lit; an old session's running rows would hand back falsely)
  void update($, handback, () => null).catch(() => {})
  written.delete('agents')
  void update($, agents, () => []).catch(() => {})
  if (!isActive) {
    if (written.delete('status')) $.ui.status(undefined)
    return false
  }
  timers = [
    $.clock.every(LIVE_MS, () => void pace($).catch(() => {})),
    $.clock.every(WATCH_MS, () => void watch($).catch(() => {})),
    $.clock.every(AGES_MS, () => {
      if (isShown) void update($, tick, n => n + 1).catch(() => {})
    }),
    $.clock.every(SESSION_MS, () => {
      void refreshSession($).catch(() => {})
      void refreshAgents($).catch(() => {})
    }),
  ]
  await $.command.register({
    name: 'harness',
    description: 'Open the harness panel: session, subagents, board, checks, usage today',
  })
  void refreshSnapshot($).catch(() => {})
  void refreshSession($).catch(() => {})
  void refreshAgents($).catch(() => {})
  void $.ui
    .open({ id: PANE, title: TITLE })
    .then(() => refreshShown($))
    .catch(() => {})
  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await gate($, true).catch(() => {})

    return next(e)
  })

  // A desktop session moved out of its spare folder: the gate opens before the prompt's turn.
  on('prompt.submit', async ($, e, next) => {
    await gate($).catch(() => {})

    return next(e)
  })

  on('command.run', { command: 'harness' }, async $ => {
    void refreshSnapshot($, true).catch(() => {})
    try {
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      return { text: opened.isPlaced ? 'Harness panel opened.' : `Harness panel not drawn: ${opened.reason}` }
    } catch (error) {
      return { text: `Harness panel refused: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  // The desktop attaches after the session starts: read at once, not at the next tick.
  on('session.attach', async ($, e, next) => {
    void gate($)
      .then(isStarted => {
        if (isActive && !isStarted) void refreshSnapshot($).catch(() => {})
      })
      .catch(() => {})

    return next(e)
  })

  // Each model call, as it ends: the main loop's model, a subagent's tokens.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!isActive) return result
    try {
      const usage = result?.usage
      if (e.agentId === undefined) {
        const effort = typeof e.effort === 'string' ? e.effort : undefined
        void refreshSession($, usage?.model ?? e.model, effort).catch(() => {})
      } else if (usage) {
        const id = e.agentId
        const context = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        void update($, steps, all => {
          const was: AgentSteps | undefined = all[id]
          return {
            ...all,
            [id]: {
              model: usage.model || e.model,
              steps: (was?.steps ?? 0) + 1,
              context,
              output: (was?.output ?? 0) + usage.output_tokens,
            },
          }
        })
          .then(() => refreshAgents($))
          .catch(() => {})
      }
    } catch {}
    return result
  })

  // The main loop's turn: the diagram's lines pulse from its start to its end.
  on('turn.start', async ($, e, next) => {
    if (isActive) void setTurn($, true).catch(() => {})

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!isActive) return next(e)
    if (e.agentId === undefined) void setTurn($, false).catch(() => {})
    void refreshSession($).catch(() => {})
    void refreshAgents($).catch(() => {})

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button } = table
    // Every text cut at its end, never wrapped, its styled runs too: the
    // desktop draws a Text with no wrap as wrapping text, inside a cut one as well.
    const Text = (props: Parameters<typeof table.Text>[0]) => table.Text({ wrap: 'truncate-end', ...props })
    // Every table names every element, a surface's missing ones drawing nothing: chosen by the surface.
    // The editor and the phone draw no Client: their moving parts stand still.
    const Client = (e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in table ? table.Client : undefined
    // The desktop draws an Svg: the bars and the diagram's lines are vector there. Its renderer
    // is the one read (README, "The desktop's paint"): the editor's and the phone's are not, they keep characters.
    const Svg = e.surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
    // A row between stacked boxes: the desktop's vertical unit is half a line.
    const gapY = e.surface === 'desktop' ? 2 : GAP_Y
    const [snap, error, facts, rows, work, back] = await Promise.all([
      read($, snapshot),
      read($, snapshotError),
      read($, session),
      read($, agents),
      read($, turn),
      read($, handback),
      read($, tick),
    ])
    const now = await $.clock.now()
    const W = Math.max(32, e.props.bodyColumns)
    const tier = W >= 96 ? 'wide' : W >= 64 ? 'medium' : 'narrow'

    // --- motion ------------------------------------------------------------
    // A moving part, drawn by motion.tsx on the drawing thread, or the same standing still.
    const still = (key: string, p: MotionProps) => {
      switch (p.kind) {
        case 'spin':
          return (
            <Text key={key} color={p.color} dimColor={!p.on}>
              {p.on ? '⠋' : (p.idle ?? '·')}
            </Text>
          )
        case 'live':
          return (
            <Text key={key} color={p.color}>
              {p.label ? `● ${p.label}` : '●'}
            </Text>
          )
        case 'flow':
          return (
            <Text key={key} color={p.base ?? p.color} dimColor={p.base === undefined} wrap="truncate-end">
              {p.text}
            </Text>
          )
        case 'bar': {
          const b = bar(p.value, p.max, p.width, p.rest)
          return (
            <Text key={key} wrap="truncate-end">
              <Text color={p.color}>{b.filled}</Text>
              <Text color={p.color} dimColor>
                {b.empty}
              </Text>
            </Text>
          )
        }
        case 'count':
          return (
            <Text key={key} color={p.color} bold={p.bold} dimColor={p.dim}>
              {p.unit === 'int' ? String(Math.round(p.value)) : tokens(p.value)}
            </Text>
          )
        case 'fresh':
          return (
            <Text key={key} color={p.settled ?? p.color}>
              {p.mark ?? ' '}
            </Text>
          )
        case 'ago':
          return (
            <Text key={key} dimColor>
              {`${p.label ?? ''}${ago(p.at, now)} ago`}
            </Text>
          )
      }
    }
    const motion = (key: string, p: MotionProps) => (Client ? <Client key={key} module="./motion.tsx" props={p} /> : still(key, p))
    // A bar: vector where the surface draws an Svg (block characters overflow a desktop cell), else rolling characters.
    const barOf = (key: string, value: number, max: number, width: number, color: string) => {
      if (!Svg) return motion(key, { kind: 'bar', value, max, width, rest: '▒', color })
      const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
      const from = barsShown.get(key) ?? 0
      barsShown.set(key, share)
      return (
        <Box key={key} width={width} flexShrink={0} alignItems="center">
          <Svg source={barSvg(share, from, color)} alt={`${Math.round(share * 100)}%`} height={BAR_PX} />
        </Box>
      )
    }
    const running = rows.filter(a => a.status === 'running')
    // Work flows down the diagram while the main loop's turn runs or a helper does; out to the helpers while one runs.
    const isDelegating = running.length > 0
    const isWorking = work.isRunning || isDelegating
    // The gates at work: a q.ts run going on, in any session (the hooks are done in an instant).
    const gates = snap?.gates ?? []
    const isGating = gates.length > 0
    // A helper just handed back: the way back to the lead lights up a few seconds (HANDBACK_MS).
    const isReturning = back !== null
    // A spinner inside a line's words: `words [ ⠋ ]`.
    const spinning = (key: string, before: string, isOn: boolean, color: string, props: { dim?: boolean; color?: string; bold?: boolean } = {}, after = ' ]') => (
      <Box key={key}>
        {line(before, props)}
        {motion(`${key}-spin`, { kind: 'spin', on: isOn, color, idle: '-' })}
        {line(after, props)}
      </Box>
    )

    // --- the parts ---------------------------------------------------------
    // A box of the diagram: its border in its colour (dashed for the main
    // session's, as in the mock-up), a column of padding each side.
    // A box. On the desktop its border is four vector edges, at rest as at work
    // (one frame, so it keeps its size as work starts), a comet lapping them
    // while it works (`running`, its height in lines about). In the terminal
    // the terminal's own border, a comet on its top and bottom edges while it works.
    const frame = (key: string, w: number, color: string, children: RenderChildren, opts: { dashed?: boolean; middle?: boolean; running?: { lines: number } } = {}) => {
      if (Svg) {
        const edge = { cells: w, lines: opts.running?.lines ?? 6, color, nowMs: now, isRunning: opts.running !== undefined, isDashed: opts.dashed }
        return (
          <Box key={key} flexDirection="column" width={w} flexShrink={0}>
            <Svg source={edgeSvg('top', edge)} alt="a box's top edge" height={EDGE_PX} />
            {/* Stretched, not centred: the sides take the row's height (a row with no alignItems centres an image). */}
            <Box alignItems="stretch" flexGrow={1}>
              <Svg source={edgeSvg('left', edge)} alt="its left edge" width={SIDE_PX} />
              <Box flexDirection="column" flexGrow={1} minWidth={0} paddingX={1} justifyContent={opts.middle ? 'center' : 'flex-start'}>
                {children}
              </Box>
              <Svg source={edgeSvg('right', edge)} alt="its right edge" width={SIDE_PX} />
            </Box>
            <Svg source={edgeSvg('bottom', edge)} alt="its bottom edge" height={EDGE_PX} />
          </Box>
        )
      }
      // At work (and a Client to draw it), the border dims and its top and bottom
      // edges are laid over it, a comet on each: the top's left to right, the
      // bottom's right to left, so the pair turns the box round. The motion module
      // draws them, the pane doesn't redraw. (On a plain Box at top 0 and bottom 0:
      // one at top -1 inside a bordered Box isn't drawn.)
      const isLapped = opts.running !== undefined && Client !== undefined
      const bordered = (
        <Box
          key={isLapped ? `${key}-frame` : key}
          flexDirection="column"
          width={w}
          flexShrink={0}
          flexGrow={isLapped ? 1 : undefined}
          paddingX={1}
          justifyContent={opts.middle ? 'center' : 'flex-start'}
          borderStyle={opts.dashed ? 'dashed' : 'single'}
          borderColor={color}
          borderDimColor={isLapped ? true : undefined}
        >
          {children}
        </Box>
      )
      if (!isLapped || !opts.running) return bordered
      const across = Array.from({ length: w }, (_, x) => [x])
      // (the comet's way across, its tail out of sight, a pause as long as the box's sides)
      const cycle = w + COMET_TAIL + Math.max(2, opts.running.lines)
      const edge = (side: 'top' | 'bottom') =>
        motion(`${key}-${side}`, {
          kind: 'flow',
          text: edgeText(w, opts.dashed === true, side),
          path: side === 'top' ? across : [...across].reverse(),
          start: 0,
          cycle,
          on: true,
          color,
          tail: COMET_TAIL,
        })
      return (
        <Box key={key} flexDirection="column" width={w} flexShrink={0}>
          {bordered}
          <Box position="absolute" top={0} left={0} width={w}>
            {edge('top')}
          </Box>
          <Box position="absolute" bottom={0} left={0} width={w}>
            {edge('bottom')}
          </Box>
        </Box>
      )
    }
    // A centred box's lines, on a layer as wide as the box: the desktop sizes a
    // centred column to its widest line, uncut. Not a fragment: the engine
    // makes one a column Box of its own, which the centring would size so.
    // (Used in place of <> by the helpers' boxes.)
    const line = (text: string, props: { color?: string; bold?: boolean; dim?: boolean; inverse?: boolean } = {}) => (
      <Text color={props.color} bold={props.bold} dimColor={props.dim} inverse={props.inverse} wrap="truncate-end">
        {text}
      </Text>
    )
    // A line of styled runs as texts side by side: on the desktop a run inside
    // a text is a box of its own, off the line's baseline. A `fixed` run keeps
    // its width, the others are cut first.
    type Run = [text: string, style: { color?: string; bold?: boolean; dim?: boolean; inverse?: boolean; fixed?: boolean }]
    /** Where an item of a project other than the family's says so, once the pane reads several projects (the family's own are the pane's default). */
    const projectChip = (project: string | undefined): Run | null => (snap?.projects && project && !snap.projects.find(p => p.name === project)?.isFamily ? [`${project} · `, { color: PALETTE.ask, fixed: true }] : null)
    const runs = (key: string, parts: (Run | null)[]) => (
      <Box key={key} minWidth={0}>
        {parts
          .filter((part): part is Run => part !== null)
          .map(([text, st], i) => {
            const t = (
              <Text key={`${key}-${i}`} color={st.color} bold={st.bold} dimColor={st.dim} inverse={st.inverse}>
                {text}
              </Text>
            )
            return st.fixed ? (
              <Box key={`${key}-${i}-fixed`} flexShrink={0}>
                {t}
              </Box>
            ) : (
              t
            )
          })}
      </Box>
    )
    const cell = (w: number, child: RenderChildren, isRight = false) => (
      <Box width={w} flexShrink={0} justifyContent={isRight ? 'flex-end' : 'flex-start'}>
        {child}
      </Box>
    )
    // A row's last figure against the box's right edge, as a pair's value sits: a fixed cell
    // falls short of it on the desktop, whose font is proportional.
    const flush = (w: number, child: RenderChildren) => (
      <Box minWidth={w} flexGrow={1} flexShrink={0} justifyContent="flex-end">
        {child}
      </Box>
    )
    // A label, its value right-aligned in its colour: the mock-up's `calls  2 / 3`; a value may be a rolling figure.
    const pair = (key: string, label: string, value: RenderChildren, color: string) => (
      <Box key={key} justifyContent="space-between">
        <Text dimColor wrap="truncate-end">
          {label}
        </Text>
        {typeof value === 'string' ? (
          <Text color={color} wrap="truncate-end">
            {value}
          </Text>
        ) : (
          value
        )}
      </Box>
    )
    const meter = (key: string, label: string, labelW: number, value: number, max: number, barW: number, figure: string, color: string, figureW: number) => (
      <Box key={key}>
        {cell(labelW, line(label, { bold: true }))}
        {barOf(`${key}-bar`, value, max, barW, color)}
        {cell(figureW + 1, line(figure, { color, bold: true }), true)}
      </Box>
    )

    // --- the numbers ---------------------------------------------------------
    const helpers = snap?.helpers ?? []
    const day = snap?.helperDay ?? {}
    const events = snap?.events ?? []
    const repos = snap?.repos ?? []
    const board = snap?.board ?? []
    const live = snap?.sessions ?? []
    const selfId = facts?.id ?? null
    // A card's session as board.ts writes it, the session's id (an older card's may be a name, which matches nothing).
    const isSessionId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    // A running card whose session is no longer live still holds its repositories (board.ts): said so, for the user to move.
    const isGone = (c: BoardCard) => c.status === 'running' && isSessionId(c.session) && !!snap?.sessions && !live.some(x => x.id === c.session)
    const models = snap?.usage.models ?? []
    const builder = facts ? (facts.lastModel ?? facts.model) : null
    const builderName = builder ? modelName(builder) : 'main'
    const builderColor = modelColor(builder)
    const fresh = repos.filter(r => r.check?.isFresh).length
    const push = toPush(repos)
    const pushing = push.repos.length
    const waiting = board.filter(WAITING).length
    const dayTotal = models.reduce((sum, d) => sum + total(d), 0)
    const cacheRead = models.reduce((sum, d) => sum + d.cacheRead, 0)
    const lastHandback = events.find(ev => ev.source === 'helper' && ev.tokens !== undefined)

    // --- header --------------------------------------------------------------
    // The harness's own top, no box: its name, when the numbers last changed and
    // Refresh, then the plan's limits as meters (green, amber from 80%, red from
    // 95%), each with its reset, and a rule under it all. Past 80% the title says
    // the fullest window. Under 64 columns the limits stack, their names short.
    const mine = live.find(x => x.id === selfId)
    const { phase, wrong } = stance(builder, mine?.mode, facts?.settings.model)
    const limits = facts?.rateLimits ?? []
    const worst = limits.reduce<(typeof limits)[number] | null>((a, l) => (!a || l.percentUsed > a.percentUsed ? l : a), null)
    const limitColor = (pct: number) => (pct >= 95 ? PALETTE.fail : pct >= 80 ? PALETTE.wait : PALETTE.ok)
    const isShort = W < 64
    const limitGap = 4
    // Each meter's columns: its name as long as the longest, the figure, the reset (kept when a window says none: the
    // bars line up), a bar of 8 at least. Side by side while they fit, else stacked.
    const limitLabelW = Math.min(16, Math.max(2, ...limits.map(l => limitName(l.kind, isShort).length)) + 1)
    const sideW = limits.length === 0 ? W : Math.floor((W - limitGap * (limits.length - 1)) / limits.length)
    const isStacked = isShort || sideW < limitLabelW + 5 + 10 + 8
    const limitW = isStacked ? W : sideW
    const limitMeter = (l: (typeof limits)[number], i: number) => {
      const color = limitColor(l.percentUsed)
      const labelW = limitLabelW
      const figureW = 5
      const resetW = 10
      const barW = Math.max(3, limitW - labelW - figureW - resetW)
      return (
        <Box key={`limit-${l.kind}`} width={limitW} flexShrink={0} marginLeft={!isStacked && i > 0 ? limitGap : 0}>
          {cell(labelW, line(limitName(l.kind, isShort), { dim: true }))}
          {barOf(`limit-${l.kind}-bar`, l.percentUsed, 100, barW, color)}
          {cell(figureW, line(`${Math.round(l.percentUsed)}%`, { color, bold: true }), true)}
          {cell(resetW, line(l.resetsAt ? ` · ${resetIn(l.resetsAt - now)}` : '', { dim: true }))}
        </Box>
      )
    }
    // The rule under the header: a line of the diagram's kind, vector on the desktop (characters overflow its cells).
    const rule = Svg ? (
      <Box key="rule" width={W} flexShrink={0}>
        <Svg source={lineSvg({ text: '─'.repeat(W), how: 'down', at: 0, color: 'inactive', base: 'inactive', on: false, from: 0, to: 0, cycleMs: 0, phaseMs: 0 })} alt="the header's rule" height={LINE_PX} />
      </Box>
    ) : (
      <Text key="rule" dimColor>
        {'─'.repeat(W)}
      </Text>
    )
    const header = (
      <Box key="header" flexDirection="column" width={W}>
        <Box justifyContent="space-between" alignItems="center" width={W}>
          {runs('title', [
            [isShort ? 'HARNESS' : snap?.projects ? 'HARNESS · ' + snap.projects.map(p => p.name.toUpperCase()).join(' + ') : 'WOW-ADDONS HARNESS', { bold: true, fixed: true }],
            worst && worst.percentUsed >= 80 ? [` · ${limitName(worst.kind, isShort)} at ${Math.round(worst.percentUsed)}%`, { color: limitColor(worst.percentUsed), bold: true }] : null,
          ])}
          <Box flexShrink={0} alignItems="center">
            {snap ? motion('updated', { kind: 'ago', at: snap.at, label: isShort ? '' : 'changed ' }) : <Text dimColor>reading…</Text>}
            <Text> </Text>
            <Button key="refresh" label="Refresh" onPress={() => void refreshSnapshot($, true)} />
          </Box>
        </Box>
        <Box width={W} flexDirection={isStacked ? 'column' : 'row'}>
          {limits.length > 0 ? limits.map(limitMeter) : line(facts ? 'limits: none read yet' : 'limits: …', { dim: true })}
        </Box>
        {rule}
      </Box>
    )

    // --- the main session ------------------------------------------------------
    // This session, laid out as the other boxes are: what it does and on which
    // model (its title after, cut first), its state on the right; the context
    // as a meter to the edge; the effort, and the cost on the right.
    const sessionBox = (w: number) => {
      const inner = w - 4
      const labelW = 9
      const figureW = 14
      const barW = Math.max(4, inner - labelW - figureW)
      // The state beside the title where both fit (the title's fixed runs, a helper or two running), else a line of its own.
      const isStateBeside = inner >= 60
      const effort = facts?.settings.effort ?? null
      const effortLevel = effort ? Math.max(1, ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(effort) + 1) : 0
      const state =
        running.length > 0
          ? spinning('session-state', `[ ${running.map(a => a.type).join(', ')} running `, true, PALETTE.wait, { color: PALETTE.wait })
          : work.isRunning
            ? spinning('session-state', '[ working ', true, builderColor, { color: builderColor })
            : line('[ idle ]', { dim: true })
      return frame(
        'session',
        w,
        builderColor,
        <>
          <Box justifyContent="space-between">
            {runs('session-title', [
              [phase.toUpperCase(), { color: wrong ? PALETTE.fail : builderColor, bold: true, fixed: true }],
              [' · ', { dim: true, fixed: true }],
              [builderName.toUpperCase(), { color: builderColor, bold: true, fixed: true }],
              wrong ? [` · WANT ${wrong.toUpperCase()}`, { color: PALETTE.fail, bold: true, fixed: true }] : null,
              mine?.name && inner >= 56 ? [` · ${mine.name}`, { dim: true }] : null,
            ])}
            {isStateBeside ? (
              <Box flexShrink={0} marginLeft={1}>
                {state}
              </Box>
            ) : null}
          </Box>
          {isStateBeside ? null : state}
          <Box key="context">
            {cell(labelW, line('context', { dim: true }))}
            {barOf('context-bar', facts?.contextTokens ?? 0, facts?.window ?? 0, barW, builderColor)}
            {flush(
              figureW,
              <Box key="context-figure">
                {facts ? motion('context-tokens', { kind: 'count', value: facts.contextTokens ?? 0, bold: true }) : <Text bold>…</Text>}
                <Text bold>{facts ? ` / ${tokens(facts.window)}` : ''}</Text>
              </Box>,
            )}
          </Box>
          <Box key="effort">
            {cell(labelW, line('effort', { dim: true }))}
            {runs('effort-level', [
              ['■'.repeat(effortLevel), { color: builderColor }],
              ['■'.repeat(5 - effortLevel), { dim: true }],
              [` ${effort ? effort.toUpperCase() : 'DEFAULT'}`, { bold: true, color: builderColor }],
            ])}
            {flush(9, line(facts?.costUsd != null ? `$${facts.costUsd.toFixed(2)}` : '', { dim: true }))}
          </Box>
        </>,
        { dashed: true, running: work.isRunning ? { lines: 5 } : undefined },
      )
    }

    // --- the gates: what runs in code ------------------------------------------
    // At work only while a q.ts run goes on (the turn's pulse comes down to them
    // all the same): its spinner turns, its border runs, the run is named. Its
    // meters count what waits to be pushed alone (the repositories' box has them all).
    const gateMeter = (key: string, value: number, word: string, labelW: number, barW: number, figureW: number) =>
      meter(key, key, labelW, value, Math.max(pushing, 1), barW, pushing > 0 ? `${value}/${pushing} ${word}` : '—', value < pushing ? PALETTE.wait : PALETTE.gate, figureW)
    const gatesBox = (w: number) => {
      const inner = w - 4
      const [labelW = 10, figureW = 12] = fit([10, 12], inner, 6)
      const barW = Math.max(4, inner - labelW - figureW - 1)
      return frame(
        'gates',
        w,
        PALETTE.gate,
        <>
          <Box justifyContent="space-between">
            {spinning('gates-state', inner >= 48 ? 'GATES · q · hooks · review [ ' : 'GATES [ ', isGating, PALETTE.gate, { bold: true, color: PALETTE.gate })}
            {pushing > 0 ? (
              <Box key="to-push">
                <Text dimColor>to push </Text>
                {motion('to-push', { kind: 'count', value: pushing, unit: 'int', bold: true })}
              </Box>
            ) : (
              <Box key="to-push">
                <Text dimColor>nothing to push</Text>
              </Box>
            )}
          </Box>
          {pushing > 0 ? gateMeter('checks', push.fresh, 'fresh', labelW, barW, figureW) : null}
          {pushing > 0 ? gateMeter('reviews', push.reviewed, 'current', labelW, barW, figureW) : null}
          {gates[0]
            ? runs('gate-run', [
                [`q ${gates[0].name}`, { color: PALETTE.gate, bold: true }],
                [` · ${gates[0].repo}`, { dim: true }],
                gates.length > 1 ? [` +${gates.length - 1}`, { dim: true, fixed: true }] : null,
              ])
            : null}
        </>,
        { running: isGating ? { lines: 6 } : undefined },
      )
    }

    // --- the helpers: running ones first, then the family's -------------------
    const helperBoxes = (w: number, k: number) => {
      const gap = GAP_X
      const bw = Math.floor((w - gap * (k - 1)) / k)
      const seen = new Set<string>()
      const picks: { name: string; model: string | null; description: string; agent?: AgentRow }[] = []
      for (const a of running) {
        if (picks.length < k && !seen.has(a.type)) {
          seen.add(a.type)
          const def = helpers.find(h => h.name === a.type)
          picks.push({ name: a.type, model: a.steps?.model ?? day[a.type]?.model ?? def?.model ?? null, description: a.description, agent: a })
        }
      }
      // Then the others, the Opus ones among them, the busiest today first (by runs, then the latest).
      const rest = helpers
        .filter(h => !seen.has(h.name))
        .map(h => ({ name: h.name, model: day[h.name]?.model ?? h.model, description: h.description }))
      for (const [name, d] of Object.entries(day)) if (!seen.has(name) && !rest.some(r => r.name === name)) rest.push({ name, model: d.model, description: '' })
      rest.sort((a, b) => (day[b.name]?.runs ?? 0) - (day[a.name]?.runs ?? 0) || (day[b.name]?.lastAt ?? 0) - (day[a.name]?.lastAt ?? 0))
      // Only those that worked today: an idle helper that never ran says nothing.
      for (const r of rest) if (picks.length < k && (day[r.name]?.runs ?? 0) > 0) picks.push(r)
      // Fewer boxes than room: centred, the middle one (an odd count) right under the line.
      const n = Math.max(1, picks.length)
      const used = n * bw + (n - 1) * gap
      const packed = centres(n, bw, gap)
      const offset = Math.max(0, Math.min(w - used, n % 2 === 1 ? Math.floor(w / 2) - (packed[Math.floor(n / 2)] ?? 0) : Math.floor((w - used) / 2)))
      const xs = picks.length === 0 ? [] : packed.map(x => x + offset)
      const boxes = (
        <Box key="helpers" width={w} paddingLeft={offset}>
          {picks.map((p, i) => {
            const color = modelColor(p.model)
            const today = day[p.name]
            const model = p.model ? modelName(p.model) : 'model ?'
            const moment = p.agent ? momentOf(p.name, p.description) : null
            return (
              <Box key={`helper-${p.name}`} marginLeft={i > 0 ? gap : 0}>
                {frame(
                  `helper-${p.name}`,
                  bw,
                  color,
                  <Box flexDirection="column" alignItems="center" width="100%">
                    {/* A running Opus helper says the moment it was called at (the reviewer's the push, the architect's by its brief). */}
                    {moment ? runs(`helper-${p.name}-name`, [[p.name, { bold: true, fixed: true }], [` · ${MOMENT_TITLES[moment]}`, { color: PALETTE.opus }]]) : line(p.name, { bold: true })}
                    {p.agent ? spinning(`helper-${p.name}-state`, `${model} [ running `, true, color, { color }) : line(`${model} [ IDLE ]`, { color })}
                    {line(
                      p.agent?.steps
                        ? `● ctx ${tokens(p.agent.steps.context)} · ${p.agent.steps.steps} calls`
                        : `● ${today?.runs ?? 0} ${today?.runs === 1 ? 'run' : 'runs'} · ${tokens(today?.tokens ?? 0)} tok`,
                      { color },
                    )}
                  </Box>,
                  { running: p.agent ? { lines: 5 } : undefined },
                )}
              </Box>
            )
          })}
        </Box>
      )
      return { boxes, xs, count: picks.length, names: picks.map(p => p.name), isRunning: picks.map(p => p.agent !== undefined) }
    }

    // Back to the lead: at work while a helper's handback comes in, its figures once the shared numbers have them.
    // One row, as the session's box: the title, the handback on the right; two lines where the pane is narrow.
    const backBox = (w: number) => {
      // (the shared numbers have it once an end of that helper's type comes in no earlier than a little before it:
      // the whole family's events, so an earlier run of the same helper must not pass for this one)
      const isKnown = !!back && !!lastHandback && lastHandback.text.startsWith(`${back.type} `) && lastHandback.at >= back.at - 10_000
      const title = line(`back to ${builderName} · lead`, { bold: true, color: builderColor })
      const rx =
        back && !isKnown
          ? spinning('back-state', `rx: ${back.type} · handing back [ `, true, builderColor)
          : lastHandback
            ? spinning('back-state', `rx: ${lastHandback.text.split(' ')[0]} · ${tokens(lastHandback.tokens)} tok · ${duration(lastHandback.ms ?? 0)} [ `, isReturning, builderColor)
            : null
      return frame(
        'back',
        w,
        builderColor,
        w - 4 >= 60 ? (
          <Box justifyContent="space-between">
            <Box flexShrink={0}>{title}</Box>
            <Box minWidth={0} marginLeft={1}>
              {rx}
            </Box>
          </Box>
        ) : (
          <>
            {title}
            {rx}
          </>
        ),
        { dashed: true, running: isReturning ? { lines: 3 } : undefined },
      )
    }

    // The flow under the main session: the gates, the helpers, back to the lead.
    const flow = (w: number, from: number) => {
      const c = Math.floor(w / 2)
      const k = w >= 100 ? 4 : w >= 66 ? 3 : w >= 40 ? 2 : 1
      const fan = helperBoxes(w, k)
      const ends = fan.xs.length > 0 ? fan.xs : [c]
      // Out to the running helpers' boxes alone; back from the one that just handed back (every box, when it isn't drawn).
      const out = fan.xs.filter((_, i) => fan.isRunning[i])
      const handedBack = back ? fan.xs.filter((_, i) => fan.names[i] === back.type) : []
      const home = handedBack.length > 0 ? handedBack : ends
      // The pulse's way, line by line, through the lines that are on: down
      // to the gates while the turn runs, on out to the helpers while one
      // runs, back to the lead once one is done (a few seconds), a pause
      // inside each box it goes through. Each line is drawn whole; the pulse
      // runs along `pulse` (its targets' part) where it has one. Its colour:
      // the main session's out of it and back, the gates' green, the helpers' blue.
      type Flow = { key: string; text: string; pulse?: string; targets?: number[]; how: 'down' | 'out' | 'in'; at: number; on: boolean; color: string; base?: string; pause: number }
      const lines: Flow[] = [
        { key: 'to-gates-1', text: marks(w, [from], '│'), how: 'down', at: from, on: isWorking, color: builderColor, base: 'inactive', pause: 0 },
        { key: 'to-gates-2', text: marks(w, [from], '●'), how: 'down', at: from, on: isWorking, color: builderColor, base: builderColor, pause: 3 },
        { key: 'to-fan', text: marks(w, [c], '│'), how: 'down', at: c, on: isDelegating, color: PALETTE.gate, base: 'inactive', pause: 0 },
        { key: 'fan-out', text: branch(w, c, ends), pulse: branch(w, c, out), targets: out, how: 'out', at: c, on: isDelegating, color: PALETTE.haiku, base: 'inactive', pause: 0 },
        { key: 'arrows', text: marks(w, fan.xs, '▼'), pulse: marks(w, out, '▼'), targets: out, how: 'down', at: c, on: isDelegating, color: PALETTE.haiku, base: PALETTE.haiku, pause: 4 },
        { key: 'merge', text: branch(w, c, ends, true), pulse: branch(w, c, home, true), targets: home, how: 'in', at: c, on: isReturning, color: builderColor, base: 'inactive', pause: 0 },
        { key: 'to-back', text: marks(w, [c], '●'), how: 'down', at: c, on: isReturning, color: builderColor, base: 'inactive', pause: 0 },
      ]
      let step = 0
      const drawn = lines.map(l => {
        const path = pulsePath(l.pulse ?? l.text, l.at, l.how)
        const start = step
        if (l.on) step += path.length + l.pause
        return { ...l, path, start }
      })
      // Nothing but the turn: the pulse goes round the gates' part alone, a beat a second or so.
      const cycle = step + 6
      // The same way in milliseconds for the desktop's vector lines: a line of marks 160, a fan-out by its reach, a pause a box.
      let ms = 0
      const timed = drawn.map(l => {
        const dur = l.how === 'down' ? 160 : 90 * Math.max(1, l.path.length) + 80
        const from = ms
        if (l.on) ms += dur + l.pause * 110
        return { ...l, from, to: from + dur }
      })
      const cycleMs = ms + 450
      const pulse = (key: string) => {
        const l = timed.find(d => d.key === key)
        if (!l) return null
        if (Svg) {
          const source = lineSvg({ text: l.text, how: l.how, at: l.at, color: l.color, base: l.base ?? l.color, on: l.on, from: l.from, to: l.to, cycleMs, phaseMs: now % cycleMs, targets: l.targets })
          return (
            <Box key={key} width={w} flexShrink={0}>
              <Svg source={source} alt="a line of the diagram" height={LINE_PX} />
            </Box>
          )
        }
        return motion(key, { kind: 'flow', text: l.text, path: l.path, start: l.start, cycle, on: l.on, color: l.color, base: l.base })
      }
      // No helper at work or worked today, none handing back: the diagram ends at the gates.
      if (fan.count === 0 && !back) {
        return (
          <Box key="flow" flexDirection="column" width={w}>
            {pulse('to-gates-1')}
            {pulse('to-gates-2')}
            {gatesBox(w)}
          </Box>
        )
      }
      return (
        <Box key="flow" flexDirection="column" width={w}>
          {pulse('to-gates-1')}
          {pulse('to-gates-2')}
          {gatesBox(w)}
          {pulse('to-fan')}
          {pulse('fan-out')}
          {pulse('arrows')}
          {fan.boxes}
          {pulse('merge')}
          {pulse('to-back')}
          <Box width={w} justifyContent="center">
            {backBox(w)}
          </Box>
        </Box>
      )
    }

    // --- the diagram: one column, every box the pane's width -------------------------
    const diagram = (
      <Box key="diagram" flexDirection="column" width={W} marginTop={gapY}>
        {sessionBox(W)}
        {flow(W, Math.floor(W / 2))}
      </Box>
    )

    // --- the ledger: today, the board, the repositories ----------------------------------
    const todayBox = (w: number) => {
      const inner = w - 4
      const [modelW = 11, figureW = 6] = fit([11, 6], inner, 6)
      const barW = Math.max(4, inner - modelW - figureW - 1)
      const top = models[0] ? total(models[0]) : 0
      return frame(
        'today',
        w,
        'inactive',
        <>
          <Box justifyContent="space-between">
            {line('TODAY', { bold: true })}
            {dayTotal > 0 ? (
              <Box key="day-total">
                {motion('day-total', { kind: 'count', value: dayTotal, dim: true })}
                {line(` · ${Math.round((cacheRead / dayTotal) * 100)}% cache`, { dim: true })}
              </Box>
            ) : (
              line('no calls yet', { dim: true })
            )}
          </Box>
          <Box flexDirection="column">
            {models.map(d => {
              const color = modelColor(d.model)
              return (
                <Box key={`model-${d.model}`}>
                  {cell(modelW, line(modelName(d.model), { color }))}
                  {barOf(`model-${d.model}-bar`, total(d), top, barW, color)}
                  {cell(figureW + 1, motion(`model-${d.model}-tokens`, { kind: 'count', value: total(d), bold: true, color }), true)}
                </Box>
              )
            })}
          </Box>
        </>,
      )
    }

    const boardBox = (w: number) => {
      const inner = w - 4
      const [statusW = 5, ageW = 4] = fit([Math.min(15, Math.max(5, ...board.map(c => c.status.length + 1))), 4], inner)
      const busy = board.filter(c => c.status === 'running').length
      const blocked = board.filter(c => c.status === 'blocked').length
      // Done cards are history: the newest three, the rest said in a count.
      const open = board.filter(c => c.status !== 'done')
      const done = board.filter(c => c.status === 'done').sort((a, b) => b.updated.localeCompare(a.updated))
      const shownCards = [...open, ...done.slice(0, 3)]
      // What a blocked card waits for: the repositories other sessions' running cards hold of its own (board.ts's
      // lock: only a running card holds; its holder may drop one, another come to hold one), before the title so
      // it is never cut; "free now" once nothing holds them.
      const blocker = (c: BoardCard): Run => {
        const isOther = (b: BoardCard) => !(c.session && b.session === c.session)
        const held = [...new Set(board.filter(b => b.id !== c.id && HOLDS(b) && isOther(b)).flatMap(b => reposOf(b).filter(r => reposOf(c).includes(r))))]
        if (held.length === 0) return [' · free now', { color: PALETTE.ok, fixed: true }]
        return [` · on ${held.join('+')}`, { color: PALETTE.fail, fixed: true }]
      }
      return frame(
        'board',
        w,
        'inactive',
        <>
          <Box justifyContent="space-between">
            {line('BOARD', { bold: true })}
            {runs('board-counts', [
              [waiting > 0 ? `${waiting} waiting on you` : `${open.length} open`, { color: waiting > 0 ? PALETTE.wait : undefined, dim: waiting === 0 }],
              busy > 0 && inner >= 40 ? [` · ${busy} running`, { color: PALETTE.ask }] : null,
              blocked > 0 ? [` · ${blocked} blocked`, { color: PALETTE.fail }] : null,
            ])}
          </Box>
          <Box flexDirection="column">
          {board.length === 0
            ? line('no cards (board/*.md)', { dim: true })
            : shownCards.map(c => {
                const at = Date.parse(c.updated)
                return (
                  <Box key={`card-${c.id}`}>
                    {cell(statusW, line(c.status || '?', { color: cardColor(c.status) }))}
                    {cell(
                      Math.max(1, inner - statusW - ageW),
                      runs(`card-${c.id}-title`, [
                        [where(c), { bold: true, fixed: true }],
                        c.status === 'blocked' ? blocker(c) : null,
                        isGone(c) ? [' · session gone', { color: PALETTE.wait, fixed: true }] : null,
                        [`${c.status === 'blocked' ? ' ·' : ''} ${c.title}`, {}],
                      ]),
                    )}
                    {cell(ageW, line(Number.isNaN(at) ? '?' : ago(at, now), { dim: true }), true)}
                  </Box>
                )
              })}
          {done.length > 3 ? line(`+${done.length - 3} done today`, { dim: true }) : null}
          </Box>
        </>,
      )
    }

    const reposBox = (w: number) => {
      const columns = tier === 'wide' ? 2 : 1
      const inner = w - 4
      const colW = Math.floor((inner - (columns - 1) * 2) / columns)
      // A dot before the name: a session at work there (cyan), or cards waiting on you there (amber).
      const held = holds(board)
      const heldN = [...held.values()].filter(k => k === 'held').length
      const [nameW = 10, markW = 13] = fit([Math.min(20, Math.max(10, ...repos.map(r => r.name.length + 3))), 13], colW, 8)
      // A quiet repository (stamped with no edits since, nothing to push, not held, no failed check) is a count, not a row.
      const isQuiet = (r: RepoRow) => !r.failed && !!r.check?.isFresh && !!r.check.isWorkFresh && (r.ahead ?? 0) === 0 && !held.has(r.name)
      const loud = repos.filter(r => !isQuiet(r))
      const quiet = repos.length - loud.length
      const perColumn = Math.ceil(loud.length / columns)
      const row = (r: RepoRow) => {
        const mark = checkMark(r.check, now, r.failed)
        const verdict = r.review?.verdict ?? null
        // Said first, a verdict being long: one on an older commit, or HEAD's that didn't read all a push sends.
        const state = !r.review ? null : !r.review.isCurrent ? 'older' : (r.ahead ?? 0) > 0 && verdict && !r.review.covers ? (r.review.base ? 'partial' : 'no packet') : null
        const kind = held.get(r.name)
        return (
          <Box key={`repo-${r.name}`} width={colW}>
            {cell(
              nameW,
              runs(`repo-${r.name}-name`, [
                [kind === 'held' ? '● ' : kind === 'pending' ? '○ ' : '  ', { color: kind === 'held' ? PALETTE.ask : PALETTE.wait, fixed: true }],
                [r.name, { bold: true }],
              ]),
            )}
            {cell(markW, line(mark.text, { color: mark.color }))}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {r.review
                ? runs(`repo-${r.name}-review`, [
                    state ? [`${state} `, { color: state === 'older' ? 'inactive' : PALETTE.wait, fixed: true }] : null,
                    [`${verdict ?? 'packet'} ${r.review.sha.slice(0, 7)}`, { color: verdict ? verdictColor(verdict) : 'inactive' }],
                  ])
                : line('no review', { dim: true })}
            </Box>
          </Box>
        )
      }
      return frame(
        'repos',
        w,
        PALETTE.gate,
        <>
          <Box justifyContent="space-between">
            {line(inner >= 56 ? 'REPOSITORIES · checks and reviews' : 'REPOSITORIES', { bold: true, color: PALETTE.gate })}
            {runs('repos-counts', [
              heldN > 0 ? [`● ${heldN} held · `, { color: PALETTE.ask }] : null,
              [`${fresh}/${repos.length} pushable`, { color: fresh === repos.length ? PALETTE.ok : PALETTE.wait }],
            ])}
          </Box>
          {repos.length === 0 ? (
            line('reading…', { dim: true })
          ) : (
            <Box flexDirection="column">
              {loud.length > 0 ? (
                <Box>
                  {Array.from({ length: columns }, (_, i) => (
                    <Box key={`repo-col-${i}`} flexDirection="column" marginLeft={i > 0 ? 2 : 0}>
                      {loud.slice(i * perColumn, (i + 1) * perColumn).map(row)}
                    </Box>
                  ))}
                </Box>
              ) : null}
              {quiet > 0 ? line(`${quiet} more stamped, nothing to push`, { dim: true }) : null}
            </Box>
          )}
        </>,
      )
    }

    // --- the locks: who works where ------------------------------------------------------
    // board.ts's lock per repository, as the snapshot read it (its own rules, not copied here): the session whose
    // running card holds a repository, who waits behind it, and the sessions that wrote where their cards don't hold.
    const locksBox = (w: number) => {
      const inner = w - 4
      const locks = snap?.locks
      const slips = snap?.slips ?? []
      const held = (locks ?? []).filter(l => l.holder)
      const quiet = (locks ?? []).filter(l => !l.holder)
      const queued = held.reduce((n, l) => n + l.later.length, 0)
      const nameW = Math.min(18, Math.max(10, ...held.map(l => l.repo.length + 3), ...slips.map(x => x.repo.length + 3)))
      const row = (l: RepoLock) => {
        const top = l.holder as LockCard
        return (
          <Box key={`lock-${l.project ?? ''}-${l.repo}`}>
            {cell(nameW, runs(`lock-${l.repo}-name`, [['● ', { color: PALETTE.ask, fixed: true }], [l.repo, { bold: true }]]))}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {runs(`lock-${l.repo}-who`, [
                [whoOf(top), { color: PALETTE.ask, bold: true, fixed: true }],
                top.gone ? [' (session gone)', { color: PALETTE.wait, fixed: true }] : null,
                l.later.length > 0 ? [` · then ${lockNames(l.later)}`, { color: PALETTE.fail }] : null,
                l.stopped.length > 0 ? [` · stopped ${lockNames(l.stopped)}`, { color: PALETTE.wait, dim: true }] : null,
              ])}
            </Box>
          </Box>
        )
      }
      return frame(
        'locks',
        w,
        'inactive',
        <>
          <Box justifyContent="space-between">
            {line(inner >= 40 ? 'LOCKS · who works where' : 'LOCKS', { bold: true })}
            {runs('locks-counts', [
              slips.length > 0 ? [`⚠ ${slips.length} off the lock`, { color: PALETTE.fail }] : null,
              slips.length > 0 && held.length > 0 ? [' · ', { dim: true }] : null,
              held.length > 0 ? [`${held.length} held`, { color: PALETTE.ask }] : null,
              queued > 0 ? [` · ${queued} waiting`, { color: PALETTE.fail }] : null,
            ])}
          </Box>
          <Box flexDirection="column">
            {!snap ? line('reading…', { dim: true }) : !locks ? line("no lock data (needs the project's board.ts)", { dim: true }) : held.length === 0 && slips.length === 0 ? line('nothing held', { dim: true }) : null}
            {held.map(row)}
            {slips.map(x => (
              <Box key={`slip-${x.session}-${x.repo}`}>
                {cell(nameW, runs(`slip-${x.session}-${x.repo}-name`, [['⚠ ', { color: PALETTE.fail, fixed: true }], [x.repo, { bold: true }]]))}
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  {runs(`slip-${x.session}-${x.repo}-why`, [[`${x.who} wrote here ${ago(x.at, now)} ago: `, { color: PALETTE.fail }], [x.why, { dim: true }]])}
                </Box>
              </Box>
            ))}
            {quiet.length > 0 ? line(`${new Set(quiet.map(l => l.repo)).size} more with stopped cards only: ${[...new Set(quiet.map(l => l.repo))].join(', ')}`, { dim: true }) : null}
          </Box>
        </>,
      )
    }

    const todayW = Math.floor((W - GAP_X) * 0.42)
    // --- the sessions: every one running in the family folder ---------------------------
    // Claude Code's registry of live sessions (the snapshot's `sessions`): what each
    // does now, waiting on you first, with its card and an Open for a desktop one.
    const sessionsBox = (w: number) => {
      const inner = w - 4
      const asking = live.filter(x => x.status === 'waiting' && x.id !== selfId).length
      const busy = live.filter(x => x.status === 'busy').length
      const isWide = inner >= 72
      const isMid = inner >= 52
      const [statusW = 10, whatW = 26, cardW = 15, ageW = 5, openW = 8] = fit([10, isMid ? 26 : 0, isWide ? 15 : 0, 5, 8], inner, 4)
      // (a column apart from the next: a cut title's ellipsis would touch it)
      const titleW = Math.max(8, inner - statusW - whatW - cardW - ageW - openW - 1)
      // A session's card: its newest open one (board.ts writes the session's id on it), else its newest done one, dim.
      const cardOf = (x: LiveSession) => {
        const mine = board.filter(c => c.session === x.id).sort((a, b) => b.updated.localeCompare(a.updated))
        return mine.find(c => c.status !== 'done') ?? mine[0]
      }
      const row = ({ session: x, depth }: { session: LiveSession; depth: number }) => {
        const isSelf = x.id === selfId
        const color = x.status === 'waiting' ? PALETTE.wait : x.status === 'busy' ? PALETTE.ask : 'inactive'
        const helping = x.helpers.map(h => h.type)
        const what =
          x.status === 'waiting'
            ? line(x.waitingFor ?? 'waiting on you', { color: PALETTE.wait })
            : line(`${x.model ? `${stance(x.model, x.mode, null).phase === 'planning' ? 'plan' : 'build'} ${modelName(x.model)}` : '—'}${helping.length ? ` · ${helping.join(', ')}` : ''}`, { color: helping.length ? PALETTE.wait : x.model ? modelColor(x.model) : 'inactive' })
        const card = cardOf(x)
        // The skills it used, each with who started it (a user's `/name` typed, the session's own load) and a count past one.
        const skilled = x.skills ?? []
        return (
          <Box key={`session-${x.id}`} flexDirection="column">
          <Box alignItems="center">
            <Box width={statusW} flexShrink={0}>
              {x.status === 'busy' ? motion(`session-${x.id}-spin`, { kind: 'spin', on: true, color }) : line(x.status === 'waiting' ? '●' : '·', { color })}
              {line(` ${x.status}`, { color, bold: x.status === 'waiting' })}
            </Box>
            {cell(titleW, runs(`session-${x.id}-title`, [[`${depth > 0 ? `${'  '.repeat(depth - 1)}└ ` : ''}`, { fixed: true }], projectChip(x.project), [x.name, { bold: isSelf || x.status === 'waiting' }]]))}
            <Box width={1} flexShrink={0} />
            {whatW > 0 ? cell(whatW, what) : null}
            {cardW > 0 ? cell(cardW, card ? line(card.status, { color: cardColor(card.status), dim: card.status === 'done' }) : line('no card', { dim: true })) : null}
            {cell(ageW, line(ago(x.since, now), { dim: true }), true)}
            <Box width={openW} flexShrink={0} justifyContent="flex-end">
              {isSelf ? line('this', { dim: true }) : x.link ? <Button key={`open-${x.id}`} label="Open" onPress={() => void openSession($, x.link as string)} /> : line(x.entrypoint === 'cli' ? (x.background ? 'bg' : 'terminal') : '', { dim: true })}
            </Box>
          </Box>
          {skilled.length > 0 ? (
            <Box>
              <Box width={statusW} flexShrink={0} />
              {cell(inner - statusW, runs(`session-${x.id}-skills`, [['skills ', { dim: true }], [skillsText(skilled), { color: PALETTE.opus }]]))}
            </Box>
          ) : null}
          </Box>
        )
      }
      return frame(
        'sessions',
        w,
        'inactive',
        <>
          <Box justifyContent="space-between">
            {line(inner >= 40 ? `SESSIONS · ${live.length} live in ${snap?.projects ? (snap.projects.length > 1 ? `${snap.projects.length} projects` : snap.projects[0].name) : 'the family folder'}` : `SESSIONS · ${live.length}`, { bold: true })}
            {runs('sessions-counts', [
              asking > 0 ? [`${asking} waiting on you`, { color: PALETTE.wait }] : null,
              asking > 0 && busy > 0 ? [' · ', { dim: true }] : null,
              busy > 0 ? [`${busy} busy`, { color: PALETTE.ask }] : null,
            ])}
          </Box>
          <Box flexDirection="column">
            {!snap?.sessions ? line(snap ? "can't read Claude Code's sessions (~/.claude/sessions)" : 'reading…', { dim: true }) : live.length === 0 ? line('none', { dim: true }) : groupSessions(live).map(row)}
          </Box>
        </>,
      )
    }

    const ledger =
      tier === 'narrow' || W < 80 ? (
        <Box key="ledger" flexDirection="column" width={W} marginTop={gapY} gap={gapY}>
          {sessionsBox(W)}
          {locksBox(W)}
          {todayBox(W)}
          {boardBox(W)}
          {reposBox(W)}
        </Box>
      ) : (
        <Box key="ledger" flexDirection="column" width={W} marginTop={gapY} gap={gapY}>
          {sessionsBox(W)}
          {locksBox(W)}
          <Box width={W}>
            {todayBox(todayW)}
            <Box marginLeft={GAP_X}>{boardBox(W - GAP_X - todayW)}</Box>
          </Box>
          {reposBox(W)}
        </Box>
      )

    // --- the session log, the prompt, the status bar ----------------------------------
    const shown = events.slice(0, LOG_LINES)
    const logInner = W - 4
    const [markW = 2, timeW = 9, sourceW = 13, figureW = 10] = fit(
      [2, 9, Math.min(16, Math.max(6, ...shown.map(ev => sourceLabel(ev).length + 1))), Math.min(12, Math.max(4, ...shown.map(ev => eventFigure(ev).length + 1)))],
      logInner,
      14,
    )
    // A line's mark keeps its instance as newer lines push it down: keyed by the event, not the row.
    const used = new Set<string>()
    const eventKey = (ev: HarnessEvent, i: number) => {
      const key = `fresh-${ev.id ?? `${ev.at}-${ev.source}-${ev.repo}`}`
      const unique = used.has(key) ? `${key}-${i}` : key
      used.add(unique)
      return unique
    }
    const log = frame(
      'log',
      W,
      'inactive',
      <>
        <Box key="log-head">
          <Text bold>session log </Text>
          <Text dimColor>[ stream: </Text>
          {motion('live', { kind: 'live', color: PALETTE.ok, label: 'live' })}
          <Text dimColor> ]</Text>
        </Box>
        <Box flexDirection="column">
          {shown.length === 0
            ? line('nothing yet today', { dim: true })
            : shown.map((ev, i) => {
                // A new line blinks its mark and stands out until it settles.
                const age = Math.max(0, now - ev.at)
                return (
                  <Box key={`event-${i}-${ev.at}`}>
                    {cell(markW, motion(eventKey(ev, i), { kind: 'fresh', age, color: toneColor(ev.tone, ev.text), settled: PALETTE.ok, mark: i === 0 ? '›' : ' ' }))}
                    {cell(timeW, line(clockTime(ev.at), { bold: i === 0, dim: i !== 0 }))}
                    {cell(sourceW, line(sourceLabel(ev), { color: sourceColor(ev) }))}
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      {line(`${ev.repo ? `${ev.repo} ` : ''}${eventText(ev)}`, {})}
                    </Box>
                    {cell(figureW, line(eventFigure(ev), { color: toneColor(ev.tone, ev.text) }), true)}
                  </Box>
                )
              })}
        </Box>
      </>,
    )

    return (
      <Box flexDirection="column" width={W}>
        {header}
        {error ? (
          <Text color={PALETTE.fail} wrap="wrap">
            Snapshot failed: {error}
          </Text>
        ) : null}
        {diagram}
        {ledger}
        <Box marginTop={gapY} flexDirection="column">
          {log}
        </Box>
      </Box>
    )
  })
}
