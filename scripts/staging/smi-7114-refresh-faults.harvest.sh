#!/usr/bin/env bash
# smi-7114-refresh-faults.harvest.sh -- F5 (the pg_net TTL gap) for smi-7114-refresh-faults.sh.
# SOURCED by that script (uses run_sql, kv, record, db_clock, red_eval, red_verdict, red_unverified,
# mut_status, MUT_*, F1_RID, F1_STATUS, ROW_RIDS and SKIP_RED).
#
# pg_net purges _http_response rows after 6h while the observer's gaps reach 13h, so
# harvest_refresh_dispatch_results() copies each pg_cron dispatch's response into a durable
# refresh:dispatch_result audit row and refresh_metadata_health() classifies from that row first.
# F5 proves, with a REAL response from the F1 dispatch (so it needs f1 in --only):
#   a. one harvester call leaves exactly ONE durable row for the request, carrying the real status;
#      a second call adds none (idempotence)
#   b. the RPC classifies that dispatch consistently with the response
#   c. the durable row WINS over the live response: a NEWER durable row injected inside
#      BEGIN..ROLLBACK (status 598) is what the RPC reports, not the live row's status
# Not here, cited: "durable wins after the live row is PURGED" is covered by the pg suite
# (skills-refresh-metadata-pg-health.ts); the harness never deletes net._http_response rows.
# Red checks: (i) drop the harvester's NOT EXISTS guard => the second call duplicates; (ii) make the
# RPC ignore the durable status => the injected 598 is not reported.

IFS= read -r -d '' F5_COUNT_SQL <<'SQL' || true
SELECT '@@dur=' || count(*)::text FROM audit_logs
 WHERE event_type = 'refresh:dispatch_result' AND metadata->>'net_request_id' = :'rid';
SQL

# Injects a NEWER durable row (status 598) for the request and reads back the status codes the RPC
# reports for that dispatch. Run only inside BEGIN..ROLLBACK (red_eval wraps it; f5_precedence too).
IFS= read -r -d '' F5_PRECEDENCE_SQL <<'SQL' || true
INSERT INTO audit_logs (event_type, actor, action, result, metadata, created_at)
VALUES ('refresh:dispatch_result', 'pg_cron', 'harvest', 'error',
        jsonb_build_object('net_request_id', :rid, 'status_code', 598, 'timed_out', NULL, 'error_msg', 'smi-7114 harness precedence probe'),
        now());
SELECT '@@pcodes=' || coalesce(string_agg(DISTINCT coalesce(f->>'status_code', 'NULL'), ','), '')
  FROM jsonb_array_elements(public.refresh_metadata_health('9 hours')->'failures') f
 WHERE abs(extract(epoch FROM ((f->>'dispatched_at')::timestamptz - :'dts'::timestamptz))) < 0.001;
SQL

f5_get_dts() {
  run_sql -v "rid=$F1_RID" <<'SQL' || return 1
SELECT '@@dts=' || created_at::text FROM audit_logs
 WHERE event_type = 'refresh:dispatch' AND actor = 'pg_cron' AND metadata->>'net_request_id' = :'rid'
 ORDER BY created_at DESC LIMIT 1;
SQL
  F5_DTS=$(kv dts)
}

test_f5() {
  echo "--- F5: harvester makes the response durable (one row, idempotent) and the RPC prefers it ---"
  local before after1 after2 dstatus want_status expect_kind n codes pcodes
  if [ -z "$F1_RID" ] || [ -z "$F1_STATUS" ]; then
    record "F5" "INCONCLUSIVE" "needs the F1 dispatch and its live response (run with f1 in --only and a response within 90s)"; return 0
  fi
  case "$F1_STATUS" in NULL) want_status="" ;; *[!0-9]*) record "F5" "INCONCLUSIVE" "F1 response status [$F1_STATUS] is not numeric"; return 0 ;; *) want_status="$F1_STATUS" ;; esac
  f5_get_dts || { record "F5" "INCONCLUSIVE" "could not read the F1 dispatch row"; return 0; }
  [ -n "$F5_DTS" ] || { record "F5" "INCONCLUSIVE" "F1 dispatch row not found"; return 0; }
  run_sql -v "rid=$F1_RID" <<<"$F5_COUNT_SQL" || return 1
  before=$(kv dur)
  run_sql -v "rid=$F1_RID" <<<"DO \$\$ BEGIN PERFORM public.harvest_refresh_dispatch_results(); END \$\$;
$F5_COUNT_SQL
SELECT '@@dstatus=' || coalesce(metadata->>'status_code', 'NULL') FROM audit_logs
 WHERE event_type = 'refresh:dispatch_result' AND metadata->>'net_request_id' = :'rid' ORDER BY created_at DESC LIMIT 1;" \
    || { record "F5" "INCONCLUSIVE" "harvester call failed"; return 0; }
  after1=$(kv dur); dstatus=$(kv dstatus)
  run_sql -v "rid=$F1_RID" <<<"DO \$\$ BEGIN PERFORM public.harvest_refresh_dispatch_results(); END \$\$;
