#!/usr/bin/env bun
// The harness view's shared numbers, as one JSON object on stdout: each
// repository's check stamp and review, the task board, today's tokens by
// model from every Claude Code transcript on this machine, and today's
// events (the harness's events.log, helpers and answered prompts from the
// transcripts). The panel runs it on a timer; nothing here writes outside
// its own cache.
//
//   bun snapshot.ts [--root <family folder>] [--projects <dir>]
//                   [--cache <dir>] [--day YYYY-MM-DD] [--fresh]
//
// Every open session runs it: a snapshot younger than 15 seconds is printed
// again from the cache instead of read anew (--fresh reads anew).

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { BoardCard, HarnessEvent, ModelDay, RepoRow, Snapshot } from '../types'

const CHUNK = 16 * 1024 * 1024

export function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function dayBounds(day: string): [number, number] {
  const [y, m, d] = day.split('-').map(Number)
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()]
}

// --- repositories ---------------------------------------------------------

function git(dir: string, args: string[]): string | null {
  const run = Bun.spawnSync(['git', '-C', dir, ...args], { stderr: 'ignore' })
  return run.exitCode === 0 ? run.stdout.toString().trim() : null
}

function newest(dir: string, prefix: string): { name: string; at: number } | null {
  if (!existsSync(dir)) return null
  let best: { name: string; at: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue
    const at = statSync(join(dir, name)).mtimeMs
    if (best === null || at > best.at) best = { name, at }
  }
  return best
}

/** A file's last `bytes`, a line cut at the start left out. */
function tailText(path: string, bytes: number): string {
  const size = statSync(path).size
  const start = Math.max(0, size - bytes)
  const buffer = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, start)
  } finally {
    closeSync(fd)
  }
  const text = buffer.toString('utf8')
  return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
}

/** The last check run when it failed after `after`: q.ts's log ends `[exit N, 41s]`. */
export function failedCheck(dir: string, after: number): RepoRow['failed'] {
  const log = join(dir, '.cache', 'logs', 'check.log')
  if (!existsSync(log)) return null
  const at = statSync(log).mtimeMs
  if (at <= after) return null
  const exit = Number(/\[exit (\d+),[^\]]*\]\s*$/.exec(tailText(log, 256))?.[1] ?? 0)
  return exit === 0 ? null : { at, exit }
}

function firstLine(path: string): string | null {
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .find(Boolean)
  return line ? line.replace(/^verdict:\s*/i, '').slice(0, 80) : null
}

/** The stamps as addon-kit's q.ts writes and reads them (B), when it is there. */
export type StampKit = {
  headTree: (dir: string) => string | undefined
  workTree: (dir: string) => string | undefined
  stampOf: (dir: string, tree: string | undefined) => { tree: string; at: string } | undefined
  lastStamp: (dir: string) => { tree: string; at: string } | undefined
}

export function readRepo(dir: string, kit?: StampKit): RepoRow | null {
  const ids = git(dir, ['rev-parse', 'HEAD', 'HEAD^{tree}'])
  if (ids === null) return null
  const [head, tree] = ids.split('\n')
  const harness = join(dir, '.git', 'harness')

  // Fresh: HEAD's tree is stamped, so a push of HEAD passes pre-push. The
  // working directory as it is now is told apart (edits made after the check,
  // or a checked state not committed yet). Without the kit, HEAD alone.
  let check: RepoRow['check'] = null
  if (kit) {
    const last = kit.lastStamp(dir)
    const head = kit.stampOf(dir, kit.headTree(dir))
    if (last) {
      // A fresh check's age is HEAD's stamp's, not a later working-tree check's.
      const shown = head ?? last
      check = {
        tree: shown.tree,
        at: Date.parse(shown.at),
        isFresh: head !== undefined,
        isWorkFresh: kit.stampOf(dir, kit.workTree(dir)) !== undefined,
      }
    }
  } else {
    const stamp = newest(harness, 'check-')
    if (stamp) {
      const isFresh = existsSync(join(harness, `check-${tree}`))
      check = { tree: stamp.name.slice('check-'.length), at: stamp.at, isFresh, isWorkFresh: isFresh }
    }
  }

  // A verdict recorded beside the stamps wins; a packet alone says one was asked.
  const verdict = newest(harness, 'review-')
  const packet = newest(join(dir, '.cache', 'review'), '')
  let review: RepoRow['review'] = null
  if (verdict) {
    const sha = verdict.name.slice('review-'.length)
    review = {
      sha,
      at: verdict.at,
      verdict: firstLine(join(harness, verdict.name)),
      isCurrent: head.startsWith(sha) || sha.startsWith(head),
    }
  } else if (packet) {
    const sha = packet.name.replace(/\.md$/, '')
    review = { sha, at: packet.at, verdict: null, isCurrent: head.startsWith(sha) || sha.startsWith(head) }
  }

  return { name: basename(dir), head: head.slice(0, 7), check, failed: failedCheck(dir, check?.at ?? 0), review }
}

