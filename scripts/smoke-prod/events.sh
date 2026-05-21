#!/usr/bin/env bash
# SMI-5023 Wave 4 Step 1 — skill-invocation telemetry smoke checks.
#
# Checks:
#   check_events_skill_invoke_accepted  — POST a synthetic skill_invoke event;
#                                         assert HTTP 200 and body contains
#                                         "accepted" (proves INSERT into
#                                         search_metrics completed).
#   check_events_skill_invoke_row_visible — Optional: verify the synthetic row
#                                           is queryable via PostgREST REST API
#                                           using SMOKE_SKILLS_* creds against
#                                           the skills-smoke Supabase project.
#                                           Skips gracefully when creds absent.
#
# Synthetic events are tagged source='smoke-prod' so production dashboards
# can filter them. The anonymous_id uses smoke-test-<epoch-s> to ensure
# dedup-safety across concurrent smoke runs.
#
# See docs/internal/implementation/skill-invoke-telemetry.md Wave 4 Step 1.

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"

# SUPABASE_URL must be supplied by the caller (env/secret). Fail loudly
# if absent — same guard used in website.sh.
SMOKE_SUPABASE_URL="${SUPABASE_URL:-}"

_require_events_supabase_url() {
  if [ -z "$SMOKE_SUPABASE_URL" ]; then
    smoke_warn "SUPABASE_URL not set -- skipping events check"
    return 1
  fi
  return 0
}

# ---- check_events_skill_invoke_accepted ----------------------------------
# POSTs a synthetic skill_invoke event to prod /functions/v1/events.
# The events function is anonymous (no-verify-jwt) and returns {"accepted":N}
# after a successful INSERT into search_metrics. Asserting the response body
# contains "accepted" proves the write path is live end-to-end.
#
# Failure modes:
#   non-2xx HTTP     — function not reachable or threw an error
#   body missing "accepted" — INSERT path broken or response schema changed
check_events_skill_invoke_accepted() {
  _require_events_supabase_url || {
    report_fail "edge-fn-events" "check_events_skill_invoke_accepted" "" "SUPABASE_URL" "unset"
    return 1
  }

  local url="${SMOKE_SUPABASE_URL}/functions/v1/events"
  local anon_id="smoke-test-$(date +%s)"
  local run_id="smoke-$(date +%s)"
  local payload
  payload=$(printf '{"event":"skill_invoke","anonymous_id":"%s","metadata":{"skill_name":"smoke","session_id":"%s","duration_ms":1,"source":"smoke-prod","framework":"smoke","platform":"linux","is_subagent":false,"success":true}}' \
    "$anon_id" "$run_id")

  local t0 t1 ms status body resp
  t0=$(now_ms)
  resp=$(with_retry http_body POST "$url" \
    -H "Content-Type: application/json" \
    -d "$payload") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  case "$status" in
    200|204) ;;
    *)
      report_fail "edge-fn-events" "check_events_skill_invoke_accepted" \
        "$url" "200|204" "$status" "$ms"
      return 1
      ;;
  esac

  if ! assert_contains "$body" "accepted" "events-response-accepted-field"; then
    report_fail "edge-fn-events" "check_events_skill_invoke_accepted" \
      "$url" 'body contains "accepted"' "${body:0:120}" "$ms"
    return 1
  fi

  report_pass "edge-fn-events" "check_events_skill_invoke_accepted" "$url" "$ms"
  # Stash run_id in a module-level variable so the row-visibility check
  # can use the same session_id without re-generating it.
  _EVENTS_LAST_RUN_ID="$run_id"
  return 0
}

# Module-level cache of the run_id written by check_events_skill_invoke_accepted.
# Reset each time that check runs.
_EVENTS_LAST_RUN_ID=""

