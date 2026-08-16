#!/usr/bin/env bash
# SMI-6040 (Wave 1, Step 4) — anon-key daily budget smoke probe helpers.
#
# Split out of anon-budget.sh (SMI-audit-standards Check: <500 lines/file,
# CLAUDE.md CI Health Requirements) -- this file holds every reusable
# "toolbox" function (credential guards, the HTTP request helper, the three
# service-role RPC callers, and egress-IP/hash-identity derivation). The two
# public check functions (`check_anon_budget_counter_increments`,
# `check_anon_budget_identity_derivation`) and their private Layer 2
# sub-functions stay in anon-budget.sh itself, since those are what
# scripts/smoke-prod/surfaces.json's "checks" array names directly.
#
# Sourced by anon-budget.sh, same as lib.sh -- not meant to be sourced
# standalone (it depends on SMOKE_SUPABASE_URL / SMOKE_TRIAL_SALT /
# SMOKE_SERVICE_ROLE_KEY / SMOKE_HTTP_TIMEOUT being set by the caller, and on
# lib.sh's smoke_warn/with_retry/now_ms already being in scope).

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh

# ---- credential guards ------------------------------------------------------
# Each guard only smoke_warns + returns 1 -- same shape as
# search.sh's `_require_search_supabase_url`. The HARD-FAIL behavior lives in
# the calling check function, which turns a guard failure into `report_fail`
# (not `report_pass`) for every credential this script needs. That is the
# deliberate deviation from this directory's usual soft-skip convention (see
# anon-budget.sh's module header).

_require_anon_budget_supabase_url() {
  if [ -z "$SMOKE_SUPABASE_URL" ]; then
    smoke_warn "SUPABASE_URL not set -- anon-budget check cannot run"
    return 1
  fi
  return 0
}

_require_anon_budget_anon_key() {
  if [ -z "$SMOKE_ANON_KEY_VALUE" ]; then
    smoke_warn "SUPABASE_ANON_KEY not set -- anon-budget check cannot run"
    return 1
  fi
  return 0
}

_require_anon_budget_trial_salt() {
  if [ -z "$SMOKE_TRIAL_SALT" ]; then
    smoke_warn "TRIAL_SALT not set -- anon-budget identity-derivation check cannot run"
    return 1
  fi
  return 0
}

_require_anon_budget_service_role_key() {
  if [ -z "$SMOKE_SERVICE_ROLE_KEY" ]; then
    smoke_warn "SUPABASE_SERVICE_ROLE_KEY not set -- anon-budget identity-derivation check cannot run"
    return 1
  fi
  return 0
}

# ---- request helper ----------------------------------------------------------

# _anon_budget_search_request ANON_KEY -- one anon-key GET to skills-search.
# Echoes "STATUS\nX-ANON-BUDGET-USED\nBODY" (three sections; lib.sh's
# http_body only returns STATUS\nBODY, which is not enough here -- this probe
# needs the X-Anon-Budget-Used response header, not just the body).
# Header shape mirrors search.sh's own anon RPC calls (apikey + Authorization:
# Bearer <key>) and was empirically confirmed against prod to classify as
# `X-Auth-Method: anon_key` (2026-08-15) -- not assumed from reading
# auth-middleware.ts alone.
_anon_budget_search_request() {
  local anon="$1"
  local url="${SMOKE_SUPABASE_URL}/functions/v1/skills-search?category=testing&limit=1"
  local body_tmp headers_tmp status used
  body_tmp=$(mktemp)
  headers_tmp=$(mktemp)
  status=$(curl --silent --show-error \
    --max-time "$SMOKE_HTTP_TIMEOUT" \
    --output "$body_tmp" \
    --dump-header "$headers_tmp" \
    --write-out '%{http_code}' \
    --request GET \
    -H "apikey: ${anon}" \
    -H "Authorization: Bearer ${anon}" \
    "$url" 2>/dev/null) || status="000"
  used=$(grep -i '^x-anon-budget-used:' "$headers_tmp" | tail -n1 | cut -d: -f2- | tr -d ' \r\n')
  printf '%s\n%s\n' "$status" "$used"
  cat "$body_tmp"
  rm -f "$body_tmp" "$headers_tmp"
}

