#!/usr/bin/env bash
# SMI-4451 Wave 1 Step 7 — SessionStart priming hook.
#
# Spec: docs/internal/implementation/smi-4450-sparc-research.md §P1 +
#       smi-4450-step7-session-start-hook.md §S2.
#
# Reads JSON event on stdin (Claude Code SessionStart format):
#   { "session_id": "uuid", "source": "startup"|"resume"|"compact",
#     "cwd": "/abs/path", "transcript_path": "..." }
# Writes JSON to stdout: { "hookSpecificOutput": { "additionalContext": "..." } }
#
# Always exits 0 (best-effort). Gates 1/2/3 fall through to empty context.
# Gate 4 (query) delegates to scripts/session-priming-query.ts via tsx with a
# capability-probed timeout fallback (macOS hosts often lack `timeout` AND
# `gtimeout`, plan-review #5).
#
# JSON parsing uses python3 (already in Dockerfile line 39 + stock macOS) to
# avoid a `jq` dep — neither the Skillsmith Docker base image nor stock macOS
# ships jq by default.

set -euo pipefail

INPUT=$(cat)

json_get() {
  printf '%s' "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('$1', '$2'))
except Exception:
    print('$2')
" 2>/dev/null || printf '%s' "$2"
}

emit_json() {
  python3 -c "
import json, sys
print(json.dumps({'hookSpecificOutput': {'additionalContext': sys.argv[1] if len(sys.argv) > 1 else ''}}))
" "$1"
}

emit_empty() {
  emit_json ""
  exit 0
}

SOURCE=$(json_get source unknown)
SESSION_ID=$(json_get session_id unknown)
CWD=$(json_get cwd "")

# Gate 1: source must be startup
if [ "$SOURCE" != "startup" ]; then
  emit_empty
fi

# Gate 1b: cwd must be a git checkout
if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
  emit_empty
fi
REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$REPO_ROOT" ]; then
  emit_empty
fi

# Gate 2: branch must be smi-* or wave-*
BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null || echo "")
case "$BRANCH" in
  main|hotfix-*|dependabot/*|renovate/*|"")
    emit_empty
    ;;
  smi-*|wave-*)
    ;;
  *)
    emit_empty
    ;;
esac

SMI=$(echo "$BRANCH" | grep -oE '^(smi-[0-9]+|wave-[0-9]+)' || echo "")

# Gate 3: idempotency — reuse a < 60s old transient
TRANSIENT="/tmp/session-priming-${SESSION_ID}.md"
if [ -f "$TRANSIENT" ]; then
  # Portable mtime: macOS BSD `stat -f %m` and Linux GNU `stat -c %Y` differ.
  MTIME=$(python3 -c "import os,sys;print(int(os.path.getmtime(sys.argv[1])))" \
    "$TRANSIENT" 2>/dev/null || echo 0)
  AGE=$(( $(date +%s) - MTIME ))
  if [ "$AGE" -lt 60 ]; then
    CTX=$(cat "$TRANSIENT" 2>/dev/null || echo "")
    emit_json "$CTX"
    exit 0
  fi
fi

# Gate 4: build query and search.
LOG_DIR="$HOME/.claude/projects/$(echo "$REPO_ROOT" | sed 's|^/|-|;s|/|-|g')"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG="$LOG_DIR/session-priming.log"

# Capability-probe timeout binary (plan-review #5). macOS often lacks both.
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1 && timeout --kill-after=0 0 true >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
fi

QUERY_SCRIPT="$REPO_ROOT/scripts/session-priming-query.ts"
if [ ! -f "$QUERY_SCRIPT" ]; then
  emit_empty
fi

run_with_timeout_bin() {
  "$TIMEOUT_BIN" --kill-after=2.5s 2s npx --no-install tsx "$QUERY_SCRIPT" \
    --session-id "$SESSION_ID" \
    --branch "$BRANCH" \
    --smi "$SMI" \
    --cwd "$CWD" \
    --out "$TRANSIENT" 2>>"$LOG"
}

run_with_fallback() {
  # Job-control fallback: launch in background, watchdog SIGTERM at 2s,
  # SIGKILL at 2.5s. set -m enables process-group signaling.
  set -m
  npx --no-install tsx "$QUERY_SCRIPT" \
    --session-id "$SESSION_ID" \
    --branch "$BRANCH" \
    --smi "$SMI" \
    --cwd "$CWD" \
    --out "$TRANSIENT" 2>>"$LOG" &
  PRIMING_PID=$!
  (
    sleep 2
    kill -TERM "-$PRIMING_PID" 2>/dev/null || true
    sleep 0.5
    kill -KILL "-$PRIMING_PID" 2>/dev/null || true
  ) &
  WATCHDOG_PID=$!
  RESULT=$(wait "$PRIMING_PID" 2>/dev/null || true)
  kill "$WATCHDOG_PID" 2>/dev/null || true
  echo "$RESULT"
}

if [ -n "$TIMEOUT_BIN" ]; then
  RESULT=$(run_with_timeout_bin || true)
else
  RESULT=$(run_with_fallback || true)
fi

# Extract additionalContext from tsx JSON output via python3
CTX=$(printf '%s' "$RESULT" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('additionalContext', ''))
except Exception:
    pass
" 2>/dev/null || echo "")

# Atomic transient write: write to .tmp adjacent then mv.
if [ -n "$CTX" ]; then
  printf '%s' "$CTX" > "${TRANSIENT}.tmp" 2>/dev/null || true
  mv "${TRANSIENT}.tmp" "$TRANSIENT" 2>/dev/null || true
  chmod 0600 "$TRANSIENT" 2>/dev/null || true
fi

# Sweep stale transients (24h cross-session TTL).
find /tmp -maxdepth 1 -name 'session-priming-*.md' -mmin +1440 -delete 2>/dev/null || true

emit_json "$CTX"
exit 0