# ---- check_events_skill_invoke_row_visible --------------------------------
# Optional: query search_metrics via PostgREST REST API to confirm the
# synthetic row landed. Uses SMOKE_SKILLS_SUPABASE_URL / SMOKE_SKILLS_*
# creds (the same staging account used by the usage-counter checks).
#
# Skips gracefully when creds are absent -- the accepted-body assertion in
# check_events_skill_invoke_accepted is the load-bearing gate. This check
# provides a deeper end-to-end read-path assertion as a belt-and-suspenders
# layer when the skills smoke credentials are provisioned.
#
# Waits up to 10s (2 probe attempts with a 5s gap) for the row to be
# visible (accounts for PostgREST plan-cache and pg connection pooling).
check_events_skill_invoke_row_visible() {
  if [ -z "${SMOKE_SKILLS_SUPABASE_URL:-}" ]; then
    smoke_warn "SMOKE_SKILLS_SUPABASE_URL not set -- skipping row-visibility check"
    return 0
  fi
  if [ -z "${SMOKE_SKILLS_ANON_KEY:-}" ] && [ -z "${SMOKE_SKILLS_SUPABASE_ANON_KEY:-}" ]; then
    smoke_warn "SMOKE_SKILLS_SUPABASE_ANON_KEY not set -- skipping row-visibility check"
    return 0
  fi
  if [ -z "${SMOKE_SKILLS_EMAIL:-}" ] || [ -z "${SMOKE_SKILLS_PASSWORD:-}" ]; then
    smoke_warn "SMOKE_SKILLS_EMAIL / SMOKE_SKILLS_PASSWORD not set -- skipping row-visibility check"
    return 0
  fi
  if [ -z "$_EVENTS_LAST_RUN_ID" ]; then
    smoke_warn "no run_id from check_events_skill_invoke_accepted -- skipping row-visibility check"
    return 0
  fi

  local skills_url="${SMOKE_SKILLS_SUPABASE_URL}"
  local skills_anon="${SMOKE_SKILLS_SUPABASE_ANON_KEY:-${SMOKE_SKILLS_ANON_KEY:-}}"
  local session_id="$_EVENTS_LAST_RUN_ID"

  # Sign in to obtain a JWT for the RLS-gated search_metrics read.
  local jwt
  jwt=$(curl --silent --max-time "$SMOKE_HTTP_TIMEOUT" \
    -X POST "${skills_url}/auth/v1/token?grant_type=password" \
    -H "apikey: ${skills_anon}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${SMOKE_SKILLS_EMAIL}\",\"password\":\"${SMOKE_SKILLS_PASSWORD}\"}" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null) || true

  if [ -z "$jwt" ]; then
    smoke_warn "row-visibility sign-in failed -- skipping"
    return 0
  fi

  local rest_url="${skills_url}/rest/v1/search_metrics?select=session_id&metadata->>session_id=eq.${session_id}&limit=1"
  local t0 t1 ms resp status body count

  # Probe once immediately, then once after 5s if no row yet (10s total budget).
  local attempt=1
  while [ "$attempt" -le 2 ]; do
    t0=$(now_ms)
    resp=$(curl --silent --max-time "$SMOKE_HTTP_TIMEOUT" \
      -X GET "$rest_url" \
      -H "apikey: ${skills_anon}" \
      -H "Authorization: Bearer ${jwt}" \
      -H "Accept: application/json" 2>/dev/null) || resp=""
    t1=$(now_ms)
    ms=$((t1 - t0))
    count=$(printf '%s' "$resp" | python3 -c "
import sys, json
try:
    rows = json.load(sys.stdin)
    print(len(rows) if isinstance(rows, list) else 0)
except Exception:
    print(0)
" 2>/dev/null) || count="0"

    if [ "$count" -gt 0 ] 2>/dev/null; then
      report_pass "edge-fn-events" "check_events_skill_invoke_row_visible" "$rest_url" "$ms"
      return 0
    fi

    if [ "$attempt" -lt 2 ]; then
      smoke_log "row-visibility: row not yet visible, retrying in 5s..."
      sleep 5
    fi
    attempt=$((attempt + 1))
  done

  report_fail "edge-fn-events" "check_events_skill_invoke_row_visible" \
    "$rest_url" "count>=1" "count=0 after 10s" "$ms"
  return 1
}
