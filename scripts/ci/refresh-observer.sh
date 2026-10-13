#!/usr/bin/env bash
# SMI-7114: independent observer for the pg_cron-triggered metadata refresh.
#
# Runs on GitHub Actions, a different scheduler from pg_cron, and is never retired.
# It reads refresh_metadata_health() over PostgREST and evaluates three arms:
#   stale           no refresh:run in the last 9h (or never)
#   dispatch_stale  no refresh:dispatch in the last 9h (or never): pg_cron is dead
#                   while manual runs keep refresh:run fresh
#   failures        the RPC lists at least one failed dispatch
# A non-empty arm set POSTs alert-notify `refresh_unhealthy` naming EVERY arm.
#
# Dead-man contract: the `refresh:observer` heartbeat row is the LAST thing written, and
# only after the secrets were present, the RPC answered 2xx with a well-formed body, and
# any alert was delivered with 200. Every other outcome exits 1 without a heartbeat, so
# the pg_cron check_refresh_observer_heartbeat() sees the heartbeat age and pages.
#
# Exit 0: healthy, or unhealthy and the alert was delivered (or alerting is disabled).
# Exit 1: missing secret, RPC failure, malformed body, alert not delivered (non-200),
#         or the heartbeat insert failed.
#
# Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required), GITHUB_RUN_ID, GITHUB_SERVER_URL,
#      GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY, SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE
#      (=1 reports to the step summary only), REFRESH_OBSERVER_NOW (test seam: ISO-8601
#      instant standing in for the current time).
set -euo pipefail

STALE_HOURS=9

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo ""; echo "### Refresh observer"; echo ""; echo "$1"; } >> "$GITHUB_STEP_SUMMARY"
  fi
}

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "::error::refresh-observer: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set -- refusing to run (no heartbeat)."
  exit 1
fi

WORK="$(mktemp -d)" || { echo "::error::refresh-observer: mktemp failed"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

# Prints the HTTP status on stdout; the response body lands in $2. A curl that did not
# complete yields "000" so every caller treats it as a non-2xx.
post_json() {
  local url="$1" out="$2" body="$3" code
  if code=$(curl -sS --max-time 60 -o "$out" -w '%{http_code}' -X POST \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body" "$url" 2>"$WORK/curl.err"); then
    echo "$code"
  else
    echo "000"
  fi
}

# --- 1. Read the health RPC ---------------------------------------------------
RPC_CODE="$(post_json "${SUPABASE_URL}/rest/v1/rpc/refresh_metadata_health" "$WORK/rpc.json" '{}')"
case "$RPC_CODE" in
  2??) ;;
  *)
    echo "::error::refresh-observer: refresh_metadata_health returned HTTP ${RPC_CODE} -- cannot observe (no heartbeat)."
    exit 1 ;;
esac

# --- 2. Evaluate the arms (node, not jq: present on the runner and in the dev container) ---
# shellcheck disable=SC2016  # the JS is deliberately single-quoted: no shell expansion inside it
node -e '
const fs = require("node:fs")
const [file, nowIso, hoursStr, runUrl] = process.argv.slice(1)
const out = (verdict, arms, message) => {
  console.log(verdict); console.log(JSON.stringify(arms)); console.log(message); process.exit(0)
}
let h
try { h = JSON.parse(fs.readFileSync(file, "utf8")) } catch { out("INVALID", [], "the RPC body is not JSON") }
if (h === null || typeof h !== "object" || Array.isArray(h)) out("INVALID", [], "the RPC body is not a JSON object")
if (!Array.isArray(h.failures)) out("INVALID", [], "failures is not an array")
const now = nowIso ? Date.parse(nowIso) : Date.now()
if (Number.isNaN(now)) out("INVALID", [], "the observer clock is not a valid instant")
const windowMs = Number(hoursStr) * 3600 * 1000
const age = (key) => {
  const v = h[key]
  if (v === null) return { missing: true }
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) out("INVALID", [], key + " is not a timestamp")
  return { missing: false, ms: now - Date.parse(v), at: v }
}
const hrs = (ms) => (ms / 3600000).toFixed(1)
const describe = (label, a) => (a.missing ? label + ": none recorded" : label + ": " + a.at + " (" + hrs(a.ms) + "h ago)")
const run = age("last_run"), disp = age("last_dispatch")
const arms = [], parts = []
if (run.missing || run.ms > windowMs) { arms.push("stale"); parts.push("stale (" + describe("last refresh:run", run) + ", window " + hoursStr + "h)") }
if (disp.missing || disp.ms > windowMs) { arms.push("dispatch_stale"); parts.push("dispatch_stale (" + describe("last refresh:dispatch", disp) + ", window " + hoursStr + "h)") }
if (h.failures.length > 0) {
  arms.push("failures")
  const kinds = h.failures.slice(0, 10).map((f) => String((f && f.kind) ?? "unknown") + (f && f.status_code != null ? " " + f.status_code : "") + " at " + String((f && f.dispatched_at) ?? "unknown")).join("; ")
  parts.push("failures (" + h.failures.length + " failed dispatch(es): " + kinds + ")")
}
const unknown = typeof h.unknown_count === "number" ? " Unknown (response expired) dispatches: " + h.unknown_count + "." : ""
const message = arms.length === 0 ? "healthy" : "The metadata refresh is unhealthy. Arms: " + parts.join("; ") + "." + unknown + (runUrl ? " Observer run: " + runUrl : "")
out("OK", arms, message)
' "$WORK/rpc.json" "${REFRESH_OBSERVER_NOW:-}" "$STALE_HOURS" \
  "${GITHUB_SERVER_URL:-}${GITHUB_REPOSITORY:+/${GITHUB_REPOSITORY}}${GITHUB_RUN_ID:+/actions/runs/${GITHUB_RUN_ID}}" \
  > "$WORK/verdict" || { echo "::error::refresh-observer: the evaluator itself failed (no heartbeat)."; exit 1; }

