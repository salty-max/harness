import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ModelDay } from '../types'
import { momentOf } from '../hooks/format'
import * as boardKit from '../../board'
import {
  agentDefs,
  agentModels,
  askedPart,
  cachedRepos,
  countLine,
  type EventState,
  eventRow,
  logSince,
  scanLine,
  skillNames,
  failedCheck,
  parseCard,
  desktopParent,
  parentsOf,
  parseEventLine,
  readBoard,
  readLocks,
  readOpened,
  readSlips,
  readEventLog,
  readGates,
  readRepo,
  readSessions,
  readTranscripts,
  repoMarks,
  repoOf,
  resolveRoots,
  projectOf,
  tomlStrings,
  summaryOf,
} from './snapshot'

const temp = () => mkdtempSync(join(tmpdir(), 'harness-view-'))

const CARD = `---
repo: yonder
title: "Eight riddles"
status: waiting-test
session: riddles-20oct
updated: 2026-10-20T09:00:00+02:00
---

# What to test

Walk to the Pool of Tears at night.
`

describe('the board', () => {
  test('a card reads its front matter and its first line, headings skipped', () => {
    expect(parseCard('riddles', CARD)).toEqual({
      id: 'riddles',
      repo: 'yonder',
      title: 'Eight riddles',
      status: 'waiting-test',
      session: 'riddles-20oct',
      updated: '2026-10-20T09:00:00+02:00',
      summary: 'Walk to the Pool of Tears at night.',
      repos: ['yonder'],
    })
  })

  test("a card's repositories and the card a blocked one waits on, as board.ts writes them", () => {
    const text = '---\nrepo: wow-data\ntitle: t\nstatus: blocked\nrepos: wow-data, mealbook, yonder\nwaits: yonder-riddles\n---\n'
    expect(parseCard('t', text)).toMatchObject({ status: 'blocked', repos: ['wow-data', 'mealbook', 'yonder'], waits: 'yonder-riddles' })
    expect(parseCard('e', '---\nrepo: every repo\n---\n').repos).toEqual([])
  })

  test("board.ts's cards lead with what to try", () => {
    const text = '---\nrepo: yonder\ntitle: t\nstatus: waiting-test\n---\n\nWritten by hand.\n\n## Try\n\n- Ride to the Pool of Tears.\n\n## Left\n\nNothing.\n'
    expect(parseCard('t', text).summary).toBe('Ride to the Pool of Tears.')
  })

  test('an empty Try falls back to the lead, never to Committed or Left', () => {
    expect(summaryOf('Lead line.\n\n## Try\n\n## Committed\n\nabc1234\n')).toBe('Lead line.')
    expect(summaryOf('## Try\n\n## Left\n\nEverything.\n')).toBe('')
  })

  test('a quoted value reads as board.ts wrote it', () => {
    const title = 'Say "hi" to C:\\'
    const text = `---\ntitle: ${JSON.stringify(title)}\nupdated: "2026-10-20T11:24:54+02:00"\n---\n`
    expect(parseCard('q', text)).toMatchObject({ title, updated: '2026-10-20T11:24:54+02:00' })
  })

  test('waiting cards first, done ones only from today, no README', () => {
    const dir = temp()
    const card = (id: string, status: string, updated: string) =>
      writeFileSync(join(dir, `${id}.md`), `---\nrepo: r\ntitle: ${id}\nstatus: ${status}\nupdated: ${updated}\n---\n`)
    card('old-done', 'done', '2026-10-18T10:00')
    card('done-today', 'done', '2026-10-20T08:00')
    card('running', 'running', '2026-10-20T09:00')
    card('push', 'ready-to-push', '2026-10-20T07:00')
    card('test', 'waiting-test', '2026-10-20T06:00')
    writeFileSync(join(dir, 'README.md'), '# The board\n')
    expect(readBoard(dir, '2026-10-20').map(c => c.id)).toEqual(['test', 'push', 'running', 'done-today'])
    expect(readBoard(join(dir, 'missing'), '2026-10-20')).toEqual([])
  })
})

const line = (id: string, timestamp: string, model = 'claude-opus-5-5', type = 'assistant') =>
  JSON.stringify({
    type,
    timestamp,
    message: {
      id,
      model,
      usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 },
    },
  })

describe('usage', () => {
  const from = new Date(2026, 9, 20).getTime()
  const to = new Date(2026, 9, 21).getTime()
  const noon = new Date(2026, 9, 20, 12).toISOString()

  test('a message counts once, inside the day, real models only', () => {
    const seen = new Set<string>()
    const models: Record<string, ModelDay> = {}
    countLine(line('a', noon), from, to, seen, models)
    countLine(line('a', noon), from, to, seen, models)
    countLine(line('b', new Date(2026, 9, 19, 23).toISOString()), from, to, seen, models)
    countLine(line('c', noon, '<synthetic>'), from, to, seen, models)
    countLine(line('d', noon, 'claude-opus-5-5', 'user'), from, to, seen, models)
    countLine('{not json "type":"assistant" "usage"', from, to, seen, models)
    expect(models).toEqual({
      'claude-opus-5-5': { model: 'claude-opus-5-5', calls: 1, input: 2, cacheRead: 100, cacheWrite: 10, output: 5 },
    })
  })

  test('a second read takes only what was added, a half-written line included', async () => {
    const projects = temp()
    const cache = temp()
    mkdirSync(join(projects, 'p', 's', 'subagents'), { recursive: true })
    const main = join(projects, 'p', 's.jsonl')
    const sub = join(projects, 'p', 's', 'subagents', 'agent-x.jsonl')
    const half = line('m3', noon, 'claude-sonnet-5-5')
    writeFileSync(main, `${line('m1', noon)}\n${line('m2', noon)}\n${half.slice(0, 40)}`)
    writeFileSync(sub, `${line('s1', noon, 'claude-sonnet-5-5')}\n`)

    const first = (await readTranscripts(projects, cache, '2026-10-20', '/family')).usage
    expect(first.files).toBe(2)
    expect(first.models.map(m => [m.model, m.calls])).toEqual([
      ['claude-opus-5-5', 2],
      ['claude-sonnet-5-5', 1],
    ])

    appendFileSync(main, `${half.slice(40)}\n${line('m1', noon)}\n`)
    const second = (await readTranscripts(projects, cache, '2026-10-20', '/family')).usage
    expect(second.models.map(m => [m.model, m.calls])).toEqual([
      ['claude-opus-5-5', 2],
      ['claude-sonnet-5-5', 2],
    ])
  })
})

