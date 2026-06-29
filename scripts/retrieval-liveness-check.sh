#!/usr/bin/env bash
# audit:host-npm-required — see SMI-4814 (host-side telemetry liveness check; cannot run in Docker)
#
# retrieval-liveness-check.sh (SMI-5432 W0.2) — scheduled DETECTION backstop:
# reads the local retrieval-logs.db via the sqlite3 CLI (binding-independent) and
# opens a deduped GitHub issue when the telemetry feed has gone stale.
#
# Called by scripts/eval-baseline-cron.sh immediately after EVAL_EXIT is captured
# (best-effort, || true) so it runs even on eval failure — the diagnostic case (C2).
#
# Uses the sqlite3 CLI deliberately (NOT better-sqlite3): the CLI can read the DB
# in the exact dead-node-binding state that caused the original 6-week outage; the
# TS assessInstrumentationHealth() cannot, because its `await import('better-sqlite3')`
# throws when the binding is dead. UNION ALL is also avoided (C1 — see §1 in the
# plan): two independent queries handle an old DB missing frontmatter_lint_events.
#
# Two distinct keys (H3):
#   DB-path key:  prefer SKILLSMITH_PROJECT_DIR_ENCODED (baked into the eval plist);
#                 else resolve_shared_project_dir. Avoids resolving to the eval clone.
#   State key:    MAIN_REPO (raw absolute path, identical derivation to retrieval-autoheal.sh).
#                 NEVER use the encoded path as the state key.
#
# Usage:
#   ./scripts/retrieval-liveness-check.sh [--soak-report]
#
# Exit codes:
#   0 — healthy or not-applicable
#   1 — stale (alert-eligible)
#   2 — probe-failed (ambiguous resolver / sqlite3 / node unavailable)
#
# NOTE: no `set -e` — non-zero sqlite3/node exit is normal control flow.
# set -u/-o pipefail stay on; all paths guard unbound vars with ${x:-}.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# SMI-5419 shared resolver (casing-reconciled project-dir lookup).
# shellcheck source=lib/project-dir.sh
. "$SCRIPT_DIR/lib/project-dir.sh"

# --- Resolve the main repo (state key) ----------------------------------------
# Identical derivation to retrieval-autoheal.sh:33-37.
# Use sed, NOT awk '{print $2}' — awk truncates paths containing spaces.
MAIN_REPO="$(git -C "$SCRIPT_DIR" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -1)"
if [ -z "${MAIN_REPO:-}" ]; then
  MAIN_REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "")"
fi
[ -z "${MAIN_REPO:-}" ] && MAIN_REPO="$REPO_ROOT"

# --- Paths / constants ---------------------------------------------------------
# SKILLSMITH_LIVENESS_HOME isolates all state/logs under a test temp dir;
# honored identically by liveness-state.ts resolveLivenessStateDir().
STATE_DIR="${SKILLSMITH_LIVENESS_HOME:-$HOME}/.skillsmith"
LOG_DIR="$STATE_DIR/logs"
LOG_FILE="$LOG_DIR/retrieval-liveness-$(date +%Y-%m-%d).log"
STATE_CLI="$SCRIPT_DIR/retrieval-liveness-state.ts"

# Shadow and snooze var names (mirrored from liveness-state.ts LIVENESS_*_VAR).
VAR_DISABLE="SKILLSMITH_RETRIEVAL_LIVENESS_DISABLE"
VAR_SHADOW="SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW"
VAR_SNOOZE="SKILLSMITH_RETRIEVAL_LIVENESS_SNOOZE_UNTIL"

# --- Test-seam master switch ---------------------------------------------------
# ALL seams require SKILLSMITH_LIVENESS_TEST=1. Production behavior can never be
# hijacked by a stray env var (asserted by static-source test pattern).
LIVENESS_TEST="${SKILLSMITH_LIVENESS_TEST:-}"

# --- Logging (fail-soft) -------------------------------------------------------
log() {
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" >> "$LOG_FILE" 2>/dev/null || true
}

# --- tsx runner (prefer local bin; npx --no-install fallback) ------------------
run_state_cli() {
  local tsx_bin="$MAIN_REPO/node_modules/.bin/tsx"
  if [ -x "$tsx_bin" ]; then
    "$tsx_bin" "$STATE_CLI" "$@" --key "$MAIN_REPO" 2>/dev/null
  else
    npx --no-install tsx "$STATE_CLI" "$@" --key "$MAIN_REPO" 2>/dev/null
  fi
}

