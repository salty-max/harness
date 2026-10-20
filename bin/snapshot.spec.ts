import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ModelDay } from '../types'
import {
  agentDefs,
  agentModels,
  askedPart,
  cachedRepos,
  countLine,
  type EventState,
  eventRow,
  scanLine,
  failedCheck,
  parseCard,
  parseEventLine,
  readBoard,
  readEventLog,
  readRepo,
  readTranscripts,
  repoMarks,
  repoOf,
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
    })
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
  const state = (): EventState => ({ root: '/f', models: { reviewer: 'opus' }, pending: {}, events: [], helpers: {}, moments: {}, known: new Set() })
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
      { id: 't1:start', at: Date.parse(noon), source: 'helper', tone: 'info', repo: 'yonder', text: 'reviewer started: Review the riddles', model: 'opus' },
      { id: 't1:end', at: Date.parse(noon), source: 'helper', tone: 'ok', repo: 'yonder', text: 'reviewer done', model: 'claude-opus-5-5', tokens: 106_689, ms: 503_770 },
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

  test("the Opus helpers' calls by moment: the reviewer's the push, the architect's by its brief, each once", () => {
    const s = state()
    eventRow(call('m1', 'Agent', { subagent_type: 'reviewer', description: 'Review the riddles' }), from, to, s)
    eventRow(call('m2', 'Agent', { subagent_type: 'architect', description: 'The plan for the panel' }), from, to, s)
    eventRow(call('m3', 'Agent', { subagent_type: 'architect', description: 'The same test failing again' }), from, to, s)
    eventRow(call('m4', 'Agent', { subagent_type: 'architect', description: 'Sign off the whole change' }), from, to, s)
    eventRow(call('m5', 'Agent', { subagent_type: 'Explore', description: 'Find the plan' }), from, to, s)
    // A line read again counts nothing more.
    eventRow(call('m1', 'Agent', { subagent_type: 'reviewer', description: 'Review the riddles' }), from, to, s)
    const at = Date.parse(noon)
    expect(s.moments).toEqual({ push: { runs: 1, lastAt: at }, plan: { runs: 1, lastAt: at }, error: { runs: 1, lastAt: at }, done: { runs: 1, lastAt: at } })
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
