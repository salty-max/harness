import type { RenderSurface } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { agentTone, bar, checkMark, clockTime, eventText, fit, modelColor, modelName, sourceColor, statusLine, tokens, toneColor, verdictTone } from './register'

const SNAPSHOT: Snapshot = {
  at: 1_760_940_000_000,
  repos: [
    { name: 'yonder', head: 'f4ab31a', check: { tree: 'abc', at: 1_760_939_000_000, isFresh: true, isWorkFresh: true }, failed: null, review: null },
    {
      name: 'wow-data',
      head: '6b545ad',
      check: null,
      failed: { at: 1_760_939_500_000, exit: 1 },
      review: { sha: '6b545ad', at: 1_760_930_000_000, verdict: 'no findings', isCurrent: true },
    },
  ],
  board: [
    {
      id: 'harness-d',
      repo: 'addon-kit',
      title: 'The harness panel',
      status: 'waiting-test',
      session: 'harness D',
      updated: '2026-10-20T09:00:00+02:00',
      summary: 'Open the Harness pane and check the numbers.',
    },
  ],
  usage: {
    day: '2026-10-20',
    models: [
      { model: 'claude-opus-5-5', calls: 329, input: 654, cacheRead: 107_000_000, cacheWrite: 1_700_000, output: 353_000 },
      { model: 'claude-haiku-4-5-20251001', calls: 31, input: 0, cacheRead: 0, cacheWrite: 600_000, output: 57_000 },
      { model: 'claude-haiku-5-5', calls: 2, input: 0, cacheRead: 70_000, cacheWrite: 7_000, output: 600 },
    ],
    files: 27,
  },
  events: [
    { at: 1_760_939_900_000, source: 'check', tone: 'fail', repo: 'wow-data', text: 'check: FAILED (exit 1, 3.2s) · .cache/logs/check.log' },
    {
      id: 't1:end',
      at: 1_760_939_800_000,
      source: 'helper',
      tone: 'ok',
      repo: 'yonder',
      text: 'reviewer done',
      model: 'claude-opus-5-5',
      tokens: 106_689,
      ms: 503_770,
    },
    { at: 1_760_939_700_000, source: 'board', tone: 'wait', repo: 'addon-kit', text: 'The harness panel running → waiting-test' },
    { at: 1_760_939_600_000, source: 'review', tone: '', repo: 'yonder', text: 'f4ab31a no findings' },
  ],
}

