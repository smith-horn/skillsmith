#!/usr/bin/env bash
# smi-7114-refresh-faults.sh -- OWNER-RUN staging fault harness for the SMI-7114 metadata-refresh
# pg_cron trigger + observer RPC + dead-man (plan: docs/internal/implementation/
# smi-7112-indexer-ops-reliability-sparc.md, Wave 3a "RED TESTS"). The repo has no live-Postgres
# harness, so the SQL in supabase/migrations/20261013000000_skills_refresh_metadata_pg_cron.sql is
# proven here, on staging, after the migration is applied there.
#
#   F1       base-URL secret bent to a nonexistent path => RPC lists an http_error entry
#   F2       1ms pg_net timeout => RPC lists a transport_error (status NULL, timed_out NULL; fact 11)
#   F3       dispatch row older than 6h with no response => counted `unknown`, NOT a failure
#   F4       p_window := '1 minute' while the last refresh:run is older => staleness is visible
#   deadman  dead-man test 5: SLA comparison + once-a-day dedup of check_refresh_observer_heartbeat
#   overlap  R3-7: the pg_cron path and a manual POST at once => no corruption (+ a control leg)
#
# Every assertion test is paired with its plan mutation (the RED check): the mutation is applied
# inside BEGIN ... ROLLBACK with CREATE OR REPLACE FUNCTION (built from pg_get_functiondef plus a
# regexp edit, verified to have CHANGED the function), the SAME assertion is re-evaluated, and the
# test is only RED-OK if the assertion would FAIL under the mutation. A mutation whose regexp no
# longer matches the function text is RED-UNVERIFIED (never silently green): adjust the MUT_* values.
#
# STAGING ONLY: hard-refuses unless STAGING_SUPABASE_PROJECT_REF is exactly the staging ref
# (ovhcifugwqnzoebwfuku); the prod ref (vrcnzpmndtroqxxoqkzy) is refused. `--self-test` runs the
# guard's case table with no database and no env.
#
# What it changes on staging (printed again at exit, names only):
#   - vault secret refresh_metadata_functions_base_url: briefly suffixed by F1, RESTORED by a trap
#     (the original value never leaves the database; restore strips the suffix deterministically)
#   - audit_logs: harness-marked rows (refresh:dispatch for F2/F3, refresh:observer for deadman) and
#     the F1 dispatch row; deleted at exit unless --keep-rows (may fail if audit_logs is append-only)
#   - pg_net requests: F1 and F2 call the real skills-refresh-metadata; the deadman committed leg
#     sends ONE real alert-notify request (staging may email its alert recipient); overlap runs
#     REAL refreshes (writes skills metadata)
#   - no DDL is left behind: every mutation is inside BEGIN ... ROLLBACK
#
# Usage:
#   varlock run -- ./scripts/staging/smi-7114-refresh-faults.sh [options]
#   ./scripts/staging/smi-7114-refresh-faults.sh --self-test
#
# Options:
#   --only f1,f2,f3,f4,deadman,overlap   run a subset (default: all)
#   --skip-red                           skip the mutation (RED) checks
#   --skip-overlap-control               skip the dryRun control leg of the overlap test
#   --keep-rows                          do not delete the harness audit_logs rows at exit
#   --yes                                skip the interactive confirmation
#   --self-test                          run the staging-ref guard case table and exit
#   -h, --help
#
# Exit: 0 all PASS / RED-OK; 1 any FAIL; 3 no FAIL but something INCONCLUSIVE / RED-UNVERIFIED.
#
# Prerequisites: the 20261013000000 migration applied to STAGING; staging vault secrets
# refresh_metadata_functions_base_url (== https://<staging-ref>.supabase.co) and
# refresh_metadata_service_role_key provisioned; skillsmith-dev-1 running.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=smi-7114-staging-lib.sh
. "$SCRIPT_DIR/smi-7114-staging-lib.sh"

ONLY="f1,f2,f3,f4,deadman,overlap"
SKIP_RED=0
SKIP_CONTROL=0
KEEP_ROWS=0
SELF_TEST=0
VAULT_DIRTY=0
CHANGED_ROWS=""
ROW_RIDS=""

