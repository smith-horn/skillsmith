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
  # Fixed, static JSON — no python3 dependency needed (SMI-5642 companion
  # fix: a missing/failing python3 here, under `set -euo pipefail`, would
  # previously abort this function before emitting the required envelope
  # at EVERY call site, including the Gate 0 disable-var short-circuit —
  # violating the "always exits 0, never blocks" guarantee this comment
  # block claims). printf has no such dependency.
  # Byte-identical to Python's `json.dumps(...)` default separators
  # (', ' / ': ') so existing test assertions (session-start-audit.test.sh)
  # that match this exact spacing keep passing unchanged.
  printf '%s\n' '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ""}}'
  exit 0
}

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

# SMI-5823: all-tier, report-only local container inventory. This has its
# own 2-second cap because the helper's later 5-second cap cannot bound Docker.
run_container_sprawl_audit() {
  [ "${SKILLSMITH_CONTAINER_SPRAWL_AUDIT_DISABLE:-0}" = "1" ] && return 0
  local reporter="$REPO_ROOT/scripts/prune-orphaned-docker-volumes.sh"
  [ -x "$reporter" ] || return 0
  local out state_dir state_file digest previous now
  if [ -n "$TIMEOUT_BIN" ]; then
    out=$("$TIMEOUT_BIN" --kill-after=1s 2s "$reporter" --report-containers 2>/dev/null || true)
  else
    local tmp pid wd
    tmp=$(mktemp -t skillsmith-sprawl.XXXXXX) || return 0
    ("$reporter" --report-containers >"$tmp" 2>/dev/null) & pid=$!
    (sleep 2; kill "$pid" 2>/dev/null || true) & wd=$!
    wait "$pid" 2>/dev/null || true
    kill "$wd" 2>/dev/null || true
    wait "$wd" 2>/dev/null || true
    out=$(head -c 8192 "$tmp" 2>/dev/null || true)
    rm -f "$tmp"
  fi
  [ -n "$out" ] || return 0
  out=$(printf '%s' "$out" | head -c 8192)
  state_dir="${HOME}/.skillsmith"
  state_file="$state_dir/container-sprawl-audit.state"
  digest=$(printf '%s' "$out" | cksum | awk '{print $1}')
  now=$(date +%s)
  previous=$(cat "$state_file" 2>/dev/null || true)
  if printf '%s' "$previous" | grep -qE '^[0-9]+ [0-9]+$'; then
    if [ "${previous%% *}" = "$digest" ] && [ $((now - ${previous#* })) -lt 86400 ]; then
      return 0
    fi
  fi
  printf '%s\n' "$out" >&2
  mkdir -p "$state_dir" 2>/dev/null || return 0
  printf '%s %s\n' "$digest" "$now" >"$state_file.tmp" 2>/dev/null &&
    mv "$state_file.tmp" "$state_file" 2>/dev/null || true
}

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
elif command -v timeout >/dev/null 2>&1 && timeout 1 true >/dev/null 2>&1; then
  # Probe with `timeout 1 true` — the simplest invocation that works on
  # both GNU coreutils and BusyBox/Alpine. The previous probe
  # (`timeout --kill-after=0 0 true`) used GNU-specific flag syntax and
  # falsely failed on BusyBox, forcing the job-control fallback. (SMI-4753)
  TIMEOUT_BIN="timeout"
fi

run_container_sprawl_audit

# Existing namespace audit opt-out does not disable the machine-health probe.
if [ "${SKILLSMITH_SESSION_AUDIT_DISABLE:-0}" = "1" ]; then
  emit_empty_and_exit
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
