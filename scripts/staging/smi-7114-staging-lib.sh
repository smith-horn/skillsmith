#!/usr/bin/env bash
# smi-7114-staging-lib.sh -- shared helpers for the SMI-7114 OWNER-RUN staging scripts
# (smi-7114-w0-measure.sh, smi-7114-refresh-faults.sh). SOURCED, never executed.
#
# What it provides:
#   - the staging-ref guard (guard_check_target / guard_self_test): a POSITIVE allow-list that
#     proceeds only for the staging project ref, plus an explicit prod-ref deny. Both scripts call
#     staging_init before any database access, and both expose --self-test (no database, no env).
#   - sql_run / run_sql: psql against the STAGING pooler through scripts/pooler-psql.sh, with
#     SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD overridden by the STAGING_* values for that call
#     only (the same override smi-5863-apply-staging.sh uses).
#   - kv / poll_response / record / summary_exit: output parsing, pg_net polling, PASS/FAIL ledger.
#
# Secrets: no key is ever read into the shell by the W0 script or the DB-side tests. Vault values
# are read inside SQL and used inside SQL; only booleans, format labels and status codes come back.
# All DB output is passed through redact() before it is printed.
#
# bash 3.2 compatible (macOS /bin/bash): no associative arrays, no ${var,,}, no mapfile.

STAGING_REF_LITERAL="ovhcifugwqnzoebwfuku"
PROD_REF_LITERAL="vrcnzpmndtroqxxoqkzy"

LAST_OUT=""
GUARD_REASON=""
STAGING_REF=""
BASE_URL=""
WORK_DIR=""
ASSUME_YES=0
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

R_NAMES=()
R_STATUS=()
R_DETAIL=()

die() {
  echo "$1" >&2
  exit "${2:-1}"
}

redact() {
  sed -E 's/eyJ[A-Za-z0-9_.-]{10,}/[redacted-jwt]/g; s/sb_secret_[A-Za-z0-9_-]*/[redacted-sb-secret]/g'
}

# ---------------------------------------------------------------------------------------------
# Staging-ref guard. Returns 0 only for exactly the staging ref (and, if a URL is given, exactly
# https://<staging-ref>.supabase.co with an optional trailing slash). Everything else refuses and
# sets GUARD_REASON: empty, the prod ref anywhere in either value, any other ref, and lookalikes
# (suffix hosts, http, whitespace, case changes, comma lists).
# ---------------------------------------------------------------------------------------------
guard_check_target() {
  local ref="${1-}" url="${2-}" norm
  GUARD_REASON=""
  if [ -z "$ref" ]; then
    GUARD_REASON="project ref is empty"
    return 1
  fi
  case "$ref$url" in
    *"$PROD_REF_LITERAL"*)
      GUARD_REASON="ref or URL names the PROD project ($PROD_REF_LITERAL)"
      return 1
      ;;
  esac
  if [ "$ref" != "$STAGING_REF_LITERAL" ]; then
    GUARD_REASON="ref is not exactly the staging ref"
    return 1
  fi
  if [ -n "$url" ]; then
    norm="${url%/}"
    if [ "$norm" != "https://${STAGING_REF_LITERAL}.supabase.co" ]; then
      GUARD_REASON="URL is not exactly https://${STAGING_REF_LITERAL}.supabase.co"
      return 1
    fi
  fi
  return 0
}

