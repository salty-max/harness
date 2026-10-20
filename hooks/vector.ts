// The desktop's bars and the diagram's lines as SVG (the page draws an Svg
// as an image it sizes to its cell): block characters there are wider than
// a cell in the page's font, so a bar overflows and a line drifts off the box
// it should meet. Each image is wider than any cell, cut to its cell's width
// by the page (`max-width:100%`) and stretched to it (`preserveAspectRatio`
// none), so a column of the drawing is a column of the cells.
//
// Motion is SMIL, which the page's images run: a bar slides from its last
// value, a pulse runs along a line. The page draws the pane anew at each
// redraw, so a pulse starts at the wall clock's phase of its cycle (a
// negative `begin`): the images drawn again carry on where they were.

/** A line's height on the desktop, in CSS pixels (a line of its text). */
export const LINE_PX = 19
/** A bar's height, in CSS pixels. */
export const BAR_PX = 8

const UNIT = 10
const H = 20
// The image's own width per cell: far wider than any cell, so the page always cuts it to the cell.
const WIDE = 100

/** Colours an image can hold: the page's named ones are its CSS variables, out of an image's reach. */
const NAMED: Record<string, string> = { inactive: '#7d7c78', text: '#d9d7d2' }
export const paint = (c: string) => NAMED[c] ?? c

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const r = (n: number) => Math.round(n * 1000) / 1000

/**
 * A bar `share` (0 to 1) full, sliding from `from` in half a second when
 * the two differ. Its rest is its colour, faint.
 */
export function barSvg(share: number, from: number, color: string): string {
  const to = r(Math.min(1, Math.max(0, share)) * 1000)
  const was = r(Math.min(1, Math.max(0, from)) * 1000)
  const c = esc(paint(color))
  const slide = was === to ? '' : `<animate attributeName="width" from="${was}" to="${to}" dur="500ms" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="10" viewBox="0 0 1000 10" preserveAspectRatio="none">` +
    `<rect width="1000" height="10" fill="${c}" fill-opacity=".18"/>` +
    `<rect width="${to}" height="10" fill="${c}">${slide}</rect>` +
    `</svg>`
  )
}

// A line's cell by the strokes its character draws: up, down, left, right.
const STROKES: Record<string, string> = {
  '│': 'ud', '─': 'lr', '┌': 'dr', '┐': 'dl', '└': 'ur', '┘': 'ul',
  '┬': 'dlr', '┴': 'ulr', '├': 'udr', '┤': 'udl', '┼': 'udlr', '●': 'ud', '▼': 'u', '┄': 'lr', '◂': '',
}

export type LineSvg = {
  /** The line as the terminal draws it (marks, a fan-out, a merge), a character a cell. */
  text: string
  /** How a pulse runs along it: down its marks, out from the stem at `at`, in to it. */
  how: 'down' | 'out' | 'in'
  at: number
  color: string
  base: string
  on: boolean
  /** The pulse's time on this line, in milliseconds of its cycle, and the cycle's length. */
  from: number
  to: number
  cycleMs: number
  /** Where the wall clock is in the cycle, in milliseconds. */
  phaseMs: number
}

/** One line of the diagram, its pulse running while `on`. */
export function lineSvg(l: LineSvg): string {
  const w = Math.max(1, l.text.length)
  const cx = (x: number) => x * UNIT + UNIT / 2
  const cy = H / 2
  const base = esc(paint(l.base))
  const parts: string[] = []
  const cells: number[] = []
  const stroke = (x1: number, y1: number, x2: number, y2: number, dash = false) =>
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${base}" stroke-width="1.5" vector-effect="non-scaling-stroke"${dash ? ' stroke-dasharray="3 3"' : ''}/>`)
  for (let x = 0; x < l.text.length; x++) {
    const ch = l.text[x] ?? ' '
    if (ch === ' ') continue
    cells.push(x)
    const s = STROKES[ch] ?? ''
    const left = x * UNIT
    if (s.includes('u')) stroke(cx(x), 0, cx(x), ch === '▼' ? H - 7 : cy)
    if (s.includes('d')) stroke(cx(x), cy, cx(x), H)
    if (s.includes('l')) stroke(left, cy, cx(x), cy, ch === '┄')
    if (s.includes('r')) stroke(cx(x), cy, left + UNIT, cy, ch === '┄')
    if (ch === '●') parts.push(`<ellipse cx="${cx(x)}" cy="${cy}" rx="3.5" ry="3.5" fill="${base}"/>`)
    if (ch === '▼') parts.push(`<path d="M${cx(x) - 4} ${H - 7}L${cx(x) + 4} ${H - 7}L${cx(x)} ${H}Z" fill="${base}"/>`)
    if (ch === '◂') parts.push(`<path d="M${left + 1} ${cy}L${left + UNIT} ${cy - 4}L${left + UNIT} ${cy + 4}Z" fill="${base}"/>`)
  }
  if (l.on && cells.length > 0 && l.cycleMs > 0) {
    const t0 = Math.min(0.998, Math.max(0.001, l.from / l.cycleMs))
    const t1 = Math.min(0.999, Math.max(t0 + 0.001, l.to / l.cycleMs))
    const timing = `dur="${Math.round(l.cycleMs)}ms" begin="-${Math.round(l.phaseMs % l.cycleMs)}ms" repeatCount="indefinite"`
    const seen = `<animate attributeName="opacity" values="0;1;0" keyTimes="0;${r(t0)};${r(t1)}" calcMode="discrete" ${timing}/>`
    const run = (attr: string, a: number, b: number) => `<animate attributeName="${attr}" values="${a};${a};${b};${b}" keyTimes="0;${r(t0)};${r(t1)};1" ${timing}/>`
    const dot = (moves: string, x: number, y: number) =>
      `<ellipse cx="${x}" cy="${y}" rx="3" ry="3" fill="${esc(paint(l.color))}" opacity="0">${seen}${moves}</ellipse>`
    if (l.how === 'down') {
      for (const x of cells) parts.push(dot(run('cy', 0, H), cx(x), 0))
    } else {
      const lo = Math.min(...cells)
      const hi = Math.max(...cells)
      const stem = cx(l.at)
      for (const end of [lo, hi].filter((x, i, all) => all.indexOf(x) === i && x !== l.at)) {
        parts.push(l.how === 'out' ? dot(run('cx', stem, cx(end)), stem, cy) : dot(run('cx', cx(end), stem), cx(end), cy))
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w * WIDE}" height="${H}" viewBox="0 0 ${w * UNIT} ${H}" preserveAspectRatio="none">` +
    parts.join('') +
    `</svg>`
  )
}
