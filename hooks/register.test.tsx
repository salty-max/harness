import type { RenderSurface } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import {
  agentColor,
  bar,
  branch,
  centre,
  checkMark,
  clockTime,
  eventFigure,
  eventText,
  fit,
  holds,
  marks,
  modelColor,
  modelName,
  PALETTE,
  resetIn,
  sourceColor,
  sourceLabel,
  statusLine,
  tokens,
  toPush,
  toneColor,
  verdictTone,
  where,
} from './register'

const SNAPSHOT: Snapshot = {
  at: 1_760_940_000_000,
  repos: [
    { name: 'yonder', head: 'f4ab31a', check: { tree: 'abc', at: 1_760_939_000_000, isFresh: true, isWorkFresh: true }, failed: null, review: null, ahead: 2 },
    {
      name: 'wow-data',
      head: '6b545ad',
      check: null,
      failed: { at: 1_760_939_500_000, exit: 1 },
      review: { sha: '6b545ad', at: 1_760_930_000_000, verdict: 'no findings', isCurrent: true, base: 'a'.repeat(40), covers: true },
      ahead: 1,
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
  helpers: [
    { name: 'reviewer', model: 'opus', description: 'Reviews one change.' },
    { name: 'architect', model: 'opus', description: 'A second opinion.' },
    { name: 'data-scout', model: 'sonnet', description: 'Answers a data question.' },
    { name: 'prose-reader', model: 'sonnet', description: 'Reads text cold.' },
  ],
  helperDay: {
    reviewer: { runs: 2, tokens: 190_000, ms: 900_000, lastAt: 1_760_939_800_000, model: 'claude-opus-5-5' },
    Explore: { runs: 1, tokens: 40_000, ms: 60_000, lastAt: 1_760_939_000_000, model: 'claude-haiku-5-5' },
  },
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
    expect(line).toBe('harness · board 1 waiting · 2 agents · ready to push 0/2 · today opus 109M haiku 735k')
    // Nothing to push: nothing said of the gates.
    expect(statusLine({ ...SNAPSHOT, repos: SNAPSHOT.repos.map(r => ({ ...r, ahead: 0 })) }, 0)).toBe('harness · board 1 waiting · today opus 109M haiku 735k')
    expect(statusLine(null, 0)).toBe('harness: reading')
  })

  test('a clean verdict is green, findings amber', async () => {
    expect(verdictTone('no findings')).toBe('ok')
    expect(verdictTone('0 findings')).toBe('ok')
    expect(verdictTone('clean')).toBe('ok')
    expect(verdictTone('clean (7 findings fixed in f73192e)')).toBe('ok')
    expect(verdictTone('f4ab31a no findings')).toBe('ok')
    expect(verdictTone('f4ab31a 2 findings')).toBe('wait')
    expect(verdictTone('2 findings')).toBe('wait')
    expect(verdictTone('6 findings on 5c2476b, fixed in 1d0646a')).toBe('wait')
    expect(verdictTone('3 findings, otherwise ok')).toBe('wait')
    expect(verdictTone('not clean')).toBe('wait')
    expect(verdictTone('looked')).toBe('plain')
    expect(verdictTone(null)).toBe('none')
  })

  test('bars fill in eighths of a cell, a sliver for anything above zero', async () => {
    expect(bar(50, 100, 8)).toEqual({ filled: '████', empty: '░░░░' })
    expect(bar(3, 16, 4)).toEqual({ filled: '▊', empty: '░░░' })
    expect(bar(1, 1_000_000, 4)).toEqual({ filled: '▏', empty: '░░░' })
    expect(bar(0, 100, 3)).toEqual({ filled: '', empty: '░░░' })
    expect(bar(200, 100, 3)).toEqual({ filled: '███', empty: '' })
    expect(bar(5, 0, 2)).toEqual({ filled: '', empty: '░░' })
    // The mock-up's checkered rest.
    expect(bar(50, 100, 4, '▒')).toEqual({ filled: '██', empty: '▒▒' })
  })

  test("the diagram's lines: centred words, marks, the fan-out and the merge", async () => {
    expect(centre('ab', 6)).toBe('  ab  ')
    expect(centre('abcdef', 4)).toBe('abcd')
    expect(marks(7, [1, 5], '▼')).toBe(' ▼   ▼ ')
    expect(branch(11, 5, [1, 5, 9])).toBe(' ┌───┼───┐ ')
    expect(branch(11, 5, [1, 5, 9], true)).toBe(' └───┼───┘ ')
    expect(branch(9, 4, [1, 7])).toBe(' ┌──┴──┐ ')
    expect(branch(9, 4, [1, 7], true)).toBe(' └──┬──┘ ')
    expect(branch(5, 2, [2])).toBe('  │  ')
    // The line's own end over a box, and past the last box.
    expect(branch(9, 7, [1, 7])).toBe(' ┌─────┤ ')
    expect(branch(9, 7, [1, 7], true)).toBe(' └─────┤ ')
    expect(branch(9, 8, [1, 6])).toBe(' ┌────┬─┘')
  })

  test('columns as asked when they fit, narrower in step when they do not', async () => {
    expect(fit([2, 12, 11, 10], 68)).toEqual([2, 12, 11, 10])
    expect(fit([2, 16, 11, 10], 28)).toEqual([1, 8, 5, 5])
    expect(fit([6, 7, 12], 30, 12)).toEqual([4, 5, 8])
    expect(fit([10, 15], 4)).toEqual([1, 1])
  })

  test('each model its colour, each status its own', async () => {
    expect(modelColor('claude-opus-5-5')).toBe(PALETTE.opus)
    expect(modelColor('opus')).toBe(PALETTE.opus)
    expect(modelColor('claude-sonnet-5-5')).toBe(PALETTE.sonnet)
    expect(modelColor('claude-haiku-4-5-20251001')).toBe(PALETTE.haiku)
    expect(modelColor(undefined)).toBe('inactive')
    expect([toneColor('ok'), toneColor('wait'), toneColor('fail'), toneColor('info')]).toEqual([PALETTE.ok, PALETTE.wait, PALETTE.fail, 'text'])
    expect(toneColor('', 'f4ab31a no findings')).toBe(PALETTE.ok)
    expect(toneColor('', 'f4ab31a 2 findings')).toBe(PALETTE.wait)
    expect([agentColor('running'), agentColor('completed'), agentColor('failed'), agentColor('killed')]).toEqual([PALETTE.wait, PALETTE.ok, PALETTE.fail, PALETTE.fail])
    expect(sourceColor({ source: 'helper', model: 'claude-haiku-5-5' })).toBe(PALETTE.haiku)
    // The gates (any q.ts run, the hooks) are the mock-up's green.
    expect(sourceColor({ source: 'test' })).toBe(PALETTE.gate)
    expect(sourceColor({ source: 'hook' })).toBe(PALETTE.gate)
  })

  test("a log line says a helper's model, tokens and time", async () => {
    expect(eventText({ at: 0, source: 'helper', tone: 'ok', repo: '', text: 'reviewer done', model: 'claude-opus-5-5', tokens: 106_689, ms: 503_770 })).toBe(
      'reviewer done · opus 5.5 · 107k tok · 8m 24s',
    )
    // A start says its model in its colour only: no time yet.
    expect(eventText({ at: 0, source: 'helper', tone: 'info', repo: '', text: 'reviewer started: Review', model: 'opus' })).toBe('reviewer started: Review')
    expect(clockTime(new Date(2026, 9, 20, 9, 5, 7).getTime())).toBe('09:05:07')
    // The source as the mock-up says a helper's, the figure on the right.
    expect(sourceLabel({ source: 'helper', text: 'reviewer done', model: 'claude-opus-5-5' })).toBe('opus:reviewer')
    expect(sourceLabel({ source: 'check', text: 'check: ok' })).toBe('check')
    expect(eventFigure({ at: 0, source: 'helper', tone: 'info', repo: '', text: 'reviewer started: Review' })).toBe('spawn')
    expect(eventFigure({ at: 0, source: 'helper', tone: 'ok', repo: '', text: 'reviewer done', tokens: 106_689 })).toBe('107k tok')
    expect(eventFigure({ at: 0, source: 'check', tone: 'ok', repo: '', text: 'check: ok (3s) · stamped abc1234' })).toBe('stamped')
    expect(eventFigure({ at: 0, source: 'check', tone: 'fail', repo: '', text: 'check: FAILED (exit 1, 3s)' })).toBe('failed')
    expect(eventFigure({ at: 0, source: 'review', tone: '', repo: '', text: 'abc1234 clean' })).toBe('clean')
    expect(eventFigure({ at: 0, source: 'board', tone: 'wait', repo: '', text: 'Panel running → waiting-test' })).toBe('waiting-test')
    expect(eventFigure({ at: 0, source: 'ask', tone: 'ok', repo: '', text: 'git push allowed' })).toBe('allowed')
  })

  test("a limit's reset reads in days past a day", async () => {
    expect(resetIn(12 * 60_000)).toBe('12m')
    expect(resetIn((2 * 60 + 10) * 60_000)).toBe('2h 10m')
    expect(resetIn((3 * 24 * 60 + 2 * 60 + 5) * 60_000)).toBe('3d 2h')
    expect(resetIn(-5)).toBe('0m')
  })

  test('a check says whether a push of HEAD passes and what changed since', async () => {
    const at = 1_000_000
    const now = at + 12 * 60_000
    expect(checkMark(null, now)).toEqual({ text: 'no stamp', color: 'inactive' })
    expect(checkMark({ tree: 't', at, isFresh: true, isWorkFresh: true }, now, { at: at + 60_000, exit: 1 })).toEqual({ text: '✗ 11m exit 1', color: PALETTE.fail })
    expect(checkMark({ tree: 't', at, isFresh: true, isWorkFresh: true }, now)).toEqual({ text: '✓ 12m', color: PALETTE.ok })
    expect(checkMark({ tree: 't', at, isFresh: true, isWorkFresh: false }, now)).toEqual({ text: '✓ 12m +edits', color: PALETTE.ok })
    expect(checkMark({ tree: 't', at, isFresh: false, isWorkFresh: true }, now)).toEqual({ text: '◐ 12m commit', color: PALETTE.wait })
    expect(checkMark({ tree: 't', at, isFresh: false, isWorkFresh: false }, now)).toEqual({ text: '· 12m old', color: 'inactive' })
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
    // The three layouts: the mock-up's three columns, two, one.
    for (const bodyColumns of [110, 80, 48]) {
      const ui = await $.ui.mount({ plugin: 'harness-view', surface, ...PANE, props: { ...PANE.props, bodyColumns } })
      await ui.press({ key: 'refresh' })
      const at = `${surface} ${bodyColumns}`
      const has = async (text: string | RegExp) => expect([at, text, (await ui.find({ text })) !== undefined]).toEqual([at, text, true])
      await has(bodyColumns >= 64 ? 'WOW-ADDONS HARNESS' : 'HARNESS')
      await has('OPUS 5.5 PLANS')
      await has('CONFIG & LIMITS')
      await has(/^GATES /)
      await has(/^back to /)
      // The planner says what it is for, each moment who it calls.
      await has('second opinions')
      await has('◇ before a push')
      // The helpers fanned out: the busiest today first, the planner's left to it.
      await has('Explore')
      await has('The harness panel')
      await has(/^1 waiting on you$/)
      await has('1/2 pushable')
      await has('no findings 6b545ad')
      await has(/✗ \d+\w exit 1/)
      // The log, newest first: the repository, then what happened, its figure on the right.
      const log = await ui.findAll({ type: 'Text', text: /check: FAILED|reviewer done|running → waiting-test|f4ab31a no findings/ })
      expect([at, log.map(t => t.text)]).toEqual([
        at,
        [
          'wow-data check: FAILED (exit 1, 3.2s) · .cache/logs/check.log',
          'yonder reviewer done · opus 5.5 · 107k tok · 8m 24s',
          'addon-kit The harness panel running → waiting-test',
          'yonder f4ab31a no findings',
        ],
      ])
      await has('opus:reviewer')
      // The main session's boxes dashed, as in the mock-up: the terminal's border, the desktop's vector edges.
      expect(JSON.stringify(await ui.drawn())).toContain(surface === 'terminal' ? '"borderStyle":"dashed"' : 'stroke-dasharray')
      await ui.unmount()
    }
  }
  expect(runs[0]?.[0]).toBe('bun')
  expect(runs[0]?.slice(2)).toEqual(['--root', '/Users/someone/code/wow-addons', '--fresh'])
  expect(statuses.at(-1)).toBe('harness · board 1 waiting · ready to push 0/2 · today opus 109M haiku 735k')
})

