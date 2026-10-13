#!/usr/bin/env bash
# smi-7114-refresh-faults.deadman.sh -- dead-man test 5 for smi-7114-refresh-faults.sh.
# SOURCED by that script (uses run_sql, kv, record, db_clock, poll_response, MUT_* and the red helpers).

# --------------------------------------------------------------------------------------------
# Dead-man (test 5). Counting uses the pg_net request sequence, which advances on every
# net.http_post even inside a rolled-back transaction, so the count cases leave nothing behind and
# send nothing; only the committed leg sends ONE real alert to check for status 200.
# --------------------------------------------------------------------------------------------
IFS= read -r -d '' DM_COUNT_SQL <<'SQL' || true
SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END AS s0 FROM net.http_request_queue_id_seq \gset
BEGIN;
\if :do_mut
SELECT :'mdef' \gexec
\endif
INSERT INTO audit_logs (event_type, actor, action, result, metadata, created_at)
VALUES ('refresh:observer', 'staging-harness', 'heartbeat', 'ok', '{"harness":"smi-7114-dm"}'::jsonb, now() - :'age'::interval);
DO $$ BEGIN PERFORM public.check_refresh_observer_heartbeat('16 hours'); END $$;
SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END AS s1 FROM net.http_request_queue_id_seq \gset
ROLLBACK;
SELECT '@@count=' || (:s1 - :s0)::text;
SQL

# dm_count AGE DO_MUT [RE TO]: sets DM_COUNT (requests the dead-man would send for a heartbeat that old).
dm_count() {
  local age="$1" do_mut="$2" re="${3:-$NO_MUT_RE}" to="${4:-}"
  run_sql -v "mut_func=$DEADMAN_FN" -v "mut_from=$re" -v "mut_to=$to" -v "age=$age" -v "do_mut=$do_mut" \
    <<<"$MUT_PRELUDE
$DM_COUNT_SQL" || return 1
  DM_COUNT=$(kv count)
  MUT_APPLIED=$(kv mutation_applied)
}

test_deadman() {
  echo "--- deadman: check_refresh_observer_heartbeat SLA + once-a-day dedup ---"
  local c_first c_next c_young
  # Ages are chosen from the migration's own arithmetic: over_h = floor((age - SLA)/1h); the alert
  # needs age > SLA and over_h % 24 = 0, so the first hour past a 16h SLA is age in (16h,17h).
  # The plan text backdates 17h, which gives over_h = 1 and (per the migration as written) NO alert.
  dm_count '16 hours 30 minutes' false || { record "deadman" "INCONCLUSIVE" "count query failed (vault secrets / sequence?)"; return 0; }
  c_first=$DM_COUNT
  dm_count '17 hours 30 minutes' false || return 1; c_next=$DM_COUNT
  dm_count '2 hours' false || return 1; c_young=$DM_COUNT
  if [ "$c_first" = 1 ] && [ "$c_next" = 0 ] && [ "$c_young" = 0 ]; then
    record "deadman-counts" "PASS" "16h30m old => $c_first request; next hourly tick (17h30m) => $c_next (dedup); 2h old => $c_young"
  else
    record "deadman-counts" "FAIL" "requests: 16h30m=$c_first (want 1), 17h30m=$c_next (want 0), 2h=$c_young (want 0)"
  fi
  dm_committed_leg
  if [ "$SKIP_RED" = 0 ]; then
    dm_count '2 hours' true "$MUT_DM1_RE" "$MUT_DM1_TO" || return 1
    red_dm_verdict "deadman-red-i (no SLA comparison)" "$c_young"
    dm_count '17 hours 30 minutes' true "$MUT_DM2_RE" "$MUT_DM2_TO" || return 1
    red_dm_verdict "deadman-red-ii (no dedup)" "$c_next"
  fi
}

red_dm_verdict() {
  local name="$1" healthy="$2"
  if [ "$MUT_APPLIED" != "true" ]; then
    record "$name" "RED-UNVERIFIED" "mutation regexp did not change the function text -- update MUT_DM*; nothing was proven"
  elif [ "$DM_COUNT" != "$healthy" ]; then
    record "$name" "RED-OK" "under the mutation the request count is $DM_COUNT (healthy $healthy): the case would FAIL"
  else
    record "$name" "FAIL" "mutation applied but the count stayed $healthy: the case does not constrain it"
  fi
}

# One REAL call: a committed 16h30m-old heartbeat, the function sends one alert-notify request via
# vault credentials; assert exactly one request and its _http_response status_code = 200.
dm_committed_leg() {
  local t0 cnt id
  t0=$(db_clock) || return 1
  run_sql <<'SQL' || { record "deadman-200" "INCONCLUSIVE" "committed leg failed"; return 0; }
SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END AS s0 FROM net.http_request_queue_id_seq \gset
INSERT INTO audit_logs (event_type, actor, action, result, metadata, created_at)
VALUES ('refresh:observer', 'staging-harness', 'heartbeat', 'ok', '{"harness":"smi-7114-dm"}'::jsonb, now() - interval '16 hours 30 minutes');
DO $$ BEGIN PERFORM public.check_refresh_observer_heartbeat('16 hours'); END $$;
SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END AS s1 FROM net.http_request_queue_id_seq \gset
SELECT '@@count=' || (:s1 - :s0)::text;
SELECT '@@id=' || :s1::text;
SQL
  CHANGED_ROWS="${CHANGED_ROWS:+$CHANGED_ROWS }deadman"
  cnt=$(kv count); id=$(kv id)
  if [ "$cnt" != 1 ]; then
    record "deadman-200" "INCONCLUSIVE" "expected exactly 1 pg_net request, saw $cnt (another pg_net user on staging? re-run when quiet)"; return 0
  fi
  if ! poll_response "$id" 90 "$t0"; then
    record "deadman-200" "INCONCLUSIVE" "no _http_response row for alert request $id within 90s"; return 0
  fi
  if [ "$RESP_STATUS" = "200" ]; then
    record "deadman-200" "PASS" "alert-notify answered 200 to the vault-credential request (id $id)"
  else
    record "deadman-200" "FAIL" "alert-notify answered status_code=$RESP_STATUS error_msg=[$RESP_ERR] (id $id)"
  fi
}
