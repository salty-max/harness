#!/bin/zsh
# What the pane costs, counted: mounts it on the desktop surface with this
# machine's last snapshot (idle, or busy: a q run, every session working, three
# helpers) and advances a mock clock 30 s in 80 ms steps, counting the pane's
# redraws, each Client's redraws, the SMIL animations the page would run, and
# the calls made (process.run, fs.stat). One PANE-CPU json line per run.
#
#   zsh bin/pane-cpu.sh [idle|busy] [shown|hidden]
#   CALM=1 zsh bin/pane-cpu.sh busy     (the calm setting on)
#   SURFACE=terminal CALM=1 zsh bin/pane-cpu.sh busy   (the terminal's pane)
set -e
here=${0:A:h:h}
mode=${1:-busy}
shown=true
[[ ${2:-shown} == hidden ]] && shown=false
snap=${HARNESS_SNAPSHOT:-$HOME/.cache/harness-view/snapshot.json}
test_file=$here/hooks/zz-pane-cpu.test.tsx
had_tsconfig=0
[[ -e $here/tsconfig.json ]] && had_tsconfig=1
cleanup() {
  rm -f $test_file
  (( had_tsconfig )) || rm -f $here/tsconfig.json
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP
{
  print -r -- "const SNAP = $(cat $snap)"
  sed -e "s/@MODE@/$mode/" -e "s/@SHOWN@/$shown/" -e "s/@SURFACE@/${SURFACE:-desktop}/" -e "s/@CALMENV@/$([[ ${CALM:-0} == 1 ]] && print on || print off)/" $here/bin/pane-cpu.template.tsx
} > $test_file
(cd $here && claude plugin test . 2>&1) | grep -a -A8 "PANE-CPU\|(fail)\|error:" || true