# --- gh wrapper (SKILLSMITH_LIVENESS_GH_CMD test seam) ------------------------
# When the seam is active, bash the provided script with the same args instead
# of calling gh — this lets tests capture what gh would have been called with.
run_gh() {
  if [ "$LIVENESS_TEST" = "1" ] && [ -n "${SKILLSMITH_LIVENESS_GH_CMD:-}" ]; then
    bash "${SKILLSMITH_LIVENESS_GH_CMD}" "$@"
    return $?
  fi
  gh "$@"
}

# --- --soak-report mode --------------------------------------------------------
# Grep verdict lines across all liveness log files and print a tally.
# Makes the shadow-lift decision auditable without reading four weekly log files.
if [ "${1:-}" = "--soak-report" ]; then
  total=0
  printf '=== retrieval-liveness soak report ===\n'
  for verdict in healthy stale probe-failed; do
    count=0
    for f in "$LOG_DIR"/retrieval-liveness-*.log; do
      [ -f "$f" ] || continue
      # grep -c already prints "0" (and exits 1) on no match; `|| true` keeps
      # that single 0 — `|| echo 0` would append a SECOND 0 and break $(()).
      n=$(grep -c "\[liveness\] $verdict" "$f" 2>/dev/null || true)
      [ -z "$n" ] && n=0
      count=$((count + n))
      total=$((total + n))
    done
    printf '  %-15s %d\n' "${verdict}:" "$count"
  done
  printf '  %-15s %d\n' "total:" "$total"
  printf '======================================\n'
  exit 0
fi

# --- 1. Kill-switch (checked first) -------------------------------------------
if [ "${SKILLSMITH_RETRIEVAL_LIVENESS_DISABLE:-}" = "1" ]; then
  log "[liveness] skip: disabled (${VAR_DISABLE}=1)"
  exit 0
fi

# --- 2. Docker no-op -----------------------------------------------------------
# IS_DOCKER=true on the host means the writer no-ops by design; probe not applicable.
# SKILLSMITH_LIVENESS_FORCE_NON_DOCKER seam: exercises the check logic inside the
# CI container (where /.dockerenv exists) so core invariants get real CI coverage.
if [ "$LIVENESS_TEST" = "1" ] && [ "${SKILLSMITH_LIVENESS_FORCE_NON_DOCKER:-}" = "1" ]; then
  : # test override — fall through
elif [ "${IS_DOCKER:-}" = "true" ] || [ -f /.dockerenv ]; then
  log "[liveness] skip: inside Docker — host writer no-ops by design"
  exit 0
fi

# --- 3. Check tsx availability (M3) -------------------------------------------
# If tsx is not available, log + exit 0 without writing state or calling gh.
TSX_BIN="$MAIN_REPO/node_modules/.bin/tsx"
TSX_AVAIL=0
if [ -x "$TSX_BIN" ]; then
  TSX_AVAIL=1
elif command -v npx >/dev/null 2>&1 && npx --no-install tsx --version >/dev/null 2>&1; then
  TSX_AVAIL=1
fi
if [ "$TSX_AVAIL" = "0" ]; then
  log "[liveness] tsx unavailable — no state write, no gh call; run npm ci first"
  exit 0
fi

# --- 4. Resolve DB path (H3) ---------------------------------------------------
# (a) DB-path key: prefer SKILLSMITH_PROJECT_DIR_ENCODED when set (baked into the
#     eval plist so the cron always reads the canonical main-repo's encoded dir,
#     not the eval clone). Fall back to resolve_shared_project_dir for standalone.
# (b) State key: always MAIN_REPO — never the encoded path.
VERDICT=""
MAX_TS=""
DB_PATH=""
MARKER_PATH=""

if [ "$LIVENESS_TEST" = "1" ] && [ -n "${SKILLSMITH_LIVENESS_DB_PATH:-}" ]; then
  # Test seam: point directly at a fixture DB, bypassing the resolver entirely.
  DB_PATH="${SKILLSMITH_LIVENESS_DB_PATH}"
else
  if [ -n "${SKILLSMITH_PROJECT_DIR_ENCODED:-}" ]; then
    ENCODED="${SKILLSMITH_PROJECT_DIR_ENCODED}"
  else
    RECONCILED="$(resolve_shared_project_dir "$REPO_ROOT")"
    RECONCILE_STATE="$(printf '%s' "$RECONCILED" | cut -f1)"
    ENCODED="$(printf '%s' "$RECONCILED" | cut -f2)"
    if [ "$RECONCILE_STATE" = "ambiguous" ]; then
      log "[liveness] probe-failed: ambiguous project dir — cannot determine canonical DB"
      exit 2
    fi
  fi
  # PROJECT_DIR always uses HOME (SKILLSMITH_LIVENESS_HOME only isolates .skillsmith state/logs).
  PROJECT_DIR="$HOME/.claude/projects/$ENCODED"
  DB_PATH="$PROJECT_DIR/retrieval-logs.db"
  MARKER_PATH="$PROJECT_DIR/retrieval-log.outage.json"
