#!/usr/bin/env bash
# SMI-5532 — fuzzy_search_skills word_similarity smoke checks.
#
# Checks:
#   check_fuzzy_short_query_bounded        — POST fuzzy_search_skills RPC with a short
#                                            high-cardinality needle ("ci"); asserts HTTP 200,
#                                            >0 rows, and a now_ms delta bounded well under the
#                                            pre-fix ~1853ms cost (prod prototype: 305ms for
#                                            "ci" @0.3 post-fix -- see docs/internal/
#                                            implementation/smi-5532-fuzzy-word-similarity-migration.md).
#   check_fuzzy_recall_short_token         — POST fuzzy_search_skills RPC with "sql" at the
#                                            recommend-caller's 0.2 threshold; recall guard --
#                                            the rejected Option A (raw threshold remap without
#                                            the word_similarity swap) zeroed rows for callers at
#                                            this threshold. Option H floors every caller onto
#                                            GREATEST(threshold, 0.5) on the word-similarity
#                                            scale; the prod prototype measured full recall
#                                            (20 rows) for "sql" @0.2 post-fix.
#   check_recommend_fallback_2char         — POST skills-recommend end-to-end with a 2-char stack
#                                            token; the DX-critical fallback path (the handler
#                                            falls back to fuzzy_search_skills at its own 0.2
#                                            threshold when search_skills has no direct match for
#                                            a short stack -- see
#                                            supabase/functions/skills-recommend/index.ts:192).
#                                            Unauthenticated, matching the plain no-auth trial
#                                            path a first-time CLI user hits. skills-recommend
#                                            shares the SAME IP-hash trial pool as skills-search
#                                            (trial-limiter.ts: 100 requests TOTAL per IP hash,
#                                            not per endpoint), so a structured trial-exhausted
#                                            401 or a 429 here proves the function is alive and
#                                            enforcing policy, not broken -- the same SMI-5370
#                                            precedent as website.sh's check_skills_search_edge_fn.
#                                            Treating those as hard failures would false-page
#                                            on-call whenever the CI runner's egress IP has burned
#                                            the shared trial quota.
#   check_fuzzy_normal_query_no_regression — POST fuzzy_search_skills RPC with a normal-cardinality
#                                            needle ("docker"); no-regression guard. Pre-fix
#                                            ~480ms was already acceptable; prod prototype measured
#                                            182ms post-fix.
#   check_fuzzy_stage2_fallback_recall     — SMI-6284: POST fuzzy_search_skills RPC with a genuine
#                                            typo ("dokcer") that has zero name-arm matches, so the
#                                            20260831120000 staged rewrite's stage 2 (description
#                                            arm) actually executes -- none of the other checks in
#                                            this file exercise stage 2 at all, since "ci"/"sql"/
#                                            "docker" all fill the limit from the name arm alone.
#                                            Asserts HTTP 200, >0 rows, no duplicate ids (stage-1/
#                                            stage-2 dedup), and a 1000ms ceiling -- measured live
#                                            101-113ms for "dokcer"; the plan doc's own adversarial
#                                            testing found a rarer term ("kuberentes") reaching
#                                            ~551-708ms, still under this ceiling but closer to it
#                                            -- see docs/internal/implementation/
#                                            smi-6284-fuzzy-search-scale-redesign.md for why that
#                                            residual risk is monitored (Wave 2) rather than capped
#                                            tighter here.
#
# fuzzy_search_skills EXECUTE is granted to anon (see
# supabase/migrations/20260704184030_fuzzy_search_skills_shortquery_cost.sql), so checks (a)/(b)/(d)
# call the RPC directly with the anon apikey, mirroring the anon-RPC-call convention in
# inventory.sh's check_get_user_inventory_rpc_denies_anon (apikey + Authorization: Bearer
# <anon-key> headers).
#
# See docs/internal/implementation/smi-5532-fuzzy-word-similarity-migration.md ("What Changes" #2)
# for the design record this surface implements.

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"

# SUPABASE_URL must be supplied by the caller (env/secret). Fail loudly if absent -- same guard
# shape used in events.sh / inventory.sh / website.sh.
SMOKE_SUPABASE_URL="${SUPABASE_URL:-}"

