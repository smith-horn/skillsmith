#!/bin/sh
# Skillsmith Agent - SessionEnd hook (codex). Generated; do not edit by hand.
# Writes/removes the agent-mediation marker file (SMI-5456). Self-contained
# POSIX sh, no CLI dependency; every path exits 0 so it never fails a session.
set -uC
HOME="${HOME:-/tmp}"
if [ "${SKILLSMITH_AGENT_HOOK_DISABLE:-}" = "1" ]; then cat >/dev/null 2>&1 || true; exit 0; fi
MARKER_DIR="${SKILLSMITH_AGENT_MARKER_DIR:-$HOME/.skillsmith/agent-markers}"

input=$(cat 2>/dev/null || true)
sid=""
if command -v jq >/dev/null 2>&1; then
  sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)
fi
if [ -z "$sid" ]; then
  sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
fi
if [ -z "$sid" ]; then
  sid="unknown-$(date +%s 2>/dev/null || echo 0)-$$"
fi
sid=$(printf '%s' "$sid" | tr -c 'A-Za-z0-9._-' '_')

rm -f "$MARKER_DIR/$sid.json" 2>/dev/null
exit 0