const PANE = {
  component: 'Pane',
  requestId: 'harness',
  props: { title: 'Harness', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

describe('numbers', () => {
  test('tokens and model names read short', async () => {
    expect(tokens(950)).toBe('950')
    expect(tokens(4_200)).toBe('4.2k')
    expect(tokens(107_000_000)).toBe('107M')
    expect(modelName('claude-opus-5-5')).toBe('opus 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
  })

  test('the status line is one line and says what claude-hud does not', async () => {
    const line = statusLine(SNAPSHOT, 2)
    expect(line.includes('\n')).toBe(false)
    expect(line).toBe('harness · board 1 waiting · 2 agents · checks 1/2 · today opus 109M haiku 735k')
    expect(statusLine(null, 0)).toBe('harness: reading')
  })

  test('a clean verdict is green, findings amber', async () => {
    expect(verdictTone('no findings')).toBe('success')
    expect(verdictTone('0 findings')).toBe('success')
    expect(verdictTone('clean')).toBe('success')
    expect(verdictTone('clean (7 findings fixed in f73192e)')).toBe('success')
    expect(verdictTone('f4ab31a no findings')).toBe('success')
    expect(verdictTone('f4ab31a 2 findings')).toBe('warning')
    expect(verdictTone('2 findings')).toBe('warning')
    expect(verdictTone('6 findings on 5c2476b, fixed in 1d0646a')).toBe('warning')
    expect(verdictTone('3 findings, otherwise ok')).toBe('warning')
    expect(verdictTone('not clean')).toBe('warning')
    expect(verdictTone('looked')).toBe('text')
    expect(verdictTone(null)).toBe('inactive')
  })

  test('bars fill in eighths of a cell, a sliver for anything above zero', async () => {
    expect(bar(50, 100, 8)).toEqual({ filled: '████', empty: '░░░░' })
    expect(bar(3, 16, 4)).toEqual({ filled: '▊', empty: '░░░' })
    expect(bar(1, 1_000_000, 4)).toEqual({ filled: '▏', empty: '░░░' })
    expect(bar(0, 100, 3)).toEqual({ filled: '', empty: '░░░' })
    expect(bar(200, 100, 3)).toEqual({ filled: '███', empty: '' })
    expect(bar(5, 0, 2)).toEqual({ filled: '', empty: '░░' })
  })

  test('columns as asked when they fit, narrower in step when they do not', async () => {
    expect(fit([2, 12, 11, 10], 68)).toEqual([2, 12, 11, 10])
    expect(fit([2, 16, 11, 10], 28)).toEqual([1, 8, 5, 5])
    expect(fit([6, 7, 12], 30, 12)).toEqual([4, 5, 8])
    expect(fit([10, 15], 4)).toEqual([1, 1])
  })

  test('each model its colour, each status its own', async () => {
    expect(modelColor('claude-opus-5-5')).toBe('#8b5cf6')
    expect(modelColor('opus')).toBe('#8b5cf6')
    expect(modelColor('claude-sonnet-5-5')).toBe('#f97316')
    expect(modelColor('claude-haiku-4-5-20251001')).toBe('#3b82f6')
    expect(modelColor(undefined)).toBe('inactive')
    expect([toneColor('ok'), toneColor('wait'), toneColor('fail'), toneColor('info')]).toEqual(['success', 'warning', 'error', 'text'])
    expect(toneColor('', 'f4ab31a no findings')).toBe('success')
    expect(toneColor('', 'f4ab31a 2 findings')).toBe('warning')
    expect([agentTone('running'), agentTone('completed'), agentTone('failed'), agentTone('killed')]).toEqual(['warning', 'success', 'error', 'error'])
    expect(sourceColor({ source: 'helper', model: 'claude-haiku-5-5' })).toBe('#3b82f6')
    expect(sourceColor({ source: 'test' })).toBe(sourceColor({ source: 'check' }))
  })

  test("a log line says a helper's model, tokens and time", async () => {
    expect(eventText({ at: 0, source: 'helper', tone: 'ok', repo: '', text: 'reviewer done', model: 'claude-opus-5-5', tokens: 106_689, ms: 503_770 })).toBe(
      'reviewer done · opus 5.5 · 107k tok · 8m 24s',
    )
    // A start says its model in its colour only: no time yet.
    expect(eventText({ at: 0, source: 'helper', tone: 'info', repo: '', text: 'reviewer started: Review', model: 'opus' })).toBe('reviewer started: Review')
    expect(clockTime(new Date(2026, 9, 20, 9, 5).getTime())).toBe('09:05')
  })

  test('a check says whether a push of HEAD passes and what changed since', async () => {
    const at = 1_000_000
    const now = at + 12 * 60_000
    expect(checkMark(null, now)).toEqual({ text: 'no stamp', tone: 'inactive' })
    expect(checkMark({ tree: 't', at, isFresh: true, isWorkFresh: true }, now, { at: at + 60_000, exit: 1 })).toEqual({ text: '✗ 11m exit 1', tone: 'error' })
    expect(checkMark({ tree: 't', at, isFresh: true, isWorkFresh: true }, now)).toEqual({ text: '✓ 12m', tone: 'success' })
    expect(checkMark({ tree: 't', at, isFresh: true, isWorkFresh: false }, now)).toEqual({ text: '✓ 12m +edits', tone: 'success' })
    expect(checkMark({ tree: 't', at, isFresh: false, isWorkFresh: true }, now)).toEqual({ text: '◐ 12m commit', tone: 'warning' })
    expect(checkMark({ tree: 't', at, isFresh: false, isWorkFresh: false }, now)).toEqual({ text: '· 12m old', tone: 'inactive' })
  })
})

test('the pane draws the board, the checks and the day on every surface', async ($, on) => {
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  mock.env(on, { HOME: '/Users/someone' })
  mock.clock(on)
  on('session.surfaces', () => ({ value: ['desktop'] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'harness-view', surface, ...PANE })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /The harness panel/ })).toBeDefined()
    expect(await ui.find({ text: / 1 waiting / })).toBeDefined()
    expect(await ui.find({ text: / checks 1\/2 / })).toBeDefined()
    expect(await ui.find({ text: /^no findings$/ })).toBeDefined()
    expect(await ui.find({ text: /opus 5.5/ })).toBeDefined()
    expect(await ui.find({ text: /✗ \d+\w exit 1/ })).toBeDefined()
    // The log, newest first, a helper's model, tokens and time after it.
    const log = await ui.findAll({ type: 'Text', text: /check: FAILED|reviewer done|running → waiting-test|f4ab31a no findings/ })
    expect(log.map(t => t.text)).toEqual([
      'check: FAILED (exit 1, 3.2s) · .cache/logs/check.log',
      'reviewer done · opus 5.5 · 107k tok · 8m 24s',
      'The harness panel running → waiting-test',
      'f4ab31a no findings',
    ])
    // Each section a rounded box, its label on the top border.
    for (const title of [' Session ', ' Subagents ', ' Repositories ', ' Today ', ' Board ', ' Log ']) {
      expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    }
    expect(JSON.stringify(await ui.drawn())).toContain('"borderStyle":"round"')
    await ui.unmount()
  }
  expect(runs[0]?.[0]).toBe('bun')
  expect(runs[0]?.slice(2)).toEqual(['--root', '/Users/someone/code/wow-addons', '--fresh'])
  expect(statuses.at(-1)).toBe('harness · board 1 waiting · checks 1/2 · today opus 109M haiku 735k')
})

