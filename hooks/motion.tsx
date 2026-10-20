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

import { bar, FRESH_MS, tokens } from './format'

/** One frame: 80 ms, about twelve a second. */
export const FRAME_MS = 80
/** A figure or a bar on its way to a new value: six frames, about half a second. */
export const TWEEN_FRAMES = 6

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// The pulse draws the line it runs along in its heavy strokes.
const HEAVY: Record<string, string> = {
  '│': '┃', '─': '━', '┌': '┏', '┐': '┓', '└': '┗', '┘': '┛',
  '┬': '┳', '┴': '┻', '├': '┣', '┤': '┫', '┼': '╋', '┄': '┅',
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
   * `color`, the step before them as its trail. The line itself is drawn in
   * `base`, else in `color` dimmed.
   */
  | { kind: 'flow'; text: string; path: number[][]; start: number; cycle: number; on: boolean; color: string; base?: string }
  /** A bar of `width` cells rolling to `value` of `max`. */
  | { kind: 'bar'; value: number; max: number; width: number; rest?: string; color: string }
  /** A figure rolling to `value`. */
  | { kind: 'count'; value: number; unit?: 'tokens' | 'int'; color?: string; bold?: boolean; dim?: boolean }
  /** A log line's mark: blinks while the line is newer than FRESH_MS (`age` as drawn), then `mark`. */
  | { kind: 'fresh'; age: number; color: string; mark?: string }

type Run = {
  frame: number
  cancel: (() => void) | null
  props: MotionProps
  from: number
  to: number
  t0: number
  born: number
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
      return true
    case 'bar':
    case 'count':
      return frame - r.t0 < TWEEN_FRAMES
    case 'fresh':
      return frame - r.born < Math.ceil((FRESH_MS - p.age) / FRAME_MS)
  }
}

/** The lit cells of a flow line at `frame`: the pulse's head and its trail. */
export function lit(p: Extract<MotionProps, { kind: 'flow' }>, frame: number): { head: Set<number>; trail: Set<number> } {
  const none = { head: new Set<number>(), trail: new Set<number>() }
  if (!p.on || p.cycle <= 0) return none
  const k = (((frame % p.cycle) + p.cycle) % p.cycle) - p.start
  if (k < 0 || k > p.path.length) return none
  return { head: new Set(p.path[k] ?? []), trail: new Set(p.path[k - 1] ?? []) }
}

const Motion: ClientModule<MotionProps, number> = (p, s: ClientSurface<number>) => {
  const { Text } = s.elements
  let r = runs.get(s)
  const now = Math.max(r?.frame ?? 0, wall())
  if (!r) {
    // A figure or a bar rolls up from nothing as it first shows.
    r = { frame: now, cancel: null, props: p, from: 0, to: 0, t0: now, born: now }
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
      s.setState(run.frame)
    })
  }
  const frame = Math.max(run.frame, now)

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
      drawn = (
        <Text>
          <Text color={p.color} bold={isUp} dimColor={!isUp}>
            ●
          </Text>
          {p.label ? <Text dimColor> {p.label}</Text> : ''}
        </Text>
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
      const isAlive = frame - run.born < Math.ceil((FRESH_MS - p.age) / FRAME_MS)
      const isUp = Math.floor((frame - run.born) / 3) % 2 === 0
      drawn = isAlive ? (
        <Text color={p.color} bold={isUp} dimColor={!isUp}>
          ●
        </Text>
      ) : (
        <Text color={p.color}>{p.mark ?? ' '}</Text>
      )
      break
    }
  }
  return drawn
}

export default Motion