# Mutations (plan RED TESTS column). Each is (regexp over pg_get_functiondef text, replacement).
# They are matched against supabase/migrations/20261013000000_skills_refresh_metadata_pg_cron.sql.
HEALTH_FN="public.refresh_metadata_health(interval)"
DEADMAN_FN="public.check_refresh_observer_heartbeat(interval)"
MUT_F1_RE="WHEN r\\.status_code NOT BETWEEN 200 AND 299\\s+THEN 'http_error'"
MUT_F1_TO=""
MUT_F2_RE="WHEN r\\.status_code IS NULL(\\s+)THEN 'transport_error'"
MUT_F2_TO="WHEN r.timed_out IS TRUE\\1THEN 'transport_error'"
MUT_F3_RE="WHEN r\\.id IS NULL AND d\\.created_at < now\\(\\) - v_ttl\\s+THEN 'unknown'"
MUT_F3_TO=""
MUT_DM1_RE="v_age > p_sla AND v_over_h % 24 = 0"
MUT_DM1_TO="true"
MUT_DM2_RE=" AND v_over_h % 24 = 0"
MUT_DM2_TO=""
NO_MUT_RE="ZZ_NO_MATCH_ZZ"

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:?--only needs a value}"; shift 2 ;;
    --skip-red) SKIP_RED=1; shift ;;
    --skip-overlap-control) SKIP_CONTROL=1; shift ;;
    --keep-rows) KEEP_ROWS=1; shift ;;
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

want() {
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

# --------------------------------------------------------------------------------------------
# Cleanup trap: restore the vault secret FIRST, then (unless --keep-rows) delete harness rows.
# --------------------------------------------------------------------------------------------
restore_vault() {
  run_sql <<'SQL' || return 1
SELECT '@@restored=' || count(vault.update_secret(id, regexp_replace(decrypted_secret, '/does-not-exist$', '')))::text
  FROM vault.decrypted_secrets
 WHERE name = 'refresh_metadata_functions_base_url' AND decrypted_secret ~ '/does-not-exist$';
SQL
  VAULT_DIRTY=0
}

delete_rows() {
  run_sql -v "rids=$ROW_RIDS" <<'SQL' || return 1
WITH d AS (
  DELETE FROM audit_logs
   WHERE (event_type = 'refresh:dispatch'
          AND (metadata->>'harness' LIKE 'smi-7114-%'
               OR metadata->>'net_request_id' = ANY (string_to_array(:'rids', ','))))
      OR (event_type = 'refresh:observer' AND metadata->>'harness' LIKE 'smi-7114-%')
  RETURNING 1)
SELECT '@@deleted=' || count(*)::text FROM d;
SQL
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ -n "$STAGING_REF" ]; then
    echo >&2
    echo "---- cleanup (changed state, names only) ----" >&2
    if [ "$VAULT_DIRTY" = 1 ]; then
      if restore_vault; then
        echo "vault secret refresh_metadata_functions_base_url: RESTORED (rows updated: $(kv restored))" >&2
      else
        echo "vault secret refresh_metadata_functions_base_url: RESTORE FAILED -- it still ends in /does-not-exist; strip it by hand" >&2
        rc=1
      fi
    else
      echo "vault secret refresh_metadata_functions_base_url: unchanged (or already restored)" >&2
    fi
    if [ "$KEEP_ROWS" = 0 ] && [ -n "$CHANGED_ROWS" ]; then
      if delete_rows; then
        echo "audit_logs harness rows: deleted $(kv deleted) (refresh:dispatch for $CHANGED_ROWS; refresh:observer)" >&2
      else
        echo "audit_logs harness rows: delete FAILED (append-only?) -- rows remain: refresh:dispatch ($CHANGED_ROWS) / refresh:observer marked metadata.harness='smi-7114-*'" >&2
      fi
    elif [ -n "$CHANGED_ROWS" ]; then
      echo "audit_logs harness rows kept (--keep-rows): refresh:dispatch ($CHANGED_ROWS) / refresh:observer marked metadata.harness='smi-7114-*'" >&2
    fi
    echo "pg_net requests sent: skills-refresh-metadata (F1, F2, overlap), alert-notify (deadman committed leg)" >&2
  fi
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
  exit "$rc"
}

