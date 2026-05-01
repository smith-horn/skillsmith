#!/usr/bin/env bash
# SMI-4459 — website + edge-function smoke checks.
# Read-only. Uses curl with a 10s timeout per call. Single 2s-backoff retry
# on transient failure (HTTP 000 or curl error).

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"

SMOKE_WEBSITE_URL="${SMOKE_WEBSITE_URL:-https://www.skillsmith.app}"
# SUPABASE_URL must be supplied by the caller (env/secret). Fail loudly if absent.
SMOKE_SUPABASE_URL="${SUPABASE_URL:-}"

_require_supabase_url() {
  if [ -z "$SMOKE_SUPABASE_URL" ]; then
    smoke_warn "SUPABASE_URL not set — skipping edge-fn check"
    return 1
  fi
  return 0
}

# ---- check_health_edge_fn ---------------------------------------------
# Always-on canary. Hits the public health endpoint; 200 + JSON body. Used
# every PR (including --dry-run sanity) to prove the harness wiring works.
check_health_edge_fn() {
  _require_supabase_url || { report_fail "health" "check_health_edge_fn" "" "SUPABASE_URL" "unset"; return 1; }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/health"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status GET "$url")
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ "$status" = "200" ]; then
    report_pass "health" "check_health_edge_fn" "$url" "$ms"
    return 0
  fi
  report_fail "health" "check_health_edge_fn" "$url" "200" "$status" "$ms"
  return 1
}

# ---- check_device_page_renders ----------------------------------------
# Verifies the /device page renders the device-input form (not the expired
# fallback). Uses the data-smoke="device-input" attribute as a stable
# fingerprint (see Q3 of the plan).
check_device_page_renders() {
  local url="${SMOKE_WEBSITE_URL}/device"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "website-device-page" "check_device_page_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'data-smoke="device-input"' "device-page-content"; then
    report_fail "website-device-page" "check_device_page_renders" "$url" 'data-smoke="device-input"' "missing-fingerprint" "$ms"
    return 1
  fi
  report_pass "website-device-page" "check_device_page_renders" "$url" "$ms"
  return 0
}

# ---- check_auth_device_code_reachable ---------------------------------
# POSTs an empty JSON body. Function deployed and routing → 400 (validation
# error). 404 = function never deployed (the SMI-4252-class regression we
# want to surface). 200 is also acceptable in case the validator changes.
check_auth_device_code_reachable() {
  _require_supabase_url || { report_fail "edge-fn-auth-device" "check_auth_device_code_reachable" "" "SUPABASE_URL" "unset"; return 1; }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/auth-device-code"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status POST "$url" -H 'content-type: application/json' -d '{}')
  t1=$(now_ms)
  ms=$((t1 - t0))
  case "$status" in
    200|400)
      report_pass "edge-fn-auth-device" "check_auth_device_code_reachable" "$url" "$ms"
      return 0
      ;;
    404)
      report_fail "edge-fn-auth-device" "check_auth_device_code_reachable" "$url" "200|400" "404 (function not deployed?)" "$ms"
      return 1
      ;;
    *)
      report_fail "edge-fn-auth-device" "check_auth_device_code_reachable" "$url" "200|400" "$status" "$ms"
      return 1
      ;;
  esac
}

# ---- check_website_homepage_renders -----------------------------------
# SMI-4592 — homepage 200 + <title> contains "Skillsmith". Catches broken
# Vercel build output / adapter mismatches that the SMI-4592 fix addressed.
check_website_homepage_renders() {
  local url="${SMOKE_WEBSITE_URL}/"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "website-homepage" "check_website_homepage_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" "<title>" "homepage-title-tag"; then
    report_fail "website-homepage" "check_website_homepage_renders" "$url" "<title>...</title>" "missing-title" "$ms"
    return 1
  fi
  if ! assert_contains "$body" "Skillsmith" "homepage-title-content"; then
    report_fail "website-homepage" "check_website_homepage_renders" "$url" "Skillsmith in <title>" "missing-brand" "$ms"
    return 1
  fi
  report_pass "website-homepage" "check_website_homepage_renders" "$url" "$ms"
  return 0
}

# ---- check_website_pricing_renders ------------------------------------
check_website_pricing_renders() {
  local url="${SMOKE_WEBSITE_URL}/pricing"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status GET "$url")
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ "$status" = "200" ]; then
    report_pass "website-homepage" "check_website_pricing_renders" "$url" "$ms"
    return 0
  fi
  report_fail "website-homepage" "check_website_pricing_renders" "$url" "200" "$status" "$ms"
  return 1
}

# ---- check_website_docs_quickstart_renders ----------------------------
check_website_docs_quickstart_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/quickstart"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status GET "$url")
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ "$status" = "200" ]; then
    report_pass "website-homepage" "check_website_docs_quickstart_renders" "$url" "$ms"
    return 0
  fi
  report_fail "website-homepage" "check_website_docs_quickstart_renders" "$url" "200" "$status" "$ms"
  return 1
}

# ---- check_website_sitemap_index --------------------------------------
# SMI-4184 lastmod must be present for GSC crawl prioritization. Sitemap
# regression would silently degrade Discovered-not-indexed metrics.
check_website_sitemap_index() {
  local url="${SMOKE_WEBSITE_URL}/sitemap-index.xml"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "website-homepage" "check_website_sitemap_index" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" "<sitemap>" "sitemap-element"; then
    report_fail "website-homepage" "check_website_sitemap_index" "$url" "<sitemap>" "missing-sitemap-element" "$ms"
    return 1
  fi
  report_pass "website-homepage" "check_website_sitemap_index" "$url" "$ms"
  return 0
}

# ---- check_auth_device_preview_requires_jwt ---------------------------
# GET without auth. Gateway-verified function → 401 with no JWT. 200 means
# JWT verification is broken (dangerous; the cousins-of-B1 class).
check_auth_device_preview_requires_jwt() {
  _require_supabase_url || { report_fail "edge-fn-auth-device" "check_auth_device_preview_requires_jwt" "" "SUPABASE_URL" "unset"; return 1; }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/auth-device-preview"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status GET "$url")
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ "$status" = "401" ]; then
    report_pass "edge-fn-auth-device" "check_auth_device_preview_requires_jwt" "$url" "$ms"
    return 0
  fi
  report_fail "edge-fn-auth-device" "check_auth_device_preview_requires_jwt" "$url" "401" "$status" "$ms"
  return 1
}