describe('the log', () => {
  const from = new Date(2026, 9, 20).getTime()
  const at = (h: number, m = 0) => new Date(2026, 9, 20, h, m)

  test('a line of events.log reads back, a broken one is left out', () => {
    expect(parseEventLine(`${at(9).toISOString()}\tcheck\tok\tyonder\tcheck: ok (41s) · stamped 3f2a1b9`)).toEqual({
      at: at(9).getTime(),
      source: 'check',
      tone: 'ok',
      repo: 'yonder',
      text: 'check: ok (41s) · stamped 3f2a1b9',
    })
    // An unknown tone is read from the words; an empty repository is the family folder.
    expect(parseEventLine(`${at(9).toISOString()}\treview\t\t\tabc1234 clean`)).toMatchObject({ tone: '', repo: '', text: 'abc1234 clean' })
    expect(parseEventLine(`${at(9).toISOString()}\thook\tloud\tr\tx`)?.tone).toBe('')
    expect(parseEventLine('not a date\tcheck\tok\tr\tx')).toBeNull()
    expect(parseEventLine(`${at(9).toISOString()}\tcheck\tok\tr`)).toBeNull()
    expect(parseEventLine('')).toBeNull()
  })

  test("today's events newest first, read from the end of a long log", () => {
    const file = join(temp(), 'events.log')
    const row = (d: Date, text: string) => `${d.toISOString()}\tboard\twait\tyonder\t${text}\n`
    let text = row(new Date(2026, 9, 19, 23, 59), 'yesterday')
    // 100 KB of older lines first: only the last 64 KB is read, its cut first line left out.
    for (let i = 0; i < 1000; i++) text += row(at(1), `filler ${i} ${'x'.repeat(80)}`)
    text += row(at(9), 'first') + 'a torn line\n' + row(at(10, 30), 'second')
    writeFileSync(file, text)
    const events = readEventLog(file, from)
    expect(events[0]?.text).toBe('second')
    expect(events[1]?.text).toBe('first')
    expect(events).toHaveLength(40)
    expect(events.every(e => e.at >= from)).toBe(true)
    expect(readEventLog(file, at(10).getTime()).map(e => e.text)).toEqual(['second'])
    expect(readEventLog(join(temp(), 'missing.log'), from)).toEqual([])
  })

  test('a push or a release is said short, its repository found', () => {
    expect(askedPart('cd /x/addon-kit && git status --short && git push -q origin main 2>&1 | tail -3')).toBe('git push -q origin main')
    expect(askedPart('scripts/release.sh --version 1.2.3 NOTES.md')).toBe('scripts/release.sh --version 1.2.3 NOTES.md')
    expect(askedPart('gh workflow run release.yml -f tag=v0.2.0')).toBe('gh workflow run release.yml -f tag=v0.2.0')
    expect(askedPart('ls -la')).toBe('ls -la')
    expect(askedPart(`echo ${'y'.repeat(100)}`)).toHaveLength(60)
    expect(repoOf('/f', '/f', 'cd /f/addon-kit && git push')).toBe('addon-kit')
    expect(repoOf('/f', '/f', 'git -C yonder push origin main')).toBe('yonder')
    expect(repoOf('/f', '/f/wow-data/src', 'git push')).toBe('wow-data')
    expect(repoOf('/f', '/f', 'git push')).toBe('')
    expect(repoOf('/f', '/elsewhere')).toBe('')
  })

  test("a helper's model and description come from its definition", () => {
    const dir = temp()
    writeFileSync(join(dir, 'reviewer.md'), '---\nname: reviewer\ndescription: "Reviews one change. Read-only."\nmodel: opus\ntools: Read\n---\nReview.\n')
    writeFileSync(join(dir, 'scout.md'), "---\nname: data-scout\nmodel: 'sonnet'\n---\n")
    writeFileSync(join(dir, 'plain.md'), '---\nmodel: inherit\n---\n')
    const defs = agentDefs([dir, join(dir, 'missing')])
    expect(defs.find(d => d.name === 'reviewer')).toEqual({ name: 'reviewer', model: 'opus', description: 'Reviews one change.' })
    expect(defs.find(d => d.name === 'plain')).toEqual({ name: 'plain', model: null, description: '' })
    expect(agentModels(defs)).toEqual({ reviewer: 'opus', 'data-scout': 'sonnet' })
  })
})

