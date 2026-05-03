#!/usr/bin/env bash
# SMI-4549 Wave 2 — standalone retrieval_events probe.
#
# Reports the same verdict the SessionStart hook surfaces (outage marker,
# IS_DOCKER trap, recent-row count). Useful for verifying instrumentation
# health between sessions or after a node-version change without waiting
# for the next session to fire.
#
# Usage:
#   ./scripts/check-retrieval-events.sh
#
# Exit codes:
#   0 — healthy
#   1 — stale (banner-eligible)
#   2 — probe failed to run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Walk up to the main repo root (worktrees: stop at the first dir whose
# .git is a directory). Mirrors writer.ts/findMainRepoRoot.
resolve_main_repo_root() {
  local current parent depth
  current="$1"
  depth=0
  while (( depth < 64 )); do
    if [[ -d "$current/.git" ]]; then
      printf '%s\n' "$current"
      return 0
    fi
    parent="$(dirname "$current")"
    if [[ "$parent" == "$current" ]]; then
      return 1
    fi
    current="$parent"
    depth=$(( depth + 1 ))
  done
  return 1
}

MAIN_REPO_ROOT="$(resolve_main_repo_root "$REPO_ROOT" 2>/dev/null || echo "$REPO_ROOT")"

if [[ -n "${IS_DOCKER:-}" ]] && [[ ! -e /.dockerenv ]]; then
  echo "stale: IS_DOCKER=$IS_DOCKER set on host but /.dockerenv absent — writer will no-op"
  echo "fix: unset IS_DOCKER (likely sourced from .env.docker) before next session"
  exit 1
fi

ENCODED="$(echo "$MAIN_REPO_ROOT" | sed 's|^/|-|;s|/|-|g')"
PROJECT_DIR="$HOME/.claude/projects/$ENCODED"
DB_PATH="$PROJECT_DIR/retrieval-logs.db"
MARKER_PATH="$PROJECT_DIR/retrieval-log.outage.json"

if [[ -f "$MARKER_PATH" ]]; then
  echo "stale: outage marker present at $MARKER_PATH"
  echo "---"
  cat "$MARKER_PATH"
  echo "---"
  echo "fix: ./scripts/repair-host-native-deps.sh"
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "no DB at $DB_PATH (fresh install or never ran a session_start_priming hook)"
  exit 0
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "probe-failed: sqlite3 CLI not on PATH"
  exit 2
fi

CUTOFF="$(node -e "console.log(new Date(Date.now() - 24*60*60*1000).toISOString())" 2>/dev/null || echo "")"
if [[ -z "$CUTOFF" ]]; then
  echo "probe-failed: node not on PATH (needed to compute cutoff)"
  exit 2
fi

ROWS="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM retrieval_events WHERE trigger = 'session_start_priming' AND hook_outcome = 'primed' AND ts >= '$CUTOFF';")"
LAST_TS="$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(ts), '') FROM retrieval_events WHERE trigger = 'session_start_priming' AND hook_outcome = 'primed';")"

echo "DB:        $DB_PATH"
echo "rows(24h): $ROWS"
echo "last_ts:   ${LAST_TS:-never}"

if [[ "$ROWS" -eq 0 ]]; then
  echo "stale: zero primed rows in last 24h"
  echo "fix: start a fresh smi-* / wave-* session and re-check"
  exit 1
fi

echo "healthy"
exit 0