# Case table for the guard: "<expected>|<ref>|<url>" with expected = ok | refuse.
# Positive and negative controls both live here; the self-test fails if any row disagrees.
guard_self_test() {
  local rows row want ref url got bad=0 n=0 old_ifs="$IFS"
  rows=(
    "ok|$STAGING_REF_LITERAL|https://$STAGING_REF_LITERAL.supabase.co"
    "ok|$STAGING_REF_LITERAL|https://$STAGING_REF_LITERAL.supabase.co/"
    "ok|$STAGING_REF_LITERAL|"
    "refuse|$PROD_REF_LITERAL|https://$PROD_REF_LITERAL.supabase.co"
    "refuse|$PROD_REF_LITERAL|"
    "refuse|$STAGING_REF_LITERAL|https://$PROD_REF_LITERAL.supabase.co"
    "refuse|$PROD_REF_LITERAL|https://$STAGING_REF_LITERAL.supabase.co"
    "refuse||"
    "refuse||https://$STAGING_REF_LITERAL.supabase.co"
    "refuse|$STAGING_REF_LITERAL |"
    "refuse|OVHCIFUGWQNZOEBWFUKU|"
    "refuse|$STAGING_REF_LITERAL,$PROD_REF_LITERAL|"
    "refuse|$STAGING_REF_LITERAL|https://$STAGING_REF_LITERAL.supabase.co.evil.example"
    "refuse|$STAGING_REF_LITERAL|http://$STAGING_REF_LITERAL.supabase.co"
    "refuse|someotherrefabcdefghij|https://someotherrefabcdefghij.supabase.co"
  )
  IFS='|'
  for row in "${rows[@]}"; do
    set -- $row
    want="$1"
    ref="${2-}"
    url="${3-}"
    n=$((n + 1))
    if guard_check_target "$ref" "$url"; then got="ok"; else got="refuse"; fi
    if [ "$got" = "$want" ]; then
      printf '  case %2d  want=%-6s got=%-6s ref=[%s] url=[%s]\n' "$n" "$want" "$got" "$ref" "$url"
    else
      printf '  case %2d  MISMATCH want=%s got=%s ref=[%s] url=[%s]\n' "$n" "$want" "$got" "$ref" "$url"
      bad=$((bad + 1))
    fi
  done
  IFS="$old_ifs"
  if [ "$bad" -ne 0 ]; then
    echo "guard self-test FAILED: $bad of $n cases disagree" >&2
    return 1
  fi
  echo "guard self-test passed: $n of $n cases agree (proceeds only for the staging ref)"
}

# ---------------------------------------------------------------------------------------------
# Environment + DB access
# ---------------------------------------------------------------------------------------------
staging_init() {
  STAGING_REF="${STAGING_SUPABASE_PROJECT_REF:-}"
  if ! guard_check_target "$STAGING_REF" "${STAGING_SUPABASE_URL:-}"; then
    die "REFUSING: $GUARD_REASON. Run via: varlock run -- <this script>  (STAGING_* vars must point at staging)."
  fi
  if [ -z "${STAGING_SUPABASE_DB_PASSWORD:-}" ]; then
    die "REFUSING: STAGING_SUPABASE_DB_PASSWORD is not set. Run via: varlock run -- <this script>"
  fi
  BASE_URL="https://${STAGING_REF}.supabase.co"
  WORK_DIR=$(mktemp -d) || die "mktemp failed"
  echo "Target: staging ref $STAGING_REF (prod ref $PROD_REF_LITERAL is refused)" >&2
}

# stdin = SQL. Extra args pass to psql. Staging credentials replace the prod ones for this call only.
sql_run() {
  SUPABASE_PROJECT_REF="$STAGING_REF" \
    SUPABASE_DB_PASSWORD="$STAGING_SUPABASE_DB_PASSWORD" \
    "$REPO_ROOT/scripts/pooler-psql.sh" -X -q -At -v ON_ERROR_STOP=1 "$@"
}

# Runs sql_run, captures redacted stdout into LAST_OUT, prints redacted stderr on failure.
run_sql() {
  local rc=0 out
  out=$(sql_run "$@" 2>"$WORK_DIR/sql.err") || rc=$?
  LAST_OUT=$(printf '%s\n' "$out" | redact)
  if [ "$rc" -ne 0 ]; then
    echo "psql failed (exit $rc):" >&2
    redact <"$WORK_DIR/sql.err" >&2
    return "$rc"
  fi
}

# Value of an "@@key=value" line from the last run_sql output (last occurrence), or empty.
kv() {
  printf '%s\n' "$LAST_OUT" | sed -n "s/^@@$1=//p" | tail -n 1
}