test("the plan's limits are meters, the planner's moments say who, how often and their last word", async ($, on) => {
  mock.env(on, { HOME: '/Users/someone' })
  const now = SNAPSHOT.at + 3000
  const clock = mock.clock(on, { now })
  const snap: Snapshot = { ...SNAPSHOT, moments: { push: { runs: 2, lastAt: SNAPSHOT.at - 60_000 } } }
  on('session.root', () => ({ value: '/Users/someone/code/wow-addons' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(snap), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'harness', title: 'Harness', isShown: true, isFocused: false, isPlaced: true }] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      context: { tokens: 403_000, window: 1_000_000, percent: 40 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 28 },
        { kind: 'seven_day', percentUsed: 86, resetsAt: new Date(now + (2 * 60 + 10) * 60_000).toISOString() },
      ],
    },
  }))
  on('settings.read', () => ({ value: { model: 'opus' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/Users/someone/code/wow-addons', surface: 'desktop', isInteractive: true })
  await clock.advance(1100)

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [110, 80, 48]) {
      const ui = await $.ui.mount({ plugin: 'harness-view', surface, ...PANE, props: { ...PANE.props, bodyColumns } })
      await ui.press({ key: 'refresh' })
      const at = `${surface} ${bodyColumns}`
      const has = async (text: string | RegExp, isThere = true) => expect([at, text, (await ui.find({ text })) !== undefined]).toEqual([at, text, isThere])
      // Each window a meter, its colour by how full; the worst past 80% in the title, with its reset.
      await has('five hour')
      await has('28%')
      await has('seven day')
      await has('86%')
      await has(/^ \[ 86% · 2h (9|10)m \]$/)
      await has(/% used$/, false)
      // A moment called today is filled, the others hollow; the counts by moment.
      await has('◆ before a push')
      await has('◇ before a plan')
      if (bodyColumns >= 96) {
        // Who each moment calls, and its last word: the newest verdict, or why the architect stays off.
        await has('reviewer')
        await has('no findings')
        await has('off in an opus session')
        await has('their time')
      }
      await ui.unmount()
    }
  }
})

