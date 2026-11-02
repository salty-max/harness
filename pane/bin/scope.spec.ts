import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LiveSession, Snapshot } from '../types'
import { dispatcherOf, ownProject, scopeSnapshot, summariseOthers } from '../hooks/scope'
import { type EventState, projectAt, readTranscripts, scanLine } from './snapshot'

const day = (model: string, calls: number) => ({ model, calls, input: 1, cacheRead: 2, cacheWrite: 3, output: 4 })
const session = (id: string, project: string, extra: Partial<LiveSession> = {}): LiveSession => ({
  project, id, pid: 1, name: id, status: 'idle', waitingFor: null, since: 1000, entrypoint: 'claude-desktop', link: `claude://claude.ai/epitaxy/${id}`,
  model: null, mode: null, helpers: [], skills: [], ...extra,
})

// Two projects: the family and a puzzles-like standalone repository.
const SNAP = {
  at: 1,
  repos: [{ project: 'fam', name: 'yonder' }, { project: 'puz', name: 'puz' }],
  board: [
    { project: 'fam', id: 'a', status: 'running' },
    { project: 'puz', id: 'b', status: 'waiting-review' },
    { project: 'puz', id: 'c', status: 'done' },
  ],
  usage: { day: 'd', models: [day('opus', 10)], byProject: { fam: [day('opus', 7)], puz: [day('sonnet', 3)] }, files: 3 },
  events: [{ project: 'fam', at: 1, source: 'check', tone: 'ok', repo: 'yonder', text: 'x' }, { project: 'puz', at: 2, source: 'board', tone: '', repo: 'puz', text: 'y' }],
  helpers: [],
  helperDay: { reviewer: { runs: 5, tokens: 1, ms: 1, lastAt: 1, model: null } },
  helperDayBy: { puz: { reviewer: { runs: 2, tokens: 1, ms: 1, lastAt: 1, model: null } } },
  sessions: [session('mother', 'fam'), session('kid', 'fam', { parent: 'mother' }), session('puzmom', 'puz', { skills: [{ name: 'child', by: 'user', at: 1, count: 1 }], status: 'waiting' })],
  gates: [{ project: 'fam', pid: 1, name: 'check', repo: 'yonder', at: 1 }],
  locks: [{ project: 'puz', repo: 'puz', holder: null, later: [], stopped: [] }],
  slips: [],
  projects: [{ name: 'fam', dir: '/code/fam', isFamily: true }, { name: 'puz', dir: '/code/puz', isFamily: false }],
} as unknown as Snapshot

describe('the pane is its project', () => {
  test("a pane shows its own project's rows, usage and helpers, nothing of the other, and no project list", () => {
    const puz = scopeSnapshot(SNAP, 'puz')
    expect(puz.repos.map(r => r.name)).toEqual(['puz'])
    expect(puz.board.map(c => c.id)).toEqual(['b', 'c'])
    expect(puz.events.map(e => e.text)).toEqual(['y'])
    expect(puz.sessions?.map(x => x.id)).toEqual(['puzmom'])
    expect(puz.gates).toEqual([])
    expect(puz.locks?.length).toBe(1)
    expect(puz.usage.models.map(m => m.model)).toEqual(['sonnet'])
    expect(puz.helperDay.reviewer?.runs).toBe(2)
    expect(puz.projects).toBeUndefined()
    const fam = scopeSnapshot(SNAP, 'fam')
    expect(fam.usage.models.map(m => m.calls)).toEqual([7])
    expect(fam.helperDay).toEqual({})
  })

  test('with no project, or one the snapshot lacks, nothing is filtered', () => {
    expect(scopeSnapshot(SNAP, undefined)).toBe(SNAP)
    expect(scopeSnapshot(SNAP, 'gone')).toBe(SNAP)
  })

  test("the own project is the session's own row's, else the folder's, none with one project", () => {
    expect(ownProject(SNAP, 'puzmom')).toBe('puz')
    expect(ownProject(SNAP, 'unlisted', '/code/fam/.claude/worktrees/x')).toBe('fam')
    expect(ownProject(SNAP, 'unlisted', '/code/other')).toBeUndefined()
    expect(ownProject({ ...SNAP, projects: [SNAP.projects![0]!] }, 'mother')).toBeUndefined()
    expect(ownProject(null, 'mother')).toBeUndefined()
  })

  test('the other projects: sessions, those waiting, cards waiting, and the dispatcher', () => {
    const [other, ...rest] = summariseOthers(SNAP, 'fam', s => s.startsWith('waiting'))
    expect(rest).toEqual([])
    expect(other).toMatchObject({ name: 'puz', live: 1, waiting: 1, cards: 1 })
    expect(other?.dispatcher?.id).toBe('puzmom')
    expect(summariseOthers(SNAP, undefined, () => false)).toEqual([])
  })
})