confirm_or_exit() {
  printf '%s\n' "$1" >&2
  if [ "$ASSUME_YES" = 1 ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    die "REFUSING: stdin is not a terminal; re-run with --yes to confirm non-interactively."
  fi
  printf 'Type the staging ref (%s) to continue: ' "$STAGING_REF" >&2
  local ans=""
  read -r ans
  [ "$ans" = "$STAGING_REF" ] || die "Aborted."
}

# Polls net._http_response for a request id until a row exists or max seconds pass.
# Sets RESP_FOUND (0/1), RESP_STATUS, RESP_TIMED_OUT, RESP_ERR, RESP_LAT (seconds since $3, if given).
poll_response() {
  local rid="$1" max="$2" t0="${3:-}" waited=0
  RESP_FOUND=0
  RESP_STATUS=""
  RESP_TIMED_OUT=""
  RESP_ERR=""
  RESP_LAT=""
  case "$rid" in '' | *[!0-9]*) die "poll_response: request id is not numeric: [$rid]" ;; esac
  [ -n "$t0" ] || t0="1970-01-01 00:00:00+00"
  while :; do
    run_sql -v "rid=$rid" -v "t0=$t0" <<'SQL' || return 2
SELECT '@@found=' || count(*)::text FROM net._http_response WHERE id = :rid;
SELECT '@@status=' || coalesce(status_code::text, 'NULL') FROM net._http_response WHERE id = :rid;
SELECT '@@timed_out=' || coalesce(timed_out::text, 'NULL') FROM net._http_response WHERE id = :rid;
SELECT '@@err=' || coalesce(left(replace(error_msg, E'\n', ' '), 200), '') FROM net._http_response WHERE id = :rid;
SELECT '@@lat=' || round(extract(epoch FROM (created - :'t0'::timestamptz))::numeric, 1)::text FROM net._http_response WHERE id = :rid;
SQL
    if [ "$(kv found)" = "1" ]; then
      RESP_FOUND=1
      RESP_STATUS=$(kv status)
      RESP_TIMED_OUT=$(kv timed_out)
      RESP_ERR=$(kv err)
      RESP_LAT=$(kv lat)
      return 0
    fi
    if [ "$waited" -ge "$max" ]; then
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

# ---------------------------------------------------------------------------------------------
# PASS / FAIL ledger. Three outcomes, not two (a test that never ran is not a pass):
#   PASS | FAIL | INCONCLUSIVE.   RED-OK | RED-UNVERIFIED are the mutation-check outcomes.
# ---------------------------------------------------------------------------------------------
record() {
  R_NAMES+=("$1")
  R_STATUS+=("$2")
  R_DETAIL+=("$3")
  printf '%-14s %-22s %s\n' "$2" "$1" "$3"
}

# Prints the ledger and returns: 0 all PASS/RED-OK, 1 any FAIL, 3 no FAIL but something unproven.
summary_exit() {
  local i n=${#R_NAMES[@]} fails=0 unproven=0
  echo
  echo "================ SUMMARY ================"
  for ((i = 0; i < n; i++)); do
    printf '%-14s %-22s %s\n' "${R_STATUS[$i]}" "${R_NAMES[$i]}" "${R_DETAIL[$i]}"
    case "${R_STATUS[$i]}" in
      FAIL) fails=$((fails + 1)) ;;
      PASS | RED-OK) ;;
      *) unproven=$((unproven + 1)) ;;
    esac
  done
  echo "-----------------------------------------"
  echo "results: $n recorded, $fails FAIL, $unproven unproven (INCONCLUSIVE / RED-UNVERIFIED)"
  if [ "$fails" -gt 0 ]; then
    return 1
  fi
  if [ "$unproven" -gt 0 ]; then
    return 3
  fi
  return 0
}