$F5_COUNT_SQL" || { record "F5" "INCONCLUSIVE" "second harvester call failed"; return 0; }
  after2=$(kv dur)
  if [ "${after1:-x}" = "0" ]; then
    record "F5" "INCONCLUSIVE" "harvester left no durable row for request $F1_RID (advisory-lock contention with the :43 job, or the live row vanished); re-run"; return 0
  fi
  if [ "$after1" = "1" ] && [ "$after2" = "1" ] && [ "$dstatus" = "${want_status:-NULL}" ]; then
    record "F5-harvest" "PASS" "durable rows for request $F1_RID: before=$before after-1st=$after1 after-2nd=$after2 (second call added none); durable status_code=$dstatus equals the live response status"
  else
    record "F5-harvest" "FAIL" "durable rows before=$before 1st=$after1 2nd=$after2 (want 1 and 1); durable status=$dstatus (want ${want_status:-NULL})"
  fi
  if [ "$SKIP_RED" = 0 ]; then
    red_eval "$HARVEST_FN" "$MUT_F5A_RE" "$MUT_F5A_TO" "DO \$\$ BEGIN PERFORM public.harvest_refresh_dispatch_results(); END \$\$;
$F5_COUNT_SQL" -v "rid=$F1_RID" || { red_unverified "F5-harvest-red (no idempotence guard)"; return 0; }
    # Healthy value is 1 durable row after a further call; the mutation must make it more.
    red_verdict "F5-harvest-red (no idempotence guard)" dur 1
  fi
  # b. RPC classification consistent with the response
  if [ -z "$want_status" ]; then expect_kind="transport_error"
  elif [ "$want_status" -ge 200 ] && [ "$want_status" -le 299 ]; then expect_kind="none"
  else expect_kind="http_error"; fi
  run_sql -v "dts=$F5_DTS" -v "kind=$expect_kind" <<'SQL' || { record "F5-classify" "INCONCLUSIVE" "RPC call failed"; return 0; }
SELECT '@@n=' || count(*)::text
  FROM jsonb_array_elements(public.refresh_metadata_health('9 hours')->'failures') f
 WHERE abs(extract(epoch FROM ((f->>'dispatched_at')::timestamptz - :'dts'::timestamptz))) < 0.001 AND f->>'kind' = :'kind';
SELECT '@@codes=' || coalesce(string_agg(DISTINCT coalesce(f->>'status_code', 'NULL'), ','), '')
  FROM jsonb_array_elements(public.refresh_metadata_health('9 hours')->'failures') f
 WHERE abs(extract(epoch FROM ((f->>'dispatched_at')::timestamptz - :'dts'::timestamptz))) < 0.001 AND f->>'kind' = :'kind';
SQL
  n=$(kv n); codes=$(kv codes)
  if [ "$expect_kind" = "none" ]; then
    record "F5-classify" "INCONCLUSIVE" "F1 response was 2xx ($F1_STATUS), so no failure entry is expected; nothing to classify"
  elif [ "$n" = "1" ] && [ "$codes" = "${want_status:-NULL}" ]; then
    record "F5-classify" "PASS" "RPC lists the dispatch as $expect_kind with status ${want_status:-NULL}, matching the durable row and the live response"
  else
    record "F5-classify" "FAIL" "RPC entries of kind $expect_kind for the dispatch: n=$n codes=[$codes] (want 1 / ${want_status:-NULL})"
  fi
  # c. durable wins over the live response (injected newer durable row, rolled back)
  pcodes=$(f5_precedence_healthy) || { record "F5-precedence" "INCONCLUSIVE" "precedence probe failed (audit_logs insert refused?)"; return 0; }
  if [ "$pcodes" = "598" ]; then
    record "F5-precedence" "PASS" "a newer durable row (status 598, rolled back) overrides the live response status ${want_status:-NULL} in the RPC"
  else
    record "F5-precedence" "FAIL" "RPC reported status [$pcodes] for the dispatch; a newer durable row with 598 should win over the live response"
  fi
  if [ "$SKIP_RED" = 0 ]; then
    red_eval "$HEALTH_FN" "$MUT_F5B_RE" "$MUT_F5B_TO" "$F5_PRECEDENCE_SQL" -v "rid=$F1_RID" -v "dts=$F5_DTS" \
      || { red_unverified "F5-precedence-red (durable ignored)"; return 0; }
    if [ "$MUT_APPLIED" != "true" ]; then
      record "F5-precedence-red (durable ignored)" "RED-UNVERIFIED" "mutation regexp matched $MUT_MATCHES time(s) (need exactly 1); nothing was proven"
    elif [ "$(kv pcodes)" != "598" ]; then
      record "F5-precedence-red (durable ignored)" "RED-OK" "under the mutation the RPC reports [$(kv pcodes)] instead of 598: the assertion would FAIL"
    else
      record "F5-precedence-red (durable ignored)" "FAIL" "mutation applied but the RPC still reports 598: the precedence assertion is decorative"
    fi
  fi
}

# Healthy precedence probe: prints the status codes the RPC reports for the F1 dispatch after a newer
# durable row is injected; the transaction is rolled back.
f5_precedence_healthy() {
  run_sql -v "rid=$F1_RID" -v "dts=$F5_DTS" <<<"BEGIN;
$F5_PRECEDENCE_SQL
ROLLBACK;" || return 1
  kv pcodes
}
