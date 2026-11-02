import { expect, mock, test } from 'claude-code/testing'

const MODE = '@MODE@'
const SHOWN = @SHOWN@
const BUSY = MODE === 'busy'

test('pane cpu', async ($, on) => {
  mock.env(on, { HOME: '/Users/someone', HARNESS_CALM: '@CALMENV@' })
  const clock = mock.clock(on, { now: SNAP.at + 3000 })
  const calls: Record<string, number> = {}
  const count = (k: string) => { calls[k] = (calls[k] ?? 0) + 1 }
  const snap = BUSY
    ? { ...SNAP, gates: [{ ...(SNAP.gates?.[0] ?? {}), pid: 1, name: 'check', repo: 'yonder', at: SNAP.at }], sessions: SNAP.sessions.map((s: any) => ({ ...s, status: 'busy' })) }
    : { ...SNAP, gates: [], sessions: SNAP.sessions.map((s: any) => ({ ...s, status: 'idle' })) }
  on('session.root', () => ({ value: '/Users/someone/code/wow-addons' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('process.run', () => { count('process.run'); return { value: { exitCode: 0, stdout: JSON.stringify(snap), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('fs.stat', () => { count('fs.stat'); return { value: { size: 1, mtimeMs: 1 } } })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'harness', title: 'Harness', isShown: SHOWN, isFocused: false, isPlaced: true }] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: BUSY ? [1, 2, 3].map(i => ({ id: `a${i}`, type: 'reviewer', description: 'x', status: 'running' })) : [] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'me' }))
  on('session.usage', () => ({ value: { context: { tokens: 403_000, window: 1_000_000, percent: 40 }, cost: { usd: 14.72 }, rateLimits: [{ kind: 'five_hour', percentUsed: 28 }] } }))
  on('settings.read', () => ({ value: { model: 'opus' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/Users/someone/code/wow-addons', surface: 'desktop', isInteractive: true })
  if (BUSY) await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(1100)
  const ui = await $.ui.mount({ plugin: 'harness-view', surface: 'desktop', component: 'Pane', requestId: 'harness', props: { title: 'Harness', isFocused: false, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} } })
  await ui.advance(500)
  const tree = await ui.drawn()
  const clients: string[] = []
  const props: Record<string, any> = {}
  const svgs: string[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === 'Client') { clients.push(n.props.key); props[n.props.key] = n.props.props }
    if (n.type === 'Svg') svgs.push(n.props.source)
    walk(n.children)
  }
  walk(tree)
  const animates = svgs.reduce((a, s) => a + (s.match(/<animate/g)?.length ?? 0) + (s.match(/<animateTransform/g)?.length ?? 0), 0)
  const animSvgs = svgs.filter(s => /repeatCount="indefinite"/.test(s)).length
  // 30 s in 80 ms steps; count pane re-renders (tree changes), per-Client redraws
  const WINDOW = 30_000, STEP = 80
  let renders = 0, last = JSON.stringify(tree)
  const clientRedraws: Record<string, number> = {}
  const lastClient: Record<string, string> = {}
  for (const k of clients) lastClient[k] = JSON.stringify(await ui.drawn({ in: k }))
  const t0 = performance.now()
  for (let t = 0; t < WINDOW; t += STEP) {
    await clock.advance(STEP)
    await ui.advance(STEP)
    const now = JSON.stringify(await ui.drawn())
    if (now !== last) { renders++; last = now }
    for (const k of clients) {
      const c = JSON.stringify(await ui.drawn({ in: k }))
      if (c !== lastClient[k]) { clientRedraws[k] = (clientRedraws[k] ?? 0) + 1; lastClient[k] = c }
    }
  }
  const wall = performance.now() - t0
  // cost of one render
  const R = 20
  const r0 = performance.now()
  for (let i = 0; i < R; i++) await ui.drawn()
  const draw = (performance.now() - r0) / R
  // timers alive: an instance counts frames on its own 80 ms timer while it moves (spin/flow on, live, ago, a tween or a fresh blink for a moment)
  const kinds: Record<string, number> = {}
  let timersAlive = 0
  let ticks = 0
  for (const k of clients) {
    const p = props[k]
    kinds[p.kind] = (kinds[p.kind] ?? 0) + 1
    if ((p.kind === 'spin' || p.kind === 'flow') ? p.on : (p.kind === 'live' || p.kind === 'ago')) { timersAlive++; ticks += 1000 / (p.kind === 'live' ? 400 : p.kind === 'ago' ? 1000 : 80) }
  }
  const totalClient = Object.values(clientRedraws).reduce((a, b) => a + b, 0)
  console.log('PANE-CPU ' + JSON.stringify({ MODE, shown: SHOWN, clients: clients.length, kinds, timersAlive, timerTicksPerSec: ticks, svgs: svgs.length, animatedSvgs: animSvgs, animateElements: animates, svgBytes: svgs.join('').length, treeRenders30s: renders, clientRedraws30s: totalClient, clientRedrawsPerSec: +(totalClient / 30).toFixed(1), calls, drawMs: +draw.toFixed(2), wallMs: Math.round(wall) }))
  await ui.unmount()
  expect(1).toBe(1)
})