# --------------------------------------------------------------------------------------------
# SQL building blocks (static text; parameters arrive as psql variables)
# --------------------------------------------------------------------------------------------
IFS= read -r -d '' MUT_PRELUDE <<'SQL' || true
SELECT pg_get_functiondef(:'mut_func'::regprocedure) AS def \gset
SELECT regexp_replace(:'def', :'mut_from', :'mut_to', 'g') AS mdef \gset
SELECT '@@mutation_applied=' || (:'def' <> :'mdef')::text;
SQL

IFS= read -r -d '' HEALTH_ENTRIES_SQL <<'SQL' || true
SELECT '@@n=' || count(*)::text
  FROM jsonb_array_elements(public.refresh_metadata_health('9 hours')->'failures') f
 WHERE (f->>'dispatched_at')::timestamptz >= :'t0'::timestamptz AND f->>'kind' = :'kind';
SELECT '@@codes=' || coalesce(string_agg(DISTINCT coalesce(f->>'status_code', 'NULL'), ','), '')
  FROM jsonb_array_elements(public.refresh_metadata_health('9 hours')->'failures') f
 WHERE (f->>'dispatched_at')::timestamptz >= :'t0'::timestamptz AND f->>'kind' = :'kind';
SQL

# red_eval FUNC RE TO BODY [extra -v args...]: runs BODY inside BEGIN; <mutated function>; BODY; ROLLBACK.
# Sets MUT_APPLIED from @@mutation_applied; BODY's @@ lines are left in LAST_OUT.
red_eval() {
  local func="$1" re="$2" to="$3" body="$4"
  shift 4
  run_sql -v "mut_func=$func" -v "mut_from=$re" -v "mut_to=$to" "$@" <<<"$MUT_PRELUDE
BEGIN;
SELECT :'mdef' \\gexec
$body
ROLLBACK;" || return 1
  MUT_APPLIED=$(kv mutation_applied)
}

# red_verdict NAME EXPECT_FIELD HEALTHY_VALUE: RED-OK iff the mutation applied AND the field changed.
red_verdict() {
  local name="$1" field="$2" healthy="$3" observed
  observed=$(kv "$field")
  if [ "$MUT_APPLIED" != "true" ]; then
    record "$name" "RED-UNVERIFIED" "mutation regexp did not change the function text -- update MUT_* to match the migration; nothing was proven"
  elif [ "$observed" != "$healthy" ]; then
    record "$name" "RED-OK" "under the mutation $field=$observed (healthy value $healthy): the assertion would FAIL"
  else
    record "$name" "FAIL" "mutation applied but $field stayed $healthy: the assertion does not constrain the mutated arm (decorative test)"
  fi
}

get_dispatch_rid() {
  run_sql -v "t0=$1" <<'SQL' || return 1
SELECT '@@rid=' || (metadata->>'net_request_id')
  FROM audit_logs
 WHERE event_type = 'refresh:dispatch' AND created_at >= :'t0'::timestamptz AND actor = 'pg_cron'
 ORDER BY created_at DESC LIMIT 1;
SQL
  kv rid
}

db_clock() {
  run_sql <<'SQL' || return 1
SELECT '@@t0=' || clock_timestamp()::text;
SQL
  kv t0
}

