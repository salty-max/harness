#!/bin/zsh
# The pane as a terminal paints it, in motion: a claude session with this mod
# (--plugin-dir) in a pty in the family folder, a turn running (one prompt, no
# tool), its screen rebuilt frame by frame by pyte (in a venv of its own), the
# pane's columns at each moment screenshot by headless Chrome. Output:
# .cache/paint/terminal.png (and .html, and .txt: every frame as text, to
# measure columns and steps). The session answers one prompt: a few cents.
#
#   zsh bin/terminal-paint.sh                 20 s to 21.3 s, a frame each 160 ms
#   zsh bin/terminal-paint.sh 22 22.8 0.08    every frame (80 ms) of that stretch
set -e
here=${0:A:h:h}
family=${here:h:h}
out=$here/.cache/paint
venv=$here/.cache/tty-venv
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x $chrome ]] || { print "no Chrome at $chrome: nothing to screenshot with"; exit 1 }
mkdir -p $out
[[ -x $venv/bin/python ]] || { python3 -m venv $venv && $venv/bin/python -I -m pip install -q pyte }
# The session lays a tsconfig.json beside the mod: taken away only if it wasn't there.
had_tsconfig=0
[[ -e $here/tsconfig.json ]] && had_tsconfig=1
trap '(( had_tsconfig )) || rm -f $here/tsconfig.json' EXIT
python3 -I $here/bin/terminal-paint.py record $out/terminal.jsonl $here $family
$venv/bin/python -I $here/bin/terminal-paint.py render $out/terminal.jsonl $out/terminal ${1:-20} ${2:-21.3} ${3:-0.16}
$chrome --headless=new --disable-gpu --hide-scrollbars --window-size=1700,2600 --screenshot=$out/terminal.png file://$out/terminal.html 2>/dev/null
print "painted: $out/terminal.png (every frame as text: $out/terminal.txt)"