export function readRepos(root: string, kit?: StampKit): RepoRow[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(root, e.name, '.git', 'HEAD')))
    .map(e => readRepo(join(root, e.name), kit))
    .filter((r): r is RepoRow => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// --- the task board -------------------------------------------------------

const ORDER = ['waiting-test', 'waiting-review', 'ready-to-push', 'running', 'done']

/** The cards as addon-kit's board.ts parses them (B), when it is there. */
export type CardKit = {
  parseCard: (id: string, text: string) => Omit<BoardCard, 'summary'> & { body: string }
}

/** The first line under `## Try`, else the body's first line before any section. */
export function summaryOf(body: string): string {
  const lines = body.split('\n').map(l => l.trim())
  const plain = (from: number) => {
    for (const line of lines.slice(from)) {
      if (/^##\s/.test(line)) return ''
      if (line.startsWith('#')) continue
      const text = line.replace(/^[>*\-\s]+/, '').trim()
      if (text) return text
    }
    return ''
  }
  const tryAt = lines.findIndex(l => /^##\s+try\b/i.test(l))
  return ((tryAt !== -1 && plain(tryAt + 1)) || plain(0)).slice(0, 160)
}

/** The fallback parser, for a family folder without board.ts. */
export function parseCard(id: string, text: string): BoardCard {
  const card: BoardCard = { id, repo: '', title: id, status: '', session: '', updated: '', summary: '' }
  let body = text
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (front) {
    body = text.slice(front[0].length)
    for (const line of front[1].split('\n')) {
      const m = /^(\w+):\s*(.*)$/.exec(line.trim())
      if (!m) continue
      let value = m[2]
      if (/^".*"$/.test(value)) {
        try {
          value = JSON.parse(value)
        } catch {}
      } else {
        value = value.replace(/^'(.*)'$/, '$1')
      }
      if (m[1] in card && m[1] !== 'id' && m[1] !== 'summary') {
        ;(card as Record<string, string>)[m[1]] = value
      }
    }
  }
  card.summary = summaryOf(body)
  return card
}

export function readBoard(dir: string, today: string, kit?: CardKit): BoardCard[] {
  if (!existsSync(dir)) return []
  const rank = (s: string) => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length - 1.5)
  const read = (id: string, text: string): BoardCard => {
    if (!kit) return parseCard(id, text)
    const { body, ...card } = kit.parseCard(id, text)
    return { ...card, summary: summaryOf(body) }
  }
  return readdirSync(dir)
    .filter(n => n.endsWith('.md') && !n.startsWith('.') && n.toLowerCase() !== 'readme.md')
    .map(n => read(n.replace(/\.md$/, ''), readFileSync(join(dir, n), 'utf8')))
    .filter(c => c.status !== 'done' || c.updated.startsWith(today))
    .sort((a, b) => rank(a.status) - rank(b.status) || b.updated.localeCompare(a.updated))
}

// --- today's usage --------------------------------------------------------

// (version 2 added the events: a day cache of version 1 is read again whole)
const CACHE_VERSION = 2

type UsageCache = {
  version: number
  day: string
  files: Record<string, { offset: number }>
  seen: string[]
  models: Record<string, ModelDay>
  pending: Record<string, PendingCall>
  events: HarnessEvent[]
}

function listTranscripts(dir: string, since: number): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = []
  if (!existsSync(dir)) return out
  for (const rel of new Bun.Glob('**/*.jsonl').scanSync({ cwd: dir, onlyFiles: true })) {
    const path = join(dir, rel)
    const st = statSync(path)
    if (st.mtimeMs >= since) out.push({ path, size: st.size })
  }
  return out
}

type Block = { type?: string; id?: unknown; name?: string; input?: Record<string, unknown>; tool_use_id?: unknown }

/** A transcript line, as much of it as the panel reads. */
type Row = {
  type?: string
  timestamp?: string
  cwd?: string
  message?: { id?: string; model?: string; usage?: Record<string, number>; content?: unknown }
  toolUseResult?: unknown
  permissionDecision?: { decision?: string; source?: string }
}

/** Adds one transcript line to the day's sums; a repeated message counts once. */
export function countLine(line: string, from: number, to: number, seen: Set<string>, models: Record<string, ModelDay>) {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return
  try {
    countRow(JSON.parse(line), from, to, seen, models)
  } catch {}
}

function countRow(row: Row, from: number, to: number, seen: Set<string>, models: Record<string, ModelDay>) {
  const msg = row.message
  if (row.type !== 'assistant' || !msg?.usage || !msg.id || !msg.model || msg.model.startsWith('<')) return
  const at = Date.parse(row.timestamp ?? '')
  if (!(at >= from && at < to) || seen.has(msg.id)) return
  seen.add(msg.id)
  const u = msg.usage
  const day = (models[msg.model] ??= { model: msg.model, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  day.calls += 1
  day.input += u.input_tokens ?? 0
  day.cacheRead += u.cache_read_input_tokens ?? 0
  day.cacheWrite += u.cache_creation_input_tokens ?? 0
  day.output += u.output_tokens ?? 0
}

// --- today's events ---------------------------------------------------------

const TONES = ['ok', 'wait', 'fail', 'info']
const MAX_EVENTS = 40

/** One line of the harness's events.log (addon-kit/events.ts writes it), or null. */
export function parseEventLine(line: string): HarnessEvent | null {
  const [iso = '', source = '', tone = '', repo = '', ...text] = line.split('\t')
  const at = Date.parse(iso)
  if (Number.isNaN(at) || !source || text.length === 0) return null
  return { at, source, tone: (TONES.includes(tone) ? tone : '') as HarnessEvent['tone'], repo, text: text.join(' ') }
}

/** The log's events since `from`, newest first, read from its end (its writer trims it past 256 KB). */
export function readEventLog(path: string, from: number, max = MAX_EVENTS): HarnessEvent[] {
  if (!existsSync(path)) return []
  return tailText(path, 64 * 1024)
    .split('\n')
    .map(parseEventLine)
    .filter((e): e is HarnessEvent => e !== null && e.at >= from)
    .reverse()
    .slice(0, max)
}

/** A push or release waiting for its result: a prompt the user answers is told by it. */
type PendingCall = { at: number; repo: string; command: string }

/** What the transcript scan keeps between lines: the family folder, the helpers' models, calls and events. */
export type EventState = {
  root: string
  models: Record<string, string>
  pending: Record<string, PendingCall>
  events: HarnessEvent[]
}

// The part of a command a push or release prompt is about (the root's ask rules).
const ASKED =
  /\bgit\b[^;&|]*?\spush\b[^;&|]*|[\w./-]*release\.sh\b[^;&|]*|\bgh\b[^;&|]*?\b(?:release|pr merge|workflow run)\b[^;&|]*|\bvercel\b[^;&|]*|\bstore\.ts\b[^;&|]*--apply[^;&|]*/

/** A command as the log says it: the push or release in it, else its start. */
export function askedPart(command: string): string {
  const part = (ASKED.exec(command)?.[0] ?? command).replace(/\s+/g, ' ').replace(/\s*\d*>.*$/, '').trim()
  return part.length > 60 ? `${part.slice(0, 59)}…` : part
}

/** The family repository a line is about: a path in its command first, else its working directory. */
export function repoOf(root: string, cwd: string | undefined, command = ''): string {
  const named = command.split(`${root}/`)[1]?.split(/[/\s"';&|]/)[0]
  if (named) return named
  const relative = /\bgit\s+-C\s+["']?([\w.-]+)["']?(?:\s|$)/.exec(command)?.[1]
  if (relative && cwd === root) return relative
  return cwd?.startsWith(`${root}/`) ? (cwd.slice(root.length + 1).split('/')[0] ?? '') : ''
}

function addEvent(state: EventState, event: HarnessEvent) {
  if (!state.events.some(e => e.id === event.id)) state.events.push(event)
}

/**
 * Finds the events in one transcript line of a family session: a helper
 * started (the Agent call) or finished (its result: model, tokens, time),
 * and a push or release whose prompt the user answered (`permissionDecision`
 * from the user, or a rejection; an interrupt reads as one too).
 */
export function eventRow(row: Row, from: number, to: number, state: EventState) {
  const at = Date.parse(row.timestamp ?? '')
  const cwd = row.cwd
  if (!(at >= from && at < to) || (cwd !== state.root && !cwd?.startsWith(`${state.root}/`))) return
  const blocks = (Array.isArray(row.message?.content) ? row.message.content : []) as Block[]
  for (const block of blocks) {
    if (row.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
      const input = block.input ?? {}
      if (block.name === 'Agent' || block.name === 'Task') {
        const type = String(input.subagent_type ?? 'general-purpose')
        const model = typeof input.model === 'string' ? input.model : state.models[type]
        const description = typeof input.description === 'string' ? `: ${input.description}` : ''
        addEvent(state, { id: `${block.id}:start`, at, source: 'helper', tone: 'info', repo: repoOf(state.root, cwd), text: `${type} started${description}`, ...(model ? { model } : {}) })
      } else if (block.name === 'Bash' && typeof input.command === 'string' && ASKED.test(input.command)) {
        state.pending[block.id] = { at, repo: repoOf(state.root, cwd, input.command), command: askedPart(input.command) }
      }
    } else if (row.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const id = block.tool_use_id
      const result = row.toolUseResult
      const call = state.pending[id]
      if (call) {
        delete state.pending[id]
        const decision = row.permissionDecision
        const isRefused = result === 'User rejected tool use' || (decision?.decision === 'reject' && !!decision.source?.startsWith('user'))
        if (isRefused || decision?.source?.startsWith('user')) {
          addEvent(state, { id: `${id}:ask`, at, source: 'ask', tone: isRefused ? 'fail' : 'ok', repo: call.repo, text: `${call.command} ${isRefused ? 'refused' : 'allowed'}` })
        }
      } else if (result !== null && typeof result === 'object' && 'agentType' in result) {
        const r = result as { agentType?: string; status?: string; resolvedModel?: string; totalTokens?: number; totalDurationMs?: number }
        if (r.status === 'async_launched') continue
        const isDone = r.status === 'completed'
        addEvent(state, {
          id: `${id}:end`,
          at,
          source: 'helper',
          tone: isDone ? 'ok' : 'fail',
          repo: repoOf(state.root, cwd),
          text: `${r.agentType ?? 'helper'} ${isDone ? 'done' : (r.status ?? 'stopped')}`,
          ...(r.resolvedModel ? { model: r.resolvedModel } : {}),
          ...(typeof r.totalTokens === 'number' ? { tokens: r.totalTokens } : {}),
          ...(typeof r.totalDurationMs === 'number' ? { ms: r.totalDurationMs } : {}),
        })
      }
    }
  }
}

// A line worth parsing for an event: an Agent or Bash call, or a result that is a helper's or a prompt's answer
// (an Agent result names its agentType, a prompt's answer its user source or the rejection).
const isEventLine = (line: string) =>
  /"name":"(?:Agent|Task|Bash)"/.test(line) ||
  (line.includes('"tool_use_id"') && (line.includes('"agentType"') || line.includes('"source":"user') || line.includes('User rejected tool use')))

const RESULT_ID = /"tool_use_id":"([^"]+)"/g

/**
 * One transcript line into the day's sums and events, parsed once. A result
 * no prompt answered (a rule let the push through) clears its call unparsed.
 */
export function scanLine(line: string, from: number, to: number, seen: Set<string>, models: Record<string, ModelDay>, state: EventState) {
  const isUsage = line.includes('"type":"assistant"') && line.includes('"usage"')
  const isEvent = isEventLine(line)
  if (!isEvent && line.includes('"tool_result"')) {
    for (const [, id] of line.matchAll(RESULT_ID)) if (id) delete state.pending[id]
  }
  if (!isUsage && !isEvent) return
  let row: Row
  try {
    row = JSON.parse(line)
  } catch {
    return
  }
  if (isUsage) countRow(row, from, to, seen, models)
  if (isEvent) eventRow(row, from, to, state)
}

/** Each helper's model from its definition (`.claude/agents/<name>.md`), `inherit` left out. */
export function agentModels(dirs: string[]): Record<string, string> {
  const models: Record<string, string> = {}
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter(n => n.endsWith('.md'))) {
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, name), 'utf8'))?.[1] ?? ''
      const field = (key: string) => new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm').exec(front)?.[1]
      const model = field('model')
      if (model && model !== 'inherit') models[field('name') ?? name.slice(0, -3)] ??= model
    }
  }
  return models
}