describe('events in the transcripts', () => {
  const from = new Date(2026, 9, 20).getTime()
  const to = new Date(2026, 9, 21).getTime()
  const noon = new Date(2026, 9, 20, 12).toISOString()
  const state = (): EventState => ({ root: '/f', models: { reviewer: 'opus' }, pending: {}, events: [], helpers: {}, sessions: { models: {}, modes: {}, open: {} }, known: new Set() })
  const call = (id: string, name: string, input: Record<string, unknown>, cwd = '/f/yonder') => ({
    type: 'assistant',
    timestamp: noon,
    cwd,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  })
  const result = (id: string, extra: Record<string, unknown>, cwd = '/f/yonder') => ({
    type: 'user',
    timestamp: noon,
    cwd,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
    ...extra,
  })

  test("a session's permission mode: the last one the transcript recorded, a row or a user record's field", () => {
    const s = state()
    const row = (m: string) => `{"type":"permission-mode","permissionMode":"${m}","sessionId":"s1"}`
    const user = (m: string, extra = '') => `{"parentUuid":null,"isSidechain":${extra || 'false'},"type":"user","message":{"role":"user","content":"hi"},"permissionMode":"${m}","sessionId":"s1"}`
    // A `-p` run: a plan user record and no mode row at all.
    scanLine(user('plan'), from, to, new Set(), {}, s)
    expect(s.sessions.modes.s1).toBe('plan')
    // Later, a mode row of auto: building again.
    scanLine(row('auto'), from, to, new Set(), {}, s)
    expect(s.sessions.modes.s1).toBe('auto')
    scanLine(row('plan'), from, to, new Set(), {}, s)
    expect(s.sessions.modes.s1).toBe('plan')
    // A helper's record (a sidechain) is not the session's.
    scanLine(user('auto', 'true'), from, to, new Set(), {}, s)
    expect(s.sessions.modes.s1).toBe('plan')
    // A prompt that merely quotes the field is no record of it.
    scanLine(`{"type":"user","message":{"content":"the \\"permissionMode\\":\\"plan\\" row"},"sessionId":"s2"}`, from, to, new Set(), {}, s)
    expect(s.sessions.modes.s2).toBeUndefined()
  })

  test('a skill the session loaded or the user typed: a log line and the session\'s list, built-in commands left out', () => {
    const s = { ...state(), skillNames: new Set(['child', 'wow-releasing']) }
    const loaded = (id: string, skill: string) => ({ ...call(id, 'Skill', { skill, args: 'x' }), sessionId: 's1' })
    const typed = (uuid: string, name: string) => ({ type: 'user', uuid, timestamp: noon, cwd: '/f', sessionId: 's1', message: { content: `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args></command-args>` } })
    eventRow(loaded('t1', 'child'), from, to, s)
    eventRow(loaded('t2', 'child'), from, to, s)
    eventRow(typed('u1', 'wow-releasing'), from, to, s)
    // A built-in command or a mod's is no skill; a row read again counts once.
    eventRow(typed('u2', 'harness'), from, to, s)
    eventRow(typed('u1', 'wow-releasing'), from, to, s)
    expect(s.events.map(e => [e.source, e.text])).toEqual([['skill', 'child loaded'], ['skill', 'child loaded'], ['skill', 'wow-releasing typed']])
    expect(s.sessions.skills?.s1).toEqual([
      { name: 'child', by: 'session', at: Date.parse(noon), count: 2 },
      { name: 'wow-releasing', by: 'user', at: Date.parse(noon), count: 1 },
    ])
    // A helper's own load (a sidechain) is a log line, not the session's.
    eventRow({ ...loaded('t9', 'child'), isSidechain: true }, from, to, s)
    expect(s.sessions.skills?.s1?.[0]?.count).toBe(2)
    expect(s.events.at(-1)?.text).toBe('child loaded')
    // Through the line filter: the Skill call and the typed command are both parsed, a mere mention of a skill isn't.
    const t = { ...state(), skillNames: new Set(['child']) }
    scanLine(JSON.stringify(loaded('t3', 'child')), from, to, new Set(), {}, t)
    scanLine(JSON.stringify(typed('u3', 'child')), from, to, new Set(), {}, t)
    scanLine(`{"type":"assistant","message":{"content":[{"type":"text","text":"the Skill tool"}]}}`, from, to, new Set(), {}, t)
    expect(t.sessions.skills?.s1?.map(u => [u.name, u.by])).toEqual([['child', 'session'], ['child', 'user']])
  })

  test('the installed skills: a folder holding a SKILL.md', () => {
    const dir = temp()
    mkdirSync(join(dir, 'child'))
    writeFileSync(join(dir, 'child', 'SKILL.md'), '---\nname: child\n---\n')
    mkdirSync(join(dir, 'empty'))
    writeFileSync(join(dir, 'README.md'), '')
    expect([...skillNames([dir, join(dir, 'missing')])]).toEqual(['child'])
  })

  test('a helper starting and finishing, with its model, tokens and time', () => {
    const s = state()
    eventRow(call('t1', 'Agent', { subagent_type: 'reviewer', description: 'Review the riddles' }), from, to, s)
    eventRow(
      result('t1', {
        toolUseResult: { status: 'completed', agentType: 'reviewer', resolvedModel: 'claude-opus-5-5', totalTokens: 106_689, totalDurationMs: 503_770 },
      }),
      from,
      to,
      s,
    )
    expect(s.events).toEqual([
      { id: 't1:start', at: Date.parse(noon), source: 'helper', tone: 'info', repo: 'yonder', project: 'f', text: 'reviewer started: Review the riddles', model: 'opus' },
      { id: 't1:end', at: Date.parse(noon), source: 'helper', tone: 'ok', repo: 'yonder', project: 'f', text: 'reviewer done', model: 'claude-opus-5-5', tokens: 106_689, ms: 503_770 },
    ])
    // Its own model wins over the definition's; a failure is red; a background start has no end yet.
    eventRow(call('t2', 'Agent', { subagent_type: 'Explore', model: 'haiku' }), from, to, s)
    eventRow(result('t2', { toolUseResult: { status: 'failed', agentType: 'Explore' } }), from, to, s)
    eventRow(result('t3', { toolUseResult: { status: 'async_launched', agentType: 'Explore' } }), from, to, s)
    expect(s.events.slice(2).map(e => [e.text, e.tone, e.model])).toEqual([
      ['Explore started', 'info', 'haiku'],
      ['Explore failed', 'fail', undefined],
    ])
    // Each helper's day: a run counted once, however often its line is read.
    eventRow(
      result('t1', { toolUseResult: { status: 'completed', agentType: 'reviewer', resolvedModel: 'claude-opus-5-5', totalTokens: 106_689, totalDurationMs: 503_770 } }),
      from,
      to,
      s,
    )
    // ...and still once when the 40 kept events have long dropped it.
    s.events.length = 0
    eventRow(
      result('t1', { toolUseResult: { status: 'completed', agentType: 'reviewer', resolvedModel: 'claude-opus-5-5', totalTokens: 106_689, totalDurationMs: 503_770 } }),
      from,
      to,
      s,
    )
    expect(s.events).toEqual([])
    expect(s.helpers).toEqual({
      reviewer: { runs: 1, tokens: 106_689, ms: 503_770, lastAt: Date.parse(noon), model: 'claude-opus-5-5' },
      Explore: { runs: 1, tokens: 0, ms: 0, lastAt: Date.parse(noon), model: null },
    })
  })

  test("each session's helpers open from the call to its result, a background one to the notice of its end; its main loop's model", () => {
    const s = state()
    const of = (row: Record<string, unknown>) => ({ ...row, sessionId: 'S1' })
    eventRow(of(call('h1', 'Agent', { subagent_type: 'data-scout', description: 'a question' })), from, to, s)
    eventRow(of(call('h2', 'Agent', { subagent_type: 'reviewer', description: 'a review', run_in_background: true })), from, to, s)
    // A helper's own calls (a sidechain) open nothing of the session's.
    eventRow({ ...of(call('h3', 'Agent', { subagent_type: 'Explore' })), isSidechain: true }, from, to, s)
    expect(Object.keys(s.sessions.open).sort()).toEqual(['h1', 'h2'])
    // The background one only launched: still open; the other back.
    eventRow(of(result('h2', { toolUseResult: { status: 'async_launched', agentType: 'reviewer' } })), from, to, s)
    eventRow(of(result('h1', { toolUseResult: { status: 'completed', agentType: 'data-scout' } })), from, to, s)
    expect(Object.keys(s.sessions.open)).toEqual(['h2'])
    // Its end's notice closes it: a user row, or (mid-turn) a queued_command attachment.
    const notice = (id: string) => `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>`
    scanLine(JSON.stringify(of({ type: 'user', timestamp: noon, cwd: '/f', message: { content: notice('h2') } })), from, to, new Set(), {}, s)
    expect(s.sessions.open).toEqual({})
    eventRow(of(call('h5', 'Agent', { subagent_type: 'reviewer', run_in_background: true })), from, to, s)
    scanLine(JSON.stringify(of({ type: 'attachment', timestamp: noon, cwd: '/f', attachment: { type: 'queued_command', prompt: notice('h5'), commandMode: 'task-notification' } })), from, to, new Set(), {}, s)
    expect(s.sessions.open).toEqual({})
    // An interrupted call's result, read no further than its id, closes it too.
    eventRow(of(call('h4', 'Agent', { subagent_type: 'data-scout' })), from, to, s)
    scanLine(JSON.stringify(of(result('h4', {}))), from, to, new Set(), {}, s)
    expect(s.sessions.open).toEqual({})
    // The model: the main loop's, never a helper's.
    const usage = (model: string, side = false) => JSON.stringify({ type: 'assistant', timestamp: noon, sessionId: 'S1', isSidechain: side, message: { id: `m-${model}-${side}`, model, usage: { input_tokens: 1, output_tokens: 1 } } })
    scanLine(usage('claude-sonnet-5-5'), from, to, new Set(), {}, s)
    scanLine(usage('claude-haiku-5-5', true), from, to, new Set(), {}, s)
    expect(s.sessions.models).toEqual({ S1: 'claude-sonnet-5-5' })
  })

  test("an Opus helper's moment: the reviewer's the push, the architect's by its brief", () => {
    expect(momentOf('reviewer', 'Review the riddles')).toBe('push')
    expect(momentOf('architect', 'The plan for the panel')).toBe('plan')
    expect(momentOf('architect', 'The same test failing again')).toBe('error')
    expect(momentOf('architect', 'Sign off the whole change')).toBe('done')
    expect(momentOf('Explore', 'Find the plan')).toBe(null)
    // Whole words: a design is a plan, an error log's word in a longer one is not an error.
    expect(momentOf('architect', 'Design the moment counter')).toBe('plan')
    expect(momentOf('architect', 'Assign the terror of the abandoned path')).toBe('plan')
  })

  test("a background helper's run ends at the notice of its end: its tokens, time and model, once", () => {
    const s = state()
    scanLine(JSON.stringify({ ...call('h1', 'Agent', { subagent_type: 'reviewer', description: 'Review the push' }), sessionId: 'S1' }), from, to, new Set(), {}, s)
    // Only launched: still open, its model resolved.
    scanLine(JSON.stringify(result('h1', { sessionId: 'S1', toolUseResult: { isAsync: true, status: 'async_launched', resolvedModel: 'claude-opus-5-5' } })), from, to, new Set(), {}, s)
    expect(s.sessions.open.h1?.model).toBe('claude-opus-5-5')
    const notice = '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>h1</tool-use-id>\n<status>completed</status>\n<usage><subagent_tokens>55565</subagent_tokens><tool_uses>6</tool_uses><duration_ms>78561</duration_ms></usage>\n</task-notification>'
    // The notice lands twice (a queued row, then the user row): one run.
    scanLine(JSON.stringify({ type: 'queue-operation', timestamp: noon, content: notice }), from, to, new Set(), {}, s)
    scanLine(JSON.stringify({ type: 'user', timestamp: noon, cwd: '/f/yonder', message: { role: 'user', content: notice } }), from, to, new Set(), {}, s)
    expect(s.sessions.open.h1).toBeUndefined()
    expect(s.helpers.reviewer).toEqual({ runs: 1, tokens: 55565, ms: 78561, lastAt: Date.parse(noon), model: 'claude-opus-5-5' })
    expect(s.events.find(e => e.id === 'h1:end')).toMatchObject({ text: 'reviewer done', repo: 'yonder', tokens: 55565, ms: 78561 })
  })

  test('a push the user allowed or refused, never one a rule let through, nor another command', () => {
    const s = state()
    eventRow(call('b1', 'Bash', { command: 'git push -q origin main 2>&1 | tail -3' }), from, to, s)
    eventRow(call('b2', 'Bash', { command: 'git -C wow-data push' }, '/f'), from, to, s)
    eventRow(call('b3', 'Bash', { command: 'git status' }), from, to, s)
    eventRow(call('b4', 'Bash', { command: 'scripts/release.sh NOTES.md' }), from, to, s)
    // Only a push or a release waits for its answer.
    expect(Object.keys(s.pending)).toEqual(['b1', 'b2', 'b4'])
    eventRow(result('b1', { permissionDecision: { decision: 'accept', source: 'user_temporary' } }), from, to, s)
    eventRow(result('b2', { toolUseResult: 'User rejected tool use' }, '/f'), from, to, s)
    eventRow(result('b3', { permissionDecision: { decision: 'accept', source: 'config', reasonType: 'classifier' } }), from, to, s)
    eventRow(result('b4', { permissionDecision: { decision: 'reject', source: 'user_reject' } }), from, to, s)
    expect(s.events.map(e => [e.source, e.tone, e.repo, e.text])).toEqual([
      ['ask', 'ok', 'yonder', 'git push -q origin main allowed'],
      ['ask', 'fail', 'wow-data', 'git -C wow-data push refused'],
      ['ask', 'fail', 'yonder', 'scripts/release.sh NOTES.md refused'],
    ])
    expect(s.pending).toEqual({})
  })

  test('a result no prompt answered clears its call without being parsed', () => {
    const s = state()
    const seen = new Set<string>()
    const models: Record<string, ModelDay> = {}
    const scan = (row: object) => scanLine(JSON.stringify(row), from, to, seen, models, s)
    scan(call('p1', 'Bash', { command: 'git push origin main' }))
    scan(call('p2', 'Bash', { command: 'gh release create v1' }))
    expect(Object.keys(s.pending)).toEqual(['p1', 'p2'])
    scan(result('p1', { permissionDecision: { decision: 'accept', source: 'config', reasonType: 'rule' } }))
    scan(result('p2', { permissionDecision: { decision: 'accept', source: 'user_temporary' } }))
    expect(s.pending).toEqual({})
    expect(s.events.map(e => e.text)).toEqual(['gh release create v1 allowed'])
  })

  test('outside the family folder or the day, nothing', () => {
    const s = state()
    eventRow(call('o1', 'Agent', { subagent_type: 'reviewer' }, '/elsewhere'), from, to, s)
    eventRow({ ...call('o2', 'Agent', { subagent_type: 'reviewer' }), timestamp: new Date(2026, 9, 19, 23).toISOString() }, from, to, s)
    expect(s.events).toEqual([])
  })

  test('a call and its answer in two reads, an old day cache read again whole', async () => {
    const projects = temp()
    const cache = temp()
    mkdirSync(join(projects, 'p'), { recursive: true })
    const file = join(projects, 'p', 's.jsonl')
    writeFileSync(join(cache, 'usage-2026-10-20.json'), JSON.stringify({ day: '2026-10-20', files: { [file]: { offset: 999 } }, seen: [], models: {} }))
    writeFileSync(file, `${JSON.stringify(call('b1', 'Bash', { command: 'git push' }))}\n`)
    expect((await readTranscripts(projects, cache, '2026-10-20', '/f')).events).toEqual([])
    appendFileSync(file, `${JSON.stringify(result('b1', { permissionDecision: { decision: 'accept', source: 'user_temporary' } }))}\n`)
    const read = await readTranscripts(projects, cache, '2026-10-20', '/f')
    expect(read.events.map(e => e.text)).toEqual(['git push allowed'])
    // Read again from the start (a rewritten file): the same event once.
    writeFileSync(join(cache, 'usage-2026-10-20.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(cache, 'usage-2026-10-20.json'), 'utf8')), files: {} }))
    expect((await readTranscripts(projects, cache, '2026-10-20', '/f')).events).toHaveLength(1)
  })
})

describe('past midnight', () => {
  const line = (o: object) => `${JSON.stringify(o)}\n`
  const base = { cwd: '/f/yonder', sessionId: 'S1' }
  const tool = (at: Date, id: string, name: string, input: object) => line({ ...base, type: 'assistant', timestamp: at.toISOString(), message: { content: [{ type: 'tool_use', id, name, input }] } })

  test('a session started at 23:55 keeps its skill and open helper at 00:10, only the day figures start again', async () => {
    const projects = temp()
    const cache = temp()
    mkdirSync(join(projects, 'p'), { recursive: true })
    const file = join(projects, 'p', 'S1.jsonl')
    const night = new Date(2026, 9, 25, 23, 55)
    writeFileSync(file, tool(night, 'sk1', 'Skill', { skill: 'wow-translating' }) + tool(night, 'h1', 'Agent', { subagent_type: 'reviewer', description: 'look' }))
    const before = await readTranscripts(projects, cache, '2026-10-25', '/f')
    expect(before.sessions.skills?.S1?.map(u => u.name)).toEqual(['wow-translating'])

    // 00:10 the next day: the helper's end, a new load of the same skill.
    const after = new Date(2026, 9, 26, 0, 10)
    const notice = '<task-notification>\n<tool-use-id>h1</tool-use-id>\n<status>completed</status>\n<usage><subagent_tokens>900</subagent_tokens><duration_ms>5000</duration_ms></usage>\n</task-notification>'
    appendFileSync(file, line({ ...base, type: 'user', timestamp: after.toISOString(), message: { role: 'user', content: notice } }))
    const open = await readTranscripts(projects, cache, '2026-10-26', '/f')
    // Its skill and the night's events stay; the helper's end counts in the new day only.
    expect(open.sessions.skills?.S1?.map(u => u.name)).toEqual(['wow-translating'])
    expect(open.sessions.open).toEqual({})
    expect(open.helperDay.reviewer?.runs).toBe(1)
    expect(open.events.map(e => e.text)).toContain('wow-translating loaded')
    // The night's helper is not in the new day's, nor its tokens.
    const prior = await readTranscripts(projects, cache, '2026-10-25', '/f')
    expect(prior.helperDay.reviewer).toBeUndefined()
  })

  test('a helper still open at 00:10 stays open', async () => {
    const projects = temp()
    const cache = temp()
    mkdirSync(join(projects, 'p'), { recursive: true })
    writeFileSync(join(projects, 'p', 'S1.jsonl'), tool(new Date(2026, 9, 25, 23, 55), 'h1', 'Agent', { subagent_type: 'reviewer', run_in_background: true }))
    await readTranscripts(projects, cache, '2026-10-25', '/f')
    const next = await readTranscripts(projects, cache, '2026-10-26', '/f')
    expect(Object.values(next.sessions.open).map(h => h.type)).toEqual(['reviewer'])
  })

  test('a pane idle since the evening still finds the skill and the helper after midnight', async () => {
    const projects = temp()
    const cache = temp()
    mkdirSync(join(projects, 'p'), { recursive: true })
    const file = join(projects, 'p', 'S1.jsonl')
    writeFileSync(file, tool(new Date(2026, 9, 25, 20, 0), 'sk0', 'Skill', { skill: 'child' }))
    await readTranscripts(projects, cache, '2026-10-25', '/f')
    // Nobody read from 21:00 to 00:30.
    appendFileSync(file, tool(new Date(2026, 9, 25, 22, 0), 'sk1', 'Skill', { skill: 'wow-translating' }) + tool(new Date(2026, 9, 25, 22, 0), 'h1', 'Agent', { subagent_type: 'reviewer', run_in_background: true }))
    const next = await readTranscripts(projects, cache, '2026-10-26', '/f')
    expect(next.sessions.skills?.S1?.map(u => u.name).sort()).toEqual(['child', 'wow-translating'])
    expect(Object.values(next.sessions.open).map(h => h.type)).toEqual(['reviewer'])
  })

  test('the log starts twelve hours back until midday, the day after', () => {
    const day = '2026-10-26'
    expect(logSince(day, new Date(2026, 9, 26, 0, 10).getTime())).toBe(new Date(2026, 9, 25, 12, 10).getTime())
    expect(logSince(day, new Date(2026, 9, 26, 15, 0).getTime())).toBe(new Date(2026, 9, 26).getTime())
  })
})

describe('repositories', () => {
  const git = (dir: string, ...args: string[]) => {
    const run = Bun.spawnSync(['git', '-C', dir, ...args], { stderr: 'pipe' })
    if (run.exitCode !== 0) throw new Error(run.stderr.toString())
    return run.stdout.toString().trim()
  }
  const repo = () => {
    const dir = join(temp(), 'yonder')
    mkdirSync(dir)
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git(dir, 'add', '.')
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
    mkdirSync(join(dir, '.git', 'harness'))
    return dir
  }

  test('a stamp for HEAD is fresh, a recorded verdict is read', () => {
    const dir = repo()
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}')
    const head = git(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, '.git', 'harness', `check-${tree}`), '')
    writeFileSync(join(dir, '.git', 'harness', `review-${head}`), 'verdict: 2 findings\n\nthe rest\n')
    const row = readRepo(dir)
    expect(row?.name).toBe('yonder')
    expect(row?.check).toMatchObject({ isFresh: true, isWorkFresh: true })
    expect(row?.review).toMatchObject({ verdict: '2 findings', isCurrent: true })
  })

  test("with addon-kit's stamps, fresh means the working directory as it is", () => {
    const dir = repo()
    const kit = {
      headTree: () => 'head1',
      workTree: () => 'work1',
      stampOf: (_: string, tree: string | undefined) => (tree === 'work1' ? { tree, at: '2026-10-20T10:00:00+02:00' } : undefined),
      lastStamp: () => ({ tree: 'work1', at: '2026-10-20T10:00:00+02:00' }),
    }
    // Checked uncommitted edits: the push of HEAD would be refused.
    expect(readRepo(dir, kit)?.check).toEqual({ tree: 'work1', at: Date.parse('2026-10-20T10:00:00+02:00'), isFresh: false, isWorkFresh: true })
    // Committed: HEAD's tree is the stamped one.
    expect(readRepo(dir, { ...kit, headTree: () => 'work1' })?.check).toMatchObject({ isFresh: true, isWorkFresh: true })
    // Checked, committed, then edited again.
    expect(readRepo(dir, { ...kit, headTree: () => 'work1', workTree: () => 'work2' })?.check).toMatchObject({ isFresh: true, isWorkFresh: false })
    expect(readRepo(dir, { ...kit, lastStamp: () => undefined })?.check).toBeNull()
  })

  test('a check that failed after the newest stamp is told', () => {
    const dir = repo()
    mkdirSync(join(dir, '.cache', 'logs'), { recursive: true })
    const log = join(dir, '.cache', 'logs', 'check.log')
    writeFileSync(log, '$ bun run check\n(fail) a test\n\n[exit 1, 3.2s]\n')
    expect(failedCheck(dir, 0)).toMatchObject({ exit: 1 })
    expect(failedCheck(dir, Date.now() + 1000)).toBeNull()
    writeFileSync(log, '$ bun run check\nok\n\n[exit 0, 41s]\n')
    expect(failedCheck(dir, 0)).toBeNull()
    writeFileSync(log, '$ bun run check\nstill running\n')
    expect(failedCheck(dir, 0)).toBeNull()
    expect(readRepo(dir)?.failed).toBeNull()
  })

  test('an older stamp is stale, a packet alone has no verdict', () => {
    const dir = repo()
    writeFileSync(join(dir, '.git', 'harness', 'check-0000000'), '')
    mkdirSync(join(dir, '.cache', 'review'), { recursive: true })
    writeFileSync(join(dir, '.cache', 'review', 'abc1234.md'), '# packet\n')
    const row = readRepo(dir)
    expect(row?.check).toMatchObject({ tree: '0000000', isFresh: false, isWorkFresh: false })
    expect(row?.review).toMatchObject({ sha: 'abc1234', verdict: null, isCurrent: false })
  })

  test('the rows are read again only when a repository moved: a stamp, a commit', () => {
    const dir = repo()
    const root = join(dir, '..')
    const cache = temp()
    const first = cachedRepos(root, cache, undefined, false)
    expect(first.map(r => r.check)).toEqual([null])
    // Nothing moved: the cached rows, even where a read would differ.
    const marks = repoMarks(root)
    expect(repoMarks(root)).toBe(marks)
    // A stamp moves .git/harness: read again.
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}')
    writeFileSync(join(dir, '.git', 'harness', `check-${tree}`), '')
    expect(repoMarks(root)).not.toBe(marks)
    expect(cachedRepos(root, cache, undefined, false)[0]?.check).toMatchObject({ isFresh: true })
    // A commit moves HEAD's log: the stamp is old again.
    const stamped = repoMarks(root)
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    git(dir, 'add', '.')
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b')
    expect(repoMarks(root)).not.toBe(stamped)
    expect(cachedRepos(root, cache, undefined, false)[0]?.check).toMatchObject({ isFresh: false })
  })

  test("what a push would send: the commits its upstream lacks, none known without one; a push moves the row", () => {
    const dir = repo()
    const root = join(dir, '..')
    const cache = temp()
    expect(readRepo(dir)?.ahead).toBeNull()
    const remote = join(temp(), 'remote.git')
    git(temp(), 'init', '-q', '--bare', remote)
    git(dir, 'remote', 'add', 'origin', remote)
    // A branch never pushed: all it holds waits, though it has no upstream yet.
    expect(readRepo(dir)?.ahead).toBe(1)
    const branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
    git(dir, 'push', '-q', '-u', 'origin', branch)
    expect(readRepo(dir)?.ahead).toBe(0)
    // A new branch off it, with a commit: that commit, which no remote has.
    git(dir, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(dir, 's.txt'), 's\n')
    git(dir, 'add', '.')
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 's')
    expect(readRepo(dir)?.ahead).toBe(1)
    git(dir, 'checkout', '-q', branch)
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    git(dir, 'add', '.')
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b')
    expect(cachedRepos(root, cache, undefined, false)[0]?.ahead).toBe(1)
    // The push moves the upstream's log: the cached row is read again at once.
    const marks = repoMarks(root)
    git(dir, 'push', '-q', 'origin', branch)
    expect(repoMarks(root)).not.toBe(marks)
    expect(cachedRepos(root, cache, undefined, false)[0]?.ahead).toBe(0)
  })

  test("HEAD's own verdict, and whether its reviewer read all a push sends", () => {
    const dir = repo()
    const commit = (subject: string) => {
      writeFileSync(join(dir, `${subject}.txt`), `${subject}\n`)
      git(dir, 'add', '.')
      git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', subject)
      return git(dir, 'rev-parse', 'HEAD')
    }
    const remote = join(temp(), 'remote.git')
    git(temp(), 'init', '-q', '--bare', remote)
    git(dir, 'remote', 'add', 'origin', remote)
    const pushed = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'push', '-q', '-u', 'origin', git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'))
    const one = commit('one')
    const head = commit('two')
    const verdict = (sha: string, base?: string, tip = sha) =>
      writeFileSync(join(dir, '.git', 'harness', `review-${sha}`), `verdict: clean\nhead: ${sha}\n${base ? `base: ${base}\ntip: ${tip}\n` : ''}`)
    // Its reviewer read from the upstream on: both commits a push sends.
    verdict(head, pushed)
    expect(readRepo(dir)?.review).toMatchObject({ isCurrent: true, base: pushed, covers: true })
    // Read from the first unpushed commit on: the other one unread.
    verdict(head, one)
    expect(readRepo(dir)?.review).toMatchObject({ isCurrent: true, base: one, covers: false })
    // Recorded with no range (no packet, or before review.ts kept one).
    verdict(head)
    expect(readRepo(dir)?.review).toMatchObject({ isCurrent: true, base: null, covers: false })
    // The whole history read (a packet from the first commit): all of it.
    verdict(head, '4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    expect(readRepo(dir)?.review?.covers).toBe(true)
    // A packet of an earlier push (its tip already there): it read none of what this one sends.
    verdict(head, pushed, pushed)
    expect(readRepo(dir)?.review?.covers).toBe(false)
    // A tip or a base this clone doesn't know: nothing.
    verdict(head, pushed, 'f'.repeat(40))
    expect(readRepo(dir)?.review?.covers).toBe(false)
    verdict(head, 'f'.repeat(40))
    expect(readRepo(dir)?.review?.covers).toBe(false)
    // A newer verdict file for another commit (a reset since) doesn't hide HEAD's own.
    verdict(head, pushed)
    const other = join(dir, '.git', 'harness', `review-${one}`)
    writeFileSync(other, `verdict: 2 findings\nhead: ${one}\n`)
    utimesSync(other, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    expect(readRepo(dir)?.review).toMatchObject({ sha: head, verdict: 'clean', covers: true })
  })

  test('unmoved, the cached rows stand; fresh reads them anew', () => {
    const dir = repo()
    const root = join(dir, '..')
    const cache = temp()
    cachedRepos(root, cache, undefined, false)
    // Rows a read would not give, kept beside the same marks: proof the cache answered.
    const path = join(cache, 'repos.json')
    const was = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...was, repos: [{ ...was.repos[0], head: 'cached' }] }))
    expect(cachedRepos(root, cache, undefined, false)[0]?.head).toBe('cached')
    expect(cachedRepos(root, cache, undefined, true)[0]?.head).not.toBe('cached')
  })
})

