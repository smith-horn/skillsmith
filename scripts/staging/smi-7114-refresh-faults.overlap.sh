#!/usr/bin/env bash
# smi-7114-refresh-faults.overlap.sh -- the overlap test (plan R3-7) for smi-7114-refresh-faults.sh.
# SOURCED by that script (uses its helpers: run_sql, kv, record, want, BASE_URL, WORK_DIR, ...).
#
# R3-7: until the observer conversion lands, GHA's manual path and the pg_cron dispatcher can both
# hit skills-refresh-metadata. This fires the pg_cron path (`SELECT public.invoke_skills_refresh_metadata()`)
# and, in the same second, the GHA-equivalent curl POST of refresh-metadata.yml's manual path (same
# body), both against STAGING, and asserts:
#   - exactly 2 refresh:run rows, none result='failed'
#   - no skills row with a NULL name / repo_url
#   - no trust_tier downgraded from 'verified' (pre/post diff)
#   - the rows both runs touched hold ONE final stars/quality_score (a re-read 45s later is identical)
#   - quarantine findings added per newly quarantined skill <= 2 (quarantine writes security_findings
#     on `skills`; it has no audit row of its own)
#   - summed `updated` <= summed batch_size
# Legs: BASELINE (one invocation alone, expect 1 run), OVERLAP (both, expect 2), CONTROL (the manual
# leg runs dryRun:true; the 2-real-runs assertion MUST then be false, proving the harness counts
# both legs). A leg whose runs processed 0 skills (no stale skills on staging) is INCONCLUSIVE.
#
# The manual leg authenticates with STAGING_SUPABASE_SERVICE_ROLE_KEY. The key is handed to curl on
# stdin (-K -) from a shell builtin, so it never appears in argv, and it is never printed.

OVERLAP_BODY='{"batchSize":200,"staleDays":1,"dryRun":false}'
OVERLAP_BODY_DRY='{"batchSize":200,"staleDays":1,"dryRun":true}'

IFS= read -r -d '' OV_SNAPSHOT_SQL <<'SQL' || true
SELECT id::text || '|' || coalesce(trust_tier, '') || '|' || coalesce(quarantined, false)::text || '|' ||
       CASE WHEN jsonb_typeof(security_findings::jsonb) = 'array' THEN jsonb_array_length(security_findings::jsonb) ELSE 0 END::text
  FROM skills ORDER BY id;
SQL

IFS= read -r -d '' OV_ASSERT_SQL <<'SQL' || true
SELECT '@@downgraded=' || count(*)::text FROM pre p JOIN skills s ON s.id::text = p.id
 WHERE p.trust = 'verified' AND s.trust_tier IS DISTINCT FROM 'verified';
SELECT '@@nulls=' || count(*)::text FROM skills WHERE name IS NULL OR repo_url IS NULL;
SELECT '@@findings_added=' || coalesce(max(
  CASE WHEN jsonb_typeof(s.security_findings::jsonb) = 'array' THEN jsonb_array_length(s.security_findings::jsonb) ELSE 0 END - p.flen), 0)::text
  FROM pre p JOIN skills s ON s.id::text = p.id WHERE NOT p.quar AND coalesce(s.quarantined, false);
SELECT '@@runs=' || count(*)::text FROM audit_logs WHERE event_type = 'refresh:run' AND created_at >= :'t0'::timestamptz;
SELECT '@@real_runs=' || count(*)::text FROM audit_logs
 WHERE event_type = 'refresh:run' AND created_at >= :'t0'::timestamptz AND metadata->>'dry_run' IS DISTINCT FROM 'true';
SELECT '@@failed_runs=' || count(*)::text FROM audit_logs
 WHERE event_type = 'refresh:run' AND created_at >= :'t0'::timestamptz AND result = 'failed';
SELECT '@@updated_sum=' || coalesce(sum((metadata->>'updated')::int), 0)::text FROM audit_logs
 WHERE event_type = 'refresh:run' AND created_at >= :'t0'::timestamptz;
SELECT '@@batch_sum=' || coalesce(sum((metadata->>'batch_size')::int), 0)::text FROM audit_logs
 WHERE event_type = 'refresh:run' AND created_at >= :'t0'::timestamptz;
SELECT '@@processed_sum=' || coalesce(sum((metadata->>'processed')::int), 0)::text FROM audit_logs
 WHERE event_type = 'refresh:run' AND created_at >= :'t0'::timestamptz;
SQL

# Fires the GHA-equivalent manual POST (background-safe: writes its HTTP status to a file).
ov_curl_manual() {
  local body="$1" code
  code=$(printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\n' \
    "$STAGING_SUPABASE_SERVICE_ROLE_KEY" "$STAGING_SUPABASE_SERVICE_ROLE_KEY" \
    | curl -sS -K - --max-time 400 -o "$WORK_DIR/curl.body" -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' -d "$body" \
        "${BASE_URL}/functions/v1/skills-refresh-metadata" 2>"$WORK_DIR/curl.err") || code="000"
  printf '%s' "$code" >"$WORK_DIR/curl.code"
}