const card = (id: string, repo: string, status: string, extra: Partial<Snapshot['board'][number]> = {}) => ({
  id,
  repo,
  title: id,
  status,
  session: '',
  updated: '2026-10-20T21:00:00+02:00',
  summary: '',
  ...extra,
})

test('the board says who holds each repository: running cards hold, blocked and waiting ones are pending', async () => {
  const board = [
    card('riddles', 'yonder', 'running'),
    card('trainers', 'wow-data', 'blocked', { repos: ['wow-data', 'mealbook', 'yonder'], waits: 'riddles' }),
    card('german', 'lorekeepers-codex', 'waiting-test'),
    card('older', 'yonder', 'ready-to-push'),
    card('cleanup', 'every repo', 'done', { repos: [] }),
  ]
  expect([...holds(board)].sort()).toEqual([
    ['lorekeepers-codex', 'pending'],
    ['mealbook', 'pending'],
    ['wow-data', 'pending'],
    ['yonder', 'held'],
  ])
  expect(where(board[1]!)).toBe('wow-data +2')
  expect(where({ ...board[1]!, repos: ['wow-data', 'yonder'] })).toBe('wow-data+yonder')
  expect(where(board[0]!)).toBe('yonder')
})

test("the pane's board shows a blocked card's blocker, free once it is done; the repositories their holders", async ($, on) => {
  const snap: Snapshot = {
    ...SNAPSHOT,
    board: [
      card('riddles', 'wow-data', 'running', { title: 'Three Westfall riddles', repos: ['wow-data', 'yonder'] }),
      card('trainers', 'mealbook', 'blocked', { title: 'New-land trainers', repos: ['mealbook', 'yonder'], waits: 'riddles' }),
      card('german', 'lorekeepers-codex', 'blocked', { title: 'German pages', waits: 'gone' }),
      card('tested', 'keyring', 'waiting-test', { title: 'Keyring fix' }),
      card('after', 'keyring', 'blocked', { title: 'After the fix', waits: 'tested' }),
    ],
  }
  mock.env(on, { HOME: '/Users/someone' })
  mock.clock(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(snap), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [110, 48]) {
      const ui = await $.ui.mount({ plugin: 'harness-view', surface, ...PANE, props: { ...PANE.props, bodyColumns } })
      await ui.press({ key: 'refresh' })
      const at = `${surface} ${bodyColumns}`
      const has = async (text: string | RegExp) => expect([at, text, (await ui.find({ text })) !== undefined]).toEqual([at, text, true])
      await has('wow-data+yonder')
      // The repository they share, not the holder's own.
      await has(' · on yonder')
      // Free once the holder is gone, or stopped (waiting on the user).
      expect([at, (await ui.findAll({ type: 'Text', text: ' · free now' })).length]).toEqual([at, 2])
      await has(' · 3 blocked')
      // yonder and wow-data held by the running card (the fixture's repositories), the count in the header.
      await has('● 2 held · ')
      await ui.unmount()
    }
  }
  expect(statusLine(snap, 0)).toContain('3 blocked')
})