describe('the live sessions', () => {
  const root = '/Users/someone/code/wow-addons'
  const write = (dir: string, pid: number, extra: Record<string, unknown>) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: `s${pid}`, cwd: root, startedAt: 1_000_000, status: 'idle', statusUpdatedAt: 1_000_000, ...extra }))

  test("the registry's sessions in the family folder whose process lives, waiting first, each with its link, model and helpers", () => {
    const dir = temp()
    write(dir, 11, { name: 'Riddles', status: 'busy', statusUpdatedAt: 2_000_000, entrypoint: 'claude-desktop', hostSessionId: 'local_aa-11' })
    write(dir, 12, { name: 'Downloads', status: 'waiting', waitingFor: 'permission prompt', entrypoint: 'claude-desktop', hostSessionId: 'local_bb-12' })
    write(dir, 13, { name: 'In a terminal', entrypoint: 'cli', cwd: `${root}/yonder` })
    write(dir, 21, { name: 'In the background', entrypoint: 'cli', kind: 'bg', statusUpdatedAt: 500_000 })
    // Elsewhere, gone, or a pid since reused by a later process: left out.
    write(dir, 14, { name: 'Elsewhere', cwd: '/Users/someone/code/other' })
    write(dir, 15, { name: 'Gone' })
    write(dir, 16, { name: 'Reused' })
    writeFileSync(join(dir, '17.json'), 'not json')
    writeFileSync(join(dir, '18.abc.key'), '{}')
    // A malformed one is left out alone: the others still read.
    writeFileSync(join(dir, '19.json'), JSON.stringify({ pid: '19; rm', sessionId: 's19', cwd: root, name: 'Bad pid' }))
    writeFileSync(join(dir, '20.json'), JSON.stringify({ pid: 20, sessionId: 's20', cwd: root, name: { not: 'a string' } }))
    // A kind of another shape (an internal format) only means not a background one: the session stays.
    write(dir, 22, { name: 'Odd kind', kind: { not: 'a string' }, statusUpdatedAt: 400_000 })
    const starts = (pids: number[]) => new Map(pids.filter(p => p !== 15).map(p => [p, p === 16 ? 9_000_000 : 999_000] as [number, number]))
    const day = { models: { s11: 'claude-sonnet-5-5' }, modes: { s11: 'plan' }, open: { t1: { session: 's11', type: 'reviewer', at: 2_500_000 }, t2: { session: 's99', type: 'Explore', at: 2_500_000 } } }
    const live = readSessions(dir, root, { ...day, skills: { s11: [{ name: 'child', by: 'user' as const, at: 2_600_000, count: 1 }] } }, 3_000_000, starts)
    expect(live?.map(s => [s.name, s.status, s.waitingFor, s.link])).toEqual([
      ['Downloads', 'waiting', 'permission prompt', 'claude://claude.ai/epitaxy/local_bb-12'],
      ['Riddles', 'busy', null, 'claude://claude.ai/epitaxy/local_aa-11'],
      ['In a terminal', 'idle', null, null],
      ['In the background', 'idle', null, null],
      ['Odd kind', 'idle', null, null],
    ])
    // A background one (`claude --bg`, session.ts's) says so: `claude attach` joins it.
    expect(live?.map(s => s.background)).toEqual([false, false, false, true, false])
    expect(live?.[1]).toMatchObject({ id: 's11', model: 'claude-sonnet-5-5', mode: 'plan', helpers: [{ type: 'reviewer', at: 2_500_000 }], since: 2_000_000 })
    // A helper open for hours was never seen back: left out.
    expect(live?.[1]?.skills).toEqual([{ name: 'child', by: 'user', at: 2_600_000, count: 1 }])
    expect(live?.[0]?.skills).toEqual([])
    expect(readSessions(dir, root, day, 2_500_000 + 7 * 3600_000, starts)?.[1]?.helpers).toEqual([])
    // No registry, or no ps: nothing known (undefined), not "no session".
    expect(readSessions(join(dir, 'missing'), root, day, 0, starts)).toBeUndefined()
    expect(readSessions(dir, root, day, 0, () => null)).toBeUndefined()
    // The same process by the start the registry wrote (UTC, ps's own spelling): a slow start is kept, a reuse isn't.
    const dir2 = temp()
    write(dir2, 31, { name: 'Slow start', startedAt: 1_792_519_640_000, procStart: 'Tue Oct 20 18:06:55 2026' })
    write(dir2, 32, { name: 'Reused', startedAt: 1_792_519_640_000, procStart: 'Tue Oct 20 18:06:55 2026' })
    const psStarts = () => new Map<number, number>([[31, 1_792_519_615_000], [32, 1_792_519_900_000]])
    expect(readSessions(dir2, root, day, 1_792_520_000_000, psStarts)?.map(s => s.name)).toEqual(['Slow start'])
  })
})

