// Paints dumped pane trees as the desktop app's renderer does (its CSS
// mapping read from the cached page bundle c2719cf1b, 18 Oct 2026): Box a
// flex div with widths in ch and vertical units of half a line, Text a span
// (truncate-end an ellipsed inline-block, else pre-wrap), Client a wrapper
// around a holder whose row unit is a whole line, grid-like text lines in a
// column turned monospace. Design tokens are guesses (pad, radius, fonts).
import { readFileSync, writeFileSync } from 'node:fs'

const dump = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const out = process.argv[3]
const ROW = 'var(--engine-row-unit,.5lh)'
const NAMED: Record<string, string> = { inactive: '#a3a19b', text: '#ecebe8', gray: '#8b8d98', green: '#46a758', red: '#e5484d', yellow: '#f5d90a' }
const color = (c: unknown) => (typeof c !== 'string' ? undefined : (NAMED[c] ?? (/^#|^rgb/.test(c) ? c : undefined)))
const q = (k: string, v: unknown) => (v === undefined || v === null ? undefined : `${k}:${v}`)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const across = (v: unknown) => (num(v) === undefined ? undefined : `${v}ch`)
const down = (v: unknown) => (num(v) === undefined ? undefined : `calc(${v} * ${ROW})`)
const size = (v: unknown, unit: string) => (typeof v === 'number' ? `${v}${unit}` : typeof v === 'string' && /^\d+(\.\d+)?%$/.test(v) ? v : undefined)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function spacing(p: any, what: 'margin' | 'padding'): (string | undefined)[] {
  const d = (k: string) => down(p[`${what}${k}`])
  const a = (k: string) => across(p[`${what}${k}`])
  const all = down(p[what])
  return [
    all === undefined ? undefined : `${what}:${all} ${across(p[what])}`,
    q(`${what}-top`, d('Top') ?? d('Y')),
    q(`${what}-bottom`, d('Bottom') ?? d('Y')),
    q(`${what}-left`, a('Left') ?? a('X')),
    q(`${what}-right`, a('Right') ?? a('X')),
  ]
}

function boxStyle(p: any): string {
  const bordered = typeof p.borderStyle === 'string' && p.borderStyle !== ''
  const gapDown = down(p.gap)
  return [
    'display:flex',
    'box-sizing:border-box',
    `flex-direction:${p.flexDirection ?? 'row'}`,
    q('flex-grow', num(p.flexGrow)),
    q('flex-shrink', num(p.flexShrink)),
    q('flex-wrap', p.flexWrap),
    q('align-items', p.alignItems),
    q('align-self', p.alignSelf),
    q('justify-content', p.justifyContent),
    gapDown === undefined ? undefined : `gap:${gapDown} ${across(p.gap)}`,
    q('column-gap', across(p.columnGap)),
    q('row-gap', down(p.rowGap)),
    q('width', size(p.width, 'ch')),
    q('height', size(p.height, 'lh')),
    q('min-width', size(p.minWidth, 'ch')),
    ...spacing(p, 'margin'),
    bordered ? 'padding:8px 12px' : undefined,
    ...spacing(p, 'padding'),
    ...(bordered ? ['border:1px solid #3d3d3a', p.borderStyle === 'round' ? 'border-radius:12px' : 'border-radius:8px', q('border-color', color(p.borderColor))] : []),
    q('overflow', p.overflow),
  ]
    .filter(Boolean)
    .join(';')
}

function textStyle(p: any, mono: boolean): string {
  const c = color(p.color)
  const wraps = p.wrap === undefined || p.wrap === 'wrap'
  return [
    p.inverse ? `color:#1f1f1e;background:${c ?? '#ecebe8'}` : p.dimColor ? (c ? `color:color-mix(in srgb,${c} 60%,transparent)` : 'color:#a3a19b') : q('color', c),
    p.bold ? 'font-weight:600' : undefined,
    mono ? 'font-family:ui-monospace,Menlo,monospace;font-variant-ligatures:none' : undefined,
    ...(wraps ? ['white-space:pre-wrap', 'overflow-wrap:anywhere'] : ['display:inline-block', 'max-width:100%', 'white-space:pre', 'overflow:hidden', 'text-overflow:ellipsis', 'min-width:0']),
  ]
    .filter(Boolean)
    .join(';')
}

// The renderer's grid-line test: box drawing or blocks, arrows, or two gaps of two spaces.
const isGrid = (s: string) => /[─-▟]/u.test(s) || /[-=_~]{3,}|[-=]{2,}>|<[-=]{2,}/u.test(s) || (() => { const g = [...s.matchAll(/\S( {2,})(?=\S)/gu)].map(m => m[1].length); return g.length >= 2 || g.some(n => n >= 3) })()
const plain = (n: any) => (Array.isArray(n.children) && n.children.every((c: any) => typeof c === 'string') ? n.children.join('') : undefined)

function gridSet(n: any): Set<any> {
  const set = new Set<any>()
  if (n.type !== 'Box' || !String(n.props?.flexDirection ?? '').startsWith('column')) return set
  let run: any[] = []
  let hit = false
  const flush = () => { if (hit) run.forEach(r => set.add(r)); run = []; hit = false }
  for (const c of n.children ?? []) {
    if (typeof c === 'string' && c.trim() === '') continue
    const text = typeof c !== 'string' && c.type === 'Text' && c.props?.wrap !== undefined && c.props?.wrap !== 'wrap' ? plain(c) : undefined
    if (text === undefined) flush()
    else { run.push(c); hit ||= isGrid(text) }
  }
  flush()
  return set
}

function html(n: any, clients: Record<string, any>, grid: Set<any> = new Set()): string {
  if (n === null || n === undefined || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return esc(String(n))
  if (Array.isArray(n)) return n.map(c => html(c, clients, grid)).join('')
  const p = n.props ?? {}
  if (n.type === 'Client') {
    const style = ['display:flex', 'flex-direction:column', 'flex-shrink:0', 'overflow:hidden', 'max-width:100%', q('width', size(p.width, 'ch')), q('height', size(p.height, 'lh')), q('flex-grow', num(p.flexGrow))].filter(Boolean).join(';')
    const holder = 'display:flex;flex-direction:column;min-width:0;min-height:1lh;contain:layout paint;--engine-row-unit:1lh'
    return `<div style="${style}" data-client="${esc(p.key)}"><div style="${holder}">${html(clients[p.key], clients)}</div></div>`
  }
  if (n.type === 'Button') return `<button>${esc(p.label ?? '')}</button>`
  if (n.type === 'Svg') {
    const style = ['display:block', 'max-width:100%', 'border:0', q('width', num(p.width) === undefined ? undefined : `${p.width}px`), q('height', num(p.height) === undefined ? undefined : `${p.height}px`)].filter(Boolean).join(';')
    return `<img alt="${esc(p.alt ?? '')}" style="${style}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.source)}">`
  }
  if (n.type === 'Box') {
    const g = gridSet(n)
    const row = (p.flexDirection === undefined || String(p.flexDirection).startsWith('row')) && p.alignItems === undefined
    return `<div style="${boxStyle(p)}"${row ? ' data-engine-row' : ''}${typeof p.key === 'string' ? ` data-key="${esc(p.key)}"` : ''}>${(n.children ?? []).map((c: any) => html(c, clients, g)).join('')}</div>`
  }
  if (n.type === 'Text') {
    const text = plain(n)
    const mono = grid.has(n) || (text !== undefined && text.includes('\n') && text.split('\n').some(isGrid))
    return `<span style="${textStyle(p, mono)}">${(n.children ?? []).map((c: any) => html(c, clients)).join('')}</span>`
  }
  return (n.children ?? []).map((c: any) => html(c, clients, grid)).join('')
}

const only = process.argv[4]
const panes = Object.keys(dump)
  .filter(W => only === undefined || W === only)
  .sort((a, b) => Number(b) - Number(a))
  .map(W => `<h2>${W} columns</h2><div class="pane" style="width:calc(${W}ch + 24px)">${html(dump[W].tree, dump[W].clients)}</div>`)
writeFileSync(
  out,
  `<!doctype html><meta charset="utf-8"><style>
  body{background:#1f1f1e;color:#ecebe8;font:14px/19px -apple-system,system-ui,sans-serif;margin:16px}
  h2{font:12px ui-monospace,monospace;color:#888;margin:24px 0 6px}
  .pane{padding:12px;border:1px dashed #444}
  [data-engine-row]>span,[data-engine-row]>b,[data-engine-row]>button{align-self:center}
  button{background:#2f2f2d;color:#ecebe8;border:0;border-radius:8px;padding:4px 12px;font:inherit}
  </style>${panes.join('\n')}`,
)
console.log('wrote', out)
