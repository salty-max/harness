// The numbers as the panel says them, shared by the hooks module and the
// surface module (motion.tsx): plain functions, nothing of `$`.

/** How long a new log line's mark blinks. */
export const FRESH_MS = 6_000

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '?'
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
  return `${(n / 1e9).toFixed(1)}G`
}

export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar of block characters in eighths of a cell; a value above zero shows at least a sliver. */
export function bar(value: number, max: number, width: number, rest = '░'): { filled: string; empty: string } {
  if (max <= 0 || width <= 0) return { filled: '', empty: rest.repeat(Math.max(0, width)) }
  const share = Math.min(1, Math.max(0, value / max))
  const eighths = Math.max(value > 0 ? 1 : 0, Math.round(share * width * 8))
  const part = EIGHTHS[eighths % 8] ?? ''
  const full = Math.floor(eighths / 8)
  return { filled: '█'.repeat(full) + part, empty: rest.repeat(width - full - (part ? 1 : 0)) }
}

/** The four moments the family calls an Opus helper at (CLAUDE.md, "Helpers"). */
export type Moment = 'plan' | 'error' | 'push' | 'done'

/**
 * The moment a helper's run is at, by its type and its brief: the reviewer's
 * is the push, the architect's read from what it was asked; other helpers
 * have none.
 */
export function momentOf(type: string, description: string): Moment | null {
  if (type === 'reviewer') return 'push'
  if (type !== 'architect') return null
  // Whole words: an architect asked to "design" something is planning, not signing off.
  if (/\b(errors?|fail\w*|again|twice|deadlock\w*)\b/i.test(description)) return 'error'
  if (/\b(done|finish\w*|sign(s|ed|ing)?[- ]?off)\b/i.test(description)) return 'done'
  return 'plan'
}

/**
 * Whether a session is planning or building, and whether planning is on the
 * model it should be: under opusplan Opus plans, so a session in plan mode on
 * another model is `wrong` (the model it should be on). Building on Opus is
 * not flagged: the settings can't tell a code session that should build on
 * Sonnet from a prose one that is meant to stay on Opus, the plain Opus of
 * `--model opus` never reaching `$.settings.read()`. The pane says the model
 * plainly there.
 */
export function stance(model: string | null | undefined, mode: string | null | undefined, setting: string | null | undefined): { phase: 'planning' | 'building'; wrong: 'opus' | null } {
  const phase = mode?.includes('plan') ? 'planning' : 'building'
  const kind = /opus|sonnet|haiku|fable/.exec(model ?? '')?.[0]
  return { phase, wrong: setting === 'opusplan' && phase === 'planning' && kind && kind !== 'opus' ? 'opus' : null }
}
