#!/usr/bin/env bash
# SMI-4459 — failure-payload formatter + alert dispatch.
# Invoked by the workflow's `alert` job (which holds SUPABASE_SERVICE_ROLE_KEY).
# Reads the smoke report JSON from --report and the workflow run URL from
# --run-url, formats a human-readable email body, and POSTs to alert-notify.

set -euo pipefail
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"

REPORT_FILE=""
RUN_URL=""
SHA=""

while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT_FILE="$2"; shift 2 ;;
    --run-url) RUN_URL="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    *) smoke_warn "unknown arg: $1"; shift ;;
  esac
done

if [ -z "$REPORT_FILE" ] || [ ! -f "$REPORT_FILE" ]; then
  smoke_warn "alert.sh: --report file missing or not provided"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  smoke_warn "alert.sh: jq required but not installed"
  exit 1
fi

# Pluck failed surfaces + checks for the subject line.
FAILED_SUBJECTS=$(jq -r '.results | map(select(.status == "fail")) | map("\(.surface)::\(.check)") | join(", ")' "$REPORT_FILE")
if [ -z "$FAILED_SUBJECTS" ]; then
  smoke_warn "alert.sh: no failures in report — nothing to alert"
  exit 0
fi

SUBJECT="Smoke-prod FAILED: $FAILED_SUBJECTS"

# Format a body table (one line per failed result).
BODY=$(jq -r --arg run "$RUN_URL" --arg sha "$SHA" '
  "Smoke-prod failure on " + $sha + "\n" +
  "Run: " + $run + "\n\n" +
  "Failures:\n" +
  (.results | map(select(.status == "fail")) | map(
    "  - [" + .surface + "] " + .check +
    "\n    URL: " + (.url // "n/a") +
    "\n    Expected: " + (.expected // "n/a") +
    "\n    Actual: " + (.actual // "n/a")
  ) | join("\n\n"))
' "$REPORT_FILE")

# POST to alert-notify. Caller MUST have SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  smoke_warn "alert.sh: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing — printing payload only"
  printf 'Subject: %s\n\n%s\n' "$SUBJECT" "$BODY"
  exit 0
fi

PAYLOAD=$(jq -nc \
  --arg to "support@smithhorn.ca" \
  --arg subject "$SUBJECT" \
  --arg body "$BODY" \
  '{to: $to, subject: $subject, body: $body}')

curl --silent --show-error --fail \
  --max-time 15 \
  -X POST \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "content-type: application/json" \
  -d "$PAYLOAD" \
  "${SUPABASE_URL}/functions/v1/alert-notify" \
  >/dev/null
smoke_log "alert posted to alert-notify"
