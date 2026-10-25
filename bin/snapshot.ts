#!/usr/bin/env bun
// The harness view's shared numbers, as one JSON object on stdout: each
// repository's check stamp and review, the task board, today's tokens by
// model from every Claude Code transcript on this machine, and today's
// events (the harness's events.log, helpers and answered prompts from the
// transcripts), and the q.ts runs going on (the gates at work). The panel
// runs it on a timer; nothing here writes outside its own cache.
//
//   bun snapshot.ts [--root <family folder>] [--projects <dir>]
//                   [--cache <dir>] [--day YYYY-MM-DD] [--fresh]
//
// Every open session runs it: a snapshot younger than two seconds is printed
// again from the cache instead of read anew. The repositories' rows (git, the
// stamps: most of a read's time) are read again only when one of them moved
// or 20 seconds went by. --fresh reads every number anew, the rows too.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { BoardCard, GateRun, HarnessEvent, HelperDay, HelperDef, LiveSession, ModelDay, RepoRow, Snapshot } from '../types'

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

// The tree of no files: a packet's base when its range starts at the first commit.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** The range the reviewer read, as review.ts recorded it (none before it did). */
function reviewRange(path: string): { base: string; tip: string | null } | null {
  const text = readFileSync(path, 'utf8')
  const base = /^base:\s*([0-9a-f]{40})\s*$/m.exec(text)?.[1]
  return base ? { base, tip: /^tip:\s*([0-9a-f]{40})\s*$/m.exec(text)?.[1] ?? null } : null
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

  // What a push would send: the commits its upstream doesn't have yet; a branch
  // with none yet (never pushed, or detached), those no remote has; no remote, none.
  const upstreamAhead = git(dir, ['rev-list', '--count', '@{u}..HEAD'])
  const sent = upstreamAhead !== null ? ['@{u}'] : git(dir, ['remote']) ? ['--remotes'] : null
  const ahead = upstreamAhead ?? (sent ? git(dir, ['rev-list', '--count', 'HEAD', '--not', ...sent]) : null)

  // HEAD's own verdict, else the newest (an older one); a packet alone says one was asked.
  const own = `review-${head}`
  const verdict = existsSync(join(harness, own)) ? { name: own, at: statSync(join(harness, own)).mtimeMs } : newest(harness, 'review-')
  const packet = newest(join(dir, '.cache', 'review'), '')
  let review: RepoRow['review'] = null
  if (verdict) {
    const sha = verdict.name.slice('review-'.length)
    const isCurrent = head.startsWith(sha) || sha.startsWith(head)
    const read = isCurrent ? reviewRange(join(harness, verdict.name)) : null
    // It reached all a push sends when its packet's base is already there and
    // its tip isn't (the commits after the tip: its findings' fixes; a packet
    // of an earlier push read none of this one).
    // (a commit this clone doesn't know counts for nothing: no count)
    const unsent = (sha: string) => (sent ? git(dir, ['rev-list', '--count', sha, '--not', ...sent]) : null)
    const tipUnsent = read?.tip ? unsent(read.tip) : null
    const covers = read !== null && (read.base === EMPTY_TREE || unsent(read.base) === '0') && tipUnsent !== null && tipUnsent !== '0'
    review = { sha, at: verdict.at, verdict: firstLine(join(harness, verdict.name)), isCurrent, base: read?.base ?? null, covers }
  } else if (packet) {
    const sha = packet.name.replace(/\.md$/, '')
    review = { sha, at: packet.at, verdict: null, isCurrent: head.startsWith(sha) || sha.startsWith(head) }
  }

  return { name: basename(dir), head: head.slice(0, 7), check, failed: failedCheck(dir, check?.at ?? 0), review, ahead: ahead === null ? null : Number(ahead) }
}

const repoDirs = (root: string) =>
  readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(root, e.name, '.git', 'HEAD')))
    .map(e => join(root, e.name))

export function readRepos(root: string, kit?: StampKit): RepoRow[] {
  return repoDirs(root)
    .map(dir => readRepo(dir, kit))
    .filter((r): r is RepoRow => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The branch's upstream's log as the family's branches have it, origin/<branch> (another upstream's row moves within REPOS_MS). */
function upstreamLog(dir: string): string | null {
  try {
    const branch = /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(dir, '.git', 'HEAD'), 'utf8'))?.[1]
    return branch ? `.git/logs/refs/remotes/origin/${branch}` : null
  } catch {
    return null
  }
}