# --------------------------------------------------------------------------------------------
# F1
# --------------------------------------------------------------------------------------------
test_f1() {
  echo "--- F1: bent base URL => http_error ---"
  local t0 rid n codes
  t0=$(db_clock) || return 1
  VAULT_DIRTY=1
  run_sql <<'SQL' || { record "F1" "INCONCLUSIVE" "could not bend the vault base URL / run the dispatcher"; return 0; }
SELECT '@@bent=' || count(vault.update_secret(id, decrypted_secret || '/does-not-exist'))::text
  FROM vault.decrypted_secrets WHERE name = 'refresh_metadata_functions_base_url';
DO $$ BEGIN PERFORM public.invoke_skills_refresh_metadata(); END $$;
SQL
  restore_vault || echo "WARNING: restore failed; the exit trap will retry" >&2
  rid=$(get_dispatch_rid "$t0") || return 1
  if [ -z "$rid" ]; then record "F1" "INCONCLUSIVE" "no refresh:dispatch row after the dispatcher ran"; return 0; fi
  ROW_RIDS="${ROW_RIDS:+$ROW_RIDS,}$rid"; CHANGED_ROWS="${CHANGED_ROWS:+$CHANGED_ROWS }F1"
  if ! poll_response "$rid" 90 "$t0"; then
    record "F1" "INCONCLUSIVE" "no pg_net response for request $rid within 90s"; return 0
  fi
  run_sql -v "t0=$t0" -v "kind=http_error" <<<"$HEALTH_ENTRIES_SQL" || return 1
  n=$(kv n); codes=$(kv codes)
  if [ "${n:-0}" -ge 1 ]; then
    record "F1" "PASS" "RPC lists $n http_error (status $codes; response status_code=$RESP_STATUS); plan expected 404"
  else
    record "F1" "FAIL" "RPC listed no http_error although the response was status_code=$RESP_STATUS error_msg=[$RESP_ERR]"
  fi
  if [ "$SKIP_RED" = 0 ]; then
    red_eval "$HEALTH_FN" "$MUT_F1_RE" "$MUT_F1_TO" "$HEALTH_ENTRIES_SQL" -v "t0=$t0" -v "kind=http_error" || return 1
    red_verdict "F1-red (no non-2xx arm)" n "$n"
  fi
}

# --------------------------------------------------------------------------------------------
# F2
# --------------------------------------------------------------------------------------------
test_f2() {
  echo "--- F2: 1ms pg_net timeout => transport_error (status NULL, timed_out NULL) ---"
  local t0 rid n
  t0=$(db_clock) || return 1
  # Synthetic dispatch: the real dispatcher hard-codes T, so F2 sends its own 1ms request to the
  # SAME function with the SAME vault credentials and writes the refresh:dispatch row the
  # dispatcher would (marked metadata.harness). It exercises the RPC's classification, not T.
  run_sql <<'SQL' || { record "F2" "INCONCLUSIVE" "could not send the 1ms request"; return 0; }
WITH r AS (
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'refresh_metadata_functions_base_url')
           || '/functions/v1/skills-refresh-metadata',
    body := '{"batchSize":1,"staleDays":1,"dryRun":true}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'refresh_metadata_service_role_key')),
    timeout_milliseconds := 1) AS rid),
ins AS (
  INSERT INTO audit_logs (event_type, actor, action, result, metadata)
  SELECT 'refresh:dispatch', 'staging-harness', 'dispatch', 'queued',
         jsonb_build_object('net_request_id', rid, 'harness', 'smi-7114-f2')
    FROM r RETURNING metadata->>'net_request_id' AS rid)
SELECT '@@rid=' || rid FROM ins;
SQL
  rid=$(kv rid); CHANGED_ROWS="${CHANGED_ROWS:+$CHANGED_ROWS }F2"
  if ! poll_response "$rid" 90 "$t0"; then
    record "F2" "INCONCLUSIVE" "no pg_net response for request $rid within 90s"; return 0
  fi
  run_sql -v "t0=$t0" -v "kind=transport_error" <<<"$HEALTH_ENTRIES_SQL" || return 1
  n=$(kv n)
  if [ "$RESP_STATUS" = "NULL" ] && [ "${n:-0}" -ge 1 ]; then
    record "F2" "PASS" "status_code=NULL timed_out=$RESP_TIMED_OUT error_msg=[$RESP_ERR] => RPC lists $n transport_error (fact 11 expects timed_out NULL)"
  elif [ "$RESP_STATUS" != "NULL" ]; then
    record "F2" "INCONCLUSIVE" "the 1ms request got status_code=$RESP_STATUS, not the timeout shape; fact 11 may have changed"
  else
    record "F2" "FAIL" "response was the timeout shape (status NULL, timed_out=$RESP_TIMED_OUT) but the RPC listed no transport_error"
  fi
  if [ "$SKIP_RED" = 0 ]; then
    red_eval "$HEALTH_FN" "$MUT_F2_RE" "$MUT_F2_TO" "$HEALTH_ENTRIES_SQL" -v "t0=$t0" -v "kind=transport_error" || return 1
    red_verdict "F2-red (arm keyed on timed_out)" n "$n"
  fi
}

