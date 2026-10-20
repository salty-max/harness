import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { HarnessEvent, Snapshot } from '../types'
import { FRESH_MS, tokens } from './format'
import { FRAME_MS, lit } from './motion'
import { pulsePath } from './register'

const AT = 1_760_940_000_000
const FAMILY = '/Users/someone/code/wow-addons'

const snap = (events: HarnessEvent[] = []): Snapshot => ({
  at: AT,
  repos: [{ name: 'yonder', head: 'f4ab31a', check: { tree: 'abc', at: AT - 60_000, isFresh: true, isWorkFresh: true }, failed: null, review: null }],
  board: [],
  usage: { day: '2026-10-20', models: [{ model: 'claude-opus-5-5', calls: 3, input: 0, cacheRead: 2_000_000, cacheWrite: 0, output: 500_000 }], files: 1 },
  events,
  helpers: [{ name: 'data-scout', model: 'sonnet', description: 'Answers a data question.' }],
  helperDay: {},
})

const PANE = {
  component: 'Pane',
  requestId: 'harness',
  props: { title: 'Harness', isFocused: false, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

/** The engine beneath the mod: a family session on the desktop, the pane shown unless told otherwise. */
function world(on: On, opts: { snapshot?: () => Snapshot; isShown?: boolean; events?: () => number } = {}) {
  const runs: string[][] = []
  mock.env(on, { HOME: '/Users/someone' })
  const clock = mock.clock(on, { now: AT })
  on('session.root', () => ({ value: FAMILY }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify((opts.snapshot ?? snap)()), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'harness', title: 'Harness', isShown: opts.isShown ?? true, isFocused: false, isPlaced: true }] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: opts.events?.() ?? 1, mtimeMs: opts.events?.() ?? 1, isLink: false } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { runs, clock }
}

describe('the pulse', () => {
  test('a row of marks lights at once, a fan-out from the stem out, a merge back in', async () => {
    expect(pulsePath('  │  ', 2, 'down')).toEqual([[2]])
    expect(pulsePath(' ┌─┼─┐ ', 3, 'out', 1)).toEqual([[3], [2, 4], [1, 5]])
    expect(pulsePath(' └─┬─┘ ', 3, 'in', 1)).toEqual([[1, 5], [2, 4], [3]])
    // Three cells a step by default: a wide fan-out crosses in a few frames.
    expect(pulsePath('┌─────┼─────┐', 6, 'out')).toEqual([[4, 5, 6, 7, 8], [1, 2, 3, 9, 10, 11], [0, 12]])
    expect(pulsePath('     ', 2, 'down')).toEqual([])
  })

  test("a line lights at its own steps of the drawing's cycle, its trail one step behind", async () => {
    const p = { kind: 'flow', text: '│', path: [[0]], start: 2, cycle: 10, on: true, color: 'x' } as const
    expect(lit(p, 2).head.has(0)).toBe(true)
    expect(lit(p, 3).trail.has(0)).toBe(true)
    expect(lit(p, 3).head.size).toBe(0)
    expect(lit(p, 5).head.size + lit(p, 5).trail.size).toBe(0)
    // The next round.
    expect(lit(p, 12).head.has(0)).toBe(true)
    expect(lit({ ...p, on: false }, 2).head.size).toBe(0)
  })
})

test('the lines pulse while the turn runs and stand still once it ends', async ($, on) => {
  world(on)
  await $.session.start({ cwd: FAMILY, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'harness-view', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  // Lit within a round of the cycle: the heavy stroke, bold.
  const lights = async (key: string) => {
    for (let i = 0; i < 40; i++) {
      if (JSON.stringify(await ui.drawn({ in: key })).includes('"bold":true')) return true
      await ui.advance(FRAME_MS)
    }
    return false
  }
  expect(await lights('to-gates-1')).toBe(false)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await lights('to-gates-1')).toBe(true)
  expect(await lights('to-pill')).toBe(true)
  expect(JSON.stringify(await ui.drawn({ in: 'gates-state-spin' }))).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  // The helpers' part waits for a helper.
  expect(await lights('fan-out')).toBe(false)
  await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await lights('to-gates-1')).toBe(false)
  expect(JSON.stringify(await ui.drawn({ in: 'gates-state-spin' }))).toContain('"-"')
  await ui.unmount()
})

test('figures and bars roll up to their value as they first show', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'harness-view', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  const shown = async (key: string) => (await ui.find({ in: key, type: 'Text' }))?.text
  const day = 2_500_000
  expect(await shown('day-total')).not.toBe(tokens(day))
  await ui.advance(FRAME_MS * 8)
  expect(await shown('day-total')).toBe(tokens(day))
  expect(await shown('model-claude-opus-5-5-tokens')).toBe(tokens(day))
  await ui.unmount()
})

test('a new log line blinks its mark, then settles', async ($, on) => {
  const events: HarnessEvent[] = [
    { at: AT - 1_000, source: 'check', tone: 'ok', repo: 'yonder', text: 'check: ok (3s) · stamped abc1234' },
    { at: AT - 600_000, source: 'board', tone: 'wait', repo: 'yonder', text: 'Riddles running → waiting-test' },
  ]
  // Each read its own time, as a real one: the pane draws again with the line's later age.
  let reads = 0
  const { clock } = world(on, { snapshot: () => ({ ...snap(events), at: AT + reads++ }) })
  const ui = await $.ui.mount({ plugin: 'harness-view', surface: 'desktop', ...PANE })
  await ui.press({ key: 'refresh' })
  const mark = async (key: string) => JSON.stringify(await ui.drawn({ in: key }))
  const fresh = `fresh-${AT - 1_000}-check-yonder`
  expect(await mark(fresh)).toContain('●')
  // An old line has settled already.
  expect(await mark(`fresh-${AT - 600_000}-board-yonder`)).not.toContain('●')
  // Three seconds on the pane draws again, the line now 4 seconds old: still a second of blinking left.
  await clock.advance(3_000)
  await ui.advance(3_000)
  await ui.press({ key: 'refresh' })
  await ui.advance(FRAME_MS * 6)
  expect(await mark(fresh)).toContain('●')
  // Six seconds after the line was written, it has settled.
  await ui.advance(2_000)
  expect(await mark(fresh)).toContain('›')
  await ui.unmount()
})

test('a line in the event log reads anew within a second while the pane is shown', async ($, on) => {
  let size = 10
  const { runs, clock } = world(on, { events: () => size })
  await $.session.start({ cwd: FAMILY, surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const before = runs.length
  size = 20
  await clock.advance(1_000)
  expect(runs.slice(before).some(argv => argv.includes('--fresh'))).toBe(true)
})

for (const [where, isShown, most] of [
  ['shown', true, 99],
  ['closed or behind another tab', false, 2],
] as const) {
  test(`the pane ${where}: ${isShown ? 'the live pace' : 'the slow pace'}`, async ($, on) => {
    const { runs, clock } = world(on, { isShown })
    await $.session.start({ cwd: FAMILY, surface: 'desktop', isInteractive: true })
    await clock.advance(10_000)
    expect(isShown ? runs.length >= 5 : runs.length <= most).toBe(true)
  })
}