VERDICT="$(sed -n '1p' "$WORK/verdict")"
ARMS="$(sed -n '2p' "$WORK/verdict")"
MESSAGE="$(sed -n '3p' "$WORK/verdict")"
if [ "$VERDICT" != "OK" ]; then
  echo "::error::refresh-observer: cannot read the RPC result (${MESSAGE}) -- no heartbeat."
  exit 1
fi

# --- 3. Alert when any arm tripped --------------------------------------------
if [ "$ARMS" != "[]" ]; then
  if [ "${SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE:-}" = "1" ]; then
    summary "UNHEALTHY, alert POST disabled (SKILLSMITH_REFRESH_OBSERVER_ALERT_DISABLE=1). Arms: ${ARMS}. ${MESSAGE}"
  else
    ALERT_BODY="$(node -e '
      const [message, runId, runUrl] = process.argv.slice(1)
      console.log(JSON.stringify({ type: "refresh_unhealthy", message, workflow: "Skill Metadata Refresh", runId, runUrl }))
    ' "$MESSAGE" "${GITHUB_RUN_ID:-}" "${GITHUB_SERVER_URL:-}${GITHUB_REPOSITORY:+/${GITHUB_REPOSITORY}}${GITHUB_RUN_ID:+/actions/runs/${GITHUB_RUN_ID}}")"
    ALERT_CODE="$(post_json "${SUPABASE_URL}/functions/v1/alert-notify" "$WORK/alert.out" "$ALERT_BODY")"
    summary "UNHEALTHY. Arms: ${ARMS}. alert-notify HTTP ${ALERT_CODE}. ${MESSAGE}"
    if [ "$ALERT_CODE" != "200" ]; then
      echo "::error::refresh-observer: alert-notify returned ${ALERT_CODE} -- the alert was NOT delivered (no heartbeat)."
      exit 1
    fi
  fi
fi

# --- 4. Heartbeat: last, only after everything above succeeded ----------------
HB_BODY="$(node -e '
  const [runId, arms, result] = process.argv.slice(1)
  console.log(JSON.stringify({
    event_type: "refresh:observer", actor: "github-actions", resource: "refresh_observer",
    action: "observe", result, metadata: { run_id: runId, arms: JSON.parse(arms) },
  }))
' "${GITHUB_RUN_ID:-}" "$ARMS" "$([ "$ARMS" = "[]" ] && echo healthy || echo unhealthy)")"
HB_CODE="$(post_json "${SUPABASE_URL}/rest/v1/audit_logs" "$WORK/hb.out" "$HB_BODY")"
case "$HB_CODE" in
  2??) ;;
  *)
    echo "::error::refresh-observer: the heartbeat insert returned HTTP ${HB_CODE} -- the dead-man check will page if this persists."
    exit 1 ;;
esac

if [ "$ARMS" = "[]" ]; then
  summary "healthy: last_run and last_dispatch are inside the ${STALE_HOURS}h window and no dispatch failures are listed. Heartbeat written."
fi
exit 0
