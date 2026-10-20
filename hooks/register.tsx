import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentSteps, BoardCard, CheckStamp, ModelDay, RepoRow, SessionFacts, Snapshot } from '../types'

const PANE = 'harness'
const TITLE = 'Harness'
const SNAPSHOT_MS = 30_000
const SESSION_MS = 5_000

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

function bar(value: number, max: number, width: number): string {
  if (max <= 0 || width <= 0) return ''
  const cells = Math.round((value / max) * width)
  return '█'.repeat(cells) + '░'.repeat(width - cells)
}

const total = (d: ModelDay) => d.input + d.cacheRead + d.cacheWrite + d.output

/** A recorded verdict's colour: a clean one green, findings or a failure amber. */
export function verdictTone(verdict: string | null): 'inactive' | 'success' | 'warning' | 'text' {
  if (verdict === null) return 'inactive'
  if (/^\W*(no|zero|0) (findings?|issues?)\b/i.test(verdict)) return 'success'
  if (/\b[1-9]\d* (findings?|issues?)\b|fail|block|reject|\bnot\b/i.test(verdict)) return 'warning'
  if (/\b(ok|pass(ed)?|clean|approved?|lgtm)\b/i.test(verdict)) return 'success'
  return 'text'
}

/**
 * A check stamp as the panel says it: a push of HEAD passes (✓), edits made
 * since were not checked (+edits), the checked state is not committed yet
 * (commit), or the last check was on something else (old).
 */
