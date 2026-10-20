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
export function bar(value: number, max: number, width: number): { filled: string; empty: string } {
  if (max <= 0 || width <= 0) return { filled: '', empty: '░'.repeat(Math.max(0, width)) }
  const share = Math.min(1, Math.max(0, value / max))
  const eighths = Math.max(value > 0 ? 1 : 0, Math.round(share * width * 8))
  const part = EIGHTHS[eighths % 8] ?? ''
  const full = Math.floor(eighths / 8)
  return { filled: '█'.repeat(full) + part, empty: '░'.repeat(width - full - (part ? 1 : 0)) }
}

const total = (d: ModelDay) => d.input + d.cacheRead + d.cacheWrite + d.output

// --- colours ----------------------------------------------------------------

/** Each model family its own: Opus purple, Sonnet orange, Haiku blue. */
export function modelColor(model: string | null | undefined): string {
  const m = (model ?? '').toLowerCase()
  if (m.includes('opus')) return '#8b5cf6'
  if (m.includes('sonnet')) return '#f97316'
  if (m.includes('haiku')) return '#3b82f6'
  return 'inactive'
}

// A section's label and border.
const SECTION = {
  session: '#0891b2',
  agents: '#7c3aed',
  repos: '#0d9488',
  today: '#4f46e5',
  board: '#ca8a04',
  log: '#64748b',
} as const

// A source of the log; a q.ts run of another name (test, build) is a check's colour.
const CHECK = '#14b8a6'
const SOURCE: Record<string, string> = {
  check: CHECK,
  hook: '#ec4899',
  review: '#d946ef',
  board: '#ca8a04',
  ask: '#06b6d4',
}

export function sourceColor(e: Pick<HarnessEvent, 'source' | 'model'>): string {
  if (e.source === 'helper') return modelColor(e.model)
  return SOURCE[e.source] ?? CHECK
}

type Tone = 'success' | 'warning' | 'error' | 'inactive' | 'text'

/** A status: ok green, waiting amber, failed red. */
export function toneColor(tone: HarnessEvent['tone'], text = ''): Tone {
  if (tone === 'ok') return 'success'
  if (tone === 'wait') return 'warning'
  if (tone === 'fail') return 'error'
  if (tone === 'info') return 'text'
  return verdictTone(text)
}

/**
 * A recorded verdict's colour: a clean one green (one that says so first, its
 * fixed findings after it, too), findings or a failure amber. A log line's
 * verdict may lead with the commit.
 */
export function verdictTone(verdict: string | null): 'inactive' | 'success' | 'warning' | 'text' {
  if (verdict === null) return 'inactive'
  if (/^\W*([0-9a-f]{7,40}\s+)?((no|zero|0) (findings?|issues?)|clean|lgtm|approved?)\b/i.test(verdict)) return 'success'
  if (/\b[1-9]\d* (findings?|issues?)\b|fail|block|reject|\bnot\b/i.test(verdict)) return 'warning'
  if (/\b(ok|pass(ed)?|clean|approved?|lgtm)\b/i.test(verdict)) return 'success'
  return 'text'
}

/** A subagent's status: running amber, done green, failed or stopped red. */
export function agentTone(status: string): Tone {
  if (status === 'running') return 'warning'
  if (status === 'completed' || status === 'done') return 'success'
  if (/fail|kill|error|stop|cancel/.test(status)) return 'error'
  return 'inactive'
}

/** A card's status: what waits on the user amber, done green. */
export function cardTone(status: string): Tone {
  if (status.startsWith('waiting') || status === 'ready-to-push') return 'warning'
  if (status === 'done') return 'success'
  return 'text'
}

/**
 * A check stamp as the panel says it: a push of HEAD passes (✓), edits made
 * since were not checked (+edits), the checked state is not committed yet
 * (commit), the last check was on something else (old), or the last run
 * failed after the newest stamp (✗).
 */
