// The pane's motion, drawn on the drawing thread (a `Client`'s surface
// module): spinners, the pulse along the diagram's lines, bars and figures
// rolling to their new values, a new log line's blink, the live beat. The
// hooks module hands each instance its data; the frames are counted here, so
// the pane itself redraws only when a number moved.
//
// Every instance counts frames on its own timer, held to the wall clock's
// frame so the instances of one drawing stay in step, and stops its timer
// once nothing of it moves (a props change starts it again).

import type { ClientModule, ClientSurface, RenderElement } from 'claude-code'

import { ago, bar, FRESH_MS, tokens } from './format'

/** One frame: 80 ms, about twelve a second. */
export const FRAME_MS = 80
/** A figure or a bar on its way to a new value: six frames, about half a second. */
export const TWEEN_FRAMES = 6

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// The pulse draws the line it runs along in its heavy strokes.
const HEAVY: Record<string, string> = {
  '│': '┃', '─': '━', '┌': '┏', '┐': '┓', '└': '┗', '┘': '┛',
  '┬': '┳', '┴': '┻', '├': '┣', '┤': '┫', '┼': '╋', '┄': '┅',
  '╌': '╍', '╎': '╏',
}
export const heavy = (ch: string) => HEAVY[ch] ?? ch

export type MotionProps =
  /** Turns while `on`; else `idle` stands still. */
  | { kind: 'spin'; on: boolean; color?: string; idle?: string }
  /** The beat that says the pane is live. */
  | { kind: 'live'; color: string; label?: string }
  /**
   * A line of the diagram (`text`) a pulse runs along while `on`: at step
   * `k` of the drawing's cycle the cells `path[k - start]` are lit in
   * `color`, the `tail` steps before them (one unless said) as its trail. The
   * line itself is drawn in `base`, else in `color` dimmed. A running box's
   * top and bottom edges in the terminal are flows too, a comet on each.
   */
  | { kind: 'flow'; text: string; path: number[][]; start: number; cycle: number; on: boolean; color: string; base?: string; tail?: number }
  /** A bar of `width` cells rolling to `value` of `max`. */
  | { kind: 'bar'; value: number; max: number; width: number; rest?: string; color: string }
  /** A figure rolling to `value`. */
  | { kind: 'count'; value: number; unit?: 'tokens' | 'int'; color?: string; bold?: boolean; dim?: boolean }
  /**
   * A log line's mark: blinks while the line is newer than FRESH_MS, then
   * `mark`. `age` is read as the instance first draws: a redraw's later age
   * would count the time since twice.
   */
  | { kind: 'fresh'; age: number; color: string; settled?: string; mark?: string }
  /** How long since `at` (ms since the epoch), counted here each second: `changed 4s ago`. */
  | { kind: 'ago'; at: number; label?: string }

type Run = {
  frame: number
  cancel: (() => void) | null
  props: MotionProps
  from: number
  to: number
  t0: number
  born: number
  /** The frame a new log line's blink ends at, fixed as the instance first draws. */
  until: number
  /** What it drew last, so a frame that changes nothing draws nothing. */
  look: string
}

const runs = new WeakMap<object, Run>()
const wall = () => Math.floor(Date.now() / FRAME_MS)

export const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3

/** The value a rolling figure or bar shows at `frame`. */
export function rolled(r: Pick<Run, 'from' | 'to' | 't0'>, frame: number): number {
  return r.from + (r.to - r.from) * ease((frame - r.t0) / TWEEN_FRAMES)
}

/** Whether anything of the instance still moves at `frame`. */
function isMoving(r: Run, frame: number): boolean {
  const p = r.props
  switch (p.kind) {
    case 'spin':
    case 'flow':
      return p.on
    case 'live':
    case 'ago':
      return true
    case 'bar':
    case 'count':
      return frame - r.t0 < TWEEN_FRAMES
    case 'fresh':
      return frame < r.until
  }
}

/** The lit cells of a flow line at `frame`: the pulse's head and its trail. */
export function lit(p: Extract<MotionProps, { kind: 'flow' }>, frame: number): { head: Set<number>; trail: Set<number> } {
  const none = { head: new Set<number>(), trail: new Set<number>() }
  if (!p.on || p.cycle <= 0) return none
  const k = (((frame % p.cycle) + p.cycle) % p.cycle) - p.start
  const tail = Math.max(1, p.tail ?? 1)
  if (k < 0 || k > p.path.length - 1 + tail) return none
  const head = new Set(p.path[k] ?? [])
  const trail = new Set<number>()
  for (let i = 1; i <= tail; i++) for (const x of p.path[k - i] ?? []) if (!head.has(x)) trail.add(x)
  return { head, trail }
}

type Elements = ClientSurface<number>['elements']