export function checkMark(check: CheckStamp, now: number): { text: string; tone: 'success' | 'warning' | 'inactive' } {
  const age = ago(check.at, now)
  if (check.isFresh) return { text: check.isWorkFresh ? `✓ ${age}` : `✓ ${age} +edits`, tone: 'success' }
  if (check.isWorkFresh) return { text: `◐ ${age} commit`, tone: 'warning' }
  return { text: `· ${age} old`, tone: 'inactive' }
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
    const width = Math.max(30, e.props.bodyColumns)
    const barWidth = Math.max(4, Math.min(16, width - 34))

    const heading = (title: string, note?: string) => (
      <Box key={`heading-${title}`} marginTop={1}>
        <Text bold>{title}</Text>
        {note ? <Text dimColor> {note}</Text> : null}
      </Box>
    )

    // The session
    const sessionRows = facts ? (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {modelName(facts.model)}
          {facts.lastModel && modelName(facts.lastModel) !== modelName(facts.model) ? (
            <Text dimColor> · last call {modelName(facts.lastModel)}</Text>
          ) : null}
        </Text>
        <Text wrap="truncate-end">
          <Text color={(facts.percent ?? 0) >= 80 ? 'warning' : 'text'}>
            {bar(facts.contextTokens ?? 0, facts.window, barWidth)}
          </Text>{' '}
          {tokens(facts.contextTokens)} / {tokens(facts.window)}
          {facts.percent !== null ? ` ${Math.round(facts.percent)}%` : ''}
          {facts.costUsd !== null ? <Text dimColor> · ${facts.costUsd.toFixed(2)}</Text> : null}
        </Text>
      </Box>
    ) : (
      <Text dimColor>Reading the session…</Text>
    )

    // The subagents
    const running = rows.filter(a => a.status === 'running')
    const agentRows =
      rows.length === 0 ? (
        <Text dimColor>None running.</Text>
      ) : (
        <Box flexDirection="column">
          {rows.map(a => (
            <Box key={`agent-${a.id}`} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={a.status === 'running' ? 'success' : 'inactive'}>{a.status === 'running' ? '●' : '○'}</Text>{' '}
                <Text bold>{a.type}</Text>
                {a.steps ? (
                  <Text>
                    {' '}
                    {modelName(a.steps.model)} · ctx {tokens(a.steps.context)} · out {tokens(a.steps.output)} ·{' '}
                    {a.steps.steps} calls
                  </Text>
                ) : (
                  <Text dimColor> {a.status}</Text>
                )}
              </Text>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {a.description}
              </Text>
            </Box>
          ))}
        </Box>
      )

    // The board
    const board = snap?.board ?? []
    const waiting = board.filter(WAITING).length
    const boardRows =
      board.length === 0 ? (
        <Text dimColor>No cards. (board/*.md)</Text>
      ) : (
        <Box flexDirection="column">
          {board.map(c => {
            const at = Date.parse(c.updated)
            return (
              <Box key={`card-${c.id}`} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color={WAITING(c) ? 'warning' : c.status === 'done' ? 'inactive' : 'text'}>{c.status || '?'}</Text>{' '}
                  <Text bold>{c.repo}</Text> {c.title}
                  <Text dimColor> · {Number.isNaN(at) ? c.updated : ago(at, now)}</Text>
                </Text>
                {c.summary ? (
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {c.summary}
                  </Text>
                ) : null}
              </Box>
            )
          })}
        </Box>
      )

    // The repositories
    const repos = snap?.repos ?? []
    const fresh = repos.filter(r => r.check?.isFresh).length
    const repoRow = (r: RepoRow) => {
      const verdict = r.review?.verdict ?? null
      const verdictColor = verdictTone(verdict)
      const mark = r.check && checkMark(r.check, now)
      return (
        <Box key={`repo-${r.name}`}>
          <Box width={18} flexShrink={0}>
            <Text wrap="truncate-end">{r.name}</Text>
          </Box>
          <Box width={14} flexShrink={0}>
            {mark ? (
              <Text color={mark.tone} wrap="truncate-end">
                {mark.text}
              </Text>
            ) : (
              <Text dimColor>no stamp</Text>
            )}
          </Box>
          <Box flexGrow={1}>
            {r.review ? (
              <Text color={verdictColor} wrap="truncate-end">
                {verdict ?? 'packet'} {r.review.sha.slice(0, 7)}
                {r.review.isCurrent ? '' : ' (older)'}
              </Text>
            ) : (
              <Text dimColor>no review</Text>
            )}
          </Box>
        </Box>
      )
    }

    // Today
    const models = snap?.usage.models ?? []
    const dayTotal = models.reduce((sum, d) => sum + total(d), 0)
    const cacheRead = models.reduce((sum, d) => sum + d.cacheRead, 0)
    const top = models[0] ? total(models[0]) : 0
    const usageRows =
      models.length === 0 ? (
        <Text dimColor>No calls today yet.</Text>
      ) : (
        <Box flexDirection="column">
          {models.map(d => (
            <Box key={`model-${d.model}`}>
              <Box width={11} flexShrink={0}>
                <Text wrap="truncate-end">{modelName(d.model)}</Text>
              </Box>
              <Box width={7} flexShrink={0} justifyContent="flex-end">
                <Text>{tokens(total(d))}</Text>
              </Box>
              <Text> {bar(total(d), top, barWidth)}</Text>
              <Text dimColor wrap="truncate-end">
                {' '}
                {d.calls} calls · out {tokens(d.output)}
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

        {heading('Session')}
        {sessionRows}

        {heading('Subagents', running.length > 0 ? `${running.length} running` : undefined)}
        {agentRows}

        {heading('Board', waiting > 0 ? `${waiting} waiting on you` : undefined)}
        {boardRows}

        {heading('Repositories', snap ? `checks ${fresh}/${repos.length} fresh` : undefined)}
        {repos.length === 0 ? <Text dimColor>Reading…</Text> : <Box flexDirection="column">{repos.map(repoRow)}</Box>}

        {heading(
          'Today',
          dayTotal > 0 ? `${tokens(dayTotal)} tokens · ${Math.round((cacheRead / dayTotal) * 100)}% cache reads` : undefined,
        )}
        {usageRows}
      </Box>
    )
  })
}
