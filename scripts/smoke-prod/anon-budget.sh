#!/usr/bin/env bash
# SMI-6040 (Wave 1, Step 4) — anon-key daily budget behavioral smoke probes.
#
# Context: `_shared/anon-budget.ts` metres shared-anon-key traffic (requests
# authenticating as `authMethod === 'anon_key'` -- the Supabase anon key sent
# as an `Authorization: Bearer` token with no personal API key and no JWT
# session) with a per-IP-hash DAILY budget, service-role-backed by the
# `check_anon_usage` RPC. `ENFORCE_ANON_BUDGET` ships OFF (shadow) in Wave 1
# -- see docs/internal/implementation/smi-6040-anon-key-metering-implementation.md
# ("Rollout flag + continuously-executed behavioral enforcement probes").
#
# Design precedent this file exists to avoid repeating: `ENFORCE_COMMUNITY_QUOTA`
# sat unset ~112 days despite an equivalent behavioral check already existing,
# because that check was never wired into always-run smoke. Per that lesson,
# THIS surface ships with `always_run: true` in surfaces.json and hard-fails
# (not soft-skips) on a missing credential -- a missing TRIAL_SALT or
# service-role key in prod CI is itself the silent-misconfiguration class this
# probe exists to catch, not a reason to pass quietly. This deliberately
# diverges from most other canaries in this directory (e.g.
# api-proxy.sh:64-71, search.sh:60-66's `smoke_warn` + soft-skip on a missing
# non-credential var) -- see the plan doc's §5 for the explicit reasoning.
#
# Checks:
#   check_anon_budget_counter_increments  — Layer 1 (every run, both modes).
#     Two consecutive anon-key GETs to skills-search; asserts the second
#     response's X-Anon-Budget-Used is exactly the first's + 1. Proves the
#     check_anon_usage RPC write path executes on real traffic -- header
#     PRESENCE alone would not prove the RPC actually ran and persisted.
#   check_anon_budget_identity_derivation — Layer 2 (mode-aware, gated on
#     ANON_BUDGET_INTENDED_MODE below). Computes the runner's own budget
#     identity the same way the edge middleware does
#     (sha256(egress-IP + TRIAL_SALT), truncated to 32 hex chars -- see
#     hashIP() in _shared/client-ip.ts:252-262), seeds a known count via the
#     service-role-only seed_anon_usage RPC, issues one real anon-key
#     request, and asserts the observed X-Anon-Budget-Used against the
#     manifest mode. The reset step (adjust_anon_usage, delta=-1) always
#     runs via a RETURN trap, even if an assertion above it fails or
#     `return`s early.
#
# ANON_BUDGET_INTENDED_MODE is this script's own self-contained "manifest
# mode" -- a plain shell constant, NOT a new scripts/smoke-prod/surfaces.json
# field. Keeping it here (rather than plumbing a field through the
# orchestrator) satisfies the plan's requirement that the intended-mode
# record be "updated in the same PR as any flag flip": Wave 4 flips
# ENFORCE_ANON_BUDGET (an edge secret) and this one line together, in the
# same PR, so drift between "what prod enforces" and "what smoke expects" is
# structurally impossible to introduce silently.
#
# Wave 1 exercises ONLY the shadow branch (ANON_BUDGET_INTENDED_MODE stays
# "shadow" for this entire wave). The enforce branch below is fully written
# --  syntactically complete and reachable the instant this constant flips --
# but is dead code until Wave 4 flips it; it has never executed against prod
# and cannot be exercised until ENFORCE_ANON_BUDGET + ANON_DAILY_BUDGET are
# actually set (SMOKE_ANON_DAILY_BUDGET, read below, is this script's own
# mirror of that budget -- see the comment on _anon_budget_layer2_enforce
# for why).
ANON_BUDGET_INTENDED_MODE="shadow"

# The exact observed X-Anon-Budget-Used value the shadow branch asserts.
# NOTE ip_hash is seeded to (this - 1), not this value: check_anon_usage
# ATOMICALLY INCREMENTS before returning (see the migration,
# supabase/migrations/20260816000000_anon_usage_budget.sql:198-203 --
# `request_count = anon_usage.request_count + 1 ... RETURNING request_count
# INTO current_count`), so "one real request observes exactly N" requires
# seeding to N-1, not N. Empirically confirmed live against prod
# (2026-08-15): curling skills-search with the anon key as
# `Authorization: Bearer` returns `X-Auth-Method: anon_key` and a real,
# RPC-backed `X-Anon-Budget-Used` header.
ANON_BUDGET_SHADOW_TARGET_USED=3

