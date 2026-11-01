#!/bin/sh
# The pane's plugin test and manifest validation, which need the claude CLI:
# skipped with one line where it isn't installed (CI's runner), a hard failure
# where it is and either check fails.
cd "$(dirname "$0")/.." || exit 1
if ! command -v claude >/dev/null 2>&1; then
  echo "pane: claude CLI not found, plugin test and validate skipped"
  exit 0
fi
claude plugin test . && claude plugin validate .
