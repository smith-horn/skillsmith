#!/bin/bash
# `ruflo hooks session-end` (still a thin wrapper around @claude-flow/cli) completes
# its real work (summary + state persist) but then leaves the node process running
# forever instead of exiting, which blocks Claude Code's Stop-hook wait indefinitely.
# This wrapper backgrounds it and reaps it after a bounded timeout so it can't hang
# the session or accumulate as a permanent orphaned process.
set -uo pipefail

REAP_TIMEOUT_SECS="${SKILLSMITH_STOP_HOOK_REAP_SECS:-10}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_DIR="$HOME/.skillsmith/logs"
mkdir -p "$LOG_DIR" 2>/dev/null
LOG_FILE="$LOG_DIR/ruflo-session-end-$(date +%s).log"

node "$PROJECT_DIR/node_modules/ruflo/bin/ruflo.js" hooks session-end \
  --generate-summary true --persist-state true --export-metrics true \
  > "$LOG_FILE" 2>&1 &
CHILD_PID=$!

( sleep "$REAP_TIMEOUT_SECS"; kill -9 "$CHILD_PID" 2>/dev/null ) &
WATCHDOG_PID=$!

wait "$CHILD_PID" 2>/dev/null
kill "$WATCHDOG_PID" 2>/dev/null

exit 0
