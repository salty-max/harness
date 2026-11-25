// The push pane's pure parts: what outgoing.ts reports, the line under the dialog and the pane's drawing. The hooks
// that hold it (tool.check, tool.call, ui.render) are register.tsx's: the host reads `on(...)` and every helper that
// takes `$` from the module's own source, so they sit there, spelled out, and nothing here touches `$`.
//
// When Claude Code is about to ask the user about a `git push`, the pane shows what the push sends and how the pre-push
// hook will judge it, beside the prompt. It only shows: the user answers in Claude Code's own prompt (its "No" takes a
// reason back to Claude), and the pre-push hook still decides. A push the session's rules let through (ask-push's allow
// in a project that skips the ask) is never held, so it gets no pane.
import type { EngineInterface, RenderChildren } from 'claude-code'

export const PUSH_PANE = 'harness-push'

// What outgoing.ts prints (the harness's outgoing.ts, vendored into each project): read, never trusted for more than drawing.
export type Gate = { on: boolean; ok: boolean; why?: string; partial?: true }
export type Commit = { sha: string; subject: string }
export type RefReport = { local: string; sha: string; remoteRef: string; remoteSha?: string; force: boolean; behind?: true; commits: Commit[]; count: number; dropped: Commit[]; gates?: { stamp: Gate; review: Gate; trailers: Gate } }
export type PushReport = { dir?: string; repo?: string; remote?: string; fetched?: number; refs: RefReport[]; note?: string; harness?: boolean; skipped?: string }
export type Report = { pushes: PushReport[] }

/** The pane's colours: the harness pane's palette. */
export type PushPalette = { ok: string; wait: string; fail: string; gate: string }
/** The push held for the user's answer: its call, its command line, what outgoing.ts reported. */
export type Held = { id: string; command: string; report: Report }

/** Whether a command line may hold a push (the same words ask-push looks for): anything else is none of the pane's business. */
export const mentionsPush = (s: string): boolean => s.includes('push') || s.includes('send-pack') || /(^|[^\w-])(gp[a-z!]*|ggp[a-z]*|ggf[a-z]*|grename)(?![\w-])/.test(s)

const short = (sha: string | undefined) => (sha ?? '').slice(0, 7)
const gateWord = (g: Gate, name: string) => (!g.on ? `${name} off` : g.ok ? `${name} ✓` : g.partial ? `${name} ?` : `${name} ✗`)

/** The one line under the dialog: what the push sends and the gates' marks, the first ref's, `+N` for the others. */
export function summary(r: Report): string {
  const refs = r.pushes.flatMap(p => p.refs.map(f => ({ p, f })))
  const notes = r.pushes.filter(p => p.note)
  if (!refs.length) return notes.length ? `harness: ${notes[0]!.note}` : 'harness: this push sends nothing new'
  const { p, f } = refs[0]!
  const what = f.count ? `${f.count} commit${f.count > 1 ? 's' : ''}` : f.behind ? 'nothing new (behind the remote)' : 'nothing new'
  const force = f.force ? (f.dropped.length ? ` · force, drops ${f.dropped.length}` : ' · force') : ''
  const gates = p.skipped ? ` · ${p.skipped}` : f.gates ? ` · ${[gateWord(f.gates.stamp, 'check'), gateWord(f.gates.review, 'review'), gateWord(f.gates.trailers, 'trailers')].join(' · ')}` : f.count && !p.harness ? ' · no harness gates' : ''
  const more = refs.length + notes.length > 1 ? ` · +${refs.length + notes.length - 1}` : ''
  return `harness: ${what} to ${p.remote}/${f.remoteRef}${force}${gates}${more} · the Push pane has the rest`
}

