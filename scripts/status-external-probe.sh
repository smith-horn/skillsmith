#!/usr/bin/env bash
# SMI-5756 (Wave 7, public status page — SMI-955, ADR-109-gated): external
# outage prober. Runs from GitHub Actions (outside both Supabase's and
# Vercel's infrastructure) so it can detect "Supabase itself is fully down" —
# a blind spot no in-Supabase check (pg_cron -> pg_net -> edge function) can
# ever close, because all three legs of that chain share fate with the thing
# being monitored.
#
# CRITICAL INVARIANT: the alert path below (gh issue create/comment/close)
# must NEVER depend on a Supabase call succeeding. scripts/smoke-prod/alert.sh
# POSTs to the alert-notify edge function -- that's fine for smoke-prod
# (validating a healthy deploy) but is the wrong model here: reusing it would
# make this prober's alert silently fail on exactly the outage it exists to
# report. The audit_logs write below is deliberately best-effort/non-blocking
# and structurally separate from the alert path for this reason.
#
# Probes TWO URLs to distinguish root cause (see docs/internal/implementation/
# smi-5756-external-prober.md Specification):
#   - the literal prod Supabase ref (isolates Supabase itself, bypasses the
#     Vercel proxy hop -- ADR-016) -- NEVER the staging ref (ovhcifugwqnzoebwfuku),
#     per CLAUDE.md's SMI-4252 rule.
#   - api.skillsmith.app (the exact path real clients hit, through Vercel)
#
# Alert condition: BOTH urls fail across 3 in-run retries each. A proxy-only
# failure (api.skillsmith.app down, raw URL up) is logged but does not alert
# -- see plan's "Out of scope" for why.
#
# Usage: ./scripts/status-external-probe.sh
#
# Exit codes:
#   0 — healthy (both URLs OK), or shadow/disabled no-op
#   1 — confirmed outage (alert-eligible)
#   2 — proxy-only degradation (logged, not alert-eligible)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Test-seam master switch ---------------------------------------------
# ALL seams require SKILLSMITH_STATUS_PROBE_TEST=1 (mirrors retrieval-liveness's
# convention -- production can't be hijacked by a stray env var).
PROBE_TEST="${SKILLSMITH_STATUS_PROBE_TEST:-}"

STABLE_LABEL="status-external-outage"
STABLE_TITLE="External prober: Supabase status-public unreachable from outside Supabase infra"

# Prod ref only -- see CLAUDE.md SMI-4252. Overridable ONLY under the test seam.
SUPABASE_RAW_URL="${SKILLSMITH_STATUS_PROBE_SUPABASE_URL:-https://vrcnzpmndtroqxxoqkzy.supabase.co/functions/v1/status-public}"
API_PROXY_URL="${SKILLSMITH_STATUS_PROBE_API_URL:-https://api.skillsmith.app/functions/v1/status-public}"
if [ "$PROBE_TEST" != "1" ]; then
  # Guard against a stray env var leaking a test URL into a real run.
  SUPABASE_RAW_URL="https://vrcnzpmndtroqxxoqkzy.supabase.co/functions/v1/status-public"
  API_PROXY_URL="https://api.skillsmith.app/functions/v1/status-public"
fi

# --- 1. Kill switch (checked first) ---------------------------------------
if [ "${SKILLSMITH_STATUS_EXTERNAL_PROBE_DISABLE:-}" = "1" ]; then
  echo "[status-probe] skip: disabled (SKILLSMITH_STATUS_EXTERNAL_PROBE_DISABLE=1)"
  exit 0
fi

# --- gh wrapper (test seam) -------------------------------------------------
run_gh() {
  if [ "$PROBE_TEST" = "1" ] && [ -n "${SKILLSMITH_STATUS_PROBE_GH_CMD:-}" ]; then
    bash "${SKILLSMITH_STATUS_PROBE_GH_CMD}" "$@"
    return $?
  fi
  gh "$@"
}

# --- curl wrapper (test seam) -----------------------------------------------
# Real mode: 3 attempts, 10s timeout each, 15s apart. Worst case ~60s per URL,
# well inside the job's 5-minute timeout and the 10-minute tick cadence.
check_url() {
  local url="$1"
  local attempt
  if [ "$PROBE_TEST" = "1" ] && [ -n "${SKILLSMITH_STATUS_PROBE_CURL_CMD:-}" ]; then
    bash "${SKILLSMITH_STATUS_PROBE_CURL_CMD}" "$url"
    return $?
  fi
  for attempt in 1 2 3; do
    if curl --fail --silent --show-error --max-time 10 -o /dev/null "$url"; then
      return 0
    fi
    [ "$attempt" -lt 3 ] && sleep 15
  done
  return 1
}

# --- 2. Run both probes ------------------------------------------------------
RAW_OK=1
API_OK=1
check_url "$SUPABASE_RAW_URL" && RAW_OK=0
check_url "$API_PROXY_URL" && API_OK=0

RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-smith-horn/skillsmith}/actions/runs/${GITHUB_RUN_ID:-unknown}"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- 3. Best-effort audit_logs write (non-blocking, non-critical) -----------
# Deliberately AFTER the probes and BEFORE any alert decision -- a failure
# here (e.g. because Supabase is exactly the thing that's down) must never
# suppress or delay the alert path below.
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  RESULT="healthy"
  [ "$RAW_OK" -eq 1 ] && RESULT="raw_down"
  [ "$API_OK" -eq 1 ] && [ "$RAW_OK" -eq 0 ] && RESULT="proxy_down"
  [ "$RAW_OK" -eq 1 ] && [ "$API_OK" -eq 1 ] && RESULT="both_down"
  curl --silent --max-time 5 -o /dev/null \
    -X POST "${SUPABASE_URL}/rest/v1/audit_logs" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"event_type\":\"status_external_probe:run\",\"actor\":\"system\",\"resource\":\"status_external_probe\",\"action\":\"run_checks\",\"result\":\"${RESULT}\",\"metadata\":{\"run_url\":\"${RUN_URL}\"}}" \
    || echo "[status-probe] audit_logs write failed (non-fatal, expected during a real outage)"
fi

# --- 4. Healthy path: auto-close any open outage issue -----------------------
if [ "$RAW_OK" -eq 0 ] && [ "$API_OK" -eq 0 ]; then
  echo "[status-probe] healthy: both URLs OK"
  EXISTING_ISSUE="$(run_gh issue list --label "$STABLE_LABEL" --state open --json number -q '.[0].number' 2>/dev/null || echo "")"
  if [ -n "${EXISTING_ISSUE:-}" ] && [ "$EXISTING_ISSUE" != "null" ]; then
    CREATED_AT="$(run_gh issue view "$EXISTING_ISSUE" --json createdAt -q '.createdAt' 2>/dev/null || echo "")"
    run_gh issue comment "$EXISTING_ISSUE" \
      --body "**Recovered** at ${NOW_ISO}. Opened at ${CREATED_AT:-unknown}. Closing." 2>/dev/null || true
    run_gh issue close "$EXISTING_ISSUE" 2>/dev/null || true
    echo "[status-probe] closed recovered issue #${EXISTING_ISSUE}"
  fi
  exit 0
fi

# --- 5. Proxy-only degradation: log, do not alert -----------------------------
if [ "$RAW_OK" -eq 0 ] && [ "$API_OK" -eq 1 ]; then
  echo "[status-probe] proxy-only failure: api.skillsmith.app unreachable, raw Supabase URL OK -- not alert-eligible (see plan Out of scope)"
  exit 2
fi

# --- 6. Confirmed outage path --------------------------------------------------
echo "[status-probe] CONFIRMED OUTAGE: both URLs unreachable after 3 attempts each"

# Shadow mode (default ON -- lift only after a soak period, mirrors
# retrieval-liveness's SHADOW default and concurrency-audit-pr.yml's 7-day window).
SHADOW="${SKILLSMITH_STATUS_EXTERNAL_PROBE_SHADOW:-1}"
if [ "$SHADOW" = "1" ]; then
  echo "[status-probe] [shadow] WOULD open/comment issue: ${STABLE_TITLE}"
  exit 1
fi

run_gh label create "$STABLE_LABEL" --color b60205 --force >/dev/null 2>&1 || true

BODY="## Confirmed external outage

Both probed URLs failed 3/3 attempts as of ${NOW_ISO}:
- \`${SUPABASE_RAW_URL}\` (raw Supabase — isolates Supabase itself)
- \`${API_PROXY_URL}\` (api.skillsmith.app — the path real clients use)

**Run:** ${RUN_URL}

### Graded responses
1. Check https://status.supabase.com for a known Supabase-wide incident
2. Check Vercel's status page (rules out a coincidental Vercel outage of the proxy hop)
3. **Snooze** (known maintenance window): set \`SKILLSMITH_STATUS_EXTERNAL_PROBE_DISABLE=1\` as a repo variable temporarily
4. This issue auto-closes on the next healthy tick — no manual close needed once resolved

_Auto-generated by \`scripts/status-external-probe.sh\` (SMI-5756)._"

EXISTING_ISSUE="$(run_gh issue list --label "$STABLE_LABEL" --state open --json number -q '.[0].number' 2>/dev/null || echo "")"
if [ -n "${EXISTING_ISSUE:-}" ] && [ "$EXISTING_ISSUE" != "null" ]; then
  # Throttle to ~hourly updates on an already-open, still-active outage --
  # a multi-hour incident shouldn't produce a comment every 10-minute tick.
  LAST_COMMENT_AT="$(run_gh issue view "$EXISTING_ISSUE" --json comments -q '.comments[-1].createdAt // empty' 2>/dev/null || echo "")"
  SHOULD_COMMENT=1
  if [ -n "$LAST_COMMENT_AT" ]; then
    LAST_EPOCH="$(date -u -d "$LAST_COMMENT_AT" +%s 2>/dev/null || echo 0)"
    NOW_EPOCH="$(date -u +%s)"
    [ $((NOW_EPOCH - LAST_EPOCH)) -lt 3300 ] && SHOULD_COMMENT=0  # < 55 min
  fi
  if [ "$SHOULD_COMMENT" -eq 1 ]; then
    run_gh issue comment "$EXISTING_ISSUE" --body "**Still down** as of ${NOW_ISO}. Run: ${RUN_URL}" 2>/dev/null || true
  fi
  echo "[status-probe] existing outage issue #${EXISTING_ISSUE} still open"
else
  NEW_URL="$(run_gh issue create --label "$STABLE_LABEL" --title "$STABLE_TITLE" --body "$BODY" 2>/dev/null || echo "")"
  echo "[status-probe] created issue: ${NEW_URL:-<failed>}"
fi

exit 1