# ---------------------------------------------------------------------------------------------
# Mutation (RED) checks for smi-7114-refresh-faults.sh. Kept here so the harness files stay under
# the 500-line limit. Each mutation is (regexp over pg_get_functiondef text, replacement) and must
# match its function EXACTLY ONCE (checked at run time).
# ---------------------------------------------------------------------------------------------
# Mutations (plan RED TESTS column). Each is (regexp over pg_get_functiondef text, replacement) and
# MUST match its function EXACTLY ONCE (checked at run time). Matched against
# supabase/migrations/20261013000000_skills_refresh_metadata_pg_cron.sql.
HEALTH_FN="public.refresh_metadata_health(interval)"
DEADMAN_FN="public.check_refresh_observer_heartbeat(interval)"
HARVEST_FN="public.harvest_refresh_dispatch_results()"
# F1: remove the non-2xx arm (the 404 then falls to ELSE 'ok').
MUT_F1_RE="WHEN j\\.status_code NOT BETWEEN 200 AND 299\\s+THEN 'http_error'"
MUT_F1_TO=""
# F2: key the transport arm on timed_out (NULL on the measured shape) instead of status_code IS NULL.
MUT_F2_RE="WHEN j\\.status_code IS NULL(\\s+)THEN 'transport_error'"
MUT_F2_TO="WHEN EXISTS (SELECT 1 FROM net._http_response h WHERE h.timed_out IS TRUE AND h.error_msg IS NOT DISTINCT FROM j.error_msg)\\1THEN 'transport_error'"
# F3: collapse `unknown` into `no_response` (delete the unknown arm; the next arm catches the row).
MUT_F3_RE="WHEN j\\.created_at < now\\(\\) - v_ttl\\s+THEN 'unknown'"
MUT_F3_TO=""
# DM (i): remove the SLA comparison.
MUT_DM1_RE="IF v_age <= p_sla THEN"
MUT_DM1_TO="IF false THEN"
# DM (ii): drop the dedup lookup (it then finds no alert rows, so it never suppresses).
MUT_DM2_RE="a\\.event_type = 'refresh:observer_dead_alert'"
MUT_DM2_TO="a.event_type = 'refresh:observer_dead_alert_ZZ'"
# F5 (i): drop the NOT EXISTS idempotence guard of the harvester (a second call then duplicates).
MUT_F5A_RE="AND NOT EXISTS \\(\\s*SELECT 1 FROM audit_logs x\\s+WHERE x\\.event_type = 'refresh:dispatch_result'\\s+AND x\\.metadata->>'net_request_id' = d\\.rid::text\\s*\\)"
MUT_F5A_TO=""
# F5 (ii): the RPC ignores the durable row for status_code (live response wins).
MUT_F5B_RE="CASE WHEN dr\\.created_at IS NOT NULL(\\s+)THEN CASE WHEN dr\\.metadata->>'status_code'"
MUT_F5B_TO="CASE WHEN false\\1THEN CASE WHEN dr.metadata->>'status_code'"
NO_MUT_RE="ZZ_NO_MATCH_ZZ"

IFS= read -r -d '' MUT_PRELUDE <<'SQL' || true
SELECT pg_get_functiondef(:'mut_func'::regprocedure) AS def \gset
SELECT regexp_replace(:'def', :'mut_from', :'mut_to', 'g') AS mdef \gset
SELECT '@@mutation_matches=' || (SELECT count(*) FROM regexp_matches(:'def', :'mut_from', 'g'))::text;
SELECT '@@mutation_applied=' || (:'def' <> :'mdef')::text;
SQL

# mut_status: sets MUT_APPLIED=true only when the regexp CHANGED the function AND matched exactly once.
mut_status() {
  MUT_MATCHES=$(kv mutation_matches)
  if [ "$(kv mutation_applied)" = "true" ] && [ "$MUT_MATCHES" = "1" ]; then
    MUT_APPLIED=true
  else
    MUT_APPLIED=false
  fi
}

# red_eval FUNC RE TO BODY [extra -v args...]: runs BODY inside BEGIN; <mutated function>; BODY; ROLLBACK.
# Sets MUT_APPLIED/MUT_MATCHES; BODY's @@ lines are left in LAST_OUT. Returns non-zero when the SQL
# errored (the caller records RED-UNVERIFIED: an erroring mutation is a red for the wrong reason).
red_eval() {
  local func="$1" re="$2" to="$3" body="$4"
  shift 4
  run_sql -v "mut_func=$func" -v "mut_from=$re" -v "mut_to=$to" "$@" <<<"$MUT_PRELUDE
BEGIN;
SELECT :'mdef' \\gexec
$body
ROLLBACK;" || return 1
  mut_status
}

red_unverified() {
  record "$1" "RED-UNVERIFIED" "the mutated function or its assertion errored in SQL (stderr above): an erroring mutation proves nothing; fix the MUT_* text"
}

# red_verdict NAME EXPECT_FIELD HEALTHY_VALUE: RED-OK iff the mutation applied once AND the field changed.
red_verdict() {
  local name="$1" field="$2" healthy="$3" observed
  observed=$(kv "$field")
  if [ "$MUT_APPLIED" != "true" ]; then
    record "$name" "RED-UNVERIFIED" "mutation regexp matched $MUT_MATCHES time(s) (need exactly 1) / did not change the function -- update MUT_* to match the migration; nothing was proven"
  elif [ "$observed" != "$healthy" ]; then
    record "$name" "RED-OK" "under the mutation $field=$observed (healthy value $healthy): the assertion would FAIL"
  else
    record "$name" "FAIL" "mutation applied but $field stayed $healthy: the assertion does not constrain the mutated arm (decorative test)"
  fi
}

