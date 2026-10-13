#!/usr/bin/env bash
# SMI-7113: alert when the indexer's upsert was refused by the upstream WAF.
#
# Reads the indexer's output file (scripts/indexer/run.ts, one JSON summary as the
# last line) and POSTs alert-notify `indexer_upsert_blocked` when the run reports a
# NEWLY blocked row or an exhausted bisect budget. Independent of the SMI-6220
# degraded-alert shadow: this signal is a different failure class and always sends
# unless SKILLSMITH_INDEXER_UPSERT_BLOCK_ALERT_DISABLE=1 (which skips ONLY the POST;
# every check below still runs, so a broken output file is still loud).
#
# Output-file provenance (R2-6): line 1 of the file is written by the workflow as
#   {"provenance":{"run_id":"<GITHUB_RUN_ID>","run_attempt":"<GITHUB_RUN_ATTEMPT>"}}
# and the script rejects any mismatch, so a stale file from an earlier run/attempt on
# a reused runner can never be mistaken for this run's result.
#
# Exit 0: nothing to alert (skip, clean, lock-skip, or alert delivered / disabled).
# Exit 1: provenance absent or mismatched, output unparseable, a field of the wrong
#         type, or alert-notify did not return 200.
#
# Env: INDEXER_OUTPUT_FILE, INDEXER_STEP_OUTCOME (steps.<id>.outcome), GITHUB_RUN_ID,
#      GITHUB_RUN_ATTEMPT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RUN_URL,
#      WORKFLOW_NAME, SKILLSMITH_INDEXER_UPSERT_BLOCK_ALERT_DISABLE (optional).
set -uo pipefail

summary() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    { echo ""; echo "### Upstream upsert block"; echo ""; echo "$1"; } >> "$GITHUB_STEP_SUMMARY"
  fi
}

# The indexer step failed or was skipped: `Send Alert on Failure` already covers it.
if [ "${INDEXER_STEP_OUTCOME:-}" != "success" ]; then
  summary "Upstream block check: SKIPPED (indexer step outcome '${INDEXER_STEP_OUTCOME:-unset}')"
  exit 0
fi

FILE="${INDEXER_OUTPUT_FILE:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "::error::alert-upstream-block: indexer output file is absent -- cannot read the upsert-block signal."
  exit 1
fi
if [ -z "${GITHUB_RUN_ID:-}" ] || [ -z "${GITHUB_RUN_ATTEMPT:-}" ]; then
  echo "::error::alert-upstream-block: GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT not set -- cannot verify provenance."
  exit 1
fi