# --------------------------------------------------------------------------------------------
# F3
# --------------------------------------------------------------------------------------------
IFS= read -r -d '' F3_ASSERT_SQL <<'SQL' || true
SELECT '@@u_after=' || (public.refresh_metadata_health('9 hours')->>'unknown_count');
SELECT '@@n=' || count(*)::text
  FROM jsonb_array_elements(public.refresh_metadata_health('9 hours')->'failures') f
 WHERE abs(extract(epoch FROM ((f->>'dispatched_at')::timestamptz - :'ts'::timestamptz))) < 0.001;
SQL

test_f3() {
  echo "--- F3: dispatch older than 6h, no response => unknown, not a failure ---"
  local u_before ts n u_after
  run_sql <<'SQL' || { record "F3" "INCONCLUSIVE" "could not seed the old dispatch row"; return 0; }
SELECT '@@u_before=' || (public.refresh_metadata_health('9 hours')->>'unknown_count');
WITH ins AS (
  INSERT INTO audit_logs (event_type, actor, action, result, metadata, created_at)
  VALUES ('refresh:dispatch', 'staging-harness', 'dispatch', 'queued',
          jsonb_build_object('net_request_id', 1999999999999, 'harness', 'smi-7114-f3'),
          now() - interval '7 hours')
  RETURNING created_at)
SELECT '@@ts=' || created_at::text FROM ins;
SQL
  u_before=$(kv u_before); ts=$(kv ts); CHANGED_ROWS="${CHANGED_ROWS:+$CHANGED_ROWS }F3"
  run_sql -v "ts=$ts" <<<"$F3_ASSERT_SQL" || return 1
  n=$(kv n); u_after=$(kv u_after)
  if [ "${n:-1}" -eq 0 ] && [ "${u_after:-0}" -ge $((u_before + 1)) ]; then
    record "F3" "PASS" "7h-old dispatch with no response: not in failures; unknown_count $u_before -> $u_after"
  else
    record "F3" "FAIL" "failures entries for the 7h-old row=$n (want 0); unknown_count $u_before -> $u_after (want +1)"
  fi
  if [ "$SKIP_RED" = 0 ]; then
    red_eval "$HEALTH_FN" "$MUT_F3_RE" "$MUT_F3_TO" "$F3_ASSERT_SQL" -v "ts=$ts" || return 1
    red_verdict "F3-red (unknown collapsed)" n 0
  fi
}

# --------------------------------------------------------------------------------------------
# F4
# --------------------------------------------------------------------------------------------
test_f4() {
  echo "--- F4: p_window := '1 minute' with an older last refresh:run => staleness visible ---"
  local recent last stale
  run_sql <<'SQL' || { record "F4" "INCONCLUSIVE" "RPC call failed"; return 0; }
SELECT '@@recent=' || count(*)::text FROM audit_logs WHERE event_type = 'refresh:run' AND created_at > now() - interval '1 minute';
SELECT '@@last=' || coalesce(public.refresh_metadata_health('1 minute')->>'last_run', 'NULL');
SELECT '@@stale=' || ((public.refresh_metadata_health('1 minute')->>'last_run') IS NULL
  OR now() - (public.refresh_metadata_health('1 minute')->>'last_run')::timestamptz > interval '1 minute')::text;
SQL
  recent=$(kv recent); last=$(kv last); stale=$(kv stale)
  if [ "${recent:-0}" -ne 0 ]; then
    record "F4" "INCONCLUSIVE" "a refresh:run landed in the last minute on staging; wait and re-run"; return 0
  fi
  if [ "$stale" = "true" ]; then
    record "F4" "PASS" "RPC('1 minute') last_run=$last: an observer comparing it to the window sees staleness (observer-script arm logic is vitest-covered; the script is not run here because it POSTs alerts)"
  else
    record "F4" "FAIL" "RPC('1 minute') last_run=$last is within a minute although no refresh:run landed in the last minute"
  fi
}