fi

# --- 5. Outage marker → always STALE (H2 invariant) ---------------------------
# The bash backstop does NOT apply probe.ts's 7-day OUTAGE_MARKER_TTL_DAYS.
# A present marker means the binding is still known-dead (marker self-clears on
# the next successful open), so keep alerting until actually repaired.
# MARKER_PATH is only set on the resolver path (it stays empty when the DB_PATH
# test seam is used), so this clause is naturally skipped under the seam — no
# need to read the seam var here (which would be an ungated seam leak).
if [ -n "${MARKER_PATH:-}" ] && [ -f "$MARKER_PATH" ]; then
  log "[liveness] stale: outage marker present at $MARKER_PATH (H2 — no TTL)"
  VERDICT="stale"
fi

# --- 6. DB absent → not applicable, exit 0 ------------------------------------
if [ -z "$VERDICT" ] && [ ! -f "$DB_PATH" ]; then
  log "[liveness] no DB at $DB_PATH (fresh install or writer never ran)"
  exit 0
fi

# --- 7. sqlite3 availability ---------------------------------------------------
SQLITE3_CMD="sqlite3"
if [ "$LIVENESS_TEST" = "1" ] && [ -n "${SKILLSMITH_LIVENESS_SQLITE_CMD:-}" ]; then
  SQLITE3_CMD="${SKILLSMITH_LIVENESS_SQLITE_CMD}"
fi
if [ -z "$VERDICT" ] && ! command -v "$SQLITE3_CMD" >/dev/null 2>&1; then
  log "[liveness] probe-failed: sqlite3 CLI not on PATH"
  exit 2
fi

# --- 8. Liveness query (C1 — two independent queries, NOT UNION ALL) -----------
# UNION ALL would fail on an old DB missing frontmatter_lint_events — exactly the
# machines that need this most. Two independent queries degrade gracefully.
if [ -z "$VERDICT" ]; then
  MAX_RE="$("$SQLITE3_CMD" "$DB_PATH" "SELECT COALESCE(MAX(ts),'') FROM retrieval_events;" 2>/dev/null || echo "")"
  MAX_FL="$("$SQLITE3_CMD" "$DB_PATH" "SELECT COALESCE(MAX(ts),'') FROM frontmatter_lint_events;" 2>/dev/null || echo "")"
  # ISO-8601 is lexicographically sortable; missing table → empty → the other wins.
  if [[ "$MAX_RE" > "$MAX_FL" ]]; then MAX_TS="$MAX_RE"; else MAX_TS="$MAX_FL"; fi

  # Empty → neither table has ever produced a row (writer never ran on this machine).
  if [ -z "$MAX_TS" ]; then
    log "[liveness] no rows in retrieval_events or frontmatter_lint_events — writer never ran; not alerting"
    exit 0
  fi

  # Cutoff via node (same ISO format as stored ts values). SQLite's datetime('now')
  # returns space-separated format where ' ' < 'T', breaking lexicographic compare.
  STALE_DAYS="${SKILLSMITH_RETRIEVAL_LIVENESS_STALE_DAYS:-7}"
  # Validate as a positive integer before embedding in `node -e` (prevents env-var
  # code injection; falls back to the 7-day default on any non-integer value).
  [[ "$STALE_DAYS" =~ ^[1-9][0-9]*$ ]] || STALE_DAYS=7
  CUTOFF="$(node -e "console.log(new Date(Date.now()-${STALE_DAYS}*864e5).toISOString())" 2>/dev/null || echo "")"
  if [ -z "$CUTOFF" ]; then
    log "[liveness] probe-failed: node not on PATH (needed to compute ISO cutoff)"
    exit 2
  fi

  if [[ "$MAX_TS" < "$CUTOFF" ]]; then
    VERDICT="stale"
  else
    VERDICT="healthy"
  fi
fi

# --- 9. Healthy path -----------------------------------------------------------
if [ "$VERDICT" = "healthy" ]; then
  log "[liveness] healthy: last row $MAX_TS"
  run_state_cli record --verdict healthy || true
  exit 0
fi

# --- 10. Stale path — write state, then alert ---------------------------------
log "[liveness] stale: last row ${MAX_TS:-absent}"
if [ -n "$MAX_TS" ]; then
  run_state_cli record --verdict stale --stale-since "$MAX_TS" || true
else
  run_state_cli record --verdict stale || true
fi