export function checkMark(check: CheckStamp | null, now: number, failed: RepoRow['failed'] = null): { text: string; tone: Tone } {
  if (failed) return { text: `✗ ${ago(failed.at, now)} exit ${failed.exit}`, tone: 'error' }
  if (!check) return { text: 'no stamp', tone: 'inactive' }
  const age = ago(check.at, now)
  if (check.isFresh) return { text: check.isWorkFresh ? `✓ ${age}` : `✓ ${age} +edits`, tone: 'success' }
  if (check.isWorkFresh) return { text: `◐ ${age} commit`, tone: 'warning' }
  return { text: `· ${age} old`, tone: 'inactive' }
}

/** A log line's words: a helper's model, tokens and time after what it did. */
export function eventText(e: HarnessEvent): string {
  const more = [e.model && e.ms !== undefined ? modelName(e.model) : '', e.tokens ? `${tokens(e.tokens)} tok` : '', e.ms ? duration(e.ms) : '']
  return [e.text, ...more.filter(Boolean)].join(' · ')
}

/** A log line's time: `14:02`, local. */
export function clockTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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

async function refreshSession($: EngineInterface, lastModel?: string) {
  const [model, usage, previous] = await Promise.all([$.session.model(), $.session.usage(), read($, session)])
  const facts: SessionFacts = {
    model,
    lastModel: lastModel ?? previous?.lastModel ?? null,
    contextTokens: usage.context.tokens ?? null,
    window: usage.context.window,
    percent: usage.context.percent ?? null,
    costUsd: usage.cost?.usd ?? null,
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
        void refreshSession($, usage?.model ?? e.model).catch(() => {})
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
    ])
    const now = await $.clock.now()
    const width = Math.max(32, e.props.bodyColumns)
    // Inside a section: its border and a column of padding each side.
    const inner = width - 4

    // A section: a rounded box in its colour, its title a label over the
    // box's top border: a later sibling in a wrapper with no border, so it
    // paints over the border row and no offset reaches outside the wrapper.
    const section = (key: keyof typeof SECTION, title: string, note: string | undefined, body: RenderChildren) => (
      <Box key={key} flexDirection="column" width={width} marginTop={1}>
        <Box flexDirection="column" width={width} paddingX={1} borderStyle="round" borderColor={SECTION[key]}>
          {body}
        </Box>
        <Box position="absolute" top={0} left={2} width={width - 4}>
          <Box flexShrink={0}>
            <Text backgroundColor={SECTION[key]} color="#ffffff" bold>
              {` ${title} `}
            </Text>
          </Box>
          {note ? (
            <Text color={SECTION[key]} wrap="truncate-end">
              {` ${note} `}
            </Text>
          ) : null}
        </Box>
      </Box>
    )
    // A column of a width `fit` gave it; its texts truncate, never wrap.
    const cell = (w: number, child: RenderChildren, isRight = false) => (
      <Box width={w} flexShrink={0} justifyContent={isRight ? 'flex-end' : 'flex-start'}>
        {child}
      </Box>
    )
    const quiet = (text: string) => (
      <Text dimColor wrap="truncate-end">
        {text}
      </Text>
    )

    // The session
    const contextBar = bar(facts?.contextTokens ?? 0, facts?.window ?? 0, Math.max(6, Math.min(24, inner - 26)))
    const contextTone = (facts?.percent ?? 0) >= 90 ? 'error' : (facts?.percent ?? 0) >= 80 ? 'warning' : modelColor(facts?.model)
    const sessionBody = facts ? (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={modelColor(facts.model)} bold>
              {modelName(facts.model)}
            </Text>
            {facts.lastModel && modelName(facts.lastModel) !== modelName(facts.model) ? (
              <Text>
                <Text dimColor> · last call </Text>
                <Text color={modelColor(facts.lastModel)}>{modelName(facts.lastModel)}</Text>
              </Text>
            ) : null}
          </Text>
          {facts.costUsd !== null ? <Text dimColor>${facts.costUsd.toFixed(2)}</Text> : null}
        </Box>
        <Text wrap="truncate-end">
          <Text dimColor>context </Text>
          <Text color={contextTone}>{contextBar.filled}</Text>
          <Text dimColor>{contextBar.empty}</Text> {tokens(facts.contextTokens)}
          <Text dimColor> / {tokens(facts.window)}</Text>
          {facts.percent !== null ? <Text color={contextTone}> {Math.round(facts.percent)}%</Text> : null}
        </Text>
      </Box>
    ) : (
      quiet('Reading the session…')
    )

    // The subagents: model, status, tokens
    const running = rows.filter(a => a.status === 'running').length
    const [glyphW = 2, nameW = 8, agentModelW = 11, statusW = 10] = fit(
      [2, Math.min(16, Math.max(8, ...rows.map(a => a.type.length + 1))), 11, 10],
      inner,
    )
    const agentsBody =
      rows.length === 0 ? (
        quiet('None running.')
      ) : (
        <Box flexDirection="column">
          {rows.map(a => (
            <Box key={`agent-${a.id}`} flexDirection="column">
              <Box>
                {cell(glyphW, <Text wrap="truncate-end" color={agentTone(a.status)}>{a.status === 'running' ? '●' : '○'}</Text>)}
                {cell(
                  nameW,
                  <Text bold wrap="truncate-end">
                    {a.type}
                  </Text>,
                )}
                {cell(agentModelW, <Text wrap="truncate-end" color={modelColor(a.steps?.model)}>{a.steps ? modelName(a.steps.model) : '…'}</Text>)}
                {cell(statusW, <Text wrap="truncate-end" color={agentTone(a.status)}>{a.status}</Text>)}
                <Text wrap="truncate-end">
                  {a.steps ? (
                    <Text>
                      {tokens(a.steps.context)}
                      <Text dimColor> ctx </Text>
                      {tokens(a.steps.output)}
                      <Text dimColor> out · {a.steps.steps} calls</Text>
                    </Text>
                  ) : (
                    <Text dimColor>no calls yet</Text>
                  )}
                </Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {a.description}
              </Text>
            </Box>
          ))}
        </Box>
      )

    // The repositories: each one's check and review
    const repos = snap?.repos ?? []
    const fresh = repos.filter(r => r.check?.isFresh).length
    const [repoW = 10, markW = 15] = fit([Math.min(20, Math.max(10, ...repos.map(r => r.name.length + 2))), 15], inner)
    const reposBody =
      repos.length === 0 ? (
        quiet('Reading…')
      ) : (
        <Box flexDirection="column">
          {repos.map(r => {
            const mark = checkMark(r.check, now, r.failed)
            const verdict = r.review?.verdict ?? null
            return (
              <Box key={`repo-${r.name}`}>
                {cell(
                  repoW,
                  <Text bold wrap="truncate-end">
                    {r.name}
                  </Text>,
                )}
                {cell(
                  markW,
                  <Text color={mark.tone} wrap="truncate-end">
                    {mark.text}
                  </Text>,
                )}
                <Box flexGrow={1} flexShrink={1}>
                  {r.review ? (
                    <Text wrap="truncate-end">
                      <Text color={verdictTone(verdict)}>{verdict ?? 'packet'}</Text>
                      <Text dimColor>
                        {' '}
                        {r.review.sha.slice(0, 7)}
                        {r.review.isCurrent ? '' : ' older'}
                      </Text>
                    </Text>
                  ) : (
                    quiet('no review')
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>
      )

    // Today: tokens by model, a bar each
    const models = snap?.usage.models ?? []
    const dayTotal = models.reduce((sum, d) => sum + total(d), 0)
    const cacheRead = models.reduce((sum, d) => sum + d.cacheRead, 0)
    const top = models[0] ? total(models[0]) : 0
    const [modelW = 12, usageBar = 6, totalW = 7] = fit([12, Math.max(6, Math.min(28, inner - 12 - 7 - 11)), 7], inner)
    const todayBody =
      models.length === 0 ? (
        quiet('No calls today yet.')
      ) : (
        <Box flexDirection="column">
          {models.map(d => {
            const b = bar(total(d), top, usageBar)
            return (
              <Box key={`model-${d.model}`}>
                {cell(
                  modelW,
                  <Text color={modelColor(d.model)} wrap="truncate-end">
                    {modelName(d.model)}
                  </Text>,
                )}
                {cell(
                  usageBar,
                  <Text wrap="truncate-end">
                    <Text color={modelColor(d.model)}>{b.filled}</Text>
                    <Text dimColor>{b.empty}</Text>
                  </Text>,
                )}
                {cell(totalW, <Text wrap="truncate-end" bold>{tokens(total(d))}</Text>, true)}
                <Text dimColor wrap="truncate-end">
                  {' '}
                  {d.calls} calls
                </Text>
              </Box>
            )
          })}
        </Box>
      )

    // The board
    const board = snap?.board ?? []
    const waiting = board.filter(WAITING).length
    const [statusWidth = 5, ageWidth = 5] = fit([Math.min(15, Math.max(5, ...board.map(c => c.status.length + 1))), 5], inner)
    const boardBody =
      board.length === 0 ? (
        quiet('No cards. (board/*.md)')
      ) : (
        <Box flexDirection="column">
          {board.map(c => {
            const at = Date.parse(c.updated)
            return (
              <Box key={`card-${c.id}`} flexDirection="column">
                <Box>
                  {cell(statusWidth, <Text wrap="truncate-end" color={cardTone(c.status)}>{c.status || '?'}</Text>)}
                  {cell(
                    Math.max(1, inner - statusWidth - ageWidth),
                    <Text wrap="truncate-end">
                      <Text bold>{c.repo}</Text> {c.title}
                    </Text>,
                  )}
                  {cell(ageWidth, <Text wrap="truncate-end" dimColor>{Number.isNaN(at) ? '?' : ago(at, now)}</Text>, true)}
                </Box>
                {c.summary ? (
                  <Text dimColor wrap="truncate-end">
                    {' '.repeat(statusWidth)}
                    {c.summary}
                  </Text>
                ) : null}
              </Box>
            )
          })}
        </Box>
      )

    // The log: today's events, newest first
    const events = (snap?.events ?? []).slice(0, LOG_LINES)
    const [timeW = 6, sourceWidth = 5, logRepoWidth = 1] = fit(
      [6, Math.min(8, Math.max(5, ...events.map(ev => ev.source.length + 1))), Math.min(12, Math.max(1, ...events.map(ev => (ev.repo ? ev.repo.length + 1 : 0))))],
      inner,
      12,
    )
    const logBody =
      events.length === 0 ? (
        quiet('Nothing yet today.')
      ) : (
        <Box flexDirection="column">
          {events.map((ev, i) => (
            <Box key={`event-${i}-${ev.at}`}>
              {cell(timeW, <Text wrap="truncate-end" dimColor>{clockTime(ev.at)}</Text>)}
              {cell(sourceWidth, <Text wrap="truncate-end" color={sourceColor(ev)}>{ev.source}</Text>)}
              {cell(
                logRepoWidth,
                <Text bold wrap="truncate-end">
                  {ev.repo}
                </Text>,
              )}
              <Text color={toneColor(ev.tone, ev.text)} wrap="truncate-end">
                {eventText(ev)}
              </Text>
            </Box>
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column" width={width}>
        <Box justifyContent="space-between">
          <Text dimColor>{snap ? `read ${ago(snap.at, now)} ago` : 'reading…'}</Text>
          <Button key="refresh" label="Refresh" onPress={() => void refreshSnapshot($, true)} />
        </Box>
        {error ? (
          <Text color="error" wrap="wrap">
            Snapshot failed: {error}
          </Text>
        ) : null}
        {section('session', 'Session', undefined, sessionBody)}
        {section('agents', 'Subagents', running > 0 ? `${running} running` : undefined, agentsBody)}
        {section('repos', 'Repositories', snap ? `checks ${fresh}/${repos.length}` : undefined, reposBody)}
        {section(
          'today',
          'Today',
          dayTotal > 0 ? `${tokens(dayTotal)} tokens · ${Math.round((cacheRead / dayTotal) * 100)}% cache reads` : undefined,
          todayBody,
        )}
        {section('board', 'Board', waiting > 0 ? `${waiting} waiting` : undefined, boardBody)}
        {section('log', 'Log', events.length > 0 ? 'today' : undefined, logBody)}
      </Box>
    )
  })
}
