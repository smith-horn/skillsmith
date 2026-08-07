#!/usr/bin/env bash
# SMI-5941 — PostToolUseFailure hook: detect an MCP disconnect-shaped tool
# failure and surface it immediately via `systemMessage` (a harness-rendered
# warning shown directly to the user — independent of whatever the assistant
# says in its own next message), while also recording it for the next
# SessionStart's banner (scripts/session-priming-query.ts).
#
# This is "Track B" of SMI-5941 — it only fires when a tool call is actually
# attempted against an already-broken MCP connection. The companion "Track A"
# (a CLAUDE.md instruction) covers the different, empirically-reproduced
# sub-case where the tool vanishes from the toolset outright and no call is
# ever attempted, so no PostToolUseFailure event fires at all.
#
# Reads JSON event on stdin (Claude Code PostToolUseFailure format):
#   { "tool_name": "mcp__skillsmith__search", "error": "...", "cwd": "/abs/path", ... }
# Writes JSON to stdout on a matched disconnect:
#   { "systemMessage": "..." }
# Writes nothing on a non-match or any internal failure (fail-soft).
#
# Always exits 0. Never blocks the tool call it's observing — the tool has
# already failed by the time this hook runs (PostToolUseFailure cannot block).
#
# Spec: docs/internal/implementation/smi-5941-mcp-live-disconnect-detection.md.

set -uo pipefail

INPUT=$(cat)

# --- Kill-switch (checked first, before any parsing) ---------------------------
if [ "${SKILLSMITH_MCP_DISCONNECT_DISABLE:-}" = "1" ]; then
  exit 0
fi

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

TOOL_NAME=$(json_get tool_name "")
ERROR_MSG=$(json_get error "")
CWD=$(json_get cwd "")

[ -z "$TOOL_NAME" ] && exit 0
[ -z "$CWD" ] && exit 0

# --- Server-name attribution (unambiguous by construction — see the shared
# TS module's resolveServerName() doc comment for why "-doc-retrieval" before
# the double-underscore delimiter can never collide with the shorter prefix) --
case "$TOOL_NAME" in
  mcp__skillsmith-doc-retrieval__*) SERVER="skillsmith-doc-retrieval" ;;
  mcp__skillsmith__*) SERVER="skillsmith" ;;
  *) exit 0 ;; # not one of our two servers — matcher shouldn't let this through, fail-soft anyway
esac

# --- Signature corpus (case-insensitive substring match) ----------------------
# Bare JSON-RPC codes (-32000, -32603) are deliberately excluded — too broad,
# and untested against the many ordinary application errors that also carry
# those generic codes. See the plan's "Signature corpus" section.
if ! printf '%s' "$ERROR_MSG" | grep -qiE 'failed to reconnect|transport closed|mcp server disconnected'; then
  exit 0
fi

# --- Resolve repo key (matches resolveMainRepoKey()'s derivation exactly —
# packages/doc-retrieval-mcp/src/retrieval-log/autoheal-state.ts) -------------
REPO_KEY="$(git -C "$CWD" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -1)"
if [ -z "$REPO_KEY" ]; then
  REPO_KEY="$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "")"
fi
[ -z "$REPO_KEY" ] && exit 0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_CLI="$REPO_ROOT/scripts/mcp-disconnect-state.ts"

run_state_cli() {
  local tsx_bin="$REPO_ROOT/node_modules/.bin/tsx"
  if [ -x "$tsx_bin" ]; then
    "$tsx_bin" "$STATE_CLI" "$@" 2>/dev/null
  else
    npx --no-install tsx "$STATE_CLI" "$@" 2>/dev/null
  fi
}

# Record regardless of shadow mode (shadow only suppresses user-visible
# output, per the plan — observability is preserved).
run_state_cli record --repo-key "$REPO_KEY" --server "$SERVER" \
  --tool "$TOOL_NAME" --error "$ERROR_MSG" >/dev/null || true

# --- Shadow mode: suppress systemMessage, keep the state write above ---------
if [ "${SKILLSMITH_MCP_DISCONNECT_SHADOW:-}" = "1" ]; then
  exit 0
fi

MESSAGE="⚠ MCP server '${SERVER}' disconnected — a tool call just failed. Run /mcp → select ${SERVER} → Reconnect."

python3 -c "
import json, sys
print(json.dumps({'systemMessage': sys.argv[1]}))
" "$MESSAGE"

exit 0