# Snooze (H5): suppress the alert but keep writing state/logs.
NOW_EPOCH="$(date +%s)"
if [ -n "${SKILLSMITH_RETRIEVAL_LIVENESS_SNOOZE_UNTIL:-}" ] &&
   [ "$NOW_EPOCH" -lt "${SKILLSMITH_RETRIEVAL_LIVENESS_SNOOZE_UNTIL}" ]; then
  log "[liveness] [snooze] alert suppressed until epoch ${SKILLSMITH_RETRIEVAL_LIVENESS_SNOOZE_UNTIL}"
  exit 1
fi

# Shadow (defaults to 1 — safe-by-default; lift only after 4-week zero-FP soak).
SHADOW="${SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW:-1}"
if [ "$SHADOW" = "1" ]; then
  log "[liveness] [shadow] WOULD open issue: telemetry-liveness: retrieval feed stale"
  exit 1
fi

# --- 11. Active mode: dedupe-by-label gh alert --------------------------------
DECISION="$(run_state_cli decision || echo "dedupe")"
if [ "$DECISION" != "notify" ]; then
  log "[liveness] dedupe: within 14-day re-notify cooldown; no gh action"
  exit 1
fi

STABLE_TITLE="telemetry-liveness: retrieval feed stale"
STABLE_LABEL="telemetry-liveness"

DAYS_STALE="unknown"
if [ -n "${MAX_TS:-}" ] && command -v node >/dev/null 2>&1; then
  # Pass MAX_TS as a positional arg, NOT interpolated into the JS source — a
  # non-ISO ts (future writer / hand-edited DB) can't break or inject into the script.
  DAYS_STALE="$(node -e "const d=(Date.now()-Date.parse(process.argv[1]))/(864e5);console.log(Math.round(d))" -- "$MAX_TS" 2>/dev/null || echo "unknown")"
fi

# Build issue body (four graded responses). DB_PATH embeds the absolute home dir,
# but the issue targets the owner's own private repo — no external disclosure.
BODY="## Retrieval telemetry feed stale

**DB path:** \`${DB_PATH}\`
**Last row timestamp:** ${MAX_TS:-absent}
**Days stale:** ${DAYS_STALE}
**Re-notify ETA:** ~14 days if unresolved (SMI-5432 W0.2)

### Graded responses

1. **Repair** (recommended): \`./scripts/repair-host-native-deps.sh\`; then read \`~/.skillsmith/logs/retrieval-autoheal-<date>.log\`
2. **Snooze** (known away-window): set \`${VAR_SNOOZE}=<epoch>\` in the cron plist + reload; keeps logging, pauses alerts
3. **Shadow** (slow repair underway): set \`${VAR_SHADOW}=1\` in the plist + reload; keeps logging, no GitHub noise
4. **Disable** (full kill): set \`${VAR_DISABLE}=1\`; disables the entire check

_Auto-generated by \`scripts/retrieval-liveness-check.sh\` (SMI-5432 W0.2)._"

# Search for existing open issue with the stable label (idempotent dedupe).
# (`gh issue list` supports --json/-q; an empty result set yields "" or "null".)
EXISTING_ISSUE="$(run_gh issue list --label "$STABLE_LABEL" --state open --json number -q '.[0].number' 2>/dev/null || echo "")"

if [ -n "${EXISTING_ISSUE:-}" ] && [ "$EXISTING_ISSUE" != "null" ]; then
  log "[liveness] commenting on existing issue #${EXISTING_ISSUE}"
  COMMENT="**Feed still stale.** Last row: ${MAX_TS:-absent}. Days stale: ${DAYS_STALE}. Next automated ping: ~14 days."
  run_gh issue comment "$EXISTING_ISSUE" --body "$COMMENT" 2>/dev/null \
    || log "[liveness] warn: gh issue comment failed for #${EXISTING_ISSUE}"
  run_state_cli record-alert --issue "$EXISTING_ISSUE" || true
else
  log "[liveness] creating new issue: ${STABLE_TITLE}"
  # `gh issue create` does NOT support --json/-q; it prints the new issue URL on
  # stdout. Parse the trailing number from the URL for follow-up dedupe state.
  NEW_URL="$(run_gh issue create \
    --label "$STABLE_LABEL" \
    --title "$STABLE_TITLE" \
    --body "$BODY" 2>/dev/null || echo "")"
  NEW_NUM="$(printf '%s' "$NEW_URL" | sed -n 's#.*/issues/\([0-9][0-9]*\).*#\1#p' | head -1)"
  if [ -n "${NEW_NUM:-}" ]; then
    log "[liveness] created issue #${NEW_NUM} (${NEW_URL})"
    run_state_cli record-alert --issue "$NEW_NUM" || true
  else
    log "[liveness] warn: gh issue create failed or URL unparsed (${NEW_URL:-empty})"
    run_state_cli record-alert || true
  fi
fi

exit 1