# node (not jq): present on the runner and in the dev container, jq is not.
# Prints a verdict on line 1; for an alert, the alert-notify JSON body on line 2.
VERDICT_FILE="$(mktemp)"
trap 'rm -f "$VERDICT_FILE"' EXIT
# shellcheck disable=SC2016  # the JS is deliberately single-quoted: no shell expansion inside it
node -e '
const fs = require("node:fs")
const [file, runId, attempt, runUrl, workflow] = process.argv.slice(1)
const out = (verdict, detail) => { console.log(verdict); if (detail !== undefined) console.log(detail); process.exit(0) }
const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0)
let prov
try { prov = JSON.parse(lines[0] ?? "").provenance } catch { prov = undefined }
if (!prov || typeof prov !== "object") out("PROVENANCE_MISSING")
if (String(prov.run_id) !== runId || String(prov.run_attempt) !== attempt) {
  out("PROVENANCE_MISMATCH", `file says run ${prov.run_id}/${prov.run_attempt}, this is ${runId}/${attempt}`)
}
if (lines.length < 2) out("UNPARSEABLE", "no indexer output after the provenance line")
let res
try { res = JSON.parse(lines[lines.length - 1]) } catch (e) { out("UNPARSEABLE", "last line is not JSON") }
if (res === null || typeof res !== "object" || Array.isArray(res)) out("UNPARSEABLE", "last line is not a JSON object")
if (res.event === "lock_held_by_other_run" && !("meta" in res)) out("LOCK_SKIP")
const data = res.data
if (data === null || typeof data !== "object") out("UNPARSEABLE", "summary has no data object")
const nb = data.upsert_newly_blocked
if (nb !== undefined && !Array.isArray(nb)) out("UNPARSEABLE", "data.upsert_newly_blocked is not an array")
const ex = data.upsert_block_budget_exhausted
if (ex !== undefined && typeof ex !== "boolean") out("UNPARSEABLE", "data.upsert_block_budget_exhausted is not a boolean")
const newly = nb ?? []
if (newly.length === 0 && ex !== true) out("CLEAN")
const parts = []
if (newly.length > 0) {
  const rows = newly.slice(0, 20).map((b) => `${b.fullName} (${b.repoUrl}, ${b.payloadBytes} bytes, Ray ID ${b.rayId ?? "unknown"})`)
  parts.push(`${newly.length} newly blocked row(s) refused by the upstream WAF (identity only, no content): ${rows.join("; ")}`)
}
if (ex === true) parts.push("the per-flush bisect request budget was exhausted, so some rows failed unisolated")
const message = `The indexer upsert was blocked upstream: ${parts.join(". Also, ")}.`
out("ALERT", JSON.stringify({ type: "indexer_upsert_blocked", message, workflow, runId, runUrl }))
' "$FILE" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "${RUN_URL:-}" "${WORKFLOW_NAME:-Skill Indexer}" > "$VERDICT_FILE"
NODE_RC=$?
if [ "$NODE_RC" -ne 0 ]; then
  echo "::error::alert-upstream-block: the output parser itself failed (exit $NODE_RC)."
  exit 1
fi

VERDICT="$(sed -n '1p' "$VERDICT_FILE")"
DETAIL="$(sed -n '2p' "$VERDICT_FILE")"
case "$VERDICT" in
  PROVENANCE_MISSING)
    echo "::error::alert-upstream-block: line 1 of the indexer output file carries no provenance -- refusing to trust it."
    exit 1 ;;
  PROVENANCE_MISMATCH)
    echo "::error::alert-upstream-block: provenance mismatch ($DETAIL) -- the output file is not from this run."
    exit 1 ;;
  UNPARSEABLE)
    echo "::error::alert-upstream-block: cannot read the indexer result after a successful step ($DETAIL)."
    exit 1 ;;
  LOCK_SKIP)
    summary "Upstream block check: SKIPPED (lock-skip shape, nothing was upserted)"
    exit 0 ;;
  CLEAN)
    summary "Upstream block check: clean (no newly blocked rows, budget not exhausted)"
    exit 0 ;;
  ALERT) ;;
  *)
    echo "::error::alert-upstream-block: unexpected parser verdict '$VERDICT'."
    exit 1 ;;
esac

if [ "${SKILLSMITH_INDEXER_UPSERT_BLOCK_ALERT_DISABLE:-}" = "1" ]; then
  summary "Upstream block check: BLOCKED ROWS FOUND but alert POST is disabled (SKILLSMITH_INDEXER_UPSERT_BLOCK_ALERT_DISABLE=1)"
  exit 0
fi

# SMI-5974 no-silent-delivery-failure shape: HTTP is "000" unless a curl call completed.
HTTP="000"
if RESPONSE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY:-}" \
  -H "Content-Type: application/json" \
  -d "$DETAIL" \
  "${SUPABASE_URL:-}/functions/v1/alert-notify"); then
  HTTP="$RESPONSE_CODE"
fi
summary "Upstream block check: ALERT sent (alert-notify HTTP $HTTP)"
if [ "$HTTP" != "200" ]; then
  echo "::error::alert-notify returned $HTTP -- email was NOT sent."
  exit 1
fi
exit 0
