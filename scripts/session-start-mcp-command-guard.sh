#!/usr/bin/env bash
# SMI-5642 — SessionStart guard hook: warns when an MCP server config (this
# repo's .mcp.json, or ~/.claude.json's skillsmith-project-scoped block) uses
# a bare global-bin command — the exact pattern that broke `aqe` (ENOENT)
# after an nvm Node-version drift. See docs/internal/implementation/
# mcp-bare-command-guard-hook.md and fix-aqe-mcp-enoent.md.
#
# Reads JSON event on stdin (Claude Code SessionStart format), writes fixed
# empty-additionalContext JSON to stdout (mirrors session-start-audit.sh —
# the priming hook owns the additionalContext slot). Warnings go to stderr
# only (terminal-visible, never reaches Claude's model context), debounced
# 24h per finding (see mcp-command-guard.mjs's filterDebounced).
#
# Always exits 0 (best-effort, advisory-only). Bounded execution: 5-second
# wall clock via capability-probed gtimeout/timeout/job-control fallback.
#
# Disable: SKILLSMITH_MCP_COMMAND_GUARD_DISABLE=1.

set -euo pipefail

INPUT=$(cat)

emit_empty_and_exit() {
  # Fixed, static JSON — no python3 dependency needed here (unlike the
  # SOURCE/CWD extraction below, which genuinely needs to parse variable
  # stdin). A prior draft shelled out to `python3 -c '...'` with no
  # fallback, which under `set -euo pipefail` meant a missing/failing
  # python3 silently skipped emitting this envelope on EVERY call site
  # (including Gate 0's disable-var short-circuit) — violating the
  # "always exits 0, never blocks" guarantee. printf has no such dependency.
  # Byte-identical to Python's `json.dumps(...)` default separators
  # (', ' / ': '), matching session-start-audit.sh's envelope exactly.
  printf '%s\n' '{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ""}}'
  exit 0
}

# Gate 0: opt-out via env var.
if [ "${SKILLSMITH_MCP_COMMAND_GUARD_DISABLE:-0}" = "1" ]; then
  emit_empty_and_exit
fi

SOURCE=$(printf '%s' "$INPUT" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('source', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")

CWD=$(printf '%s' "$INPUT" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin).get('cwd', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")

# Gate 1: source must be 'startup'.
if [ "$SOURCE" != "startup" ]; then
  emit_empty_and_exit
fi

# Gate 2: cwd must exist and be a git repo.
if [ -z "$CWD" ] || [ ! -d "$CWD" ]; then
  emit_empty_and_exit
fi
REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$REPO_ROOT" ]; then
  emit_empty_and_exit
fi

GUARD_SCRIPT="$REPO_ROOT/scripts/lib/mcp-command-guard.mjs"
if [ ! -f "$GUARD_SCRIPT" ]; then
  emit_empty_and_exit
fi

TIMEOUT_BIN=""
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
elif command -v timeout >/dev/null 2>&1 && timeout 1 true >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
fi

run_capture() {
  local stderr_file
  stderr_file=$(mktemp -t skillsmith-mcp-guard-stderr.XXXXXX) || return 0
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" --kill-after=2s 5s node "$GUARD_SCRIPT" "$REPO_ROOT" \
      >/dev/null 2>"$stderr_file" || true
  else
    set -m
    (
      node "$GUARD_SCRIPT" "$REPO_ROOT" >/dev/null 2>"$stderr_file"
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

  if [ -s "$stderr_file" ]; then
    head -c 8192 "$stderr_file" >&2 || true
  fi
  rm -f "$stderr_file"
}

run_capture

emit_empty_and_exit