# Mirrors the frozen `code` value in `anonBudgetExceededResponse`
# (_shared/anon-budget.ts:46, `ANON_BUDGET_EXHAUSTED_CODE`). Duplicated as a
# literal rather than imported -- there is no shared runtime between a Deno
# edge function and this bash harness -- so a rename of that TS constant
# needs a matching edit here (same accepted-drift shape as every other
# cross-language literal in this directory, e.g. inventory.sh's RPC names).
ANON_BUDGET_EXHAUSTED_CODE="anon_budget_exhausted"

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"
# shellcheck source=scripts/smoke-prod/anon-budget.helpers.sh
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/anon-budget.helpers.sh"

# All four are read once at module scope, mirroring search.sh's
# SMOKE_SUPABASE_URL convention -- each is re-checked by its own guard at the
# top of every check function so a missing one still fails loudly per-check
# (JSON report gets one fail entry per affected check, not one global abort).
SMOKE_SUPABASE_URL="${SUPABASE_URL:-}"
SMOKE_ANON_KEY_VALUE="${SUPABASE_ANON_KEY:-}"
SMOKE_TRIAL_SALT="${TRIAL_SALT:-}"
# shellcheck disable=SC2034 # consumed by anon-budget.helpers.sh's _anon_budget_seed/_anon_budget_adjust — shellcheck's
# per-file analysis can't see across the sourced file even with a `source=` directive on a computed ($SMOKE_LIB_DIR) path.
SMOKE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

# ---- check_anon_budget_counter_increments -----------------------------------
# Layer 1 (§What Changes 5): proves the check_anon_usage RPC write path
# executes on real traffic. Runs every mode, every time -- always_run: true
# in surfaces.json (see that entry's comment for why this must never be
# trigger_globs-gated).
check_anon_budget_counter_increments() {
  _require_anon_budget_supabase_url || {
    report_fail "anon-budget" "check_anon_budget_counter_increments" "" "SUPABASE_URL" "unset"
    return 1
  }
  _require_anon_budget_anon_key || {
    report_fail "anon-budget" "check_anon_budget_counter_increments" "" "SUPABASE_ANON_KEY" "unset"
    return 1
  }

  local anon="$SMOKE_ANON_KEY_VALUE"
  local url="${SMOKE_SUPABASE_URL}/functions/v1/skills-search"
  local t0 t1 ms resp1 resp2 status1 status2 used1 used2

  # Deliberately NOT with_retry (same reasoning repeated at
  # _anon_budget_layer2_shadow/_anon_budget_layer2_enforce's own
  # _anon_budget_search_request call sites below): check_anon_usage
  # increments non-idempotently on every call this makes, and this check's
  # own assertion is an EXACT used2 == used1+1 delta -- a
  # phantom retry (whether from a genuinely ambiguous "000" status or from
  # with_retry's substring match false-firing on a "000" appearing anywhere
  # in the response BODY, e.g. a `.000Z` millisecond-precision timestamp in
  # a real skill row) would silently add an extra real increment neither
  # side of the delta accounts for.
  t0=$(now_ms)
  resp1=$(_anon_budget_search_request "$anon") || true
  status1=$(printf '%s' "$resp1" | sed -n '1p')
  used1=$(printf '%s' "$resp1" | sed -n '2p')

  resp2=$(_anon_budget_search_request "$anon") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status2=$(printf '%s' "$resp2" | sed -n '1p')
  used2=$(printf '%s' "$resp2" | sed -n '2p')

  if [ "$status1" != "200" ]; then
    report_fail "anon-budget" "check_anon_budget_counter_increments" "$url" "200 (request 1)" "$status1" "$ms"
    return 1
  fi
  if [ "$status2" != "200" ]; then
    report_fail "anon-budget" "check_anon_budget_counter_increments" "$url" "200 (request 2)" "$status2" "$ms"
    return 1
  fi

  if ! [[ "$used1" =~ ^[0-9]+$ ]] || ! [[ "$used2" =~ ^[0-9]+$ ]]; then
    report_fail "anon-budget" "check_anon_budget_counter_increments" "$url" \
      "numeric X-Anon-Budget-Used on both requests" "used1='${used1}' used2='${used2}'" "$ms"
    return 1
  fi

  local expected=$((used1 + 1))
  if [ "$used2" -ne "$expected" ]; then
    report_fail "anon-budget" "check_anon_budget_counter_increments" "$url" \
      "X-Anon-Budget-Used=${expected}" "X-Anon-Budget-Used=${used2}" "$ms"
    return 1
  fi

  report_pass "anon-budget" "check_anon_budget_counter_increments" "$url" "$ms"
  return 0
}