/** Reads whole lines from `offset`; returns where the next read starts. */
async function readFrom(path: string, offset: number, size: number, onLine: (line: string) => void): Promise<number> {
  const file = Bun.file(path)
  const decoder = new TextDecoder()
  let start = offset
  while (start < size) {
    const end = Math.min(size, start + CHUNK)
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer())
    const cut = bytes.lastIndexOf(0x0a)
    if (cut === -1) {
      // One line longer than a chunk: read it whole or not at all.
      if (end === size) break
      const line = await readLine(file, start, size)
      if (line === null) break
      onLine(line.text)
      start = line.next
      continue
    }
    for (const line of decoder.decode(bytes.subarray(0, cut)).split('\n')) onLine(line)
    start += cut + 1
  }
  // A line still being written is read again next time, from its start.
  return start
}

async function readLine(file: ReturnType<typeof Bun.file>, start: number, size: number) {
  let end = start
  while (end < size) {
    const bytes = new Uint8Array(await file.slice(end, Math.min(size, end + CHUNK)).arrayBuffer())
    const cut = bytes.indexOf(0x0a)
    if (cut !== -1) {
      const text = await file.slice(start, end + cut).text()
      return { text, next: end + cut + 1 }
    }
    end += bytes.length
  }
  return null
}

/** Today's tokens by model and today's helper and prompt events, read on from where the last read stopped. */
export async function readTranscripts(
  projects: string,
  cacheDir: string,
  day: string,
  root: string,
  helpers: Record<string, string> = {},
): Promise<{ usage: Snapshot['usage']; events: HarnessEvent[] }> {
  const [from, to] = dayBounds(day)
  const cachePath = join(cacheDir, `usage-${day}.json`)
  let cache: UsageCache = { version: CACHE_VERSION, day, files: {}, seen: [], models: {}, pending: {}, events: [] }
  try {
    const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as UsageCache
    if (saved.day === day && saved.version === CACHE_VERSION) cache = saved
  } catch {}

  const seen = new Set(cache.seen)
  const state: EventState = { root, models: helpers, pending: cache.pending, events: cache.events }
  const files = listTranscripts(projects, from)
  for (const { path, size } of files) {
    const known = cache.files[path]?.offset ?? 0
    // A file that shrank was rewritten: read it whole, the seen ids keep the sums right.
    const offset = known > size ? 0 : known
    if (offset === size) continue
    const next = await readFrom(path, offset, size, line => scanLine(line, from, to, seen, cache.models, state))
    cache.files[path] = { offset: next }
  }

  cache.seen = [...seen]
  cache.events = state.events.sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS)
  mkdirSync(cacheDir, { recursive: true })
  // A week of days is plenty: older day caches go.
  for (const name of readdirSync(cacheDir)) {
    const old = /^usage-(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1]
    if (old && dayBounds(old)[0] < from - 7 * 86_400_000) rmSync(join(cacheDir, name), { force: true })
  }
  const tmp = `${cachePath}.${process.pid}`
  writeFileSync(tmp, JSON.stringify(cache))
  renameSync(tmp, cachePath)

  const models = Object.values(cache.models).sort(
    (a, b) => b.input + b.cacheRead + b.cacheWrite + b.output - (a.input + a.cacheRead + a.cacheWrite + a.output),
  )
  return { usage: { day, models, files: files.length }, events: cache.events }
}