test("the sessions: each live one's status, model, card and an Open that hands the desktop its link; a running card whose session is gone", async ($, on) => {
  const session = (id: string, extra: Partial<NonNullable<Snapshot['sessions']>[number]>) => ({
    id,
    pid: 1,
    name: id,
    status: 'idle',
    waitingFor: null,
    since: SNAPSHOT.at - 3_600_000,
    entrypoint: 'claude-desktop',
    link: `claude://claude.ai/epitaxy/local_${id}`,
    model: 'claude-opus-5-5',
    helpers: [],
    ...extra,
  })
  const snap: Snapshot = {
    ...SNAPSHOT,
    sessions: [
      session('downloads', { name: 'Addon downloads', status: 'waiting', waitingFor: 'permission prompt' }),
      session('self', { name: 'This one', status: 'busy', helpers: [{ type: 'reviewer', at: SNAPSHOT.at }] }),
      session('term', { name: 'In a terminal', entrypoint: 'cli', link: null, model: 'claude-sonnet-5-5' }),
      session('bg', { name: 'In the background', entrypoint: 'cli', link: null, background: true, model: 'claude-sonnet-5-5' }),
    ],
    board: [
      { ...SNAPSHOT.board[0]!, session: 'self', status: 'running', title: 'The panel' },
      { ...SNAPSHOT.board[0]!, id: 'orphan', session: '00000000-0000-4000-8000-000000000001', status: 'running', title: 'Left running' },
      // An older card's session as a name: matches no session, and is never said gone.
      { ...SNAPSHOT.board[0]!, id: 'named', session: "Harness E: every repository's pass", status: 'running', title: 'Named' },
    ],
  }
  const opened: string[][] = []
  mock.env(on, { HOME: '/Users/someone' })
  const clock = mock.clock(on, { now: SNAPSHOT.at })
  on('process.run', ($, e) => {
    if (e.argv[0] === '/usr/bin/open') {
      opened.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(snap), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: '/Users/someone/code/wow-addons' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.id', () => ({ value: 'self' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/Users/someone/code/wow-addons', surface: 'desktop', isInteractive: true })
  await clock.advance(1100)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [110, 48]) {
      const ui = await $.ui.mount({ plugin: 'harness-view', surface, ...PANE, props: { ...PANE.props, bodyColumns } })
      await ui.press({ key: 'refresh' })
      const at = `${surface} ${bodyColumns}`
      const has = async (text: string | RegExp, isThere = true) => expect([at, text, (await ui.find({ text })) !== undefined]).toEqual([at, text, isThere])
      await has(/^SESSIONS · 4/)
      await has('1 waiting on you')
      await has(' waiting')
      await has('Addon downloads')
      // This session's row: no Open, it says so; a terminal one can't be opened from here, a background one is attached.
      await has('this')
      await has('terminal')
      await has('bg')
      if (bodyColumns >= 96) {
        await has('permission prompt')
        await has('opus 5.5 · reviewer')
        await has('sonnet 5.5')
        await has('running')
      }
      // The board: a running card whose session isn't live is said gone, the live one's isn't.
      expect([at, (await ui.findAll({ type: 'Text', text: ' · session gone' })).length]).toEqual([at, 1])
      // Open: the desktop app gets the session's own link, through macOS.
      opened.length = 0
      await ui.press({ key: 'open-downloads' })
      expect([at, opened]).toEqual([at, [['/usr/bin/open', 'claude://claude.ai/epitaxy/local_downloads']]])
      await ui.unmount()
    }
  }
  expect(statusLine(snap, 0, 'self')).toStartWith('harness · 1 session waiting · ')
  // Its own prompt isn't another's: this session waiting says nothing of itself.
  expect(statusLine({ ...snap, sessions: [session('self', { status: 'waiting' })] }, 0, 'self')).not.toContain('session waiting')
})