# ---- service-role RPC helpers -------------------------------------------------
# All three call service-role-only functions (REVOKEd from anon/authenticated
# in the migration), so every call authenticates as service_role via both
# `apikey` and `Authorization: Bearer` -- the same pairing convention lib.sh's
# callers use for the anon key, just with the service-role credential.

# _anon_budget_seed IP_HASH COUNT -- SET (not increment) today's counter.
# Echoes "STATUS\nBODY".
_anon_budget_seed() {
  local ip_hash="$1" count="$2"
  local url="${SMOKE_SUPABASE_URL}/rest/v1/rpc/seed_anon_usage"
  local payload
  payload=$(printf '{"ip_hash_input":"%s","count_input":%d}' "$ip_hash" "$count")
  with_retry http_body POST "$url" \
    -H "apikey: ${SMOKE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SMOKE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

# _anon_budget_adjust IP_HASH DELTA -- atomic GREATEST(0, count + delta).
# Echoes "STATUS\nBODY". Used ONLY for the delta=-1 reset (never a fixed-value
# SET) -- see anon-budget.sh's module header + check_anon_budget_identity_derivation
# for why: a fixed SET reset would erase a real concurrent increment that
# landed in the seed-to-request window (plan's PR #2379 review finding).
_anon_budget_adjust() {
  local ip_hash="$1" delta="$2"
  local url="${SMOKE_SUPABASE_URL}/rest/v1/rpc/adjust_anon_usage"
  local payload
  payload=$(printf '{"ip_hash_input":"%s","delta_input":%d}' "$ip_hash" "$delta")
  with_retry http_body POST "$url" \
    -H "apikey: ${SMOKE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SMOKE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload"
}

# _anon_budget_reset IP_HASH -- best-effort cleanup, called from the RETURN
# trap. Never fails the check itself -- only warns. seed_anon_usage /
# adjust_anon_usage are themselves idempotent (plan §P-5), so a reset that
# fails to land here just leaves one probe cycle's worth of drift that the
# NEXT run's seed step silently overwrites -- "a crash doesn't leave stale
# test data lying around unnecessarily" (plan, Wave 1 Step 4).
_anon_budget_reset() {
  local ip_hash="$1"
  local resp status
  resp=$(_anon_budget_adjust "$ip_hash" "-1") || true
  status=$(printf '%s' "$resp" | head -n1)
  case "$status" in
    2??) ;;
    *)
      smoke_warn "check_anon_budget_identity_derivation: cleanup adjust_anon_usage(-1) returned status=${status} for ip_hash=${ip_hash:0:8}... -- stale probe state may remain until the next run's seed overwrites it"
      ;;
  esac
}

# ---- identity derivation -----------------------------------------------------

# _anon_budget_egress_ip -- the runner's own public egress IP via
# api.ipify.org (plain text, no JSON parsing needed). Echoes the IP on
# success; returns 1 on any failure (network error, non-IP response body) so
# the caller can report_fail rather than silently deriving a wrong identity.
_anon_budget_egress_ip() {
  local ip
  ip=$(with_retry curl --silent --show-error --fail \
    --max-time "$SMOKE_HTTP_TIMEOUT" \
    "https://api.ipify.org") || return 1
  ip=$(printf '%s' "$ip" | tr -d '[:space:]')
  if [[ "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    printf '%s' "$ip"
    return 0
  fi
  return 1
}

# _anon_budget_hash_ip IP SALT -- byte-identical to hashIP() in
# _shared/client-ip.ts:252-262: sha256(ip + salt), hex, first 32 chars.
# sha256sum is the CI-runner-native tool (ubuntu); shasum is macOS's default
# (no sha256sum there); openssl is the final, near-universal fallback -- per
# the plan's explicit call to verify sha256sum availability or fall back to
# openssl. Echoes the 32-char hash; returns 1 if no SHA-256 tool is present.
_anon_budget_hash_ip() {
  local ip="$1" salt="$2" input digest
  input="${ip}${salt}"
  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(printf '%s' "$input" | sha256sum | cut -c1-64)
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(printf '%s' "$input" | shasum -a 256 | cut -c1-64)
  elif command -v openssl >/dev/null 2>&1; then
    digest=$(printf '%s' "$input" | openssl dgst -sha256 -r | cut -d' ' -f1)
  else
    return 1
  fi
  if [ -z "$digest" ]; then
    return 1
  fi
  printf '%s' "$digest" | cut -c1-32
}
