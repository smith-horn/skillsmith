#!/usr/bin/env bash
# SMI-7167 (ADR-183): the two dispatch-phase rows of the backfill autochain's liveness ledger.
#
#   autochain-ledger.sh prepared   before `Dispatch next chunk`. Writes `since` (now - 10 min, UTC) to
#                                  $GITHUB_OUTPUT FIRST, then POSTs one
#                                  indexer_backfill_autochain_dispatch_prepared row, 3 attempts.
#                                  FAIL CLOSED: exit 1 when every attempt fails, so the dispatch
#                                  step (implicit success()) is skipped. An unwatched dispatch is the
#                                  defect this ledger exists to prevent.
#   autochain-ledger.sh resolved   right after `Dispatch next chunk`, `if: always()` once prepared was
#                                  attempted. Looks up indexer-backfill.yml runs created at or after
#                                  `since` whose title contains the exact `[tok=<token>]` (closing
#                                  bracket included, so ac-123 never matches ac-1234), then writes one
#                                  indexer_backfill_autochain_dispatch_resolved row:
#                                    exactly 1 run           -> outcome dispatched, dispatched_run_id
#                                    0 runs, dispatch did not succeed (failure/cancelled/skipped)
#                                                            -> outcome not_dispatched
#                                    0 runs after a successful dispatch, 2+ runs, a lookup or write
#                                    error                   -> no row; warn (the detector's Arm B
#                                                               pages "ambiguous")
#                                  Sets dispatched_run_id in $GITHUB_OUTPUT when it found one. ALWAYS
#                                  exits 0: it must never change the job's result.
#
# Every value arrives through the environment and is JSON-encoded by node; ids are JSON strings.
# GitHub's run list is parsed with JSON.parse, so a run id is exact only up to 2^53 (about 9e15);
# run ids were about 4e10 in 2026-10, so that bound is far off.
# Ledger key: (dispatch_token, link_run_attempt), because a re-run attempt keeps GITHUB_RUN_ID.
#
# Env (both): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
#             GITHUB_OUTPUT, LEDGER_SUPABASE_ENV.
#   prepared: LEDGER_IS_RESUME, LEDGER_RESUME_FROM.
#   resolved: GH_TOKEN, GITHUB_REPOSITORY, LEDGER_SINCE (prepared's output; empty -> now - 30 min),
#             LEDGER_DISPATCH_OUTCOME (steps.dispatch.outcome).
# Test seams: LEDGER_POLLS (default 6), LEDGER_POLL_SLEEP (default 15), LEDGER_RETRY_SLEEP (default 2,
#             doubled per retry). Requires node, curl, gh, GNU date.
set -uo pipefail

MODE="${1:-}"
TOKEN="ac-${GITHUB_RUN_ID:-}"

post_row() { # $1 = JSON body; prints the HTTP status
  local http="000" code
  if code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" \
    -d "$1" "$SUPABASE_URL/rest/v1/audit_logs"); then
    http="$code"
  fi
  printf '%s' "$http"
}

row_body() { # env LEDGER_ROW_* -> one audit_logs row
  node -e '
    const e = process.env;
    const meta = JSON.parse(e.LEDGER_ROW_META);
    process.stdout.write(JSON.stringify({
      event_type: e.LEDGER_ROW_EVENT, actor: "system", action: e.LEDGER_ROW_ACTION,
      resource: e.LEDGER_ROW_RESOURCE, result: "success", metadata: meta,
    }));'
}