# ---- check_anon_budget_identity_derivation ----------------------------------
# Layer 2 (§What Changes 5): proves the runner's egress-IP+TRIAL_SALT hash
# matches what the edge middleware derives from cf-connecting-ip, and (in
# shadow mode) that a seeded budget count round-trips through a real request
# exactly. Mode-aware via ANON_BUDGET_INTENDED_MODE (module header).
check_anon_budget_identity_derivation() {
  _require_anon_budget_supabase_url || {
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "" "SUPABASE_URL" "unset"
    return 1
  }
  _require_anon_budget_anon_key || {
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "" "SUPABASE_ANON_KEY" "unset"
    return 1
  }
  # Hard-fail, not soft-skip -- see module header. A missing TRIAL_SALT here
  # means prod would be using trial-limiter.ts's public DEFAULT_TRIAL_SALT
  # fallback, which is the exact silent-misconfiguration class this probe
  # exists to catch (Wave 0 confirmed this was unset in prod before Wave 0
  # Step 2 set it).
  _require_anon_budget_trial_salt || {
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "" "TRIAL_SALT" "unset"
    return 1
  }
  _require_anon_budget_service_role_key || {
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "" "SUPABASE_SERVICE_ROLE_KEY" "unset"
    return 1
  }

  local url="${SMOKE_SUPABASE_URL}/functions/v1/skills-search"
  local t0 ms ip ip_hash

  t0=$(now_ms)

  ip=$(_anon_budget_egress_ip) || {
    ms=$(( $(now_ms) - t0 ))
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "https://api.ipify.org" \
      "parseable egress IPv4" "unparseable/unreachable" "$ms"
    return 1
  }

  ip_hash=$(_anon_budget_hash_ip "$ip" "$SMOKE_TRIAL_SALT") || {
    ms=$(( $(now_ms) - t0 ))
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "$url" \
      "sha256 tool available (sha256sum/shasum/openssl)" "none found" "$ms"
    return 1
  }

  case "$ANON_BUDGET_INTENDED_MODE" in
    shadow)
      _anon_budget_layer2_shadow "$ip_hash" "$t0" "$url"
      return $?
      ;;
    enforce)
      _anon_budget_layer2_enforce "$ip_hash" "$t0" "$url"
      return $?
      ;;
    *)
      ms=$(( $(now_ms) - t0 ))
      report_fail "anon-budget" "check_anon_budget_identity_derivation" "$url" \
        "ANON_BUDGET_INTENDED_MODE in {shadow,enforce}" "$ANON_BUDGET_INTENDED_MODE" "$ms"
      return 1
      ;;
  esac
}

# _anon_budget_layer2_shadow IP_HASH T0 URL -- the ONLY branch Wave 1
# actually exercises. Seeds ANON_BUDGET_SHADOW_TARGET_USED - 1 (see that
# constant's comment for the atomic-increment reasoning), issues one real
# anon-key request, and asserts the observed X-Anon-Budget-Used equals
# ANON_BUDGET_SHADOW_TARGET_USED exactly -- proving the identity hash this
# script computed is the SAME identity the edge middleware derived for that
# request (a mismatched hash would seed a different row than the one the
# real request increments, and the assertion would observe 1, not 3).
_anon_budget_layer2_shadow() {
  local ip_hash="$1" t0="$2" url="$3"
  local ms seed_count resp seed_status

  seed_count=$((ANON_BUDGET_SHADOW_TARGET_USED - 1))
  resp=$(_anon_budget_seed "$ip_hash" "$seed_count") || true
  seed_status=$(printf '%s' "$resp" | head -n1)
  case "$seed_status" in
    2??) ;;
    *)
      ms=$(( $(now_ms) - t0 ))
      report_fail "anon-budget" "check_anon_budget_identity_derivation" \
        "${SMOKE_SUPABASE_URL}/rest/v1/rpc/seed_anon_usage" "2xx" "$seed_status" "$ms"
      return 1
      ;;
  esac

  # From here on, our seed landed -- the reset MUST run on every exit path
  # (assertion pass, assertion fail, or an unexpected early return), per the
  # plan's idempotency requirement ("implementer should still make the reset
  # step idempotent ... so a crash doesn't leave stale test data lying
  # around"). `trap ... RETURN` fires exactly once when THIS function
  # returns, regardless of which `return` statement below fires it.
  trap '_anon_budget_reset "$ip_hash"' RETURN

  # Deliberately NOT with_retry -- same reasoning as
  # check_anon_budget_counter_increments: check_anon_usage increments
  # non-idempotently on every call, and this branch asserts an EXACT seeded
  # target, so a phantom with_retry-triggered second call (ambiguous "000"
  # status, or a "000" substring anywhere in the real skills-search response
  # body) would silently push `used` one past ANON_BUDGET_SHADOW_TARGET_USED.
  local anon_resp status used
  anon_resp=$(_anon_budget_search_request "$SMOKE_ANON_KEY_VALUE") || true
  ms=$(( $(now_ms) - t0 ))
  status=$(printf '%s' "$anon_resp" | sed -n '1p')
  used=$(printf '%s' "$anon_resp" | sed -n '2p')

  if [ "$status" != "200" ]; then
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "$url" "200" "$status" "$ms"
    return 1
  fi

  if [ "$used" != "$ANON_BUDGET_SHADOW_TARGET_USED" ]; then
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "$url" \
      "X-Anon-Budget-Used=${ANON_BUDGET_SHADOW_TARGET_USED}" "X-Anon-Budget-Used=${used}" "$ms"
    return 1
  fi

  report_pass "anon-budget" "check_anon_budget_identity_derivation" "$url" "$ms"
  return 0
}