test('a failing snapshot says why in the pane', async ($, on) => {
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'boom: no projects', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.status', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  mock.env(on, { HOME: '/Users/someone' })
  mock.clock(on)
  const ui = await $.ui.mount({ plugin: 'harness-view', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ text: /Snapshot failed: boom: no projects/ })).toBeDefined()
  await ui.unmount()
})

for (const [where, project, isShown] of [
  ['in the family folder', '/Users/someone/code/wow-addons/yonder', true],
  ['anywhere else', '/Users/someone/code/other', false],
] as const) {
  test(`the pane opens ${where}: ${isShown}`, async ($, on) => {
    mock.env(on, { HOME: '/Users/someone' })
    mock.clock(on)
    const opened: string[] = []
    on('session.root', () => ({ value: project }))
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: project, surface: 'desktop', isInteractive: true })
    expect(opened).toEqual(isShown ? ['harness'] : [])
  })
}

test('a headless run reads nothing, /harness opens the pane and reads anew', async ($, on) => {
  mock.env(on, { HOME: '/Users/someone' })
  mock.clock(on)
  let surfaces: RenderSurface[] = []
  const runs: string[][] = []
  const opened: string[] = []
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.root', () => ({ value: '/Users/someone/code/wow-addons' }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/Users/someone/code/wow-addons', surface: null, isInteractive: false })
  expect(runs).toEqual([])

  surfaces = ['desktop']
  const answer = await $.command.run({
    command: 'harness',
    args: '',
    origin: { kind: 'sdk' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(answer.text).toBe('Harness panel opened.')
  expect(opened).toEqual(['harness', 'harness'])
  const ui = await $.ui.mount({ plugin: 'harness-view', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  expect(runs.some(argv => argv.includes('--fresh'))).toBe(true)
  await ui.unmount()
})
