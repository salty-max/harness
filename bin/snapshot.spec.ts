import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ModelDay } from '../types'
import { countLine, parseCard, readBoard, readRepo, readUsage, summaryOf } from './snapshot'

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

    const first = await readUsage(projects, cache, '2026-10-20')
    expect(first.files).toBe(2)
    expect(first.models.map(m => [m.model, m.calls])).toEqual([
      ['claude-opus-5-5', 2],
      ['claude-sonnet-5-5', 1],
    ])

    appendFileSync(main, `${half.slice(40)}\n${line('m1', noon)}\n`)
    const second = await readUsage(projects, cache, '2026-10-20')
    expect(second.models.map(m => [m.model, m.calls])).toEqual([
      ['claude-opus-5-5', 2],
      ['claude-sonnet-5-5', 2],
    ])
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

  test('an older stamp is stale, a packet alone has no verdict', () => {
    const dir = repo()
    writeFileSync(join(dir, '.git', 'harness', 'check-0000000'), '')
    mkdirSync(join(dir, '.cache', 'review'), { recursive: true })
    writeFileSync(join(dir, '.cache', 'review', 'abc1234.md'), '# packet\n')
    const row = readRepo(dir)
    expect(row?.check).toMatchObject({ tree: '0000000', isFresh: false, isWorkFresh: false })
    expect(row?.review).toMatchObject({ sha: 'abc1234', verdict: null, isCurrent: false })
  })
})