describe('the dispatcher', () => {
  const live = [
    session('a', 'p', { since: 1 }),
    session('b', 'p', { since: 5 }),
    session('kid1', 'p', { parent: 'a' }),
    session('kid2', 'p', { parent: 'a' }),
    session('grand', 'p', { parent: 'kid1' }),
    session('orphan', 'p', { parent: 'gone' }),
  ]
  test('a child goes to the root of its chain', () => {
    expect(dispatcherOf(live, 'grand')?.id).toBe('a')
    expect(dispatcherOf(live, 'kid2')?.id).toBe('a')
  })
  test('else the unopened session with the most live children', () => {
    expect(dispatcherOf(live)?.id).toBe('a')
    expect(dispatcherOf(live, 'b')?.id).toBe('a')
  })
  test('the session the user typed /child in outranks the one with more children', () => {
    const typed = live.map(x => (x.id === 'b' ? { ...x, skills: [{ name: 'child', by: 'user' as const, at: 1, count: 1 }] } : x))
    expect(dispatcherOf(typed)?.id).toBe('b')
  })
  test('a fresh dispatcher with no children yet counts by its skill; with neither, none', () => {
    expect(dispatcherOf([session('x', 'p', { skills: [{ name: 'child', by: 'session', at: 1, count: 1 }] })])?.id).toBe('x')
    expect(dispatcherOf([session('x', 'p'), session('y', 'p')])).toBeNull()
    expect(dispatcherOf([])).toBeNull()
  })
  test('a cycle of openers ends', () => {
    expect(() => dispatcherOf([session('p', 'p', { parent: 'q' }), session('q', 'p', { parent: 'p' })], 'p')).not.toThrow()
  })
})

describe('usage by project', () => {
  const from = new Date(2026, 9, 20).getTime()
  const to = new Date(2026, 9, 21).getTime()
  const noon = new Date(2026, 9, 20, 12).toISOString()
  const state = (): EventState => ({ root: '/f', others: ['/p'], models: {}, pending: {}, events: [], helpers: {}, helpersBy: {}, byProject: {}, sessions: { models: {}, modes: {}, open: {} }, known: new Set() })

  test('a project is named by the folder a working directory sits under, a worktree included', () => {
    const s = state()
    expect(projectAt(s, '/f')).toBe('f')
    expect(projectAt(s, '/f/.claude/worktrees/x')).toBe('f')
    expect(projectAt(s, '/p/src')).toBe('p')
    expect(projectAt(s, '/pp')).toBeUndefined()
    expect(projectAt(s, undefined)).toBeUndefined()
  })

  test('tokens are counted for the project alone and for the machine', () => {
    const s = state()
    const models = {}
    const row = (id: string, cwd: string) => JSON.stringify({ type: 'assistant', timestamp: noon, cwd, message: { id, model: 'opus', usage: { input_tokens: 1, output_tokens: 1 } } })
    scanLine(row('1', '/f'), from, to, new Set(), models, s)
    scanLine(row('2', '/p'), from, to, new Set(), models, s)
    scanLine(row('3', '/p/x'), from, to, new Set(), models, s)
    scanLine(row('4', '/elsewhere'), from, to, new Set(), models, s)
    expect((models as Record<string, { calls: number }>).opus?.calls).toBe(4)
    expect(Object.fromEntries(Object.entries(s.byProject ?? {}).map(([k, v]) => [k, v.opus?.calls]))).toEqual({ f: 1, p: 2 })
  })

  test("a background helper's end belongs to the project of its call, not of the line read before", () => {
    const s = state()
    const call = { type: 'assistant', timestamp: noon, cwd: '/p', sessionId: 'S', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'h1', name: 'Agent', input: { subagent_type: 'reviewer', description: 'look' } }] } }
    scanLine(JSON.stringify(call), from, to, new Set(), {}, s)
    // The line read last is the family's: the notice has no row of its own.
    scanLine(JSON.stringify({ type: 'user', timestamp: noon, cwd: '/f', sessionId: 'T', message: { role: 'user', content: 'hello' } }), from, to, new Set(), {}, s)
    const notice = '<task-notification>\n<tool-use-id>h1</tool-use-id>\n<status>completed</status>\n<usage><subagent_tokens>9</subagent_tokens><duration_ms>5</duration_ms></usage>\n</task-notification>'
    scanLine(JSON.stringify({ type: 'queue-operation', timestamp: noon, content: notice }), from, to, new Set(), {}, s)
    expect(s.events.find(e => e.id === 'h1:end')?.project).toBe('p')
    expect(s.helpersBy?.p?.reviewer?.runs).toBe(1)
    expect(s.helpersBy?.f).toBeUndefined()
  })

  test('readTranscripts hands the split back, and keeps it on a second read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-scope-'))
    const projects = join(dir, 'projects')
    mkdirSync(join(projects, 'x'), { recursive: true })
    const row = (id: string, cwd: string) => JSON.stringify({ type: 'assistant', timestamp: noon, cwd, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } } })
    writeFileSync(join(projects, 'x', 's.jsonl'), `${row('1', '/f/yonder')}\n${row('2', '/p')}\n`)
    for (let i = 0; i < 2; i++) {
      const out = (await readTranscripts(projects, join(dir, 'cache'), '2026-10-20', '/f', {}, undefined, ['/p'], true)).usage
      expect(out.models.map(m => m.calls)).toEqual([2])
      expect(Object.fromEntries(Object.entries(out.byProject ?? {}).map(([k, v]) => [k, v.map(m => m.calls)]))).toEqual({ f: [1], p: [1] })
    }
  })
})
