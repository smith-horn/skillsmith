#!/bin/bash
# `ruflo hooks session-end` (still a thin wrapper around @claude-flow/cli) completes
# its real work (summary + state persist) but then leaves the node process running
# forever instead of exiting, which blocks Claude Code's Stop-hook wait indefinitely.
# This wrapper backgrounds it and reaps it after a bounded timeout so it can't hang
# the session or accumulate as a permanent orphaned process.
set -uo pipefail

REAP_TIMEOUT_SECS="${SKILLSMITH_STOP_HOOK_REAP_SECS:-10}"
LOG_RETENTION_DAYS="${SKILLSMITH_STOP_HOOK_LOG_RETENTION_DAYS:-7}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_DIR="$HOME/.skillsmith/logs"
mkdir -p "$LOG_DIR" 2>/dev/null
LOG_FILE="$LOG_DIR/ruflo-session-end-$(date +%s).log"

# One log file per Stop hook invocation, unbounded otherwise. Prune stale
# ones before writing a new one so this doesn't accumulate forever.
find "$LOG_DIR" -maxdepth 1 -name 'ruflo-session-end-*.log' -mtime "+${LOG_RETENTION_DAYS}" -delete 2>/dev/null

node "$PROJECT_DIR/node_modules/ruflo/bin/ruflo.js" hooks session-end \
  --generate-summary true --persist-state true --export-metrics true \
  > "$LOG_FILE" 2>&1 &
CHILD_PID=$!

# SKILLSMITH_STOP_HOOK follow-up (retro on SMI-5712/PR #1915): the watchdog
# must be the `sleep` process ITSELF, not a wrapping `( sleep N; kill ... ) &`
# subshell. A wrapped subshell forks `sleep` as its OWN child, so killing the
# subshell's PID (below) does not kill that grandchild — the orphaned sleep
# keeps running and keeps its inherited stdout/stderr fd open. A caller that
# captures this script's output via a pipe (Node's `child_process.spawnSync`,
# which is how Claude Code itself invokes hook commands, and how this file's
# own test harness invokes it) doesn't see EOF until every fd holder exits —
# so the ORIGINAL wrapped-subshell version silently waited the FULL
# REAP_TIMEOUT_SECS on every single happy-path exit, not just on an actual
# hang. Tracking the bare `sleep` PID directly means killing it terminates
# the real blocking process immediately, closing its fd right away.
sleep "$REAP_TIMEOUT_SECS" &
WATCHDOG_PID=$!

while kill -0 "$CHILD_PID" 2>/dev/null && kill -0 "$WATCHDOG_PID" 2>/dev/null; do
  sleep 0.2
done

if kill -0 "$CHILD_PID" 2>/dev/null; then
  # Watchdog fired first: the real command is still running past the bound.
  kill -9 "$CHILD_PID" 2>/dev/null
fi
kill "$WATCHDOG_PID" 2>/dev/null

wait "$CHILD_PID" 2>/dev/null
wait "$WATCHDOG_PID" 2>/dev/null

exit 0