# --------------------------------------------------------------------------------------------
# Preconditions
# --------------------------------------------------------------------------------------------
preconditions() {
  run_sql -v "base_url=$BASE_URL" <<'SQL' || die "precondition query failed"
SELECT '@@fn_inv=' || (to_regprocedure('public.invoke_skills_refresh_metadata()') IS NOT NULL)::text;
SELECT '@@fn_health=' || (to_regprocedure('public.refresh_metadata_health(interval)') IS NOT NULL)::text;
SELECT '@@fn_dm=' || (to_regprocedure('public.check_refresh_observer_heartbeat(interval)') IS NOT NULL)::text;
SELECT '@@base=' || coalesce((SELECT CASE WHEN rtrim(decrypted_secret, '/') = :'base_url' THEN 'match' ELSE 'mismatch' END
  FROM vault.decrypted_secrets WHERE name = 'refresh_metadata_functions_base_url'), 'missing');
SELECT '@@key=' || CASE WHEN EXISTS (SELECT 1 FROM vault.decrypted_secrets
  WHERE name = 'refresh_metadata_service_role_key' AND length(trim(decrypted_secret)) > 0) THEN 'present' ELSE 'missing' END;
SELECT '@@dm_flag=' || coalesce((SELECT CASE WHEN lower(trim(decrypted_secret)) IN ('1', 'true') THEN 'on' ELSE 'off' END
  FROM vault.decrypted_secrets WHERE name = 'SKILLSMITH_REFRESH_OBSERVER_DEADMAN_DISABLE'), 'unset');
SELECT '@@seq=' || coalesce(pg_get_serial_sequence('net.http_request_queue', 'id'), 'none');
SELECT '@@obs_recent=' || count(*)::text FROM audit_logs WHERE event_type = 'refresh:observer' AND created_at > now() - interval '18 hours';
SQL
  [ "$(kv fn_inv)" = true ] && [ "$(kv fn_health)" = true ] && [ "$(kv fn_dm)" = true ] \
    || die "REFUSING: the SMI-7114 migration is not applied on staging (a function is missing)."
  [ "$(kv base)" = match ] \
    || die "REFUSING: vault refresh_metadata_functions_base_url is '$(kv base)' (must equal $BASE_URL): the dispatcher would not target staging."
  [ "$(kv key)" = present ] || die "REFUSING: vault refresh_metadata_service_role_key is missing on staging."
  if want deadman; then
    [ "$(kv seq)" = "net.http_request_queue_id_seq" ] || die "REFUSING: pg_net request sequence is '$(kv seq)', not net.http_request_queue_id_seq; the deadman counting method needs adapting."
    [ "$(kv dm_flag)" != on ] || die "REFUSING: SKILLSMITH_REFRESH_OBSERVER_DEADMAN_DISABLE is on in staging vault; the dead-man is silenced."
    if [ "$(kv obs_recent)" != 0 ]; then
      echo "NOTE: $(kv obs_recent) refresh:observer heartbeat(s) newer than 18h exist on staging; the deadman test is skipped (they would mask the backdated row)." >&2
      ONLY=$(printf '%s' "$ONLY" | sed 's/deadman//')
      record "deadman" "INCONCLUSIVE" "a recent refresh:observer heartbeat exists on staging; remove it or wait 18h"
    fi
  fi
}

# shellcheck source=smi-7114-refresh-faults.deadman.sh
. "$SCRIPT_DIR/smi-7114-refresh-faults.deadman.sh"
# shellcheck source=smi-7114-refresh-faults.overlap.sh
. "$SCRIPT_DIR/smi-7114-refresh-faults.overlap.sh"

staging_init
trap cleanup EXIT INT TERM
confirm_or_exit "About to run the SMI-7114 fault harness on STAGING ($STAGING_REF), tests: $ONLY.
  Temporarily edits vault refresh_metadata_functions_base_url (F1; restored by a trap), inserts harness-marked
  audit_logs rows, triggers REAL skills-refresh-metadata runs (F1, F2, overlap), and sends ONE real alert-notify
  request (deadman; staging may email its alert recipient). Every function mutation is inside BEGIN..ROLLBACK."
preconditions

want f1 && test_f1
want f2 && test_f2
want f3 && test_f3
want f4 && test_f4
want deadman && test_deadman
want overlap && test_overlap

rc=0
summary_exit || rc=$?
exit "$rc"
