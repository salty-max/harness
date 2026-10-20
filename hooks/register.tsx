import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentRow, AgentSteps, BoardCard, CheckStamp, HarnessEvent, ModelDay, RepoRow, SessionFacts, Snapshot } from '../types'

const PANE = 'harness'
const TITLE = 'Harness'
const SNAPSHOT_MS = 30_000
const SESSION_MS = 5_000
const LOG_LINES = 10

const snapshot = atom({ plugin: 'harness-view', key: 'snapshot' } as const, null)
const snapshotError = atom({ plugin: 'harness-view', key: 'snapshotError' } as const, null)
const session = atom({ plugin: 'harness-view', key: 'session' } as const, null)
const agents = atom({ plugin: 'harness-view', key: 'agents' } as const, [])
const steps = atom({ plugin: 'harness-view', key: 'steps' } as const, {})
// Turned once a second while a helper runs: the spinners' redraw.
const tick = atom({ plugin: 'harness-view', key: 'tick' } as const, 0)

// --- numbers as the panel says them ---------------------------------------

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '?'
  if (n < 1000) return String(n)
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
  return `${(n / 1e9).toFixed(1)}G`
}

/** `claude-opus-5-5` is `opus 5.5`, `claude-haiku-4-5-20251001` is `haiku 4.5`. */
export function modelName(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model)
  return m ? `${m[1]} ${m[2]}.${m[3]}` : model.replace(/^claude-/, '')
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** How long a helper ran: `42s`, `8m 24s`, `1h 3m`. */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar of block characters in eighths of a cell; a value above zero shows at least a sliver. */
export function bar(value: number, max: number, width: number, rest = '░'): { filled: string; empty: string } {
  if (max <= 0 || width <= 0) return { filled: '', empty: rest.repeat(Math.max(0, width)) }
  const share = Math.min(1, Math.max(0, value / max))
  const eighths = Math.max(value > 0 ? 1 : 0, Math.round(share * width * 8))
  const part = EIGHTHS[eighths % 8] ?? ''
  const full = Math.floor(eighths / 8)
  return { filled: '█'.repeat(full) + part, empty: rest.repeat(width - full - (part ? 1 : 0)) }
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
export function cardColor(status: string): string {
  if (status.startsWith('waiting') || status === 'ready-to-push') return PALETTE.wait
  if (status === 'done') return PALETTE.ok
  return PALETTE.plain
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

/** A log line's words: a helper's model, tokens and time after what it did. */
export function eventText(e: HarnessEvent): string {
  const more = [e.model && e.ms !== undefined ? modelName(e.model) : '', e.tokens ? `${tokens(e.tokens)} tok` : '', e.ms ? duration(e.ms) : '']
  return [e.text, ...more.filter(Boolean)].join(' · ')
}

/** A log line's figure on the right, the mock-up's last column. */
export function eventFigure(e: HarnessEvent): string {
  if (e.source === 'helper') return e.text.endsWith(' started') || e.text.includes(' started:') ? 'spawn' : e.tokens ? `${tokens(e.tokens)} tok` : (e.text.split(' ')[1] ?? '')
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

const SPINNER = ['-', '\\', '|', '/']

/** The spinner's frame at `now`: it turns while the pane redraws, once a second while a helper runs. */
export const spin = (now: number) => SPINNER[Math.floor(now / 1000) % SPINNER.length] ?? '-'

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

const WAITING = (c: BoardCard) => c.status.startsWith('waiting') || c.status === 'ready-to-push'

/** The one status line: what claude-hud does not already say. */
export function statusLine(snap: Snapshot | null, running: number): string {
  const parts: string[] = []
  if (snap) {
    const waiting = snap.board.filter(WAITING).length
    if (waiting > 0) parts.push(`board ${waiting} waiting`)
  }
  if (running > 0) parts.push(`${running} agent${running > 1 ? 's' : ''}`)
  if (snap) {
    const fresh = snap.repos.filter(r => r.check?.isFresh).length
    parts.push(`checks ${fresh}/${snap.repos.length}`)
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
let timers: { cancel: () => void }[] = []
let ticker: { cancel: () => void } | null = null
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

/** Only a session working in the family folder shows the harness. */
async function isFamilySession($: EngineInterface): Promise<boolean> {
  const [{ root }, project] = await Promise.all([familyRoot($), $.session.root()])
  return project === root || project.startsWith(`${root}/`)
}

async function runSnapshot($: EngineInterface, isFresh: boolean): Promise<Snapshot> {
  const { home, root } = await familyRoot($)
  const script = `${$.plugin.root}/bin/snapshot.ts`
  const candidates = bun ? [bun] : ['bun', `${home}/.volta/bin/bun`, `${home}/.bun/bin/bun`, '/opt/homebrew/bin/bun']
  let lastError = 'bun not found'
  for (const candidate of candidates) {
    try {
      const argv = [candidate, script, '--root', root, ...(isFresh ? ['--fresh'] : [])]
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
  // A Refresh pressed during a timed read runs once that read is done.
  if (isReading) {
    isFreshWanted ||= isFresh
    return
  }
  isReading = true
  try {
    // A headless run (claude -p) never draws: no snapshot until a surface attaches.
    if ((await $.session.surfaces()).length === 0) return
    const snap = await runSnapshot($, isFresh)
    if (isChanged('snapshot', snap)) await update($, snapshot, () => snap)
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

async function refreshSession($: EngineInterface, lastModel?: string, lastEffort?: string) {
  const [model, usage, previous, settings, subagentModel] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    read($, session),
    $.settings.read().catch(() => ({}) as Record<string, unknown>),
    $.env.get('CLAUDE_CODE_SUBAGENT_MODEL'),
  ])
  const s = settings as { model?: unknown; effortLevel?: unknown; permissions?: { defaultMode?: unknown; ask?: unknown } }
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const facts: SessionFacts = {
    model,
    lastModel: lastModel ?? previous?.lastModel ?? null,
    contextTokens: usage.context.tokens ?? null,
    window: usage.context.window,
    percent: usage.context.percent ?? null,
    costUsd: usage.cost?.usd ?? null,
    rateLimits: (usage.rateLimits ?? []).map(l => ({ kind: l.kind, percentUsed: l.percentUsed })),
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
  const [list, counted] = await Promise.all([$.agent.list(), read($, steps)])
  const rows: AgentRow[] = list.map(a => ({
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status,
    steps: counted[a.id] ?? null,
  }))
  if (isChanged('agents', rows)) await update($, agents, () => rows)
  // The spinners turn while a helper runs, and stop with the last one.
  const isRunning = rows.some(a => a.status === 'running')
  if (isRunning && !ticker) ticker = $.clock.every(1000, () => void update($, tick, n => n + 1).catch(() => {}))
  if (!isRunning && ticker) {
    ticker.cancel()
    ticker = null
  }
  await refreshStatus($)
}

async function refreshStatus($: EngineInterface) {
  const [snap, rows] = await Promise.all([read($, snapshot), read($, agents)])
  const line = statusLine(snap, rows.filter(a => a.status === 'running').length)
  if (isChanged('status', line)) $.ui.status(line)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    isActive = await isFamilySession($).catch(() => false)
    if (!isActive) {
      for (const timer of timers) timer.cancel()
      timers = []
      return next(e)
    }
    await $.command.register({
      name: 'harness',
      description: 'Open the harness panel: session, subagents, board, checks, usage today',
    })
    for (const timer of timers) timer.cancel()
    ticker?.cancel()
    ticker = null
    timers = [
      $.clock.every(SNAPSHOT_MS, () => void refreshSnapshot($).catch(() => {})),
      $.clock.every(SESSION_MS, () => {
        void refreshSession($).catch(() => {})
        void refreshAgents($).catch(() => {})
      }),
    ]
    void refreshSnapshot($).catch(() => {})
    void refreshSession($).catch(() => {})
    void refreshAgents($).catch(() => {})
    void $.ui.open({ id: PANE, title: TITLE }).catch(() => {})

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
    if (isActive) void refreshSnapshot($).catch(() => {})

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

  on('turn.complete', async ($, e, next) => {
    if (!isActive) return next(e)
    void refreshSession($).catch(() => {})
    void refreshAgents($).catch(() => {})

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [snap, error, facts, rows] = await Promise.all([
      read($, snapshot),
      read($, snapshotError),
      read($, session),
      read($, agents),
      read($, tick),
    ])
    const now = await $.clock.now()
    const W = Math.max(32, e.props.bodyColumns)
    const tier = W >= 96 ? 'wide' : W >= 64 ? 'medium' : 'narrow'
    const spinner = spin(now)

    // --- the parts ---------------------------------------------------------
    // A box of the diagram: its border in its colour (dashed for the main
    // session's, as in the mock-up), a column of padding each side.
    const frame = (key: string, w: number, color: string, children: RenderChildren, opts: { dashed?: boolean; centred?: boolean } = {}) => (
      <Box
        key={key}
        flexDirection="column"
        width={w}
        flexShrink={0}
        paddingX={1}
        borderStyle={opts.dashed ? 'dashed' : 'single'}
        borderColor={color}
        alignItems={opts.centred ? 'center' : 'stretch'}
      >
        {children}
      </Box>
    )
    const line = (text: string, props: { color?: string; bold?: boolean; dim?: boolean; inverse?: boolean } = {}) => (
      <Text color={props.color} bold={props.bold} dimColor={props.dim} inverse={props.inverse} wrap="truncate-end">
        {text}
      </Text>
    )
    const cell = (w: number, child: RenderChildren, isRight = false) => (
      <Box width={w} flexShrink={0} justifyContent={isRight ? 'flex-end' : 'flex-start'}>
        {child}
      </Box>
    )
    // A label, its value right-aligned in its colour: the mock-up's `calls  2 / 3`.
    const pair = (key: string, label: string, value: string, color: string) => (
      <Box key={key} justifyContent="space-between">
        <Text dimColor wrap="truncate-end">
          {label}
        </Text>
        <Text color={color} wrap="truncate-end">
          {value}
        </Text>
      </Box>
    )
    const meter = (key: string, label: string, labelW: number, value: number, max: number, barW: number, figure: string, color: string, figureW: number) => {
      const b = bar(value, max, barW, '▒')
      return (
        <Box key={key}>
          {cell(labelW, line(label, { bold: true }))}
          <Text wrap="truncate-end">
            <Text color={color}>{b.filled}</Text>
            <Text color={color} dimColor>
              {b.empty}
            </Text>
          </Text>
          {cell(figureW + 1, line(figure, { color, bold: true }), true)}
        </Box>
      )
    }
    const connector = (key: string, w: number, xs: number[], ch: string, color = 'inactive') => (
      <Text key={key} color={color} wrap="truncate-end">
        {marks(w, xs, ch)}
      </Text>
    )

    // --- the numbers ---------------------------------------------------------
    const helpers = snap?.helpers ?? []
    const day = snap?.helperDay ?? {}
    const events = snap?.events ?? []
    const repos = snap?.repos ?? []
    const board = snap?.board ?? []
    const models = snap?.usage.models ?? []
    const builder = facts ? (facts.lastModel ?? facts.model) : null
    const builderName = builder ? modelName(builder) : 'main'
    const builderColor = modelColor(builder)
    const running = rows.filter(a => a.status === 'running')
    const opusDefs = helpers.filter(h => family(h.model) === 'opus')
    const opusModel = Object.entries(day).find(([name]) => opusDefs.some(d => d.name === name))?.[1].model ?? opusDefs[0]?.model ?? 'opus'
    const opusRuns = opusDefs.reduce((n, d) => n + (day[d.name]?.runs ?? 0), 0)
    const opusTokens = opusDefs.reduce((n, d) => n + (day[d.name]?.tokens ?? 0), 0)
    const helperRuns = Object.values(day).reduce((n, d) => n + d.runs, 0)
    const helperTokens = Object.values(day).reduce((n, d) => n + d.tokens, 0)
    const fresh = repos.filter(r => r.check?.isFresh).length
    const reviewed = repos.filter(r => r.review?.verdict && r.review.isCurrent).length
    const waiting = board.filter(WAITING).length
    const dayTotal = models.reduce((sum, d) => sum + total(d), 0)
    const cacheRead = models.reduce((sum, d) => sum + d.cacheRead, 0)
    const lastReview = events.find(ev => ev.source === 'review')
    const lastHandback = events.find(ev => ev.source === 'helper' && ev.tokens !== undefined)

    // The moment a running Opus helper is at: the reviewer before a push, the architect by its brief.
    const runningOpus = running.find(a => opusDefs.some(d => d.name === a.type))
    const moment = !runningOpus
      ? null
      : runningOpus.type === 'reviewer'
        ? 'push'
        : /error|fail|again|twice|deadlock/i.test(runningOpus.description)
          ? 'error'
          : /done|finish|sign/i.test(runningOpus.description)
            ? 'done'
            : 'plan'

    // --- header --------------------------------------------------------------
    const legend: [string, string][] = [
      [PALETTE.opus, 'opus · plan'],
      [PALETTE.sonnet, 'sonnet · build'],
      [PALETTE.haiku, 'haiku · swarm'],
      [PALETTE.gate, 'gates · code'],
    ]
    const isShort = W < 64
    const header = (
      <Box key="header" flexDirection="column" width={W} alignItems="center">
        <Text wrap="truncate-end">
          <Text bold>{isShort ? 'HARNESS' : 'WOW-ADDONS HARNESS'}</Text>
          <Text dimColor> · </Text>
          <Text color={PALETTE.opus} bold>
            {modelName(opusModel).toUpperCase()} PLANS
          </Text>
          <Text dimColor> · </Text>
          <Text color={builderColor} bold>
            {builderName.toUpperCase()} BUILDS
          </Text>
        </Text>
        <Text wrap="truncate-end">
          {legend.map(([color, label], i) => (
            <Text key={`legend-${i}`}>
              {i > 0 ? '  ' : ''}
              <Text color={color}>■</Text>
              <Text dimColor> {isShort ? label.split(' ')[0] : label}</Text>
            </Text>
          ))}
        </Text>
        <Box justifyContent="space-between" width={W}>
          <Text dimColor>{snap ? `read ${ago(snap.at, now)} ago` : 'reading…'}</Text>
          <Button key="refresh" label="Refresh" onPress={() => void refreshSnapshot($, true)} />
        </Box>
      </Box>
    )

    // --- the planner: Opus at its moments ------------------------------------
    const isTall = tier === 'wide'
    const planner = (w: number) => {
      const inner = w - 4
      const section = (key: string, title: string, lines: string[], isActive: boolean) => (
        <Box key={key} flexDirection="column" marginTop={isTall ? 1 : 0}>
          {line(`◇ ${title}`, { bold: true, inverse: isActive, color: isActive ? PALETTE.opus : undefined })}
          {isTall
            ? lines.map((text, i) => (
                <Text key={`${key}-${i}`} wrap="truncate-end">
                  <Text dimColor>│ </Text>
                  {text}
                </Text>
              ))
            : null}
        </Box>
      )
      const lastAt = (name: string) => (day[name]?.lastAt ? `last ${clockTime(day[name].lastAt).slice(0, 5)}` : 'not today')
      return frame(
        'planner',
        w,
        PALETTE.opus,
        <>
          <Box flexDirection="column" alignItems="center">
            {line(modelName(opusModel).toUpperCase(), { bold: true, color: PALETTE.opus })}
            {line(`planner · ${runningOpus ? 'working' : 'on call'} [ ${runningOpus ? spinner : '-'} ]`, { dim: !runningOpus })}
            {line(`[ ${opusDefs.map(d => d.name).join(' · ') || 'no opus helper'} ]`, { inverse: true, color: PALETTE.opus })}
          </Box>
          <Box flexDirection="column">
            {section('plan', 'before a plan', ['architect locks it', 'a second opinion first', lastAt('architect')], moment === 'plan')}
            {section('error', 'same error twice', ['architect reads the failure', 'before a third try'], moment === 'error')}
            {section(
              'push',
              'before a push',
              ['reviewer reads the packet', 'the rules, the map', lastReview ? `last: ${lastReview.text.replace(/^\w+ /, '').slice(0, inner - 8)}` : lastAt('reviewer')],
              moment === 'push',
            )}
            {section('done', 'before done', ['architect signs off', 'on the whole change'], moment === 'done')}
          </Box>
          <Box flexGrow={isTall ? 1 : 0} />
          <Box flexDirection="column" marginTop={1}>
            {pair('runs', 'runs today', String(opusRuns), PALETTE.opus)}
            {pair('tok', 'opus tokens', tokens(opusTokens), PALETTE.opus)}
            {pair('ctx', 'context', facts ? `${tokens(facts.contextTokens)} · ${Math.round(facts.percent ?? 0)}%` : '…', PALETTE.ok)}
          </Box>
        </>,
      )
    }

    // --- the main session and its config ---------------------------------------
    const sessionBox = (w: number) => {
      const inner = w - 4
      const ctx = bar(facts?.contextTokens ?? 0, facts?.window ?? 0, Math.max(6, Math.min(16, inner - 22)), '▒')
      const effort = facts?.settings.effort ?? null
      const effortLevel = effort ? Math.max(1, ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(effort) + 1) : 0
      return frame(
        'session',
        w,
        builderColor,
        <>
          {line(`${builderName} · main session`, { bold: true, color: builderColor })}
          <Text wrap="truncate-end">
            <Text dimColor>context </Text>
            <Text color={builderColor}>{ctx.filled}</Text>
            <Text color={builderColor} dimColor>
              {ctx.empty}
            </Text>
            <Text bold> {facts ? `${tokens(facts.contextTokens)} / ${tokens(facts.window)}` : '…'}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>effort </Text>
            <Text color={builderColor}>{'■'.repeat(effortLevel)}</Text>
            <Text dimColor>{'■'.repeat(5 - effortLevel)}</Text>
            <Text bold color={builderColor}>
              {' '}
              {effort ? effort.toUpperCase() : 'DEFAULT'}
            </Text>
            {facts?.costUsd != null ? <Text dimColor> · ${facts.costUsd.toFixed(2)}</Text> : null}
          </Text>
          {line(
            running.length > 0 ? `[ ${running.map(a => a.type).join(', ')} running ${spinner} ]` : `[ ${helperRuns} helper runs today · ${tokens(helperTokens)} tok ]`,
            { dim: running.length === 0, color: running.length > 0 ? PALETTE.wait : undefined },
          )}
        </>,
        { dashed: true, centred: true },
      )
    }

    const configBox = (w: number) => {
      const limits = facts?.rateLimits ?? []
      const worst = Math.max(0, ...limits.map(l => l.percentUsed))
      const isOk = worst < 80
      const settings = facts?.settings
      return frame(
        'config',
        w,
        'inactive',
        <>
          <Box justifyContent="space-between">
            {line(w - 4 >= 24 ? 'CONFIG & LIMITS' : 'CONFIG', { bold: true })}
            {line(isOk ? '[ OK ✓ ]' : `[ ${Math.round(worst)}% ]`, { color: isOk ? PALETTE.ok : PALETTE.wait })}
          </Box>
          {pair('model', 'model:', settings?.model ?? (facts ? family(facts.model) : '…'), PALETTE.sonnet)}
          {pair('mode', 'mode:', settings?.mode ?? 'default', PALETTE.plain)}
          {pair('context', 'context:', facts ? `${tokens(facts.window)} window` : '…', PALETTE.ok)}
          <Box flexDirection="column">
            {limits.map(l => pair(`limit-${l.kind}`, `${l.kind.replace(/_/g, ' ')}:`, `${Math.round(l.percentUsed)}% used`, l.percentUsed >= 80 ? PALETTE.wait : PALETTE.ok))}
          </Box>
          {pair('asks', 'asks:', `${settings?.asks ?? 0} rules`, PALETTE.plain)}
          {pair('subagents', 'subagents:', settings?.subagentModel ? `${settings.subagentModel} · env` : 'per helper', PALETTE.haiku)}
        </>,
      )
    }

    // --- the gates: what runs in code ------------------------------------------
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
            {line(inner >= 48 ? `GATES · q · hooks · review [ ${spinner} ]` : `GATES [ ${spinner} ]`, { bold: true, color: PALETTE.gate })}
            <Text wrap="truncate-end">
              <Text dimColor>stamps </Text>
              <Text bold>
                {fresh}/{repos.length}
              </Text>
            </Text>
          </Box>
          {meter('checks', 'checks', labelW, fresh, repos.length, barW, `${fresh}/${repos.length} fresh`, PALETTE.gate, figureW)}
          {meter('reviews', 'reviews', labelW, reviewed, repos.length, barW, `${reviewed}/${repos.length} current`, PALETTE.gate, figureW)}
          {meter('board', 'board', labelW, waiting, Math.max(board.length, 1), barW, `${waiting} waiting`, waiting > 0 ? PALETTE.wait : PALETTE.gate, figureW)}
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={PALETTE.gate}>stamp</Text>
              <Text dimColor> → push passes</Text>
            </Text>
            <Text wrap="truncate-end">
              <Text color={PALETTE.gate}>refusal</Text>
              <Text dimColor> → the log</Text>
            </Text>
          </Box>
        </>,
      )
    }

    // --- the helpers: running ones first, then the family's -------------------
    const helperBoxes = (w: number, k: number) => {
      const gap = 2
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
      // Then the helpers that aren't the planner's, the busiest today first (by runs, then the latest).
      const rest = helpers
        .filter(h => family(h.model) !== 'opus' && !seen.has(h.name))
        .map(h => ({ name: h.name, model: day[h.name]?.model ?? h.model, description: h.description }))
      for (const [name, d] of Object.entries(day)) if (!seen.has(name) && !rest.some(r => r.name === name) && !opusDefs.some(o => o.name === name)) rest.push({ name, model: d.model, description: '' })
      rest.sort((a, b) => (day[b.name]?.runs ?? 0) - (day[a.name]?.runs ?? 0) || (day[b.name]?.lastAt ?? 0) - (day[a.name]?.lastAt ?? 0))
      for (const r of rest) if (picks.length < k) picks.push(r)
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
            const share = helperTokens > 0 ? (today?.tokens ?? 0) / helperTokens : 0
            const b = bar(share, 1, Math.max(3, bw - 10), '▒')
            return (
              <Box key={`helper-${p.name}`} marginLeft={i > 0 ? gap : 0}>
                {frame(
                  `helper-${p.name}`,
                  bw,
                  p.agent ? PALETTE.opus : color,
                  <>
                    {line(p.name, { bold: true })}
                    {line(`${p.model ? modelName(p.model) : 'model ?'} [ ${p.agent ? `running ${spinner}` : 'IDLE'} ]`, { color })}
                    <Text wrap="truncate-end">
                      <Text color={color}>{b.filled}</Text>
                      <Text color={color} dimColor>
                        {b.empty}
                      </Text>
                      <Text bold> {Math.round(share * 100)}%</Text>
                    </Text>
                    {line(p.description || 'built in', { dim: true })}
                    {line(
                      p.agent?.steps
                        ? `● ctx ${tokens(p.agent.steps.context)} · ${p.agent.steps.steps} calls`
                        : `● ${today?.runs ?? 0} runs · ${tokens(today?.tokens ?? 0)} tok`,
                      { color },
                    )}
                  </>,
                  { centred: true },
                )}
              </Box>
            )
          })}
        </Box>
      )
      return { boxes, xs, count: picks.length }
    }

    const backBox = (w: number) =>
      frame(
        'back',
        w,
        builderColor,
        <>
          {line(`back to ${builderName} · lead`, { bold: true, color: builderColor })}
          {line(
            lastHandback
              ? `rx: ${lastHandback.text.split(' ')[0]} · ${tokens(lastHandback.tokens)} tok · ${duration(lastHandback.ms ?? 0)} [ ${running.length > 0 ? spinner : '-'} ]`
              : 'rx: no handback today yet',
            { dim: !lastHandback },
          )}
        </>,
        { dashed: true, centred: true },
      )

    // The flow under the main session: the gates, the hand-off, the helpers, back.
    const flow = (w: number, from: number) => {
      const c = Math.floor(w / 2)
      const k = w >= 66 ? 3 : w >= 40 ? 2 : 1
      const fan = helperBoxes(w, k)
      const pill = `» delegate to helpers · ${helperRuns} runs today · ${tokens(helperTokens)} tok «`
      const backW = Math.min(w, Math.max(30, Math.round(w * 0.62)))
      return (
        <Box key="flow" flexDirection="column" width={w}>
          {connector('to-gates-1', w, [from], '│')}
          {connector('to-gates-2', w, [from], '●', builderColor)}
          {gatesBox(w)}
          {connector('to-pill', w, [c], '│')}
          <Box width={w} justifyContent="center">
            <Box borderStyle="single" borderColor="inactive" paddingX={1} flexShrink={1}>
              {line(pill, { color: PALETTE.haiku })}
            </Box>
          </Box>
          <Text color="inactive" wrap="truncate-end">
            {branch(w, c, fan.xs.length > 0 ? fan.xs : [c])}
          </Text>
          {connector('arrows', w, fan.xs, '▼', PALETTE.haiku)}
          {fan.boxes}
          <Text color="inactive" wrap="truncate-end">
            {branch(w, c, fan.xs.length > 0 ? fan.xs : [c], true)}
          </Text>
          {connector('to-back', w, [c], '●')}
          <Box width={w} justifyContent="center">
            {backBox(backW)}
          </Box>
        </Box>
      )
    }

    // --- the diagram, by the room there is ------------------------------------------
    let diagram: RenderChildren
    if (tier === 'wide') {
      const L = Math.max(24, Math.min(32, Math.round(W * 0.27)))
      const A = W - L - 3
      const Rc = Math.max(28, Math.min(34, Math.round(A * 0.36)))
      const Sw = A - Rc - 4
      diagram = (
        <Box key="diagram" width={W} marginTop={1}>
          {planner(L)}
          <Box width={3} flexShrink={0} flexDirection="column" paddingTop={2}>
            <Text color={PALETTE.opus}>◂┄┄</Text>
          </Box>
          <Box width={A} flexShrink={0} flexDirection="column">
            <Box width={A} alignItems="flex-start">
              {sessionBox(Sw)}
              <Box width={4} flexShrink={0} paddingTop={2}>
                <Text dimColor>─▸ </Text>
              </Box>
              {configBox(Rc)}
            </Box>
            {flow(A, Math.floor(Sw / 2))}
          </Box>
        </Box>
      )
    } else if (tier === 'medium') {
      const Rc = Math.max(24, Math.min(32, Math.round(W * 0.38)))
      const Sw = Math.min(W, Math.max(36, Math.round(W * 0.66)))
      diagram = (
        <Box key="diagram" flexDirection="column" width={W} marginTop={1}>
          <Box width={W}>
            {planner(W - Rc - 1)}
            <Box marginLeft={1}>{configBox(Rc)}</Box>
          </Box>
          <Box width={W} justifyContent="center" marginTop={1}>
            {sessionBox(Sw)}
          </Box>
          {flow(W, Math.floor(W / 2))}
        </Box>
      )
    } else {
      diagram = (
        <Box key="diagram" flexDirection="column" width={W} marginTop={1}>
          {planner(W)}
          {configBox(W)}
          {sessionBox(W)}
          {flow(W, Math.floor(W / 2))}
        </Box>
      )
    }

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
            {line(dayTotal > 0 ? `${tokens(dayTotal)} · ${Math.round((cacheRead / dayTotal) * 100)}% cache` : 'no calls yet', { dim: true })}
          </Box>
          <Box flexDirection="column">
          {models.map(d => {
            const b = bar(total(d), top, barW, '▒')
            const color = modelColor(d.model)
            return (
              <Box key={`model-${d.model}`}>
                {cell(modelW, line(modelName(d.model), { color }))}
                <Text wrap="truncate-end">
                  <Text color={color}>{b.filled}</Text>
                  <Text color={color} dimColor>
                    {b.empty}
                  </Text>
                </Text>
                {cell(figureW + 1, line(tokens(total(d)), { bold: true, color }), true)}
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
      return frame(
        'board',
        w,
        'inactive',
        <>
          <Box justifyContent="space-between">
            {line('BOARD', { bold: true })}
            {line(waiting > 0 ? `${waiting} waiting on you` : `${board.length} cards`, { color: waiting > 0 ? PALETTE.wait : undefined, dim: waiting === 0 })}
          </Box>
          <Box flexDirection="column">
          {board.length === 0
            ? line('no cards (board/*.md)', { dim: true })
            : board.map(c => {
                const at = Date.parse(c.updated)
                return (
                  <Box key={`card-${c.id}`}>
                    {cell(statusW, line(c.status || '?', { color: cardColor(c.status) }))}
                    {cell(
                      Math.max(1, inner - statusW - ageW),
                      <Text wrap="truncate-end">
                        <Text bold>{c.repo}</Text> {c.title}
                      </Text>,
                    )}
                    {cell(ageW, line(Number.isNaN(at) ? '?' : ago(at, now), { dim: true }), true)}
                  </Box>
                )
              })}
          </Box>
        </>,
      )
    }

    const reposBox = (w: number) => {
      const columns = tier === 'wide' ? 2 : 1
      const inner = w - 4
      const colW = Math.floor((inner - (columns - 1) * 2) / columns)
      const [nameW = 10, markW = 13] = fit([Math.min(18, Math.max(10, ...repos.map(r => r.name.length + 1))), 13], colW, 8)
      const perColumn = Math.ceil(repos.length / columns)
      const row = (r: RepoRow) => {
        const mark = checkMark(r.check, now, r.failed)
        const verdict = r.review?.verdict ?? null
        return (
          <Box key={`repo-${r.name}`} width={colW}>
            {cell(nameW, line(r.name, { bold: true }))}
            {cell(markW, line(mark.text, { color: mark.color }))}
            <Box flexGrow={1} flexShrink={1}>
              {r.review
                ? line(`${verdict ?? 'packet'} ${r.review.sha.slice(0, 7)}${r.review.isCurrent ? '' : ' older'}`, { color: verdict ? verdictColor(verdict) : 'inactive' })
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
            {line(`${fresh}/${repos.length} pushable`, { color: fresh === repos.length ? PALETTE.ok : PALETTE.wait })}
          </Box>
          {repos.length === 0 ? (
            line('reading…', { dim: true })
          ) : (
            <Box>
              {Array.from({ length: columns }, (_, i) => (
                <Box key={`repo-col-${i}`} flexDirection="column" marginLeft={i > 0 ? 2 : 0}>
                  {repos.slice(i * perColumn, (i + 1) * perColumn).map(row)}
                </Box>
              ))}
            </Box>
          )}
        </>,
      )
    }

    const ledger =
      tier === 'narrow' || W < 80 ? (
        <Box key="ledger" flexDirection="column" width={W} marginTop={1}>
          {todayBox(W)}
          {boardBox(W)}
          {reposBox(W)}
        </Box>
      ) : (
        <Box key="ledger" flexDirection="column" width={W} marginTop={1}>
          <Box width={W}>
            {todayBox(Math.floor((W - 1) * 0.42))}
            <Box marginLeft={1}>{boardBox(W - 1 - Math.floor((W - 1) * 0.42))}</Box>
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
    const log = frame(
      'log',
      W,
      'inactive',
      <>
        <Text wrap="truncate-end">
          <Text bold>session log </Text>
          <Text dimColor>[ stream: live · {spinner} ]</Text>
        </Text>
        <Box flexDirection="column">
        {shown.length === 0
          ? line('nothing yet today', { dim: true })
          : shown.map((ev, i) => (
              <Box key={`event-${i}-${ev.at}`}>
                {cell(markW, line(i === 0 ? '›' : ' ', { color: PALETTE.ok }))}
                {cell(timeW, line(clockTime(ev.at), { bold: i === 0, dim: i !== 0 }))}
                {cell(sourceW, line(sourceLabel(ev), { color: sourceColor(ev) }))}
                <Box flexGrow={1} flexShrink={1}>
                  {line(`${ev.repo ? `${ev.repo} ` : ''}${eventText(ev)}`, {})}
                </Box>
                {cell(figureW, line(eventFigure(ev), { color: toneColor(ev.tone, ev.text) }), true)}
              </Box>
            ))}
        </Box>
      </>,
    )

    const statusPair = (key: string, label: string, value: string, color: string) => (
      <Text key={key}>
        <Text dimColor>{label} [ </Text>
        <Text color={color} bold>
          {value}
        </Text>
        <Text dimColor> ] </Text>
      </Text>
    )
    const footer = (
      <Box key="footer" flexDirection="column" width={W} marginTop={1}>
        <Text wrap="truncate-end">
          <Text color={PALETTE.ok}>~/code/wow-addons $ </Text>
          <Text dimColor>claude --model </Text>
          <Text color={builderColor}>{facts?.settings.model ?? family(builder)}</Text>
          <Text inverse> </Text>
        </Text>
        <Text wrap="truncate-end">
          {statusPair('helpers', 'helpers', `${running.length}/${Math.max(helpers.length, running.length)} active`, running.length > 0 ? PALETTE.wait : PALETTE.haiku)}
          {statusPair('opus', family(opusModel), `${opusRuns} runs`, PALETTE.opus)}
          {statusPair('gates', 'gates', `${fresh}/${repos.length}`, fresh === repos.length ? PALETTE.ok : PALETTE.wait)}
          {statusPair('board', 'board', `${waiting} waiting`, waiting > 0 ? PALETTE.wait : PALETTE.ok)}
          {statusPair('today', 'today', tokens(dayTotal), PALETTE.plain)}
        </Text>
      </Box>
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
        <Box marginTop={1} flexDirection="column">
          {log}
        </Box>
        {footer}
      </Box>
    )
  })
}
