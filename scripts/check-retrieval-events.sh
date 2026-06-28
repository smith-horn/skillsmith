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

# SMI-5419: shared shell mirror of the encoded-project-dir resolver, parity-tested
# against project-dir.ts / project-dir.mjs. Provides find_main_repo_root +
# reconcile_encoded_dir + resolve_shared_project_dir so this diagnostic reads the
# SAME dir the writer wrote to even when the cwd casing differs from the one
# Claude Code recorded under ~/.claude/projects/.
# shellcheck source=lib/project-dir.sh
. "$SCRIPT_DIR/lib/project-dir.sh"

if [[ -n "${IS_DOCKER:-}" ]] && [[ ! -e /.dockerenv ]]; then
  echo "stale: IS_DOCKER=$IS_DOCKER set on host but /.dockerenv absent — writer will no-op"
  echo "fix: unset IS_DOCKER (likely sourced from .env.docker) before next session"
  exit 1
fi

# SMI-5419: resolve + casing-reconcile against ~/.claude/projects/ so a lower-cased
# cwd (the original bug) no longer points the probe at a different dir than the
# writer used — which split the feed and reported a false "no DB".
RECONCILED="$(resolve_shared_project_dir "$REPO_ROOT")"
RECONCILE_STATE="$(printf '%s' "$RECONCILED" | cut -f1)"
ENCODED="$(printf '%s' "$RECONCILED" | cut -f2)"
if [[ "$RECONCILE_STATE" == "ambiguous" ]]; then
  echo "probe-failed: ambiguous project dir — multiple case-variants under ~/.claude/projects/ fold to the same name; cannot determine the canonical DB"
  echo "fix: remove the stale case-variant dir(s) so only the canonical one remains"
  exit 2
fi
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
