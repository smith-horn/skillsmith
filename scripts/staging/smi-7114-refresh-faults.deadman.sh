#!/usr/bin/env bash
# smi-7114-refresh-faults.deadman.sh -- dead-man test 5 for smi-7114-refresh-faults.sh.
# SOURCED by that script (uses run_sql, kv, record, db_clock, poll_response, delete_rows, MUT_*, the
# red helpers, CHANGED_ROWS and DM_T0).
#
# Plan test 5 (revised for the state-based dedup): a heartbeat 17h old and
# check_refresh_observer_heartbeat('16 hours') => ONE real alert-notify request with status 200 AND
# data.sent true, plus one refresh:observer_dead_alert row; an immediate second call => no new
# request (dedup on the delivered alert); a 2h-old heartbeat => none. The non-2xx-earlier-alert
# re-alert leg is covered by the pg suite (staging cannot fake a non-2xx response row).
#
# Counting uses the pg_net request sequence, which advances on every net.http_post even inside a
# rolled-back transaction, so the count cases leave nothing behind and send nothing. ONLY the
# committed leg sends a real request (the one real email this harness may cause).
#
# ORDER MATTERS. The 2h cases run BEFORE the committed leg: once a delivered alert exists, the dedup
# would suppress a call whose SLA comparison had been removed, and mutation (i) would look like it
# passed. The second-call cases run AFTER it, because they need the delivered alert.

IFS= read -r -d '' DM_COUNT_SQL <<'SQL' || true
SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END AS s0 FROM net.http_request_queue_id_seq \gset
BEGIN;
\if :do_mut
SELECT :'mdef' \gexec
\endif
\if :do_ins
INSERT INTO audit_logs (event_type, actor, action, result, metadata, created_at)
VALUES ('refresh:observer', 'staging-harness', 'heartbeat', 'ok', '{"harness":"smi-7114-dm"}'::jsonb, now() - :'age'::interval);
\endif
DO $$ BEGIN PERFORM public.check_refresh_observer_heartbeat('16 hours'); END $$;
SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END AS s1 FROM net.http_request_queue_id_seq \gset
ROLLBACK;
SELECT '@@count=' || (:s1 - :s0)::text;
SQL

# dm_count AGE DO_INS DO_MUT [RE TO]: sets DM_COUNT (requests the dead-man would send now; with
# DO_INS=true a heartbeat AGE old is inserted first, in the rolled-back transaction).
dm_count() {
  local age="$1" do_ins="$2" do_mut="$3" re="${4:-$NO_MUT_RE}" to="${5:-}"
  run_sql -v "mut_func=$DEADMAN_FN" -v "mut_from=$re" -v "mut_to=$to" -v "age=$age" -v "do_ins=$do_ins" -v "do_mut=$do_mut" \
    <<<"$MUT_PRELUDE
$DM_COUNT_SQL" || return 1
  DM_COUNT=$(kv count)
  mut_status
}

red_dm_verdict() {
  local name="$1" healthy="$2"
  if [ "$MUT_APPLIED" != "true" ]; then
    record "$name" "RED-UNVERIFIED" "mutation regexp matched $MUT_MATCHES time(s) (need exactly 1) / did not change the function -- update MUT_DM*; nothing was proven"
  elif [ "$DM_COUNT" != "$healthy" ]; then
    record "$name" "RED-OK" "under the mutation the request count is $DM_COUNT (healthy $healthy): the case would FAIL"
  else
    record "$name" "FAIL" "mutation applied but the count stayed $healthy: the case does not constrain it"
  fi
}

