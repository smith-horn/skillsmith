#!/usr/bin/env bash
# smi-7114-w0-measure.sh -- OWNER-RUN staging measurements W0-1, W0-2, W0-3 for SMI-7114
# (plan: docs/internal/implementation/smi-7112-indexer-ops-reliability-sparc.md, "Wave 0").
#
#   W0-1  Does pg_net accept timeout_milliseconds := 300000, and does a staging refresh then
#         record 200?                                                  Decides: T (pg_net timeout)
#   W0-2  With 5000ms, does a ~90s refresh still complete on the callee side?
#                                      Decides: wording of `transport_error` in observer alerts
#   W0-3  Which key format does the gateway accept for this function (eyJ JWT vs sb_secret_)?
#                                              Decides: which vault secret to provision
#
# STAGING ONLY. Hard-refuses unless STAGING_SUPABASE_PROJECT_REF is exactly the staging ref
# (ovhcifugwqnzoebwfuku); the prod ref (vrcnzpmndtroqxxoqkzy) is refused. `--self-test` runs the
# guard's case table without touching any database.
#
# Side effects on staging: W0-1 and W0-2 each run a REAL refresh (writes skills metadata, writes a
# refresh:run audit row, spends staging GitHub quota). W0-3 uses batchSize 1 + dryRun true so the
# auth question is answered without a full refresh (a deliberate deviation from the plan's "two
# staging calls": the gateway decides 200 vs 401 before the handler runs, so the body does not
# change the answer). No secret is read into this shell: vault values are read and used inside
# SQL, and only the format label (eyJ / sb_secret_ / other / missing) and status codes come back.
#
# Usage:
#   varlock run -- ./scripts/staging/smi-7114-w0-measure.sh [options]
#   ./scripts/staging/smi-7114-w0-measure.sh --self-test      (no env, no database)
#
# Options:
#   --only w0-1,w0-2,w0-3     run a subset (default: all three, in order)
#   --key-secret NAME         vault secret for W0-1 / W0-2 (default refresh_metadata_service_role_key,
#                             the name the SMI-7114 migration reads)
#   --eyj-secret NAME         W0-3: vault secret holding a legacy eyJ JWT service-role key
#   --sb-secret NAME          W0-3: vault secret holding an sb_secret_ service-role key
#                             The vault names that hold each format on staging cannot be determined
#                             from the repo (plan fact 12 gives counts only), so W0-3 takes them as
#                             arguments; the script verifies the format label inside the DB and
#                             refuses a mislabelled secret.
#   --timeout-ms N            W0-1 timeout (default 300000)
#   --yes                     skip the interactive confirmation
#   --self-test               run the staging-ref guard case table and exit
#   -h, --help
#
# Requires: skillsmith-dev-1 container running (scripts/pooler-psql.sh), staging vault secrets
# provisioned (the SMI-7114 runbook: `refresh_metadata_service_role_key`).
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=smi-7114-staging-lib.sh
. "$SCRIPT_DIR/smi-7114-staging-lib.sh"

ONLY="w0-1,w0-2,w0-3"
KEY_SECRET="refresh_metadata_service_role_key"
EYJ_SECRET=""
SB_SECRET=""
TIMEOUT_MS=300000
SELF_TEST=0
FN_PATH="/functions/v1/skills-refresh-metadata"
REAL_BODY='{"batchSize":200,"staleDays":1,"dryRun":false}'
PROBE_BODY='{"batchSize":1,"staleDays":1,"dryRun":true}'

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:?--only needs a value}"; shift 2 ;;
    --key-secret) KEY_SECRET="${2:?--key-secret needs a value}"; shift 2 ;;
    --eyj-secret) EYJ_SECRET="${2:?--eyj-secret needs a value}"; shift 2 ;;
    --sb-secret) SB_SECRET="${2:?--sb-secret needs a value}"; shift 2 ;;
    --timeout-ms) TIMEOUT_MS="${2:?--timeout-ms needs a value}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --self-test) SELF_TEST=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

if [ "$SELF_TEST" = 1 ]; then
  guard_self_test
  exit $?
fi

case "$TIMEOUT_MS" in '' | *[!0-9]*) die "--timeout-ms must be a positive integer" ;; esac
for name in "$KEY_SECRET" "$EYJ_SECRET" "$SB_SECRET"; do
  case "$name" in *[!A-Za-z0-9_.-]*) die "vault secret names may contain only [A-Za-z0-9_.-]" ;; esac
done