_require_search_supabase_url() {
  if [ -z "$SMOKE_SUPABASE_URL" ]; then
    smoke_warn "SUPABASE_URL not set -- skipping fuzzy-search check"
    return 1
  fi
  return 0
}

# _fuzzy_row_count BODY -- echoes the row count of a fuzzy_search_skills JSON array response, or
# -1 if BODY is not a JSON array (error object / empty body). jq is a hard dependency of the
# orchestrator (scripts/smoke-prod.sh checks `command -v jq` before dispatching any surface), so
# using it here matches the harness's own reporting idiom in lib.sh's _append_result rather than
# adding a python3 dependency for a plain array-length check.
_fuzzy_row_count() {
  local body="$1" out
  out=$(printf '%s' "$body" | jq 'if type == "array" then length else -1 end' 2>/dev/null)
  if [ -z "$out" ]; then
    out="-1"
  fi
  printf '%s' "$out"
}

# _fuzzy_row_ids_unique BODY -- echoes "true" if BODY is a JSON array where every element is an
# object with a non-null `id` and every `id` is distinct (guards the SMI-6284 staged rewrite's
# stage-1/stage-2 dedup), "false" if a duplicate OR any malformed/null-id row exists (confirmation-
# review finding: a single null/missing id used to pass silently, since it's trivially "unique"
# against every real id -- now any malformed row fails outright), or "unknown" if BODY is not a
# JSON array at all.
_fuzzy_row_ids_unique() {
  local body="$1" out
  out=$(printf '%s' "$body" | jq -r '
    if type != "array" then "unknown"
    elif (all(.[]; type == "object" and (.id != null)) | not) then "false"
    else (length == (map(.id) | unique | length) | tostring)
    end
  ' 2>/dev/null)
  if [ -z "$out" ]; then
    out="unknown"
  fi
  printf '%s' "$out"
}

# _recommend_data_count BODY -- echoes the length of the .data array in a skills-recommend success
# envelope ({"data":[...],"meta":{...}}), or -1 if BODY is not an object with a .data array.
_recommend_data_count() {
  local body="$1" out
  out=$(printf '%s' "$body" | jq 'if type == "object" and (.data | type) == "array" then (.data | length) else -1 end' 2>/dev/null)
  if [ -z "$out" ]; then
    out="-1"
  fi
  printf '%s' "$out"
}

# ---- check_fuzzy_short_query_bounded ---------------------------------------
# "ci" is the short, high-cardinality needle from the confirmed prod pathology (pre-fix ~1853ms
# via the `%` operator over ~174k trigram candidates). Post-fix (`<%`/word_similarity), the prod
# read-only prototype measured 305ms. Ceiling fixed at 1000ms -- meaningfully under the ~1853ms
# pre-fix cost, with headroom above the 305ms prototype measurement for run-to-run network/DB
# variance, so a regression back toward the pre-fix pathology fails loudly without the check being
# timing-flaky.
check_fuzzy_short_query_bounded() {
  _require_search_supabase_url || {
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_short_query_bounded" "" "SUPABASE_URL" "unset"
    return 1
  }
  local anon="${SUPABASE_ANON_KEY:-}"
  if [ -z "$anon" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_short_query_bounded" "" "SUPABASE_ANON_KEY" "unset"
    return 1
  fi

  local url="${SMOKE_SUPABASE_URL}/rest/v1/rpc/fuzzy_search_skills"
  local payload='{"search_query":"ci","similarity_threshold":0.3,"limit_count":20}'
  local ceiling_ms=1000
  local t0 t1 ms resp status body rows

  t0=$(now_ms)
  resp=$(with_retry http_body POST "$url" \
    -H "apikey: ${anon}" \
    -H "Authorization: Bearer ${anon}" \
    -H "Content-Type: application/json" \
    -d "$payload") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_short_query_bounded" "$url" "200" "$status" "$ms"
    return 1
  fi

  rows=$(_fuzzy_row_count "$body")
  if [ "$rows" -le 0 ] 2>/dev/null; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_short_query_bounded" "$url" "rows>0" "rows=${rows}" "$ms"
    return 1
  fi

  if [ "$ms" -ge "$ceiling_ms" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_short_query_bounded" "$url" "<${ceiling_ms}ms" "${ms}ms" "$ms"
    return 1
  fi

  report_pass "edge-fn-fuzzy-search" "check_fuzzy_short_query_bounded" "$url" "$ms"
  return 0
}

# ---- check_fuzzy_recall_short_token -----------------------------------------
# Recall guard for "sql" at the recommend-caller's 0.2 threshold -- see the module header for the
# Option A vs Option H context. No timing ceiling here; this check is purely a recall (row-count)
# guard. check_fuzzy_short_query_bounded and check_fuzzy_normal_query_no_regression own the timing
# assertions.
check_fuzzy_recall_short_token() {
  _require_search_supabase_url || {
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_recall_short_token" "" "SUPABASE_URL" "unset"
    return 1
  }
  local anon="${SUPABASE_ANON_KEY:-}"
  if [ -z "$anon" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_recall_short_token" "" "SUPABASE_ANON_KEY" "unset"
    return 1
  fi

  local url="${SMOKE_SUPABASE_URL}/rest/v1/rpc/fuzzy_search_skills"
  local payload='{"search_query":"sql","similarity_threshold":0.2,"limit_count":20}'
  local t0 t1 ms resp status body rows

  t0=$(now_ms)
  resp=$(with_retry http_body POST "$url" \
    -H "apikey: ${anon}" \
    -H "Authorization: Bearer ${anon}" \
    -H "Content-Type: application/json" \
    -d "$payload") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_recall_short_token" "$url" "200" "$status" "$ms"
    return 1
  fi

  rows=$(_fuzzy_row_count "$body")
  if [ "$rows" -le 0 ] 2>/dev/null; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_recall_short_token" "$url" "rows>0" "rows=${rows}" "$ms"
    return 1
  fi

  report_pass "edge-fn-fuzzy-search" "check_fuzzy_recall_short_token" "$url" "$ms"
  return 0
}

# ---- check_recommend_fallback_2char -----------------------------------------
# End-to-end DX-critical path -- see the module header for the trial-pool soft-pass rationale
# (mirrors website.sh's check_skills_search_edge_fn, SMI-5370).
check_recommend_fallback_2char() {
  _require_search_supabase_url || {
    report_fail "edge-fn-fuzzy-search" "check_recommend_fallback_2char" "" "SUPABASE_URL" "unset"
    return 1
  }

  local url="${SMOKE_SUPABASE_URL}/functions/v1/skills-recommend"
  local payload='{"stack":["ci"]}'
  local t0 t1 ms resp status body

  t0=$(now_ms)
  resp=$(with_retry http_body POST "$url" \
    -H "Content-Type: application/json" \
    -d "$payload") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  case "$status" in
    429)
      smoke_warn "check_recommend_fallback_2char: rate-limited (429) -- soft pass"
      report_pass "edge-fn-fuzzy-search" "check_recommend_fallback_2char" "$url" "$ms"
      return 0
      ;;
    401)
      # SMI-5370-style structured trial-exhausted 401 == function alive.
      if printf '%s' "$body" | grep -Eq '"signupUrl"|"trialUsed"|Free trial'; then
        smoke_warn "check_recommend_fallback_2char: trial-exhausted 401 (structured) -- soft pass"
        report_pass "edge-fn-fuzzy-search" "check_recommend_fallback_2char" "$url" "$ms"
        return 0
      fi
      report_fail "edge-fn-fuzzy-search" "check_recommend_fallback_2char" "$url" "200|429|structured-401" "401-bare" "$ms"
      return 1
      ;;
    200) ;;
    *)
      report_fail "edge-fn-fuzzy-search" "check_recommend_fallback_2char" "$url" "200" "$status" "$ms"
      return 1
      ;;
  esac

  local rec_count
  rec_count=$(_recommend_data_count "$body")
  if [ "$rec_count" -le 0 ] 2>/dev/null; then
    report_fail "edge-fn-fuzzy-search" "check_recommend_fallback_2char" "$url" "data.length>0" "data.length=${rec_count}" "$ms"
    return 1
  fi

  report_pass "edge-fn-fuzzy-search" "check_recommend_fallback_2char" "$url" "$ms"
  return 0
}