describe('the gates at work', () => {
  const write = (dir: string, pid: number, extra: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, name: 'check', repo: 'yonder', at: 2_000_000, ...extra }))

  test('the q.ts runs whose process lives and started no later, the oldest first; a dead, reused or broken one left out', () => {
    const dir = temp()
    write(dir, 41, { at: 3_000_000, name: 'package', repo: 'palaver' })
    write(dir, 42)
    // Gone (killed before its end), a pid since reused by a later process, broken files.
    write(dir, 43)
    write(dir, 44)
    writeFileSync(join(dir, '45.json'), 'not json')
    writeFileSync(join(dir, '46.json'), JSON.stringify({ pid: 99, name: 'check', repo: 'yonder', at: 2_000_000 }))
    writeFileSync(join(dir, '.47.tmp'), '{}')
    // A process that started the very moment it wrote its file is still the run.
    const starts = (pids: number[]) => new Map(pids.filter(p => p !== 43).map(p => [p, p === 44 ? 2_500_000 : p === 42 ? 2_000_000 : 1_000_000] as [number, number]))
    expect(readGates(dir, starts)).toEqual([
      { pid: 42, name: 'check', repo: 'yonder', at: 2_000_000 },
      { pid: 41, name: 'package', repo: 'palaver', at: 3_000_000 },
    ])
    // No folder yet, no run, or no ps: none at work.
    expect(readGates(join(dir, 'missing'), starts)).toEqual([])
    expect(readGates(temp(), () => { throw new Error('ps asked with nothing to ask') })).toEqual([])
    expect(readGates(dir, () => null)).toEqual([])
  })
})