test('the gates count what waits to be pushed alone: stamped, reviewed, both', async () => {
  const row = (name: string, ahead: number | null | undefined, isFresh: boolean, isCurrent: boolean | null, covers = true) => ({
    name,
    head: 'f4ab31a',
    check: { tree: 't', at: 0, isFresh, isWorkFresh: isFresh },
    failed: null,
    review: isCurrent === null ? null : { sha: 'f4ab31a', at: 0, verdict: 'no findings', isCurrent, base: 'a'.repeat(40), covers },
    ahead,
  })
  const push = toPush([
    row('ready', 1, true, true),
    row('unreviewed', 3, true, false),
    row('unchecked', 1, false, true),
    // Nothing to push, no upstream, an older snapshot's row: asked nothing, whatever their stamps.
    row('pushed', 0, false, false),
    row('local', null, false, null),
    row('older', undefined, false, null),
  ])
  expect([push.repos.map(r => r.name), push.fresh, push.reviewed, push.ready]).toEqual([['ready', 'unreviewed', 'unchecked'], 2, 2, 1])
  // A packet alone is no review; nor is HEAD's verdict on a range short of what the push sends, or one with no range recorded.
  expect(toPush([{ ...row('packet', 1, true, true), review: { sha: 'f4ab31a', at: 0, verdict: null, isCurrent: true } }]).reviewed).toBe(0)
  expect(toPush([row('partial', 3, true, true, false)]).reviewed).toBe(0)
  expect(toPush([{ ...row('older format', 1, true, true), review: { sha: 'f4ab31a', at: 0, verdict: 'clean', isCurrent: true } }]).reviewed).toBe(0)
})