want() {
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

SUMMARY_LINES=()
add_summary() { SUMMARY_LINES+=("$1"); }
KEY_FMT=""

# Sets KEY_FMT to eyJ | sb_secret_ | other | missing (a label, never the value).
key_format() {
  run_sql -v "keyname=$1" <<'SQL' || return 1
SELECT '@@fmt=' || coalesce(
  (SELECT CASE WHEN left(decrypted_secret, 3) = 'eyJ' THEN 'eyJ'
               WHEN left(decrypted_secret, 10) = 'sb_secret_' THEN 'sb_secret_'
               WHEN length(trim(decrypted_secret)) = 0 THEN 'missing'
               ELSE 'other' END
     FROM vault.decrypted_secrets WHERE name = :'keyname' LIMIT 1),
  'missing');
SQL
  KEY_FMT=$(kv fmt)
}

# Fires one pg_net POST at the staging function with the key read inside SQL. Sets PROBE_RID, PROBE_T0.
fire_probe() {
  local keyname="$1" timeout="$2" body="$3"
  PROBE_RID=""
  PROBE_T0=""
  run_sql -v "url=${BASE_URL}${FN_PATH}" -v "keyname=$keyname" -v "timeout=$timeout" -v "body=$body" <<'SQL' || return 1
SELECT '@@t0=' || clock_timestamp()::text;
SELECT '@@rid=' || net.http_post(
  url := :'url',
  body := :'body'::jsonb,
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = :'keyname' LIMIT 1)
  ),
  timeout_milliseconds := :timeout
)::text;
SQL
  PROBE_T0=$(kv t0)
  PROBE_RID=$(kv rid)
  [ -n "$PROBE_RID" ] || return 1
}

# Fire + wait. Echoes a one-line outcome, sets OUTCOME_FOUND/STATUS/TIMED_OUT/ERR/LAT/RID.
run_probe() {
  local label="$1" keyname="$2" timeout="$3" body="$4" wait_s="$5"
  key_format "$keyname" || die "$label: could not read the vault format label"
  if [ "$KEY_FMT" = "missing" ]; then
    die "$label: vault secret '$keyname' is missing or empty on staging (provision it first; see the SMI-7114 migration runbook)"
  fi
  echo "$label: vault secret '$keyname' format=$KEY_FMT; POST timeout_milliseconds=$timeout" >&2
  fire_probe "$keyname" "$timeout" "$body" || die "$label: net.http_post failed (pg_net rejected the call; see error above)"
  echo "$label: request id $PROBE_RID fired at $PROBE_T0 (DB clock); polling up to ${wait_s}s" >&2
  OUTCOME_RID="$PROBE_RID"
  OUTCOME_T0="$PROBE_T0"
  OUTCOME_FMT="$KEY_FMT"
  if poll_response "$PROBE_RID" "$wait_s" "$PROBE_T0"; then
    OUTCOME_FOUND=1
  else
    OUTCOME_FOUND=0
  fi
  OUTCOME_STATUS="$RESP_STATUS"
  OUTCOME_TIMED_OUT="$RESP_TIMED_OUT"
  OUTCOME_ERR="$RESP_ERR"
  OUTCOME_LAT="$RESP_LAT"
}

describe_outcome() {
  if [ "$OUTCOME_FOUND" = 1 ]; then
    printf 'status_code=%s timed_out=%s error_msg=[%s] response_after=%ss' \
      "$OUTCOME_STATUS" "$OUTCOME_TIMED_OUT" "${OUTCOME_ERR:--}" "${OUTCOME_LAT:-?}"
  else
    printf 'NO RESPONSE ROW for request id %s within the wait (not the same as a failure: re-check later)' "$OUTCOME_RID"
  fi
}

w0_1() {
  echo "--- W0-1: timeout_milliseconds=$TIMEOUT_MS against the real refresh ---"
  run_probe "W0-1" "$KEY_SECRET" "$TIMEOUT_MS" "$REAL_BODY" 360
  W01_STATUS="$OUTCOME_STATUS"
  W01_FOUND="$OUTCOME_FOUND"
  W01_DESC=$(describe_outcome)
  echo "W0-1 result: $W01_DESC"
  if [ "$W01_FOUND" = 1 ] && [ "$W01_STATUS" = "200" ]; then
    add_summary "- **W0-1:** pg_net accepted \`timeout_milliseconds := $TIMEOUT_MS\`; the staging refresh returned **200** (\`$W01_DESC\`). T = $TIMEOUT_MS is confirmed."
  else
    add_summary "- **W0-1:** T = $TIMEOUT_MS is **NOT confirmed**: $W01_DESC. Do not ship this T until a 200 is recorded."
  fi
}