/**
 * What moves when a repository's row would: a commit, a checkout or an add
 * (HEAD, its log, the index), a push or a fetch (the upstream's log), a stamp
 * or a verdict (`.git/harness`), a check run (q's log), a packet. A stat
 * each, where the row's own read runs git.
 */
export function repoMarks(root: string): string {
  const parts = ['.git/HEAD', '.git/logs/HEAD', '.git/index', '.git/harness', '.cache/logs/check.log', '.cache/review']
  return repoDirs(root)
    .map(dir => {
      const upstream = upstreamLog(dir)
      return `${basename(dir)}:${[...parts, ...(upstream ? [upstream] : [])].map(p => (existsSync(join(dir, p)) ? statSync(join(dir, p)).mtimeMs : 0)).join(',')}`
    })
    .join('|')
}

/** How long rows read from unmoved repositories stand: the working trees' edits move nothing above. */
const REPOS_MS = 20_000

/** The rows again when nothing of the repositories moved since their last read, else read anew. */
export function cachedRepos(root: string, cacheDir: string, kit: StampKit | undefined, isFresh: boolean): RepoRow[] {
  const path = join(cacheDir, 'repos.json')
  const marks = repoMarks(root)
  if (!isFresh && existsSync(path)) {
    try {
      const was = JSON.parse(readFileSync(path, 'utf8')) as { marks: string; at: number; repos: RepoRow[] }
      if (was.marks === marks && Date.now() - was.at < REPOS_MS) return was.repos
    } catch {}
  }
  const repos = readRepos(root, kit)
  mkdirSync(cacheDir, { recursive: true })
  const tmp = `${path}.${process.pid}`
  writeFileSync(tmp, JSON.stringify({ marks, at: Date.now(), repos }))
  renameSync(tmp, path)
  return repos
}

// --- the task board -------------------------------------------------------

const ORDER = ['waiting-test', 'waiting-review', 'ready-to-push', 'blocked', 'running', 'done']

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
      if (m[1] === 'repos') card.repos = [...new Set(value.split(',').map(r => r.trim()).filter(Boolean))]
      else if (m[1] === 'waits') card.waits = value
      else if (m[1] in card && m[1] !== 'id' && m[1] !== 'summary') {
        ;(card as Record<string, string>)[m[1]] = value
      }
    }
  }
  card.repos ??= /^[a-z0-9][\w.-]*$/i.test(card.repo) && card.repo !== 'every-repo' ? [card.repo] : []
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

// (version 2 added the events, 3 left every Bash call out of the pending
// ones but pushes and releases, 4 added each helper's day: an older day
// cache is read again whole; 5 keeps every event id seen today, 6 the
// Opus helpers' calls by moment, 7 each session's model and open helpers, 8 and 9 the
// session's mode, 10 the skills each session used, 11 left the moments out again, 12 ends a
// background helper's run at the notice of its end, 13 carries the sessions' skills, open helpers, events and
// file offsets over midnight from the day before)
const CACHE_VERSION = 13

type UsageCache = {
  version: number
  day: string
  files: Record<string, { offset: number }>
  seen: string[]
  models: Record<string, ModelDay>
  pending: Record<string, PendingCall>
  events: HarnessEvent[]
  helpers: Record<string, HelperDay>
  sessions: SessionDay
  known: string[]
}

/** What the transcripts say of each session: its main loop's last model, its helpers started and not yet back (by the Agent call's id). */
export type SessionDay = { models: Record<string, string>; /** Its permission mode as the transcript last recorded it (`plan`: planning, anything else building). */ modes: Record<string, string>; open: Record<string, { session: string; type: string; at: number; repo?: string | null; model?: string }>; /** The skills each session used today: loaded by the session (a `Skill` call) or typed by the user (`/name`), once each with the last time and a count. */ skills?: Record<string, SkillUse[]> }

/** One skill a session used: `by` says who started it. */
export type SkillUse = { name: string; by: 'user' | 'session'; at: number; count: number }

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
  sessionId?: string
  isSidechain?: boolean
  message?: { id?: string; model?: string; usage?: Record<string, number>; content?: unknown }
  uuid?: string
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