case "$MODE" in
  prepared)
    for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_OUTPUT; do
      [ -n "${!v:-}" ] || { echo "::error::autochain-ledger prepared: $v is not set -- refusing to dispatch unwatched."; exit 1; }
    done
    SINCE=$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ) || { echo "::error::autochain-ledger prepared: could not compute since -- refusing to dispatch unwatched."; exit 1; }
    echo "since=$SINCE" >> "$GITHUB_OUTPUT"
    META=$(LEDGER_SINCE="$SINCE" node -e '
      const e = process.env;
      process.stdout.write(JSON.stringify({
        dispatch_token: "ac-" + e.GITHUB_RUN_ID, link_run_id: e.GITHUB_RUN_ID,
        link_run_attempt: e.GITHUB_RUN_ATTEMPT, supabase_env: e.LEDGER_SUPABASE_ENV || "",
        is_resume: e.LEDGER_IS_RESUME === "true", resume_from: e.LEDGER_RESUME_FROM || "",
        since: e.LEDGER_SINCE,
      }));') || { echo "::error::autochain-ledger prepared: could not build the row -- refusing to dispatch unwatched."; exit 1; }
    BODY=$(LEDGER_ROW_EVENT=indexer_backfill_autochain_dispatch_prepared LEDGER_ROW_ACTION=backfill_autochain_dispatch_prepared \
      LEDGER_ROW_RESOURCE="$TOKEN" LEDGER_ROW_META="$META" row_body) || { echo "::error::autochain-ledger prepared: could not build the row -- refusing to dispatch unwatched."; exit 1; }
    DELAY="${LEDGER_RETRY_SLEEP:-2}"
    for attempt in 1 2 3; do
      HTTP=$(post_row "$BODY")
      case "$HTTP" in
        2??) echo "Recorded dispatch_prepared for $TOKEN (attempt $GITHUB_RUN_ATTEMPT), HTTP $HTTP."; exit 0 ;;
      esac
      echo "::warning::autochain-ledger prepared: write attempt $attempt returned HTTP $HTTP."
      [ "$attempt" = 3 ] || { sleep "$DELAY"; DELAY=$((DELAY * 2)); }
    done
    echo "::error::autochain-ledger prepared: could not record the dispatch intent after 3 attempts -- refusing to dispatch an unwatched run (SMI-7167, ADR-183)."
    exit 1
    ;;

  resolved)
    for v in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_OUTPUT GITHUB_REPOSITORY; do
      [ -n "${!v:-}" ] || { echo "::warning::autochain-ledger resolved: $v is not set -- nothing recorded; the detector will page this dispatch as ambiguous."; exit 0; }
    done
    OUTCOME="${LEDGER_DISPATCH_OUTCOME:-}"
    SINCE="${LEDGER_SINCE:-}"
    if [ -z "$SINCE" ]; then
      SINCE=$(date -u -d '-30 minutes' +%Y-%m-%dT%H:%M:%SZ) || SINCE=""
    fi
    [ -n "$SINCE" ] || { echo "::warning::autochain-ledger resolved: no lookup floor -- nothing recorded; the detector will page this dispatch as ambiguous."; exit 0; }
    POLLS="${LEDGER_POLLS:-6}"
    [ "$OUTCOME" = "skipped" ] && POLLS=1
    COUNT="" IDS=""
    for poll in $(seq 1 "$POLLS"); do
      [ "$OUTCOME" = "skipped" ] || sleep "${LEDGER_POLL_SLEEP:-15}"
      RAW=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/indexer-backfill.yml/runs?created=%3E%3D$SINCE&per_page=100") || {
        echo "::warning::autochain-ledger resolved: run lookup failed on poll $poll."; COUNT=""; continue; }
      IDS=$(LEDGER_RAW="$RAW" LEDGER_NEEDLE="[tok=$TOKEN]" node -e '
        const runs = (JSON.parse(process.env.LEDGER_RAW).workflow_runs || []);
        const hit = runs.filter(r => typeof r.display_title === "string" && r.display_title.includes(process.env.LEDGER_NEEDLE));
        process.stdout.write(hit.map(r => String(r.id)).join(","));') || { echo "::warning::autochain-ledger resolved: unparseable run list on poll $poll."; COUNT=""; continue; }
      if [ -z "$IDS" ]; then COUNT=0; else COUNT=$(printf '%s\n' "$IDS" | tr ',' '\n' | wc -l | tr -d ' '); fi
      [ "$COUNT" = 0 ] || break
    done
    case "$COUNT" in
      1) RESULT=dispatched ;;
      0) case "$OUTCOME" in
           success) echo "::warning::autochain-ledger resolved: the dispatch step succeeded but no run titled [tok=$TOKEN] appeared after $POLLS poll(s) -- nothing recorded; the detector will page this dispatch as ambiguous."; exit 0 ;;
           *) RESULT=not_dispatched ;;
         esac ;;
      "") echo "::warning::autochain-ledger resolved: the run lookup never succeeded -- nothing recorded; the detector will page this dispatch as ambiguous."; exit 0 ;;
      *) echo "::warning::autochain-ledger resolved: $COUNT runs carry [tok=$TOKEN] ($IDS) -- nothing recorded; the detector will page this dispatch as ambiguous."; exit 0 ;;
    esac
    META=$(LEDGER_RESULT="$RESULT" LEDGER_IDS="$IDS" LEDGER_OUTCOME="$OUTCOME" node -e '
      const e = process.env;
      const m = {
        dispatch_token: "ac-" + e.GITHUB_RUN_ID, link_run_id: e.GITHUB_RUN_ID,
        link_run_attempt: e.GITHUB_RUN_ATTEMPT, supabase_env: e.LEDGER_SUPABASE_ENV || "",
        outcome: e.LEDGER_RESULT, dispatch_step_outcome: e.LEDGER_OUTCOME || "",
      };
      if (e.LEDGER_RESULT === "dispatched") m.dispatched_run_id = e.LEDGER_IDS;
      process.stdout.write(JSON.stringify(m));') || { echo "::warning::autochain-ledger resolved: could not build the row -- nothing recorded."; exit 0; }
    BODY=$(LEDGER_ROW_EVENT=indexer_backfill_autochain_dispatch_resolved LEDGER_ROW_ACTION=backfill_autochain_dispatch_resolved \
      LEDGER_ROW_RESOURCE="$TOKEN" LEDGER_ROW_META="$META" row_body) || { echo "::warning::autochain-ledger resolved: could not build the row -- nothing recorded."; exit 0; }
    HTTP=$(post_row "$BODY")
    case "$HTTP" in
      2??) ;;
      *) echo "::warning::autochain-ledger resolved: write returned HTTP $HTTP -- nothing recorded; the detector will page this dispatch as ambiguous."; exit 0 ;;
    esac
    if [ "$RESULT" = dispatched ]; then
      echo "dispatched_run_id=$IDS" >> "$GITHUB_OUTPUT"
      echo "Recorded dispatch_resolved for $TOKEN: dispatched run $IDS."
    else
      echo "Recorded dispatch_resolved for $TOKEN: not dispatched (dispatch step $OUTCOME)."
    fi
    exit 0
    ;;

  *)
    echo "::error::autochain-ledger: usage: autochain-ledger.sh prepared|resolved"
    exit 2
    ;;
esac