/** What the instance shows at `frame`. */
function draw(p: MotionProps, run: Run, frame: number, Text: Elements['Text'], Box: Elements['Box']): RenderElement {
  let drawn: RenderElement
  switch (p.kind) {
    case 'spin':
      drawn = (
        <Text color={p.color} dimColor={!p.on}>
          {p.on ? (SPIN[frame % SPIN.length] ?? '⠋') : (p.idle ?? '·')}
        </Text>
      )
      break
    case 'live': {
      // A beat: bright for most of a second and a bit, then dim.
      const isUp = frame % 15 < 10
      // Side by side, not nested: on the desktop a run inside a text sits off its baseline.
      drawn = (
        <Box>
          <Text color={p.color} bold={isUp} dimColor={!isUp}>
            ●
          </Text>
          <Text dimColor>{p.label ? ` ${p.label}` : ''}</Text>
        </Box>
      )
      break
    }
    case 'flow': {
      const { head, trail } = lit(p, frame)
      // Runs of cells drawn alike: the line dim, the pulse bright and heavy.
      const runsOf: { style: 'line' | 'head' | 'trail'; text: string }[] = []
      for (let x = 0; x < p.text.length; x++) {
        const ch = p.text[x] ?? ' '
        const style = ch === ' ' ? 'line' : head.has(x) ? 'head' : trail.has(x) ? 'trail' : 'line'
        const text = style === 'line' ? ch : heavy(ch)
        const last = runsOf.at(-1)
        if (last && last.style === style) last.text += text
        else runsOf.push({ style, text })
      }
      drawn = (
        <Text wrap="truncate-end">
          {runsOf.map((part, i) =>
            part.style === 'line' ? (
              <Text key={`f${i}`} color={p.base ?? p.color} dimColor={p.base === undefined}>
                {part.text}
              </Text>
            ) : (
              <Text key={`f${i}`} color={p.color} bold={part.style === 'head'}>
                {part.text}
              </Text>
            ),
          )}
        </Text>
      )
      break
    }
    case 'bar': {
      const b = bar(rolled(run, frame), p.max, p.width, p.rest)
      drawn = (
        <Text wrap="truncate-end">
          <Text color={p.color}>{b.filled}</Text>
          <Text color={p.color} dimColor>
            {b.empty}
          </Text>
        </Text>
      )
      break
    }
    case 'count': {
      const v = rolled(run, frame)
      drawn = (
        <Text color={p.color} bold={p.bold} dimColor={p.dim} wrap="truncate-end">
          {p.unit === 'int' ? String(Math.round(v)) : tokens(v)}
        </Text>
      )
      break
    }
    case 'fresh': {
      const isAlive = frame < run.until
      const isUp = Math.floor((frame - run.born) / 3) % 2 === 0
      drawn = isAlive ? (
        <Text color={p.color} bold={isUp} dimColor={!isUp}>
          ●
        </Text>
      ) : (
        <Text color={p.settled ?? p.color}>{p.mark ?? ' '}</Text>
      )
      break
    }
    case 'ago':
      drawn = <Text dimColor>{`${p.label ?? ''}${ago(p.at, Date.now())} ago`}</Text>
      break
  }
  return drawn
}

const Motion: ClientModule<MotionProps, number> = (p, s: ClientSurface<number>) => {
  // Cut, never wrapped, its runs too (the desktop wraps a Text with no wrap).
  const Text = (props: Parameters<Elements['Text']>[0]) => s.elements.Text({ wrap: 'truncate-end', ...props })
  let r = runs.get(s)
  const now = Math.max(r?.frame ?? 0, wall())
  if (!r) {
    // A figure or a bar rolls up from nothing as it first shows.
    const until = now + (p.kind === 'fresh' ? Math.ceil((FRESH_MS - p.age) / FRAME_MS) : 0)
    r = { frame: now, cancel: null, props: p, from: 0, to: 0, t0: now, born: now, until, look: '' }
    runs.set(s, r)
  }
  r.props = p
  if ((p.kind === 'bar' || p.kind === 'count') && p.value !== r.to) {
    r.from = rolled(r, now)
    r.to = p.value
    r.t0 = now
  }
  const run = r
  if (!run.cancel && isMoving(run, now)) {
    run.cancel = s.every(FRAME_MS, () => {
      run.frame = Math.max(run.frame + 1, wall())
      if (!isMoving(run, run.frame)) {
        run.cancel?.()
        run.cancel = null
      }
      // Drawn again only when this frame looks other than the last: a beat or a clock changes a few times a second.
      if (JSON.stringify(draw(run.props, run, run.frame, Text, s.elements.Box)) !== run.look) s.setState(run.frame)
    })
  }
  const drawn = draw(p, run, Math.max(run.frame, now), Text, s.elements.Box)
  run.look = JSON.stringify(drawn)
  return drawn
}

export default Motion