/** Where the session log starts: the day's start, or twelve hours back when that reaches further (just after midnight the log is not blank). */
export function logSince(day: string, now: number): number {
  return Math.min(dayBounds(day)[0], now - 12 * 3600_000)
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

/** What the transcript scan keeps between lines: the family folder, the helpers' models, calls, events and each helper's day. */
export type EventState = {
  root: string
  models: Record<string, string>
  pending: Record<string, PendingCall>
  events: HarnessEvent[]
  helpers: Record<string, HelperDay>
  /** Each session's model and open helpers. */
  sessions: SessionDay
  /** Every event id seen today: the events keep only the last 40, a reread line must not come back as new. */
  known: Set<string>
  /** The skills installed (a folder in `skills/`): a typed `/name` counts as a skill only when it is one of these, a built-in command or a mod's isn't. */
  skillNames?: Set<string>
  /** Where the day starts: the helpers' day sums and the tokens count from here, the rows and events read from `from`, a little before it (default: from). */
  dayFrom?: number
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

/** Notes a skill used by a session: once a name and starter, the last time and how often. */
function noteSkill(state: EventState, session: string | undefined, name: string, by: SkillUse['by'], at: number) {
  if (!session) return
  const list = ((state.sessions.skills ??= {})[session] ??= [])
  const used = list.find(u => u.name === name && u.by === by)
  if (used) {
    used.at = Math.max(used.at, at)
    used.count += 1
  } else list.push({ name, by, at, count: 1 })
}

/** Adds an event once a day, by its id; false when it was seen already. */
function addEvent(state: EventState, event: HarnessEvent): boolean {
  if (event.id === undefined || state.known.has(event.id)) return false
  state.known.add(event.id)
  state.events.push(event)
  return true
}

/**
 * A helper's run ended: its event once (by its call's id), and its day summed (the events keep only the
 * last 40). From its result for one in the foreground, from the notice of its end for one in the background.
 */
function helperEnded(state: EventState, id: string, at: number, repo: string | null, type: string, status: string, model: string | undefined, tokens: number | undefined, ms: number | undefined) {
  const isDone = status === 'completed'
  const isNew = addEvent(state, {
    id: `${id}:end`,
    at,
    source: 'helper',
    tone: isDone ? 'ok' : 'fail',
    repo,
    text: `${type} ${isDone ? 'done' : status}`,
    ...(model ? { model } : {}),
    ...(typeof tokens === 'number' ? { tokens } : {}),
    ...(typeof ms === 'number' ? { ms } : {}),
  })
  if (!isNew || at < (state.dayFrom ?? 0)) return
  const day = (state.helpers[type] ??= { runs: 0, tokens: 0, ms: 0, lastAt: 0, model: null })
  day.runs += 1
  day.tokens += tokens ?? 0
  day.ms += ms ?? 0
  day.lastAt = Math.max(day.lastAt, at)
  day.model = model ?? day.model
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
  const content = row.message?.content
  // A skill the user typed: a user row whose text is the command (`/name`), a skill when it is one installed.
  if (row.type === 'user' && typeof content === 'string' && content.includes('<command-name>')) {
    const typed = /<command-name>\/?([\w:.-]+)<\/command-name>/.exec(content)?.[1]
    if (typed && state.skillNames?.has(typed) && row.uuid && addEvent(state, { id: `${row.uuid}:skill`, at, source: 'skill', tone: 'ok', repo: repoOf(state.root, cwd), text: `${typed} typed` })) {
      noteSkill(state, row.sessionId, typed, 'user', at)
    }
    return
  }
  const blocks = (Array.isArray(content) ? content : []) as Block[]
  for (const block of blocks) {
    if (row.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
      const input = block.input ?? {}
      if (block.name === 'Skill' && typeof input.skill === 'string') {
        // The session loaded a skill itself.
        if (addEvent(state, { id: `${block.id}:skill`, at, source: 'skill', tone: 'ok', repo: repoOf(state.root, cwd), text: `${input.skill} loaded` })) { if (!row.isSidechain) noteSkill(state, row.sessionId, input.skill, 'session', at) }
      } else if (block.name === 'Agent' || block.name === 'Task') {
        const type = String(input.subagent_type ?? 'general-purpose')
        const model = typeof input.model === 'string' ? input.model : state.models[type]
        const brief = typeof input.description === 'string' ? input.description : ''
        addEvent(state, {
          id: `${block.id}:start`,
          at,
          source: 'helper',
          tone: 'info',
          repo: repoOf(state.root, cwd),
          text: `${type} started${brief ? `: ${brief}` : ''}`,
          ...(model ? { model } : {}),
        })
        // Open until its result comes back (a background one: until the notice of its end).
        if (row.sessionId && !row.isSidechain) state.sessions.open[block.id] = { session: row.sessionId, type, at, repo: repoOf(state.root, cwd), ...(model ? { model } : {}) }
      } else if (block.name === 'Bash' && typeof input.command === 'string' && ASKED.test(input.command)) {
        state.pending[block.id] = { at, repo: repoOf(state.root, cwd, input.command), command: askedPart(input.command) }
      }
    } else if (row.type === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const id = block.tool_use_id
      const result = row.toolUseResult
      // An Agent call's result: back, unless it only launched a background helper.
      const launched = (row.toolUseResult as { status?: string } | null)?.status === 'async_launched'
      if (!launched) delete state.sessions.open[id]
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
        helperEnded(state, id, at, repoOf(state.root, cwd), r.agentType ?? 'helper', r.status ?? 'stopped', r.resolvedModel, r.totalTokens, r.totalDurationMs)
      }
    }
  }
}

// A line worth parsing for an event: an Agent or Bash call, or a result that is a helper's or a prompt's answer
// (an Agent result names its agentType, a prompt's answer its user source or the rejection).
const isEventLine = (line: string) =>
  /"name":"(?:Agent|Task|Bash|Skill)"/.test(line) ||
  (line.includes('<command-name>') && line.includes('"type":"user"')) ||
  (line.includes('"tool_use_id"') && (line.includes('"agentType"') || line.includes('"source":"user') || line.includes('User rejected tool use')))

const RESULT_ID = /"tool_use_id":"([^"]+)"/g