test("the repositories' box says first why a verdict doesn't count: older, partial, no packet", async ($, on) => {
  const review = (extra: object) => ({ sha: 'f4ab31a', at: SNAPSHOT.at, verdict: 'clean (2 findings fixed in a long verdict that runs past the cell)', isCurrent: true, ...extra })
  const repo = (name: string, ahead: number, extra: object) => ({ ...SNAPSHOT.repos[0]!, name, ahead, review: review(extra) })
  const snap: Snapshot = {
    ...SNAPSHOT,
    repos: [
      repo('ready', 1, { base: 'a'.repeat(40), covers: true }),
      repo('partial', 2, { base: 'a'.repeat(40), covers: false }),
      repo('unpacked', 1, { base: null, covers: false }),
      repo('stale', 0, { isCurrent: false }),
      // Nothing to push: what its review read doesn't matter.
      repo('pushed', 0, { base: null, covers: false }),
    ],
  }
  mock.env(on, { HOME: '/Users/someone' })
  mock.clock(on, { now: SNAPSHOT.at })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(snap), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  const ui = await $.ui.mount({ plugin: 'harness-view', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 110 } })
  await ui.press({ key: 'refresh' })
  // Once each (partial, unpacked, stale): the ready row and the one with nothing to push say none.
  const states = await ui.findAll({ type: 'Text', text: /^(older|partial|no packet) $/ })
  expect(states.map(t => t.text).sort()).toEqual(['no packet ', 'older ', 'partial '])
  expect((await ui.findAll({ type: 'Text', text: /long verdict that runs past the cell\) f4ab31a$/ })).length).toBe(5)
  await ui.unmount()
})