# ---- check_fuzzy_normal_query_no_regression ---------------------------------
# "docker" is a normal-cardinality query, not on the short-high-cardinality pathology. Pre-fix
# cost was already acceptable (~480ms); the prod prototype measured 182ms post-fix. Ceiling fixed
# at 600ms -- headroom above the 182ms prototype measurement for run-to-run variance, while still
# catching a real regression back toward (or past) the pre-fix ~480ms.
check_fuzzy_normal_query_no_regression() {
  _require_search_supabase_url || {
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_normal_query_no_regression" "" "SUPABASE_URL" "unset"
    return 1
  }
  local anon="${SUPABASE_ANON_KEY:-}"
  if [ -z "$anon" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_normal_query_no_regression" "" "SUPABASE_ANON_KEY" "unset"
    return 1
  fi

  local url="${SMOKE_SUPABASE_URL}/rest/v1/rpc/fuzzy_search_skills"
  local payload='{"search_query":"docker","similarity_threshold":0.3,"limit_count":20}'
  local ceiling_ms=600
  local t0 t1 ms resp status body rows

  t0=$(now_ms)
  resp=$(with_retry http_body POST "$url" \
    -H "apikey: ${anon}" \
    -H "Authorization: Bearer ${anon}" \
    -H "Content-Type: application/json" \
    -d "$payload") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_normal_query_no_regression" "$url" "200" "$status" "$ms"
    return 1
  fi

  rows=$(_fuzzy_row_count "$body")
  if [ "$rows" -le 0 ] 2>/dev/null; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_normal_query_no_regression" "$url" "rows>0" "rows=${rows}" "$ms"
    return 1
  fi

  if [ "$ms" -ge "$ceiling_ms" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_normal_query_no_regression" "$url" "<${ceiling_ms}ms" "${ms}ms" "$ms"
    return 1
  fi

  report_pass "edge-fn-fuzzy-search" "check_fuzzy_normal_query_no_regression" "$url" "$ms"
  return 0
}

# ---- check_fuzzy_stage2_fallback_recall -------------------------------------
# SMI-6284: "dokcer" has zero name-arm matches at threshold 0.5 (confirmed live during this
# migration's adversarial testing), so this is the one check in this file that actually exercises
# the staged rewrite's stage 2 (description arm). Ceiling 1000ms matches
# check_fuzzy_short_query_bounded's; measured live 101-113ms for "dokcer" -- see the module header
# comment for why a rarer term can run closer to (but still under) this ceiling.
check_fuzzy_stage2_fallback_recall() {
  _require_search_supabase_url || {
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_stage2_fallback_recall" "" "SUPABASE_URL" "unset"
    return 1
  }
  local anon="${SUPABASE_ANON_KEY:-}"
  if [ -z "$anon" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_stage2_fallback_recall" "" "SUPABASE_ANON_KEY" "unset"
    return 1
  fi

  local url="${SMOKE_SUPABASE_URL}/rest/v1/rpc/fuzzy_search_skills"
  local payload='{"search_query":"dokcer","similarity_threshold":0.3,"limit_count":20}'
  local ceiling_ms=1000
  local t0 t1 ms resp status body rows unique

  t0=$(now_ms)
  resp=$(with_retry http_body POST "$url" \
    -H "apikey: ${anon}" \
    -H "Authorization: Bearer ${anon}" \
    -H "Content-Type: application/json" \
    -d "$payload") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_stage2_fallback_recall" "$url" "200" "$status" "$ms"
    return 1
  fi

  rows=$(_fuzzy_row_count "$body")
  if [ "$rows" -le 0 ] 2>/dev/null; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_stage2_fallback_recall" "$url" "rows>0" "rows=${rows}" "$ms"
    return 1
  fi

  unique=$(_fuzzy_row_ids_unique "$body")
  if [ "$unique" != "true" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_stage2_fallback_recall" "$url" "unique ids" "duplicates=${unique}" "$ms"
    return 1
  fi

  if [ "$ms" -ge "$ceiling_ms" ]; then
    report_fail "edge-fn-fuzzy-search" "check_fuzzy_stage2_fallback_recall" "$url" "<${ceiling_ms}ms" "${ms}ms" "$ms"
    return 1
  fi

  report_pass "edge-fn-fuzzy-search" "check_fuzzy_stage2_fallback_recall" "$url" "$ms"
  return 0
}