/**
 * One transcript line into the day's sums and events, parsed once. A result
 * no prompt answered (a rule let the push through) clears its call unparsed.
 */
export function scanLine(line: string, from: number, to: number, seen: Set<string>, models: Record<string, ModelDay>, state: EventState) {
  // A background helper's end: the notice its session gets, naming the Agent call, wherever it lands (a user
  // row, or a queued_command attachment when it comes mid-turn): read off the line, unparsed.
  // Its run ends there too (every helper runs in the background now: its result only says it was launched):
  // the notice's status, tokens and time, the call's type, repository and model kept as it was opened.
  if (line.includes('<task-notification>')) {
    const at = Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? '')
    for (const notice of line.split('<task-notification>').slice(1).map(n => n.split('</task-notification>')[0] ?? '')) {
      const id = /<tool-use-id>([\w-]+)<\/tool-use-id>/.exec(notice)?.[1]
      if (!id) continue
      const call = state.sessions.open[id]
      delete state.sessions.open[id]
      if (!call || !(at >= from && at < to)) continue
      const figure = (tag: string) => {
        const n = Number(new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(notice)?.[1])
        return Number.isNaN(n) ? undefined : n
      }
      const status = /<status>(\w+)<\/status>/.exec(notice)?.[1] ?? 'stopped'
      helperEnded(state, id, at, call.repo ?? null, call.type, status, call.model, figure('subagent_tokens'), figure('duration_ms'))
    }
  }
  // The mode a session is in, the last one the transcript records (read off the line, unparsed): a
  // `permission-mode` row in an interactive session (written again most turns), and the field on a main-loop
  // user record (all a `-p` run writes: no row). A helper's own records are a sidechain.
  const isModeRow = line.startsWith('{"type":"permission-mode"')
  if (isModeRow || (line.includes('"permissionMode":"') && line.includes('"type":"user"') && !line.includes('"isSidechain":true'))) {
    const mode = /"permissionMode":"([\w-]+)"/.exec(line)?.[1]
    const id = /"sessionId":"([\w-]+)"/.exec(line)?.[1]
    if (mode && id) state.sessions.modes[id] = mode
    if (isModeRow) return
  }
  const isUsage = line.includes('"type":"assistant"') && line.includes('"usage"')
  const isEvent = isEventLine(line)
  if (!isEvent && line.includes('"tool_result"')) {
    for (const [, id] of line.matchAll(RESULT_ID)) {
      if (!id) continue
      delete state.pending[id]
      // A helper's result read no further (an interrupt, say): back all the same, unless only launched (its
      // model resolved then, kept for the notice of its end).
      const call = state.sessions.open[id]
      if (call && !line.includes('async_launched')) delete state.sessions.open[id]
      else if (call) call.model = /"resolvedModel":"([\w.-]+)"/.exec(line)?.[1] ?? call.model
    }
  }
  if (!isUsage && !isEvent) return
  let row: Row
  try {
    row = JSON.parse(line)
  } catch {
    return
  }
  if (isUsage) countRow(row, state.dayFrom ?? from, to, seen, models)
  // A session's main loop's last model (a helper's rows are a sidechain).
  if (isUsage && row.sessionId && !row.isSidechain && row.message?.model && !row.message.model.startsWith('<')) state.sessions.models[row.sessionId] = row.message.model
  if (isEvent) eventRow(row, from, to, state)
}

