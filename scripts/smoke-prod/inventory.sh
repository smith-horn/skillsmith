#!/usr/bin/env bash
# SMI-5396 Wave 6 — cross-harness skill inventory smoke checks.
#
# Two anon-only, zero-write, PII-free checks (the smoke job runs with
# SUPABASE_URL + SUPABASE_ANON_KEY only; the service-role key is isolated to
# the separate alert job by design, so it is intentionally NOT used here):
#
#   check_inventory_upload_requires_jwt
#       POST (no auth) to /functions/v1/inventory-upload. inventory-upload is
#       gateway-verified (SMI-5389), so a request with no JWT must be rejected
#       by the gateway with 401. A 200 (or any non-401) means JWT verification
#       regressed -- and this endpoint writes per-user inventory rows, so a
#       broken gate is high-impact.
#
#   check_get_user_inventory_rpc_denies_anon
#       POST (anon apikey) to /rest/v1/rpc/get_user_inventory. The RPC is
#       granted only to authenticated/service_role (20260626000001:180), so an
#       anon caller has no EXECUTE path -> PostgREST denies with 401/403 (or
#       404 if the role cannot resolve it). The critical failure is a 200, which
#       would mean an anonymous data route exists. A connection error (000) or
#       5xx is treated as a fail, not a pass, so a transient blip cannot mask a
#       regression. (M8: this assumes PostgREST has reloaded its schema cache
#       after the migration -- always true at smoke time, since the migration is
#       applied during the 24h soak, long before the surface ships.)
#
# Deeper behavioral coverage -- consent-off no-op, seeded-row owner visibility,
# and read-path cross-user RLS isolation -- lives in the staging e2e hard gate
# (cross-harness-inventory.spec.ts Tests A/C/E), which blocks the merge. Prod
# smoke is the post-deploy liveness + anon-denial canary only.
#
# See docs/internal/implementation/smi-5396-inventory-prod-rollout.md.

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"

# SUPABASE_URL must be supplied by the caller (env/secret). Fail loudly if
# absent -- same guard shape used in website.sh / events.sh.
SMOKE_SUPABASE_URL="${SUPABASE_URL:-}"

_require_inventory_supabase_url() {
  if [ -z "$SMOKE_SUPABASE_URL" ]; then
    smoke_warn "SUPABASE_URL not set -- skipping inventory check"
    return 1
  fi
  return 0
}

# ---- check_inventory_upload_requires_jwt ---------------------------------
# POST without auth. Gateway-verified function -> 401 with no JWT. Any non-401
# means the gateway JWT verification regressed.
check_inventory_upload_requires_jwt() {
  _require_inventory_supabase_url || {
    report_fail "edge-fn-inventory-upload" "check_inventory_upload_requires_jwt" "" "SUPABASE_URL" "unset"
    return 1
  }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/inventory-upload"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status POST "$url" -H "Content-Type: application/json" -d '{}')
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ "$status" = "401" ]; then
    report_pass "edge-fn-inventory-upload" "check_inventory_upload_requires_jwt" "$url" "$ms"
    return 0
  fi
  report_fail "edge-fn-inventory-upload" "check_inventory_upload_requires_jwt" "$url" "401" "$status" "$ms"
  return 1
}

# ---- check_get_user_inventory_rpc_denies_anon ----------------------------
# Anon-key RPC call. The function is granted only to authenticated/service_role,
# so an anon caller must be denied. Pass = a denial status (401/403/404).
# A 200 is the dangerous case (anonymous data route) and fails loudly; a
# connection/transient error (000/5xx) also fails so it can't mask a regression.
check_get_user_inventory_rpc_denies_anon() {
  _require_inventory_supabase_url || {
    report_fail "edge-fn-inventory-upload" "check_get_user_inventory_rpc_denies_anon" "" "SUPABASE_URL" "unset"
    return 1
  }
  local anon="${SUPABASE_ANON_KEY:-}"
  if [ -z "$anon" ]; then
    # Anon key absent (e.g. a local run) -- skip without pass/fail, mirroring
    # events.sh row-visibility. CI always supplies SUPABASE_ANON_KEY.
    smoke_warn "SUPABASE_ANON_KEY not set -- skipping anon-denial RPC check"
    return 0
  fi
  local url="${SMOKE_SUPABASE_URL}/rest/v1/rpc/get_user_inventory"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status POST "$url" \
    -H "apikey: ${anon}" \
    -H "Authorization: Bearer ${anon}" \
    -H "Content-Type: application/json" \
    -d '{}')
  t1=$(now_ms)
  ms=$((t1 - t0))
  case "$status" in
    401 | 403 | 404)
      report_pass "edge-fn-inventory-upload" "check_get_user_inventory_rpc_denies_anon" "$url" "$ms"
      return 0
      ;;
    *)
      # 200 = leak (anon got a data route); 000/5xx = transient/unexpected.
      report_fail "edge-fn-inventory-upload" "check_get_user_inventory_rpc_denies_anon" "$url" "401|403|404" "$status" "$ms"
      return 1
      ;;
  esac
}