describe('who works where', () => {
  const card = (id: string, status: string, session: string, repos: string, since = '2026-10-26T01:00:00.000+01:00') =>
    `---\nrepo: ${repos.split(',')[0]}\ntitle: ${id}\nstatus: ${status}\nsession: ${session}\nupdated: 2026-10-26T01:00:00+01:00\nrepos: ${repos}\n${status === 'running' ? `since: ${repos.split(',').map(r => `${r}@${since}`).join(', ')}\n` : ''}---\n`
  const board = (...cards: string[][]) =>
    cards.map(([id, status, session, repos, since]) => {
      const { body, ...c } = boardKit.parseCard(id as string, card(id as string, status as string, session as string, repos as string, since))
      return { ...c, summary: body.trim() }
    })
  const live = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, pid: 1, name, status: 'idle', waitingFor: null, since: 0, entrypoint: 'cli', link: null, model: null, mode: null, helpers: [], skills: [], ...extra })

  test("the lock per repository: the first running card holds, another session's later one waits, stopped cards are listed once, a session's own cards hold with it", () => {
    const a = '11111111-1111-1111-1111-111111111111'
    const b = '22222222-2222-2222-2222-222222222222'
    const cards = board(
      ['esmx', 'running', a, 'wow-data,addon-kit', '2026-10-26T01:00:00.000+01:00'],
      ['esmx-two', 'running', a, 'addon-kit', '2026-10-26T01:30:00.000+01:00'],
      ['harness', 'running', b, 'addon-kit', '2026-10-26T01:10:00.000+01:00'],
      ['skills', 'blocked', 'c', 'addon-kit'],
      ['push', 'ready-to-push', 'd', 'wow-data'],
      ['alone', 'ready-to-push', 'e', 'aaa-stopped-only'],
    )
    const locks = readLocks(cards as never, [live(a, 'wow-data session') as never], boardKit)!
    const kit = locks.find(l => l.repo === 'addon-kit')!
    expect(kit.holder).toMatchObject({ id: 'esmx', who: 'wow-data session', gone: false })
    // (esmx-two is the holder's session's own: not queued; harness is another session's, after it, and its session is not live)
    expect(kit.later.map(c => [c.id, c.who, c.gone])).toEqual([['harness', '22222222', true]])
    expect(kit.stopped.map(c => c.id)).toEqual(['skills'])
    expect(locks.find(l => l.repo === 'wow-data')).toMatchObject({ holder: { id: 'esmx' }, stopped: [{ id: 'push' }] })
    // Held repositories first.
    expect(locks.map(l => l.repo)).toEqual(['addon-kit', 'wow-data', 'aaa-stopped-only'])
    // Without board.ts, or cards its parser did not read: no locks, the panel keeps its marks.
    expect(readLocks(cards as never, [], undefined)).toBeUndefined()
    expect(readLocks([{ id: 'x', since: undefined }] as never, [], boardKit)).toBeUndefined()
  })

  test("a write in a repository the session's cards don't hold is a slip, by board.ts's own words; old, held and unknown ones are not", () => {
    const a = '11111111-1111-1111-1111-111111111111'
    const b = '22222222-2222-2222-2222-222222222222'
    const cards = board(['esmx', 'running', a, 'addon-kit'], ['mine', 'blocked', b, 'addon-kit'])
    const now = Date.parse('2026-10-26T02:00:00+01:00')
    const sessions = [live(a, 'holder') as never, live(b, 'builder host') as never]
    const writes = { [a]: { 'addon-kit': now - 1000 }, [b]: { 'addon-kit': now - 60_000, yonder: now - 1000, board: now - 1000, hearthtale: now - 3 * 3600_000 } }
    const slips = readSlips(writes, sessions, cards as never, ['addon-kit', 'yonder', 'hearthtale'], boardKit, now)!
    // The holder is fine; b's blocked card holds nothing in addon-kit, and it has no card for yonder at all; a folder that is no repository (board) and an old write are left out.
    expect(slips.map(x => [x.who, x.repo])).toEqual([['builder host', 'yonder'], ['builder host', 'addon-kit']])
    expect(slips[1]?.why).toContain('no running card of this session names addon-kit')
    expect(readSlips(writes, sessions, cards as never, ['addon-kit'], undefined, now)).toBeUndefined()
    // A write followed by a stop is its card's own: the card moved (updated 01:00) after a write at 00:50, not before one at 01:50.
    const stopped = board(['done-card', 'ready-to-push', a, 'addon-kit'])
    const edits = { [a]: { 'addon-kit': Date.parse('2026-10-26T00:50:00+01:00') } }
    expect(readSlips(edits, sessions, stopped as never, ['addon-kit'], boardKit, now)).toEqual([])
    expect(readSlips({ [a]: { 'addon-kit': Date.parse('2026-10-26T01:50:00+01:00') } }, sessions, stopped as never, ['addon-kit'], boardKit, now)).toHaveLength(1)
  })

  test("a session's Edit, Write or NotebookEdit under a family folder is noted by repository, a helper's too; .cache, node_modules and the folder's top are not", () => {
    const from = new Date(2026, 9, 26).getTime()
    const to = from + 86_400_000
    const noon = new Date(2026, 9, 26, 12).toISOString()
    const s: EventState = { root: '/f', models: {}, pending: {}, events: [], helpers: {}, sessions: { models: {}, modes: {}, open: {} }, known: new Set() }
    const edit = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: 'assistant', timestamp: noon, cwd: '/f', sessionId: 's1', ...extra, message: { content: [{ type: 'tool_use', id: `t${Math.random()}`, name, input }] } })
    scanLine(edit('Edit', { file_path: '/f/addon-kit/a.ts' }), from, to, new Set(), {}, s)
    scanLine(edit('Write', { file_path: '/f/yonder/b.lua' }, { isSidechain: true }), from, to, new Set(), {}, s)
    scanLine(edit('NotebookEdit', { notebook_path: '/f/wow-data/n.ipynb' }), from, to, new Set(), {}, s)
    for (const p of ['/f/addon-kit/.cache/x', '/f/yonder/node_modules/y/z.js', '/f/README.md', '/elsewhere/a.ts']) scanLine(edit('Edit', { file_path: p }), from, to, new Set(), {}, s)
    expect(Object.keys(s.sessions.writes?.s1 ?? {}).sort()).toEqual(['addon-kit', 'wow-data', 'yonder'])
  })

  test("a child under its opener: session.ts's record by the short id, else the desktop's spawnedFrom; the opener must be live, never itself", () => {
    const live3 = [
      { id: 'aaaaaaaa-1', host: 'local_mother' },
      { id: 'bbbbbbbb-2', host: 'local_kid' },
      { id: 'cccccccc-3', host: null },
      { id: 'dddddddd-4', host: 'local_orphan' },
    ]
    const spawned = (h: string) => ({ local_kid: 'local_mother', local_orphan: 'local_gone' })[h]
    const parents = parentsOf(live3, [{ id: 'cccccccc', opener: 'aaaaaaaa-1' }, { id: 'aaaaaaaa', opener: 'aaaaaaaa-1' }], spawned)
    expect([...parents]).toEqual([['bbbbbbbb-2', 'aaaaaaaa-1'], ['cccccccc-3', 'aaaaaaaa-1']])
  })

  test("the records of session.ts and the desktop's session files are read soft; what spawned a session is kept", () => {
    const dir = temp()
    writeFileSync(join(dir, 'abc12345.json'), JSON.stringify({ id: 'abc12345', opener: 'op-1' }))
    writeFileSync(join(dir, 'bad.json'), 'nope')
    expect(readOpened(dir)).toEqual([{ id: 'abc12345', opener: 'op-1' }])
    expect(readOpened(join(dir, 'missing'))).toEqual([])
    const base = temp()
    mkdirSync(join(base, 'acct', 'org'), { recursive: true })
    writeFileSync(join(base, 'acct', 'org', 'local_kid.json'), JSON.stringify({ spawnedFrom: { sessionId: 'local_mother' } }))
    writeFileSync(join(base, 'acct', 'org', 'local_root.json'), JSON.stringify({}))
    const cache = temp()
    const find = desktopParent(base, cache)
    expect(find('local_kid')).toBe('local_mother')
    expect(find('local_root')).toBeUndefined()
    expect(find('../../etc')).toBeUndefined()
    // (one not found yet is looked for again after a minute, not for good)
    expect(find('local_late')).toBeUndefined()
    writeFileSync(join(base, 'acct', 'org', 'local_late.json'), JSON.stringify({ spawnedFrom: { sessionId: 'local_mother' } }))
    expect(find('local_late')).toBeUndefined()
    const clock = Date.now
    Date.now = () => clock() + 61_000
    try {
      expect(desktopParent(base, cache)('local_late')).toBe('local_mother')
    } finally {
      Date.now = clock
    }
    // (kept: the file is not read again)
    writeFileSync(join(base, 'acct', 'org', 'local_kid.json'), '{}')
    expect(desktopParent(base, cache)('local_kid')).toBe('local_mother')
  })
})