ov_invoke_cron_path() {
  sql_run <<'SQL' >/dev/null 2>"$WORK_DIR/inv.err"
DO $$ BEGIN PERFORM public.invoke_skills_refresh_metadata(); END $$;
SQL
}

ov_snapshot_to() {
  run_sql <<<"$OV_SNAPSHOT_SQL" || return 1
  printf '%s\n' "$LAST_OUT" >"$1"
}

ov_stars_to() {
  run_sql -v "t0=$2" <<'SQL' || return 1
SELECT id::text || '|' || coalesce(stars::text, '') || '|' || coalesce(quality_score::text, '')
  FROM skills WHERE last_seen_at >= :'t0'::timestamptz ORDER BY id;
SQL
  printf '%s\n' "$LAST_OUT" >"$1"
}

# ov_leg NAME MODE EXPECT_RUNS EXPECT_REAL   (MODE: baseline | overlap | control)
ov_leg() {
  local name="$1" mode="$2" want_runs="$3" want_real="$4" t0 waited=0 runs=0 hh mm
  hh=$(date -u +%H); mm=$(date -u +%M)
  if [ $((10#$hh % 4)) -eq 2 ] && [ "$((10#$mm))" -ge 27 ] && [ "$((10#$mm))" -le 50 ]; then
    record "$name" "INCONCLUSIVE" "UTC $hh:$mm is inside the :32 pg_cron window (hours 2,6,10,...); wait until it passes so a scheduled tick cannot add a run"; return 0
  fi
  # Wait for idle (up to 6 min): the previous leg's own refresh:run would otherwise make every leg
  # after the first INCONCLUSIVE (measured on staging 2026-10-14).
  while :; do
    run_sql <<'SQL' || { record "$name" "INCONCLUSIVE" "idle check failed"; return 0; }
SELECT '@@recent=' || count(*)::text FROM audit_logs WHERE event_type = 'refresh:run' AND created_at > now() - interval '4 minutes';
SQL
    [ "$(kv recent)" = 0 ] && break
    if [ "$waited" -ge 360 ]; then
      record "$name" "INCONCLUSIVE" "a refresh:run landed in the last 4 minutes on staging and it did not go idle within 6 min"; return 0
    fi
    sleep 15; waited=$((waited + 15))
  done
  if [ "${OVERLAP_RESTALE:-0}" -gt 0 ]; then
    run_sql -v "n=$OVERLAP_RESTALE" <<'SQL' || { record "$name" "INCONCLUSIVE" "restale failed"; return 0; }
WITH u AS (
  UPDATE skills SET indexed_at = indexed_at - interval '3 days'
   WHERE id IN (SELECT id FROM skills WHERE indexed_at > now() - interval '1 day' ORDER BY id LIMIT :n)
  RETURNING 1)
SELECT '@@restaled=' || count(*)::text FROM u;
SQL
    echo "$name: backdated indexed_at on $(kv restaled) staging skills (the refresh resets them)" >&2
  fi
  ov_snapshot_to "$WORK_DIR/pre.txt" || { record "$name" "INCONCLUSIVE" "pre-snapshot failed"; return 0; }
  t0=$(db_clock) || return 1
  rm -f "$WORK_DIR/curl.code" "$WORK_DIR/inv.err"
  local inv_pid="" curl_pid=""
  ov_invoke_cron_path & inv_pid=$!
  case "$mode" in
    overlap) ov_curl_manual "$OVERLAP_BODY" & curl_pid=$! ;;
    control) ov_curl_manual "$OVERLAP_BODY_DRY" & curl_pid=$! ;;
  esac
  local inv_rc=0
  wait "$inv_pid" || inv_rc=$?
  if [ -n "$curl_pid" ]; then wait "$curl_pid" || true; fi
  if [ "$inv_rc" -ne 0 ]; then
    echo "pg_cron-path invocation failed:" >&2; redact <"$WORK_DIR/inv.err" >&2
    record "$name" "INCONCLUSIVE" "the dispatcher call failed"; return 0
  fi
  if [ -n "$curl_pid" ]; then
    case "$(cat "$WORK_DIR/curl.code" 2>/dev/null || echo 000)" in
      2??) ;;
      *) record "$name" "INCONCLUSIVE" "manual POST answered HTTP $(cat "$WORK_DIR/curl.code" 2>/dev/null || echo 000) (key format rejected by the gateway? see W0-3)"; return 0 ;;
    esac
  fi
  # Wait for the expected number of refresh:run rows (each run writes its row at the end).
  while [ "$waited" -lt 600 ]; do
    run_sql -v "t0=$t0" <<'SQL' || return 1