/** The helpers the family defines (`.claude/agents/<name>.md`): name, model (`inherit` as none), the description's first sentence. */
export function agentDefs(dirs: string[]): HelperDef[] {
  const defs = new Map<string, HelperDef>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter(n => n.endsWith('.md'))) {
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, file), 'utf8'))?.[1] ?? ''
      const field = (key: string) => new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm').exec(front)?.[1]
      const name = field('name') ?? file.slice(0, -3)
      const model = field('model') ?? null
      const description = (field('description') ?? '').replace(/\\"/g, '"').split(/(?<=[.:])\s/)[0] ?? ''
      if (!defs.has(name)) defs.set(name, { name, model: model === 'inherit' ? null : model, description })
    }
  }
  return [...defs.values()]
}

/** Each helper's model by its name, for the events. */
/** The skills installed: a folder of the skills directories holding a SKILL.md (a link to one counts). */
export function skillNames(dirs: string[]): Set<string> {
  const names = new Set<string>()
  for (const dir of dirs) {
    try {
      for (const n of readdirSync(dir)) if (existsSync(join(dir, n, 'SKILL.md'))) names.add(n)
    } catch {}
  }
  return names
}

export const agentModels = (defs: HelperDef[]): Record<string, string> =>
  Object.fromEntries(defs.filter(d => d.model).map(d => [d.name, d.model as string]))

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

const EDGE_MS = 3600_000
const KNOWN_MAX = 2000

/**
 * A new day's cache starts from the newest older one of this version (within the week kept): what a live
 * session did stays (its skills, open helpers and model, the events, the files read so far), only the
 * day's figures start again (tokens, ids seen, the helpers' day).
 */
function carriedOver(cacheDir: string, day: string, fresh: UsageCache): UsageCache {
  let best: UsageCache | null = null
  try {
    for (const name of readdirSync(cacheDir)) {
      const older = /^usage-(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1]
      if (!older || older >= day || (best && older <= best.day)) continue
      try {
        const saved = JSON.parse(readFileSync(join(cacheDir, name), 'utf8')) as UsageCache
        if (saved.version === CACHE_VERSION && saved.day === older) best = saved
      } catch {}
    }
  } catch {}
  if (!best) return fresh
  // Skills of sessions untouched for a week go, the ids known are capped (oldest first).
  const stale = dayBounds(day)[0] - 7 * 86_400_000
  const skills = Object.fromEntries(Object.entries(best.sessions.skills ?? {}).filter(([, uses]) => uses.some(u => u.at >= stale)))
  return {
    ...fresh,
    files: best.files,
    pending: best.pending,
    events: best.events,
    sessions: { ...best.sessions, skills },
    known: best.known.slice(-KNOWN_MAX),
  }
}

/** Today's tokens by model and today's helper and prompt events, read on from where the last read stopped. */
export async function readTranscripts(
  projects: string,
  cacheDir: string,
  day: string,
  root: string,
  helpers: Record<string, string> = {},
  skillNames?: Set<string>,
): Promise<{ usage: Snapshot['usage']; events: HarnessEvent[]; helperDay: Record<string, HelperDay>; sessions: SessionDay }> {
  const [dayFrom, to] = dayBounds(day)
  // The rows and events read a little before the day starts: a line written across midnight is read once, by its id.
  const from = dayFrom - EDGE_MS
  const cachePath = join(cacheDir, `usage-${day}.json`)
  let cache: UsageCache = { version: CACHE_VERSION, day, files: {}, seen: [], models: {}, pending: {}, events: [], helpers: {}, sessions: { models: {}, modes: {}, open: {}, skills: {} }, known: [] }
  try {
    const saved = JSON.parse(readFileSync(cachePath, 'utf8')) as UsageCache
    if (saved.day === day && saved.version === CACHE_VERSION) cache = saved
    else throw new Error('not today')
  } catch {
    cache = carriedOver(cacheDir, day, cache)
  }

  const seen = new Set(cache.seen)
  const state: EventState = { root, models: helpers, pending: cache.pending, events: cache.events, helpers: cache.helpers, sessions: cache.sessions, known: new Set(cache.known), skillNames, dayFrom }
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
  cache.known = [...state.known]
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
  return { usage: { day, models, files: files.length }, events: cache.events, helperDay: cache.helpers, sessions: cache.sessions }
}