describe('several projects', () => {
  const sh = (dir: string, ...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args], { stderr: 'ignore' })
  /** A family folder (addon-kit beside one repository) and a standalone project with its own harness and board. */
  const world = () => {
    const home = temp()
    const family = join(home, 'code', 'wow-addons')
    mkdirSync(join(family, 'addon-kit'), { recursive: true })
    writeFileSync(join(family, 'addon-kit', 'q.ts'), '')
    mkdirSync(join(family, 'board'))
    writeFileSync(join(family, 'board', 'a.md'), CARD)
    const yonder = join(family, 'yonder')
    mkdirSync(yonder)
    sh(yonder, 'init', '-q')
    sh(yonder, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'a')
    const puzzles = join(home, 'code', 'warcraft-puzzles')
    mkdirSync(join(puzzles, '.harness', 'board'), { recursive: true })
    mkdirSync(join(puzzles, 'harness'))
    writeFileSync(join(puzzles, 'harness.toml'), '[project]\nname = "warcraft-puzzles"\n[tools]\ndir = "harness"\n')
    writeFileSync(join(puzzles, '.harness', 'board', 'p.md'), CARD.replace('repo: yonder', 'repo: warcraft-puzzles').replace('Eight riddles', 'Grid engine'))
    sh(puzzles, 'init', '-q')
    sh(puzzles, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'b')
    return { home, family, puzzles, yonder }
  }

  test('the roots: flags, then HARNESS_ROOTS, then the config file, then the family and the puzzles folder beside it', () => {
    const { home, family, puzzles } = world()
    const config = join(home, 'roots')
    expect(resolveRoots([], {}, home, config).map(r => r.dir)).toEqual([family, puzzles])
    // a named family folder is the family alone: nothing is added to what the user named
    expect(resolveRoots([], { WOW_ADDONS_ROOT: family }, home, config).map(r => r.dir)).toEqual([family])
    writeFileSync(config, '# the projects\n~/code/warcraft-puzzles\n~/code/wow-addons # first\n')
    expect(resolveRoots([], {}, home, config).map(r => [r.name, r.isFamily])).toEqual([['wow-addons', true], ['warcraft-puzzles', false]])
    expect(resolveRoots([], { HARNESS_ROOTS: puzzles }, home, config).map(r => r.dir)).toEqual([puzzles])
    expect(resolveRoots([family], { HARNESS_ROOTS: puzzles }, home, config).map(r => r.dir)).toEqual([family])
    // (without the puzzles folder there is nothing to add)
    expect(resolveRoots([], {}, temp(), join(home, 'none')).map(r => r.name)).toHaveLength(1)
  })

  test('a standalone project keeps its tools, board and events where its harness.toml says', () => {
    expect(tomlStrings('[tools]\ndir = "h"\n# x = "no"\n[state]\nboard = "cards"')).toEqual({ tools: { dir: 'h' }, state: { board: 'cards' } })
    const { family, puzzles } = world()
    expect(projectOf(family)).toMatchObject({ isFamily: true, board: join(family, 'board'), events: join(family, '.cache', 'harness', 'events.log') })
    expect(projectOf(puzzles)).toEqual({ name: 'warcraft-puzzles', dir: puzzles, isFamily: false, tools: join(puzzles, 'harness'), board: join(puzzles, '.harness', 'board'), events: join(puzzles, '.harness', 'cache', 'events.log') })
  })

  test('a standalone project is one repository row, named as its folder', () => {
    const { puzzles, family } = world()
    expect(repoMarks(puzzles)).toContain('warcraft-puzzles:')
    const rows = cachedRepos(puzzles, temp(), undefined, true)
    expect(rows.map(r => r.name)).toEqual(['warcraft-puzzles'])
    expect(cachedRepos(family, temp(), undefined, true).map(r => r.name)).toEqual(['yonder'])
  })

  test('a transcript line under either root is read, the standalone one as its project', () => {
    const from = new Date(2026, 9, 20).getTime()
    const to = new Date(2026, 9, 21).getTime()
    const noon = new Date(2026, 9, 20, 12).toISOString()
    const s: EventState = { root: '/f', others: ['/p/warcraft-puzzles'], models: {}, pending: {}, events: [], helpers: {}, sessions: { models: {}, modes: {}, open: {} }, known: new Set() }
    const loaded = (id: string, cwd: string) => ({ type: 'assistant', timestamp: noon, cwd, message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'dispatch' } }] } })
    eventRow(loaded('a', '/f/yonder'), from, to, s)
    eventRow(loaded('b', '/p/warcraft-puzzles/web'), from, to, s)
    eventRow(loaded('c', '/elsewhere'), from, to, s)
    expect(s.events.map(e => e.repo).sort()).toEqual(['warcraft-puzzles', 'yonder'])
    // a write anywhere in a standalone project counts, at its root too
    const write = (path: string) => ({ type: 'assistant', timestamp: noon, cwd: '/p/warcraft-puzzles', sessionId: 'x', message: { content: [{ type: 'tool_use', id: path, name: 'Write', input: { file_path: path } }] } })
    eventRow(write('/p/warcraft-puzzles/CLAUDE.md'), from, to, s)
    eventRow(write('/p/warcraft-puzzles/.harness/board/x.md'), from, to, s)
    expect(Object.keys(s.sessions.writes?.x ?? {})).toEqual(['warcraft-puzzles'])
  })

  test('a standalone project alone as the first root: its repository is the folder, its events tagged', () => {
    const from = new Date(2026, 9, 20).getTime()
    const to = new Date(2026, 9, 21).getTime()
    const noon = new Date(2026, 9, 20, 12).toISOString()
    const s: EventState = { root: '/p/warcraft-puzzles', isFamily: false, models: {}, pending: {}, events: [], helpers: {}, sessions: { models: {}, modes: {}, open: {} }, known: new Set() }
    eventRow({ type: 'assistant', timestamp: noon, cwd: '/p/warcraft-puzzles/web', message: { content: [{ type: 'tool_use', id: 'a', name: 'Skill', input: { skill: 'dispatch' } }] } }, from, to, s)
    expect(s.events.map(e => [e.repo, e.project])).toEqual([['warcraft-puzzles', 'warcraft-puzzles']])
  })

  test('one command reads both projects, each row tagged with its own', () => {
    const { home, family, puzzles } = world()
    const cache = temp()
    const run = Bun.spawnSync(['bun', join(import.meta.dir, 'snapshot.ts'), '--root', family, '--root', puzzles, '--cache', cache, '--projects', temp(), '--day', '2026-10-20', '--fresh'], {
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude') },
      stderr: 'pipe',
    })
    expect(run.stderr.toString()).toBe('')
    const snap = JSON.parse(run.stdout.toString())
    expect(snap.projects).toEqual([{ name: 'wow-addons', isFamily: true }, { name: 'warcraft-puzzles', isFamily: false }])
    expect(snap.repos.map((r: { name: string; project: string }) => [r.name, r.project])).toEqual([['yonder', 'wow-addons'], ['warcraft-puzzles', 'warcraft-puzzles']])
    expect(snap.board.map((c: { project: string }) => c.project).sort()).toEqual(['warcraft-puzzles', 'wow-addons'])
    const listed = JSON.parse(Bun.spawnSync(['bun', join(import.meta.dir, 'snapshot.ts'), '--roots', '--cache', temp(), '--root', puzzles]).stdout.toString())
    expect(listed.roots.map((r: { dir: string }) => r.dir)).toEqual([puzzles])
  })
})