# Reads data.sent of an alert-notify response without printing the body; the body is parsed inside
# SQL by a throwaway pg_temp function (a non-JSON body is "unparseable", never an error).
dm_alert_sent() {
  run_sql -v "rid=$1" <<'SQL' || return 1
BEGIN;
CREATE FUNCTION pg_temp.h_sent(c text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN RETURN coalesce((c::jsonb)->'data'->>'sent', 'NULL'); EXCEPTION WHEN OTHERS THEN RETURN 'unparseable'; END $f$;
SELECT '@@sent=' || coalesce((SELECT pg_temp.h_sent(content) FROM net._http_response WHERE id = :rid), 'NOROW');
ROLLBACK;
SQL
  DM_SENT=$(kv sent)
}

test_deadman() {
  echo "--- deadman: check_refresh_observer_heartbeat SLA, delivery and dedup on the delivered alert ---"
  local c_young c_next minute
  DM_LEG_OK=0
  # The committed leg leaves a backdated heartbeat and an alert row for a few minutes; the real
  # '17 * * * *' job would see them. Keep clear of that tick.
  minute=$(date -u +%M)
  if [ "$((10#$minute))" -ge 13 ] && [ "$((10#$minute))" -le 21 ]; then
    record "deadman" "INCONCLUSIVE" "UTC minute $minute is inside the dead-man's own :17 pg_cron window; re-run after :21"; return 0
  fi
  # (1) 2h-old heartbeat => no request; mutation (i) removes the SLA comparison => 1 request.
  dm_count '2 hours' true false || { record "deadman" "INCONCLUSIVE" "count query failed (vault secrets / sequence?)"; return 0; }
  c_young=$DM_COUNT
  if [ "$c_young" = 0 ]; then
    record "deadman-sla" "PASS" "2h-old heartbeat => $c_young requests (within the 16h SLA)"
  else
    record "deadman-sla" "FAIL" "2h-old heartbeat sent $c_young request(s); want 0"
  fi
  if [ "$SKIP_RED" = 0 ]; then
    if dm_count '2 hours' true true "$MUT_DM1_RE" "$MUT_DM1_TO"; then
      red_dm_verdict "deadman-red-i (no SLA comparison)" "$c_young"
    else
      red_unverified "deadman-red-i (no SLA comparison)"
    fi
  fi
  # (2) committed leg: 17h-old heartbeat => ONE real request, status 200, data.sent true, one row.
  dm_committed_leg
  # (3) immediate second call (the 17h heartbeat is committed) => dedup on the delivered alert.
  if [ "$DM_LEG_OK" = 1 ]; then
    dm_count '17 hours' false false || { record "deadman-dedup" "INCONCLUSIVE" "count query failed"; delete_rows || true; return 0; }
    c_next=$DM_COUNT
    if [ "$c_next" = 0 ]; then
      record "deadman-dedup" "PASS" "second call after the delivered alert => $c_next requests"
    else
      record "deadman-dedup" "FAIL" "second call sent $c_next request(s) although the first alert was delivered (200, sent true); want 0"
    fi
    if [ "$SKIP_RED" = 0 ]; then
      if dm_count '17 hours' false true "$MUT_DM2_RE" "$MUT_DM2_TO"; then
        red_dm_verdict "deadman-red-ii (no dedup lookup)" "$c_next"
      else
        red_unverified "deadman-red-ii (no dedup lookup)"
      fi
    fi
  else
    record "deadman-dedup" "INCONCLUSIVE" "the dedup case needs the delivered alert from the committed leg, which did not PASS"
  fi
  # Shorten the window in which the real cron can see the backdated heartbeat; the exit trap
  # re-runs the same VERIFIED delete and fails the harness if anything remains.
  delete_rows || echo "WARNING: early deadman row delete did not verify clean; the exit trap will retry" >&2
}

# One REAL call: a committed 17h-old heartbeat, the function sends one alert-notify request via
# vault credentials; assert exactly one request, one dead_alert row, the response status 200 and
# data.sent true. Sets DM_LEG_OK=1 only when all hold.
dm_committed_leg() {
  local cnt alerts arid
  DM_T0=$(db_clock) || return 1
  # OWNERSHIP (SMI-7114 R2-3, R3). The insert and the real call run in ONE psql session and ONE
  # transaction. The owned request id is read from the dead_alert row whose created_at equals this
  # transaction's now(): the function inserts that row with the column default, so only a row written
  # by THIS transaction matches. Not currval: under a transaction-mode pooler a reused backend can
  # still hold another client's currval, so a call that made no POST would "own" someone else's id
  # (round-3 cross-family finding). If no row matches, \gset fails, ON_ERROR_STOP aborts, and the whole
  # transaction (heartbeat, queued request) rolls back: nothing is owned and nothing is left behind.
  # The sequence counts below are diagnostic only (sequence name measured on prod by the queen:
  # pg_get_serial_sequence('net.http_request_queue','id') = net.http_request_queue_id_seq).
  run_sql <<'SQL' || { record "deadman-200" "INCONCLUSIVE" "committed leg failed or made no pg_net request (rolled back; nothing owned)"; return 0; }
SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END AS s0 FROM net.http_request_queue_id_seq \gset
BEGIN;
INSERT INTO audit_logs (event_type, actor, action, result, metadata, created_at)
VALUES ('refresh:observer', 'staging-harness', 'heartbeat', 'ok', '{"harness":"smi-7114-dm"}'::jsonb, now() - interval '17 hours');
DO $$ BEGIN PERFORM public.check_refresh_observer_heartbeat('16 hours'); END $$;
SELECT metadata->>'net_request_id' AS rid FROM audit_logs
 WHERE event_type = 'refresh:observer_dead_alert' AND created_at = now() \gset
SELECT last_value - CASE WHEN is_called THEN 0 ELSE 1 END AS s1 FROM net.http_request_queue_id_seq \gset
COMMIT;
SELECT '@@count=' || (:s1 - :s0)::text;
SELECT '@@rid=' || :rid::text;
SQL
  DM_RID=$(kv rid)
  CHANGED_ROWS="${CHANGED_ROWS:+$CHANGED_ROWS }deadman"
  cnt=$(kv count)
  if [ -z "$DM_RID" ]; then
    record "deadman-200" "INCONCLUSIVE" "no owned pg_net request id was captured"; return 0
  fi
  if [ "$cnt" != 1 ]; then
    record "deadman-200" "INCONCLUSIVE" "expected exactly 1 pg_net request, saw $cnt (another pg_net user on staging? re-run when quiet); owned request id $DM_RID"; return 0
  fi
  run_sql -v "rid=$DM_RID" <<'SQL' || { record "deadman-200" "INCONCLUSIVE" "alert-row query failed"; return 0; }
SELECT '@@alerts=' || count(*)::text FROM audit_logs
 WHERE event_type = 'refresh:observer_dead_alert' AND metadata->>'net_request_id' = :'rid';
SQL
  alerts=$(kv alerts); arid=$DM_RID
  dm_warn_foreign
  if [ "$alerts" != 1 ]; then
    record "deadman-200" "FAIL" "expected exactly one refresh:observer_dead_alert row for owned request $DM_RID, saw $alerts"; return 0
  fi
  if ! poll_response "$arid" 90 "$DM_T0"; then
    record "deadman-200" "INCONCLUSIVE" "no _http_response row for alert request $arid within 90s"; return 0
  fi
  dm_alert_sent "$arid" || { record "deadman-200" "INCONCLUSIVE" "could not read the alert response body"; return 0; }
  if [ "$RESP_STATUS" = "200" ] && [ "$DM_SENT" = "true" ]; then
    DM_LEG_OK=1
    record "deadman-200" "PASS" "alert-notify answered 200 with data.sent=true to the vault-credential request (id $arid); one dead_alert row"
  elif [ "$RESP_STATUS" = "200" ]; then
    record "deadman-200" "FAIL" "alert-notify answered 200 but data.sent=$DM_SENT: no email was delivered, so the dead-man would re-alert (id $arid)"
  else
    record "deadman-200" "FAIL" "alert-notify answered status_code=$RESP_STATUS error_msg=[$RESP_ERR] (id $arid)"
  fi
}

# Loudly names any refresh:observer_dead_alert row since DM_T0 that this harness does NOT own (a real
# cron or operator alert). Cleanup never deletes those; this only reports them.
dm_warn_foreign() {
  [ "$DM_T0" != "infinity" ] || return 0
  run_sql -v "t0=$DM_T0" -v "rid=${DM_RID:-}" <<'SQL' || return 0
SELECT '@@foreign=' || coalesce(string_agg(event_type || ' id=' || id::text || ' created_at=' || created_at::text
  || ' net_request_id=' || coalesce(metadata->>'net_request_id', 'NULL'), '; '), '')
  FROM audit_logs
 WHERE event_type IN ('refresh:observer_dead_alert', 'refresh:observer_dead_alert_result')
   AND created_at >= :'t0'::timestamptz
   AND metadata->>'net_request_id' IS DISTINCT FROM NULLIF(:'rid', '');
SQL
  if [ -n "$(kv foreign)" ]; then
    echo "WARNING: dead-alert row(s) NOT owned by this harness appeared since $DM_T0 and were LEFT IN PLACE: $(kv foreign)" >&2
  fi
}