// --- the command ----------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const SHARED_MS = 15_000

if (import.meta.main) {
  const root = arg('root') ?? process.env.WOW_ADDONS_ROOT ?? join(homedir(), 'code', 'wow-addons')
  const projects = arg('projects') ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const cacheDir = arg('cache') ?? join(homedir(), '.cache', 'harness-view')
  const day = arg('day') ?? localDay(Date.now())
  const shared = join(cacheDir, 'snapshot.json')

  if (!process.argv.includes('--fresh') && existsSync(shared) && Date.now() - statSync(shared).mtimeMs < SHARED_MS) {
    process.stdout.write(readFileSync(shared, 'utf8'))
  } else {
    // B's readers when the kit has them, so the panel and the gates agree.
    let stamps: StampKit | undefined
    let cards: CardKit | undefined
    try {
      stamps = (await import(join(root, 'addon-kit', 'q.ts'))) as StampKit
    } catch {}
    try {
      cards = (await import(join(root, 'addon-kit', 'board.ts'))) as CardKit
    } catch {}
    const helpers = agentModels([join(root, '.claude', 'agents'), join(homedir(), '.claude', 'agents')])
    const transcripts = await readTranscripts(projects, cacheDir, day, root, helpers)
    const log = process.env.HARNESS_EVENTS === 'off' ? [] : readEventLog(process.env.HARNESS_EVENTS || join(root, '.cache', 'harness', 'events.log'), dayBounds(day)[0])
    const snapshot: Snapshot = {
      at: Date.now(),
      repos: readRepos(root, stamps),
      board: readBoard(join(root, 'board'), day, cards),
      usage: transcripts.usage,
      events: [...log, ...transcripts.events].sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS),
    }
    const text = JSON.stringify(snapshot)
    const tmp = `${shared}.${process.pid}`
    writeFileSync(tmp, text)
    renameSync(tmp, shared)
    process.stdout.write(text)
  }
}