# _anon_budget_layer2_enforce IP_HASH T0 URL -- written for Wave 4, NOT
# reachable in Wave 1 (ANON_BUDGET_INTENDED_MODE stays "shadow" this wave).
#
# SMOKE_ANON_DAILY_BUDGET design note (real design call, not obvious from the
# plan text alone -- flagged here deliberately): the plan says "read live
# ANON_DAILY_BUDGET (service-role read of the deployed secret, never a
# hardcoded number)". `npx supabase secrets list` cannot return secret
# VALUES -- confirmed; it only returns name + digest, so there is no API path
# for this script to read the live edge-function secret's actual value. This
# branch instead reads a SEPARATE smoke-only env var, SMOKE_ANON_DAILY_BUDGET,
# that Wave 4's flip PR must set to the SAME value as the real
# ANON_DAILY_BUDGET secret in the same workflow env block (see
# .github/workflows/smoke-prod.yml). This is a deliberate mirror, not a
# read of the live value -- if the two ever drift, this check seeds against
# the WRONG budget and can false-pass or false-fail. Whoever performs the
# Wave 4 flip must set both together.
_anon_budget_layer2_enforce() {
  local ip_hash="$1" t0="$2" url="$3"
  local ms budget

  budget="${SMOKE_ANON_DAILY_BUDGET:-}"
  if [ -z "$budget" ] || ! [[ "$budget" =~ ^[0-9]+$ ]]; then
    ms=$(( $(now_ms) - t0 ))
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "$url" \
      "SMOKE_ANON_DAILY_BUDGET (positive integer)" "unset/unparseable" "$ms"
    return 1
  fi

  local seed_count resp seed_status
  seed_count=$((budget + 1))
  resp=$(_anon_budget_seed "$ip_hash" "$seed_count") || true
  seed_status=$(printf '%s' "$resp" | head -n1)
  case "$seed_status" in
    2??) ;;
    *)
      ms=$(( $(now_ms) - t0 ))
      report_fail "anon-budget" "check_anon_budget_identity_derivation" \
        "${SMOKE_SUPABASE_URL}/rest/v1/rpc/seed_anon_usage" "2xx" "$seed_status" "$ms"
      return 1
      ;;
  esac

  # See _anon_budget_layer2_shadow for why this trap must be armed
  # immediately after a successful seed and before the real request.
  trap '_anon_budget_reset "$ip_hash"' RETURN

  # Deliberately NOT with_retry -- see _anon_budget_layer2_shadow's identical
  # note. A phantom second real request here would still land as a genuine
  # extra increment against this probe's synthetic identity (harmless
  # long-term -- the next run's seed_anon_usage absolute SET erases the
  # drift -- but wrong for exactly the same reason: this is a non-idempotent
  # write, not a fetch, so ambiguous-failure retry is unsound here too).
  local anon_resp status body code
  anon_resp=$(_anon_budget_search_request "$SMOKE_ANON_KEY_VALUE") || true
  ms=$(( $(now_ms) - t0 ))
  status=$(printf '%s' "$anon_resp" | sed -n '1p')
  body=$(printf '%s' "$anon_resp" | tail -n +3)

  if [ "$status" != "401" ]; then
    # A 200 here means fail-open in prod: enforcement was requested but the
    # over-budget identity was still let through. Smoke fails on every run
    # until fixed -- exactly the plan's stated consequence.
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "$url" "401" "$status" "$ms"
    return 1
  fi

  code=$(printf '%s' "$body" | jq -r '.code // ""' 2>/dev/null)
  if [ "$code" != "$ANON_BUDGET_EXHAUSTED_CODE" ]; then
    report_fail "anon-budget" "check_anon_budget_identity_derivation" "$url" \
      "code=${ANON_BUDGET_EXHAUSTED_CODE}" "code=${code}" "$ms"
    return 1
  fi

  report_pass "anon-budget" "check_anon_budget_identity_derivation" "$url" "$ms"
  return 0
}
