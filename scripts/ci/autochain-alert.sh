#!/usr/bin/env bash
# SMI-7121: one alert-notify POST for the backfill autochain.
#
# Same payload shape and delivery check as the autochain's original alert steps:
# {type, message, workflow, runId, runUrl}, POSTed to $SUPABASE_URL/functions/v1/alert-notify
# with the service-role key, delivered ONLY on HTTP 200. Every value arrives through the
# environment and is JSON-encoded by node, so no title, reason or run id is ever shell code.
#
# Exit 0 when alert-notify returned 200; exit 1 otherwise (including a missing input), with
# an ::error:: saying the email was NOT sent. The HTTP status is written to the step summary.
#
# Env: ALERT_TYPE, ALERT_MESSAGE, ALERT_RUN_ID, ALERT_RUN_URL, SUPABASE_URL,
#      SUPABASE_SERVICE_ROLE_KEY; GITHUB_STEP_SUMMARY (optional). Requires node and curl.
set -uo pipefail

for v in ALERT_TYPE ALERT_MESSAGE ALERT_RUN_ID ALERT_RUN_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  if [ -z "${!v:-}" ]; then
    echo "::error::autochain-alert: $v is not set -- email was NOT sent."
    exit 1
  fi
done

BODY=$(node -e 'const e = process.env; process.stdout.write(JSON.stringify({type: e.ALERT_TYPE, message: e.ALERT_MESSAGE, workflow: "Skill Indexer Backfill Autochain", runId: e.ALERT_RUN_ID, runUrl: e.ALERT_RUN_URL}))') || {
  echo "::error::autochain-alert: could not build the alert body -- email was NOT sent."
  exit 1
}

HTTP="000"
if RESPONSE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -d "$BODY" \
  "$SUPABASE_URL/functions/v1/alert-notify"); then
  HTTP="$RESPONSE_CODE"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '%s\n' "" "alert-notify ($ALERT_TYPE) HTTP: $HTTP" >> "$GITHUB_STEP_SUMMARY"
fi

if [ "$HTTP" != "200" ]; then
  echo "::error::alert-notify returned $HTTP for $ALERT_TYPE -- email was NOT sent."
  exit 1
fi
echo "alert-notify accepted $ALERT_TYPE (HTTP 200)."
exit 0