// --- the live sessions --------------------------------------------------------

/** One file of Claude Code's registry of live sessions, as much of it as the panel reads. */
type Registered = {
  pid?: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  /** The process's start, as ps's lstart spells it, in UTC. */
  procStart?: string
  name?: string
  status?: string
  waitingFor?: string
  statusUpdatedAt?: number
  updatedAt?: number
  entrypoint?: string
  hostSessionId?: string
  /** `bg` for a background session (`claude --bg`), `interactive` otherwise. */
  kind?: string
}

/** Each pid's process start (`ps`'s lstart, local time, in the C locale), one call for all; a pid gone has none; null when ps can't run. */
export function startsOf(pids: number[]): Map<number, number> | null {
  const out = new Map<number, number>()
  if (pids.length === 0) return out
  let ran: ReturnType<typeof Bun.spawnSync>
  try {
    ran = Bun.spawnSync(['/bin/ps', '-o', 'pid=,lstart=', '-p', pids.join(',')], { env: { ...process.env, LC_ALL: 'C' } })
  } catch {
    return null
  }
  for (const line of ran.stdout.toString().split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    const at = m ? Date.parse(m[2] ?? '') : Number.NaN
    if (m && !Number.isNaN(at)) out.set(Number(m[1]), at)
  }
  return out
}

// A helper open longer than this was never seen back (a session killed mid-call): left out.
const OPEN_MAX_MS = 6 * 3600_000

/**
 * The sessions running in the family folder, from Claude Code's registry
 * (`<config>/sessions/<pid>.json`): those whose process is alive and
 * started no later than the session (a pid reused since started after),
 * waiting on the user first, then busy, then idle. The registry is Claude
 * Code's internal format: undefined when it can't be read at all.
 */
export function readSessions(dir: string, root: string, day: SessionDay, now = Date.now(), starts: (pids: number[]) => Map<number, number> | null = startsOf): LiveSession[] | undefined {
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => /^\d+\.json$/.test(n))
  } catch {
    return undefined
  }
  const found: Registered[] = []
  for (const name of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Registered
      // An internal format: what it holds checked before it is used (a bad pid would sink ps's whole list).
      const isText = (v: unknown) => v === undefined || typeof v === 'string'
      const isSound =
        Number.isInteger(r.pid) && (r.pid as number) > 0 && typeof r.sessionId === 'string' && /^[\w-]+$/.test(r.sessionId) && typeof r.cwd === 'string' &&
        [r.name, r.status, r.waitingFor, r.entrypoint, r.hostSessionId, r.procStart].every(isText)
      if (isSound && (r.cwd === root || (r.cwd as string).startsWith(`${root}/`))) found.push(r)
    } catch {}
  }
  const alive = starts(found.map(r => r.pid as number))
  if (!alive) return undefined
  const rank = (s: string) => (s === 'waiting' ? 0 : s === 'busy' ? 1 : 2)
  return found
    .filter(r => {
      const at = alive.get(r.pid as number)
      if (at === undefined) return false
      // The same process: its start as the registry wrote it (UTC) is ps's (a pid reused since started later);
      // with none, a start no later than a minute after the session's.
      const wrote = r.procStart ? Date.parse(`${r.procStart} UTC`) : Number.NaN
      if (!Number.isNaN(wrote)) return Math.abs(at - wrote) <= 2_000
      return !r.startedAt || at <= r.startedAt + 60_000
    })
    .map((r): LiveSession => {
      const id = r.sessionId as string
      const helpers = Object.values(day.open)
        .filter(h => h.session === id && now - h.at < OPEN_MAX_MS)
        .map(({ type, at }) => ({ type, at }))
        .sort((a, b) => a.at - b.at)
      return {
        id,
        pid: r.pid as number,
        name: r.name || basename(r.cwd as string),
        status: r.status || 'idle',
        waitingFor: r.status === 'waiting' ? (r.waitingFor ?? null) : null,
        since: r.statusUpdatedAt ?? r.updatedAt ?? r.startedAt ?? now,
        entrypoint: r.entrypoint ?? '',
        // (not in the soundness check: a kind of another shape only means not a background one)
        background: r.kind === 'bg',
        link: r.entrypoint === 'claude-desktop' && r.hostSessionId && /^[\w-]+$/.test(r.hostSessionId) ? `claude://claude.ai/epitaxy/${r.hostSessionId}` : null,
        model: day.models[id] ?? null,
        mode: day.modes[id] ?? null,
        helpers,
        skills: [...(day.skills?.[id] ?? [])].sort((a, b) => a.at - b.at),
      }
    })
    .sort((a, b) => rank(a.status) - rank(b.status) || b.since - a.since)
}