/** How long ago, short. */
export function agoText(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 172_800_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

/** The rows the pane wants: a header, each ref's lines, its commits (eight at most), the footer. */
export function paneRows(r: Report): number {
  let n = 4
  for (const p of r.pushes) {
    n += p.note ? 2 : 1
    for (const f of p.refs) n += 2 + Math.min(8, f.commits.length) + (f.dropped.length ? 1 + Math.min(4, f.dropped.length) : 0) + (f.gates ? 3 : 1)
  }
  return Math.min(30, n)
}

/**
 * The push pane's drawing: per push its repository and remote, per ref its range, commits, what a force drops and the
 * three gates. Built with the table's element calls, never JSX: JSX compiles to the global `h`, which the host gives
 * the plugin's entry module alone (an imported module's JSX threw `h is not a function` in a live session).
 */
export function drawPush(t: ReturnType<EngineInterface['ui']['resolve']>, h: Held, palette: PushPalette, now: number) {
  type BoxProps = Parameters<typeof t.Box>[0]
  type TextProps = Parameters<typeof t.Text>[0]
  // (a Text's props type has no key, which JSX passes through h all the same: a list's rows keep theirs)
  const T = (key: string, text: string, props: Omit<TextProps, 'children'> = {}) => t.Text({ key, wrap: 'truncate-end', ...props, children: text } as TextProps)
  const B = (key: string, props: Omit<BoxProps, 'children'>, children: RenderChildren[]) => t.Box({ key, ...props, children })
  const colour = (g: Gate) => (!g.on ? 'inactive' : g.ok ? palette.ok : g.partial ? palette.wait : palette.fail)
  const rows: RenderChildren[] = []
  h.report.pushes.forEach((p, i) => {
    const who = [p.repo, p.remote].filter(Boolean).join(' → ') || 'git push'
    const fetched = p.fetched ? `remote as fetched ${agoText(now - p.fetched)} ago` : p.remote ? 'never fetched' : ''
    rows.push(B(`p${i}`, { flexDirection: 'row', gap: 1 }, [T('who', who, { bold: true }), fetched ? T('fetched', fetched, { dimColor: true }) : null]))
    if (p.note) rows.push(T(`n${i}`, `  ${p.note}`, { color: palette.wait }))
    if (p.skipped) rows.push(T(`s${i}`, `  ${p.skipped}`, { color: palette.fail, bold: true }))
    p.refs.forEach((f, j) => {
      const k = `${i}.${j}`
      const range = f.behind ? `${short(f.sha)} is behind the remote's ${short(f.remoteSha)}` : f.remoteSha ? `${short(f.remoteSha)}..${short(f.sha)}` : `new, ${short(f.sha)}`
      rows.push(T(`r${k}`, `  ${f.local} → ${p.remote}/${f.remoteRef}  ${f.count ? `${f.count} commit${f.count > 1 ? 's' : ''}` : 'nothing new'}  ${range}${f.force ? '  force' : ''}`))
      f.commits.slice(0, 8).forEach((c, n) => rows.push(T(`c${k}.${n}`, `    ${short(c.sha)} ${c.subject}`, { dimColor: true })))
      if (f.count > 8) rows.push(T(`m${k}`, `    + ${f.count - Math.min(8, f.commits.length)} more`, { dimColor: true }))
      if (f.dropped.length) {
        rows.push(T(`d${k}`, `  force drops ${f.dropped.length} the remote has:`, { color: palette.fail }))
        f.dropped.slice(0, 4).forEach((c, n) => rows.push(T(`dc${k}.${n}`, `    ${short(c.sha)} ${c.subject}`, { color: palette.fail })))
      }
      if (f.gates)
        for (const [name, g] of [['check', f.gates.stamp], ['review', f.gates.review], ['trailers', f.gates.trailers]] as const)
          rows.push(B(`g${k}${name}`, { flexDirection: 'row', gap: 1 }, [T('mark', `  ${gateWord(g, name)}`, { color: colour(g) }), g.why ? T('why', g.why, { dimColor: true }) : null]))
      else if (f.count && !p.harness) rows.push(T(`x${k}`, '  no harness gates in this repository', { dimColor: true }))
    })
  })
  const skipped = h.report.pushes.some(p => p.skipped)
  const blocked = !skipped && h.report.pushes.some(p => p.refs.some(f => f.gates && Object.values(f.gates).some(g => g.on && !g.ok && !g.partial)))
  const title = skipped ? 'PUSH · no gate will run on this' : blocked ? 'PUSH · pre-push will refuse this' : 'PUSH · what this sends'
  return B('push', { flexDirection: 'column', borderStyle: 'round', borderColor: skipped || blocked ? palette.fail : palette.gate, paddingX: 1 }, [
    T('title', title, { bold: true, color: skipped || blocked ? palette.fail : palette.gate }),
    T('command', h.command.replace(/\s+/g, ' '), { dimColor: true }),
    B('rows', { flexDirection: 'column', marginTop: 1 }, rows),
    T('footer', "Answer in Claude Code's prompt. The pre-push hook still decides.", { dimColor: true }),
  ])
}
