import { describe, expect, test } from 'claude-code/testing'

import { agoText, mentionsPush, paneRows, type Report, summary } from './push'

const GATES_OK = { stamp: { on: true, ok: true }, review: { on: true, ok: true }, trailers: { on: true, ok: true } }
const REPORT: Report = {
  pushes: [
    {
      dir: '/p/hundo',
      repo: 'hundo',
      remote: 'origin',
      fetched: 1_000_000,
      harness: true,
      refs: [
        {
          local: 'main',
          sha: 'e4f5a6b'.padEnd(40, '0'),
          remoteRef: 'main',
          remoteSha: 'a1b2c3d'.padEnd(40, '0'),
          force: false,
          commits: [
            { sha: 'e4f5a6b'.padEnd(40, '0'), subject: 'feat: the push pane' },
            { sha: 'c0ffee1'.padEnd(40, '0'), subject: 'fix: the gate' },
          ],
          count: 2,
          dropped: [],
          gates: { ...GATES_OK, review: { on: true, ok: false, why: 'e4f5a6b is reviewed, but the commits after it change a.ts' } },
        },
      ],
    },
  ],
}

describe('the push pane, read from outgoing.ts', () => {
  test('the line under the dialog: what it sends and each gate, the rest in the pane', () => {
    expect(summary(REPORT)).toBe('harness: 2 commits to origin/main · check ✓ · review ✗ · trailers ✓ · the Push pane has the rest')
    const plain: Report = { pushes: [{ repo: 'x', remote: 'origin', harness: false, refs: [{ ...REPORT.pushes[0]!.refs[0]!, gates: undefined, force: true, dropped: [{ sha: 'd'.repeat(40), subject: 'gone' }] }] }] }
    expect(summary(plain)).toBe('harness: 2 commits to origin/main · force, drops 1 · no harness gates · the Push pane has the rest')
    expect(summary({ pushes: [{ refs: [], note: '--tags sends more than a ref: not measured, pre-push checks each' }] })).toBe('harness: --tags sends more than a ref: not measured, pre-push checks each')
    expect(summary({ pushes: [REPORT.pushes[0]!, { refs: [], note: 'a delete sends no commit' }] })).toContain('trailers ✓ · +1 · the Push pane')
    // (--no-verify: no gate runs, said in place of the gates, never "pre-push will refuse this")
    const unverified: Report = { pushes: [{ ...REPORT.pushes[0]!, skipped: '--no-verify skips pre-push: no gate runs', harness: false, refs: [{ ...REPORT.pushes[0]!.refs[0]!, gates: undefined }] }] }
    expect(summary(unverified)).toBe('harness: 2 commits to origin/main · --no-verify skips pre-push: no gate runs · the Push pane has the rest')
    const behind: Report = { pushes: [{ ...REPORT.pushes[0]!, refs: [{ ...REPORT.pushes[0]!.refs[0]!, count: 0, commits: [], behind: true, gates: undefined }] }] }
    expect(summary(behind)).toBe('harness: nothing new (behind the remote) to origin/main · the Push pane has the rest')
    // (a trailer read in part is no pass and no refusal: its own mark)
    const partial: Report = { pushes: [{ ...REPORT.pushes[0]!, refs: [{ ...REPORT.pushes[0]!.refs[0]!, gates: { ...GATES_OK, trailers: { on: true, ok: false, partial: true, why: 'the first 50 of 60 read' } } }] }] }
    expect(summary(partial)).toBe('harness: 2 commits to origin/main · check ✓ · review ✓ · trailers ? · the Push pane has the rest')
  })

  test('the words that may hold a push, as ask-push reads them', () => {
    for (const yes of ['git push', 'git -C x push origin main', 'gp', 'ggpush', 'git send-pack x']) expect([yes, mentionsPush(yes)]).toEqual([yes, true])
    for (const no of ['git status', 'gh pr view', 'echo gap']) expect([no, mentionsPush(no)]).toEqual([no, false])
  })

  test('how long ago, and the rows it asks for', () => {
    expect([agoText(30_000), agoText(5 * 60_000), agoText(5 * 3_600_000), agoText(4 * 86_400_000)]).toEqual(['1m', '5m', '5h', '4d'])
    expect(paneRows(REPORT)).toBe(4 + 1 + 2 + 2 + 3)
  })
})

// Not driven here: the hold (tool.check raising the pane on an ask, tool.call closing it) and the drawing in a mounted
// pane. The kit of Claude Code 2.1.295 raises no tool.check from a test's $.tool.call (a PreToolUse ask included) and
// routes no plugin Pane's render to a test's hook; drawPush is type-checked, and both were seen in a live session
// (docs/design.md, "The push pane", the probe).