test("the gates' meters and the status bar: what waits to be pushed, or nothing to push", async ($, on) => {
  let snap: Snapshot = SNAPSHOT
  mock.env(on, { HOME: '/Users/someone' })
  mock.clock(on, { now: SNAPSHOT.at })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(snap), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const isWaiting of [true, false]) {
      snap = isWaiting ? SNAPSHOT : { ...SNAPSHOT, repos: SNAPSHOT.repos.map(r => ({ ...r, ahead: 0 })) }
      const ui = await $.ui.mount({ plugin: 'harness-view', surface, ...PANE, props: { ...PANE.props, bodyColumns: 110 } })
      await ui.press({ key: 'refresh' })
      const at = `${surface} ${isWaiting ? 'waiting' : 'nothing'}`
      const has = async (text: string | RegExp, isThere = true) => expect([at, text, (await ui.find({ text })) !== undefined]).toEqual([at, text, isThere])
      // yonder stamped, not reviewed; wow-data reviewed, not stamped: both amber, neither ready.
      await has(/^to push $/, isWaiting)
      await has('1/2 fresh', isWaiting)
      await has('1/2 current', isWaiting)
      await has('0/2 ready', isWaiting)
      await has('nothing to push', !isWaiting)
      expect([at, (await ui.findAll({ type: 'Text', text: /^—$/ })).length]).toEqual([at, isWaiting ? 0 : 2])
      // The repositories' box still has them all.
      await has('1/2 pushable')
      await ui.unmount()
    }
  }
})

test('the gates are at work only while a q.ts run goes on, not for a helper or the turn alone', async ($, on) => {
  let snap: Snapshot = SNAPSHOT
  mock.env(on, { HOME: '/Users/someone' })
  const clock = mock.clock(on, { now: SNAPSHOT.at })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(snap), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: '/Users/someone/code/wow-addons' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [] } }))
  on('settings.read', () => ({ value: {} }))
  // A helper at work: the pulse runs out to it through the gates, which stay still.
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'reviewer', description: 'Review the push', status: 'running' }] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/Users/someone/code/wow-addons', surface: 'desktop', isInteractive: true })
  await clock.advance(1100)
  const runsNow = [
    { pid: 41, name: 'check', repo: 'yonder', at: SNAPSHOT.at - 20_000 },
    { pid: 42, name: 'package', repo: 'palaver', at: SNAPSHOT.at - 5_000 },
  ]
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const gates of [[], runsNow]) {
      snap = { ...SNAPSHOT, gates }
      const ui = await $.ui.mount({ plugin: 'harness-view', surface, ...PANE, props: { ...PANE.props, bodyColumns: 110 } })
      await ui.press({ key: 'refresh' })
      const at = `${surface} ${gates.length} runs`
      const isOn = gates.length > 0
      const spin = await ui.find({ key: 'gates-state-spin' })
      expect([at, (spin?.props.props as { on?: boolean } | undefined)?.on]).toEqual([at, isOn])
      // The running border: the terminal's comets on its edges, the desktop's edges told they run.
      if (surface === 'terminal') expect([at, (await ui.find({ key: 'gates-top' })) !== undefined]).toEqual([at, isOn])
      // The run named where the stamp's note stands, the others counted.
      expect([at, (await ui.find({ text: 'q check' })) !== undefined, (await ui.find({ text: ' +1' })) !== undefined]).toEqual([at, isOn, isOn])
      expect([at, (await ui.find({ text: /^stamp$/ })) !== undefined]).toEqual([at, !isOn])
      await ui.unmount()
    }
  }
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

for (const [moment, move] of [
  ['the next prompt', ($: Parameters<Parameters<typeof test>[1]>[0]) => $.prompt.submit({ text: 'hi' })],
  ['the desktop attaching', ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })],
] as const) {
  test(`a session moved out of the desktop's spare folder opens the pane at ${moment}`, async ($, on) => {
    mock.env(on, { HOME: '/Users/someone' })
    mock.clock(on)
    let project = '/Users/someone/.claude/spares/spare-abc'
    const opened: string[] = []
    const commands: string[] = []
    on('session.root', () => ({ value: project }))
    on('session.surfaces', () => ({ value: ['desktop'] }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SNAPSHOT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('command.register', ($, e) => {
      commands.push(e.name)
      return { value: { command: e.name } }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.attach', ($, e) => ({ clientId: e.clientId }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start({ cwd: project, surface: 'desktop', isInteractive: true })
    expect([opened, commands]).toEqual([[], []])

    project = '/Users/someone/code/wow-addons'
    await move($)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect([opened, commands]).toEqual([['harness'], ['harness']])
    // Read again with nothing moved, the gate stays as it is.
    await move($)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect([opened, commands]).toEqual([['harness'], ['harness']])
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