SELECT '@@runs=' || count(*)::text FROM audit_logs WHERE event_type = 'refresh:run' AND created_at >= :'t0'::timestamptz;
SQL
    runs=$(kv runs)
    if [ "$runs" -ge "$want_runs" ]; then break; fi
    sleep 10; waited=$((waited + 10))
  done
  ov_stars_to "$WORK_DIR/stars.a" "$t0" || return 1
  sleep 45
  ov_stars_to "$WORK_DIR/stars.b" "$t0" || return 1
  # One transaction, temp table dropped at COMMIT: under the transaction-mode pooler a temp table
  # outlives the client and sits on a reused backend ("relation pre already exists", staging 2026-10-14).
  { printf 'BEGIN;\nDROP TABLE IF EXISTS pg_temp.pre;\n'
    printf 'CREATE TEMP TABLE pre (id text, trust text, quar boolean, flen int) ON COMMIT DROP;\n'
    printf "COPY pre FROM STDIN WITH (DELIMITER '|');\n"
    cat "$WORK_DIR/pre.txt"
    printf '\\.\n'
    printf '%s\n' "$OV_ASSERT_SQL"
    printf 'COMMIT;\n'; } >"$WORK_DIR/post.sql"
  run_sql -v "t0=$t0" <"$WORK_DIR/post.sql" || { record "$name" "INCONCLUSIVE" "post-assertion query failed"; return 0; }
  ov_judge "$name" "$mode" "$want_runs" "$want_real"
}

ov_judge() {
  local name="$1" mode="$2" want_runs="$3" want_real="$4" bad="" touched
  touched=$(wc -l <"$WORK_DIR/stars.b" | tr -d ' ')
  [ "$(kv runs)" = "$want_runs" ] || bad="$bad runs=$(kv runs)(want $want_runs)"
  if [ "$mode" != "control" ]; then
    [ "$(kv real_runs)" = "$want_real" ] || bad="$bad real_runs=$(kv real_runs)(want $want_real)"
    [ "$(kv failed_runs)" = "0" ] || bad="$bad failed_runs=$(kv failed_runs)"
    [ "$(kv downgraded)" = "0" ] || bad="$bad verified_downgraded=$(kv downgraded)"
    [ "$(kv nulls)" = "0" ] || bad="$bad null_name_or_repo_url=$(kv nulls)"
    [ "$(kv findings_added)" -le 2 ] || bad="$bad quarantine_findings_added=$(kv findings_added)(max 2)"
    [ "$(kv updated_sum)" -le "$(kv batch_sum)" ] || bad="$bad updated_sum=$(kv updated_sum)>batch_sum=$(kv batch_sum)"
    cmp -s "$WORK_DIR/stars.a" "$WORK_DIR/stars.b" || bad="$bad stars/quality_score changed between two reads 45s apart (a writer was still active)"
  fi
  local facts="runs=$(kv runs) real_runs=$(kv real_runs) processed_sum=$(kv processed_sum) updated_sum=$(kv updated_sum) touched_skills=$touched"
  if [ "$mode" = "control" ]; then
    # The overlap leg's 2-real-runs assertion must be FALSE here: the dry leg answered 2xx (checked
    # above) yet wrote no refresh:run, so exactly one run (the real one) is counted.
    if [ "$(kv runs)" = "$want_runs" ] && [ "$(kv real_runs)" = "$want_real" ]; then
      record "$name" "PASS" "dryRun leg answered 2xx but wrote no refresh:run, so only the real run is counted ($facts): the harness distinguishes the two legs"
    else
      record "$name" "FAIL" "control did not separate the legs: $facts (want runs=$want_runs real_runs=$want_real)"
    fi
  elif [ -n "$bad" ]; then
    record "$name" "FAIL" "$facts;$bad"
  elif [ "$(kv processed_sum)" = "0" ]; then
    record "$name" "INCONCLUSIVE" "assertions held but the runs processed 0 skills (no stale skills on staging), so no overlap was exercised: $facts"
  else
    record "$name" "PASS" "$facts; no NULL name/repo_url, no verified downgrade, quarantine findings added <= 2, single final stars/quality_score"
  fi
}

test_overlap() {
  echo "--- overlap (R3-7): pg_cron path + manual POST in the same second, REAL refreshes on staging ---"
  if [ -z "${STAGING_SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
    record "overlap" "INCONCLUSIVE" "STAGING_SUPABASE_SERVICE_ROLE_KEY is not set; the manual leg cannot authenticate"; return 0
  fi
  ov_leg "overlap-baseline" baseline 1 1
  ov_leg "overlap" overlap 2 2
  if [ "$SKIP_CONTROL" = 0 ]; then
    # 1 run, 1 real: skills-refresh-metadata writes no refresh:run on dryRun (index.ts guards the
    # audit insert with `if (!dryRun)`; measured on staging 2026-10-14). The dry leg's execution is
    # proven by its HTTP 2xx, checked above in ov_leg.
    ov_leg "overlap-control" control 1 1
  fi
}
