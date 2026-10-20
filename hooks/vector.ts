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

// --- a box's border -----------------------------------------------------------
//
// The page draws a Box's border in CSS, which nothing here can move (nor dash).
// On the desktop every box's border is four images instead: a top and a
// bottom strip with the rounded corners (cut to the box's width as the bars
// are), and two side strips the row they sit in stretches to its height. At
// rest they stand still; at work they breathe while a comet laps them, top,
// right, bottom, left, on the wall clock's phase like the lines' pulse. One
// frame at rest and at work, so a box never changes size as work starts.

/** The strips' height (the corners' radius) and the sides' width, CSS pixels. */
export const EDGE_PX = 8
export const SIDE_PX = 2
// A cell's width on the desktop, about: the strips' drawing units, so their corners stay round.
const CELL_PX = 8
// The comet's length and speed, CSS pixels.
const COMET_PX = 90
const LAP_PX_PER_S = 640
// The edge breathes while the box works: brighter and fainter, this long a breath.
const BREATH_MS = 1600

export type BoxEdges = {
  /** The box's width in cells and its height in lines, about: the lap's proportions. */
  cells: number
  lines: number
  color: string
  /** Where the wall clock is, in milliseconds. */
  nowMs: number
  /** At work: the edges breathe and the comet runs. */
  isRunning: boolean
  /** The main session's boxes, dashed as in the mock-up. */
  isDashed?: boolean
}

/** The lap's length and each side's share of it, from the box's size. */
export function lap(b: BoxEdges): { ms: number; top: [number, number]; right: [number, number]; bottom: [number, number]; left: [number, number] } {
  const w = Math.max(1, b.cells) * CELL_PX
  const h = Math.max(1, b.lines) * LINE_PX + 2 * EDGE_PX
  const p = 2 * (w + h)
  const at = (n: number) => n / p
  return {
    ms: Math.round((p / LAP_PX_PER_S) * 1000),
    top: [at(0), at(w)],
    right: [at(w), at(w + h)],
    bottom: [at(w + h), at(2 * w + h)],
    left: [at(2 * w + h), at(p)],
  }
}

/** One of a box's four edges; at work, the comet crossing it at its share of the lap. */
export function edgeSvg(side: 'top' | 'right' | 'bottom' | 'left', b: BoxEdges): string {
  const l = lap(b)
  const [from, to] = l[side]
  const t0 = r(Math.min(0.997, Math.max(0.001, from)))
  const t1 = r(Math.min(0.999, Math.max(t0 + 0.001, to)))
  const c = esc(paint(b.color))
  const timing = `dur="${l.ms}ms" begin="-${Math.round(b.nowMs % l.ms)}ms" repeatCount="indefinite"`
  const seen = `<animate attributeName="opacity" values="0;1;0" keyTimes="0;${t0};${t1}" calcMode="discrete" ${timing}/>`
  const run = (attr: string, a: number, z: number) => `<animate attributeName="${attr}" values="${a};${a};${z};${z}" keyTimes="0;${t0};${t1};1" ${timing}/>`
  const breath = `<animate attributeName="stroke-opacity" values=".3;.9;.3" dur="${BREATH_MS}ms" begin="-${Math.round(b.nowMs % BREATH_MS)}ms" repeatCount="indefinite"/>`
  const edge = `stroke="${c}" stroke-opacity="${b.isRunning ? '.5' : '1'}" stroke-width="1.2" fill="none" vector-effect="non-scaling-stroke"${b.isDashed ? ' stroke-dasharray="5 4"' : ''}`
  const moving = (x: string) => (b.isRunning ? x : '')
  // The comet's tail fades behind it: the gradient runs from its tail (x1, y1) to its head (x2, y2).
  const grad = (x1: number, y1: number, x2: number, y2: number) =>
    `<defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${c}" stop-opacity="0"/><stop offset="1" stop-color="${c}"/></linearGradient></defs>`
  if (side === 'top' || side === 'bottom') {
    const w = Math.max(1, b.cells) * CELL_PX
    const e = EDGE_PX
    const k = COMET_PX
    const isTop = side === 'top'
    const y = isTop ? 1 : e - 1
    const path = isTop
      ? `M1 ${e}A${e - 1} ${e - 1} 0 0 1 ${e} 1L${w - e} 1A${e - 1} ${e - 1} 0 0 1 ${w - 1} ${e}`
      : `M1 0A${e - 1} ${e - 1} 0 0 0 ${e} ${e - 1}L${w - e} ${e - 1}A${e - 1} ${e - 1} 0 0 0 ${w - 1} 0`
    // Left to right along the top, right to left along the bottom: a bright core in a faint halo.
    const [a, z] = isTop ? [-k, w] : [w, -k]
    const comet = (yy: number, hh: number, o: number) =>
      `<g opacity="0">${seen}<rect x="${a}" y="${yy}" width="${k}" height="${hh}" rx="${hh / 2}" fill="url(#g)" opacity="${o}">${run('x', a, z)}</rect></g>`
    const glow = isTop ? comet(0, 6, 0.4) + comet(0, 3, 1) : comet(e - 6, 6, 0.4) + comet(e - 3, 3, 1)
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 20}" height="${e}" viewBox="0 0 ${w} ${e}" preserveAspectRatio="none">` +
      (isTop ? grad(0, 0, 1, 0) : grad(1, 0, 0, 0)) +
      `<path d="${path}" ${edge}>${moving(breath)}</path>${moving(glow)}</svg>`
    )
  }
  // A side: drawn on a 100-high strip the row stretches to the box's height.
  // The comet no longer than half the side, in the strip's hundred units.
  const h = Math.max(1, b.lines) * LINE_PX
  const k = r((Math.min(COMET_PX, h * 0.45) / h) * 100)
  const isRight = side === 'right'
  const [a, z] = isRight ? [-k, 100] : [100, -k]
  const comet = `<g opacity="0">${seen}<rect x="0" y="${a}" width="${SIDE_PX}" height="${k}" fill="url(#g)">${run('y', a, z)}</rect></g>`
  return (
    // Its own height a pixel: the row it sits in gives it its height, never the other way.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE_PX}" height="1" viewBox="0 0 ${SIDE_PX} 100" preserveAspectRatio="none">` +
    (isRight ? grad(0, 0, 0, 1) : grad(0, 1, 0, 0)) +
    `<line x1="${SIDE_PX / 2}" y1="0" x2="${SIDE_PX / 2}" y2="100" ${edge}>${moving(breath)}</line>${moving(comet)}</svg>`
  )
}
