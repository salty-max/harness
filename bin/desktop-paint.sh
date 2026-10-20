#!/bin/zsh
# The pane as the desktop app paints it, without the app: a throwaway test
# dumps the drawn trees (the desktop surface, mid-turn, a helper running, this
# machine's last snapshot) at 110, 80 and 48 columns; bin/desktop-paint.ts
# turns them into HTML by the desktop renderer's own rules; headless Chrome
# screenshots each. Output: .cache/paint/desktop-<columns>.png (and .html).
#
#   zsh bin/desktop-paint.sh
set -e
here=${0:A:h:h}
out=$here/.cache/paint
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x $chrome ]] || { print "no Chrome at $chrome: nothing to screenshot with"; exit 1 }
mkdir -p $out
snap=${HARNESS_SNAPSHOT:-$HOME/.cache/harness-view/snapshot.json}
# The dump runs as a test of the mod's own (zz-*.test.tsx is git-ignored); a
# test run lays a tsconfig.json beside the mod, taken away only if it wasn't there.
test_file=$here/hooks/zz-desktop-paint.test.tsx
had_tsconfig=0
[[ -e $here/tsconfig.json ]] && had_tsconfig=1
cleanup() {
  rm -f $test_file
  (( had_tsconfig )) || rm -f $here/tsconfig.json
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP
{
  print -r -- "import { expect, mock, test } from 'claude-code/testing'"
  print -r -- "const SNAP = $(cat $snap)"
  cat <<'TS'
test('desktop paint dump', async ($, on) => {
  mock.env(on, { HOME: '/Users/someone' })
  const clock = mock.clock(on, { now: SNAP.at + 3000 })
  on('session.root', () => ({ value: '/Users/someone/code/wow-addons' }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(SNAP), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'harness', title: 'Harness', isShown: true, isFocused: false, isPlaced: true }] }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.list', () => ({ value: [{ id: 'a1', type: 'data-scout', description: 'A question about the data', status: 'running' }] }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/Users/someone/code/wow-addons', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(1100)
  const out: Record<string, unknown> = {}
  for (const W of [110, 80, 48]) {
    const ui = await $.ui.mount({ plugin: 'harness-view', surface: 'desktop', component: 'Pane', requestId: 'harness', props: { title: 'Harness', isFocused: false, bodyColumns: W, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} } })
    await ui.press({ key: 'refresh' })
    await ui.advance(720)
    const tree = await ui.drawn()
    const clients: Record<string, unknown> = {}
    const walk = async (n: any) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { for (const c of n) await walk(c); return }
      if (n.type === 'Client') clients[n.props.key] = await ui.drawn({ in: n.props.key })
      await walk(n.children)
    }
    await walk(tree)
    out[W] = { tree, clients }
    await ui.unmount()
  }
  console.log('PAINT-JSON-BEGIN' + JSON.stringify(out) + 'PAINT-JSON-END')
  expect(1).toBe(1)
})
TS
} > $test_file
(cd $here && claude plugin test . > $out/dump.log 2>&1) || true
perl -0ne 'print $1 if /PAINT-JSON-BEGIN(.*?)PAINT-JSON-END/s' $out/dump.log > $out/dump.json
[[ -s $out/dump.json ]] || { print "no dump: see $out/dump.log"; exit 1 }
for w in 110 80 48; do
  bun $here/bin/desktop-paint.ts $out/dump.json $out/desktop-$w.html $w > /dev/null
  $chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=$((w * 9 + 120)),2600 --virtual-time-budget=1200 --screenshot=$out/desktop-$w.png file://$out/desktop-$w.html 2> /dev/null
done
print "painted: $out/desktop-{110,80,48}.png"