w0_2() {
  echo "--- W0-2: timeout_milliseconds=5000 against the real refresh ---"
  if [ "${W01_FOUND:-1}" != 1 ] || [ "${W01_STATUS:-200}" != "200" ]; then
    echo "W0-2: W0-1 left no clean 200, so its refresh may still be running; waiting 200s so its audit row cannot be mistaken for W0-2's" >&2
    sleep 200
  fi
  run_probe "W0-2" "$KEY_SECRET" 5000 "$REAL_BODY" 90
  local pgnet_desc
  pgnet_desc=$(describe_outcome)
  echo "W0-2 pg_net outcome: $pgnet_desc"
  echo "W0-2: now looking for a staging refresh:run row created after $OUTCOME_T0 (up to 300s)" >&2
  local waited=0 cnt=0 maxp=-1 first=""
  while :; do
    run_sql -v "t0=$OUTCOME_T0" <<'SQL' || die "W0-2: audit_logs query failed"
SELECT '@@cnt=' || count(*)::text
  FROM audit_logs WHERE event_type = 'refresh:run' AND created_at > :'t0'::timestamptz;
SELECT '@@maxp=' || coalesce(max((metadata->>'processed')::int), -1)::text
  FROM audit_logs WHERE event_type = 'refresh:run' AND created_at > :'t0'::timestamptz;
SELECT '@@first=' || coalesce(round(extract(epoch FROM (min(created_at) - :'t0'::timestamptz))::numeric, 1)::text, '')
  FROM audit_logs WHERE event_type = 'refresh:run' AND created_at > :'t0'::timestamptz;
SQL
    cnt=$(kv cnt)
    maxp=$(kv maxp)
    first=$(kv first)
    if [ "${cnt:-0}" -gt 0 ] || [ "$waited" -ge 300 ]; then break; fi
    sleep 10
    waited=$((waited + 10))
  done
  local landed
  if [ "${cnt:-0}" -gt 0 ] && [ "${maxp:--1}" -gt 0 ]; then
    landed="a refresh:run landed ${first}s after the call with processed=$maxp (the callee COMPLETED despite the 5000ms client timeout)"
  elif [ "${cnt:-0}" -gt 0 ]; then
    landed="a refresh:run landed ${first}s after the call but processed=0 (no stale skills on staging; INCONCLUSIVE for the question asked)"
  else
    landed="NO refresh:run row within 300s (the callee did not complete, or never ran)"
  fi
  echo "W0-2 callee: $landed"
  add_summary "- **W0-2:** pg_net outcome at 5000ms: \`$pgnet_desc\`. Callee: $landed."
}

w0_3() {
  echo "--- W0-3: gateway key formats (batchSize 1, dryRun true; the gateway decides before the handler) ---"
  if [ -z "$EYJ_SECRET" ] || [ -z "$SB_SECRET" ]; then
    die "W0-3 needs --eyj-secret NAME and --sb-secret NAME (the staging vault secrets holding each key format; not derivable from the repo)"
  fi
  local pair label name expect
  for pair in "eyJ|$EYJ_SECRET" "sb_secret_|$SB_SECRET"; do
    expect="${pair%%|*}"
    name="${pair#*|}"
    run_probe "W0-3[$expect]" "$name" 300000 "$PROBE_BODY" 360
    label="$expect"
    if [ "$OUTCOME_FMT" != "$expect" ]; then
      echo "W0-3: vault secret '$name' has format '$OUTCOME_FMT', not '$expect'; result NOT counted" >&2
      add_summary "- **W0-3 [$label]:** vault secret \`$name\` actually holds format \`$OUTCOME_FMT\`; not measured."
      continue
    fi
    echo "W0-3 [$label] -> $(describe_outcome)"
    add_summary "- **W0-3 [$label]:** gateway status **${OUTCOME_STATUS:-no response}** (\`$(describe_outcome)\`)."
  done
}

staging_init
confirm_or_exit "About to run on STAGING ($STAGING_REF), tests: $ONLY.
  W0-1 / W0-2 each trigger a real skills-refresh-metadata run (writes staging skills metadata + a refresh:run audit row).
  W0-3 sends two batchSize=1 dryRun requests. No secret is printed; no vault value is changed."

if want w0-1; then w0_1; fi
if want w0-2; then w0_2; fi
if want w0-3; then w0_3; fi

echo
echo "================ PASTE INTO THE PLAN DOC (Wave 0 results) ================"
echo "**W0-1...W0-3 results ($(date -u +%F), owner, staging ref $STAGING_REF) [measured]:**"
if [ "${#SUMMARY_LINES[@]}" -gt 0 ]; then
  for line in "${SUMMARY_LINES[@]}"; do
    echo "$line"
  done
else
  echo "(no test selected: --only matched none of w0-1, w0-2, w0-3)"
fi
echo "=========================================================================="
echo "No vault secret, key, or function body was changed or printed. Staging refresh data was written by W0-1/W0-2 (real runs)."
