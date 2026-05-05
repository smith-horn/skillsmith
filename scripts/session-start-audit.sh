#!/usr/bin/env bash
# SMI-4590 Wave 4 PR 6/6 — SessionStart audit hook (tier-gated continuous monitoring).
#
# Spec: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §6.
#
# Reads JSON event on stdin (Claude Code SessionStart format):
#   { "session_id": "uuid", "source": "startup"|"resume"|"compact",
#     "cwd": "/abs/path", "transcript_path": "..." }
# Writes JSON to stdout: { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "" } }
#
# stdout is ALWAYS empty additionalContext — the priming hook
# (session-start-priming.sh) owns the additionalContext slot. This hook's
# user-visible output goes to stderr (visible in terminal, NOT in
# Claude's model context).
#
# Always exits 0 (best-effort). Bounded execution: 5-second wall clock
# via capability-probed gtimeout/timeout/job-control fallback so a stuck
# helper never blocks Claude Code startup.
#
# Disable: SKILLSMITH_SESSION_AUDIT_DISABLE=1.

set -euo pipefail

INPUT=$(cat)

emit_empty_and_exit() {
  python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":""}}))'
  exit 0
}

# Gate 0: opt-out via env var.
if [ "${SKILLSMITH_SESSION_AUDIT_DISABLE:-0}" = "1" ]; then
  emit_empty_and_exit
fi

# Parse stdin for source + cwd. Anything missing → fall through to silent.
SOURCE=$(printf '%s' "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('source', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")

CWD=$(printf '%s' "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get('cwd', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")

# Gate 1: source must be 'startup'. Resume / compact / unknown → silent.
if [ "$SOURCE" != "startup" ]; then
  emit_empty_and_exit
fi

# Gate 2: cwd must exist and be a git repo (mirrors priming hook).
if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
  emit_empty_and_exit
fi
REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$REPO_ROOT" ]; then
  emit_empty_and_exit
fi

# Resolve the helper path. If missing (e.g., running on an older checkout),
# fail soft.
HELPER="$REPO_ROOT/scripts/lib/session-start-audit-helper.ts"
if [ ! -f "$HELPER" ]; then
  emit_empty_and_exit
fi

# Stage A: capability-probe a usable timeout binary (mirror priming hook
# precedent for macOS hosts that lack both `gtimeout` and `timeout`).
TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1 && timeout --kill-after=0 0 true >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
fi

# Stage B: invoke the helper via tsx with a 5-second wall-clock cap. The
# helper's stdout is REDIRECTED to /dev/null — only stderr reaches the
# user terminal. The hook's own stdout is the fixed JSON envelope.
#
# Capture helper stderr to a tmp file so we can stream it to the hook's
# stderr after the timeout cap completes. The helper writes ONE line on
# success; anything more is treated as overflow and truncated at 8 KB
# to keep the hook bounded.
run_capture() {
  local stderr_file
  stderr_file=$(mktemp -t skillsmith-audit-stderr.XXXXXX) || return 0
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" --kill-after=2s 5s npx --no-install tsx "$HELPER" \
      >/dev/null 2>"$stderr_file" || true
  else
    # Job-control fallback: launch helper, watchdog SIGTERM at 5s, SIGKILL at 7s.
    # Both helper and watchdog are launched in disowned subshells so bash's
    # job-control completion notices ("Terminated: 15") don't leak to fd 2.
    set -m
    (
      npx --no-install tsx "$HELPER" >/dev/null 2>"$stderr_file"
    ) &
    local pid=$!
    (
      sleep 5
      kill -TERM "-$pid" 2>/dev/null || true
      sleep 2
      kill -KILL "-$pid" 2>/dev/null || true
    ) >/dev/null 2>&1 &
    local wd=$!
    wait "$pid" 2>/dev/null || true
    kill "$wd" 2>/dev/null || true
    wait "$wd" 2>/dev/null || true
  fi

  # Cap output at 8 KB to defend against runaway helper bugs. The helper
  # is supposed to emit exactly one line.
  if [ -s "$stderr_file" ]; then
    head -c 8192 "$stderr_file" >&2 || true
  fi
  rm -f "$stderr_file"
}

run_capture

emit_empty_and_exit