// --- the gates at work -----------------------------------------------------

/**
 * The q.ts runs going on (addon-kit's events.ts writes `<dir>/<pid>.json` as
 * one starts and removes it before its verdict is logged): those whose
 * process lives and started no later than the run wrote its file (a pid
 * reused since started after; ps's start, cut to the second, is never later
 * than the real one), the oldest first. A run killed before
 * its end leaves its file: left out here, swept by the next run.
 */
export function readGates(dir: string, starts: (pids: number[]) => Map<number, number> | null = startsOf): GateRun[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter(n => /^\d+\.json$/.test(n))
  } catch {
    return []
  }
  const found: GateRun[] = []
  for (const name of names) {
    try {
      const r = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<GateRun>
      if (Number.isInteger(r.pid) && `${r.pid}.json` === name && typeof r.name === 'string' && typeof r.repo === 'string' && Number.isFinite(r.at))
        found.push({ pid: r.pid as number, name: r.name, repo: r.repo, at: r.at as number })
    } catch {}
  }
  const alive = found.length > 0 ? starts(found.map(r => r.pid)) : null
  if (!alive) return []
  return found.filter(r => (alive.get(r.pid) ?? Number.POSITIVE_INFINITY) <= r.at).sort((a, b) => a.at - b.at)
}

// --- the command ----------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

// The pane reads every two seconds while shown: what one session read is the others' for as long.
const SHARED_MS = 2_000

if (import.meta.main) {
  const root = arg('root') ?? process.env.WOW_ADDONS_ROOT ?? join(homedir(), 'code', 'wow-addons')
  const projects = arg('projects') ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const cacheDir = arg('cache') ?? join(homedir(), '.cache', 'harness-view')
  const day = arg('day') ?? localDay(Date.now())
  const shared = join(cacheDir, 'snapshot.json')

  const isFresh = process.argv.includes('--fresh')
  if (!isFresh && existsSync(shared) && Date.now() - statSync(shared).mtimeMs < SHARED_MS) {
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
    const helpers = agentDefs([join(root, '.claude', 'agents'), join(homedir(), '.claude', 'agents')])
    const transcripts = await readTranscripts(projects, cacheDir, day, root, agentModels(helpers), skillNames([join(root, '.claude', 'skills'), join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills')]))
    const eventsFile = process.env.HARNESS_EVENTS === 'off' ? null : process.env.HARNESS_EVENTS || join(root, '.cache', 'harness', 'events.log')
    const since = logSince(day, Date.now())
    const log = eventsFile ? readEventLog(eventsFile, since) : []
    const snapshot: Snapshot = {
      at: Date.now(),
      repos: cachedRepos(root, cacheDir, stamps, isFresh),
      board: readBoard(join(root, 'board'), day, cards),
      usage: transcripts.usage,
      events: [...log, ...transcripts.events.filter(e => e.at >= since)].sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS),
      helpers,
      helperDay: transcripts.helperDay,
      sessions: readSessions(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'sessions'), root, transcripts.sessions),
      gates: eventsFile ? readGates(join(dirname(eventsFile), 'running')) : [],
    }
    const text = JSON.stringify(snapshot)
    const tmp = `${shared}.${process.pid}`
    writeFileSync(tmp, text)
    renameSync(tmp, shared)
    process.stdout.write(text)
  }
}
