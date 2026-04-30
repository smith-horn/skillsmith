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
  # Extract the first <title>...</title> and assert "Skillsmith" inside it.
  # Avoids false-positive matches on "Skillsmith" appearing anywhere in body
  # (e.g. footer copyright) while the title itself is broken/empty.
  local title
  title=$(printf '%s' "$body" | tr -d '\n' | sed -n 's/.*<title[^>]*>\(.*\)<\/title>.*/\1/p' | head -c 500)
  if ! assert_contains "$title" "Skillsmith" "homepage-title-content"; then
    report_fail "website-homepage" "check_website_homepage_renders" "$url" "Skillsmith in <title>" "title='${title}'" "$ms"
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
  # Require the <sitemapindex> root element (proves we got a real sitemap
  # index, not an HTML 200 from a misconfigured rewrite/SPA fallback) AND
  # at least one <sitemap> child entry (an empty index would silently
  # degrade GSC crawl prioritization per SMI-4184).
  if ! assert_contains "$body" "<sitemapindex" "sitemap-root-element"; then
    report_fail "website-homepage" "check_website_sitemap_index" "$url" "<sitemapindex" "missing-sitemap-root" "$ms"
    return 1
  fi
  if ! assert_contains "$body" "<sitemap>" "sitemap-child-element"; then
    report_fail "website-homepage" "check_website_sitemap_index" "$url" "<sitemap>" "empty-sitemap-index" "$ms"
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

# ---- check_blog_local_db_renders --------------------------------------
# Verifies the /blog/inside-the-local-skill-database post renders. Uses
# the page title text as a stable fingerprint — the title is part of the
# blog frontmatter (canonical content), so a missing/changed title means
# either the post was unpublished or the slug changed (both are
# regressions worth catching).
check_blog_local_db_renders() {
  local url="${SMOKE_WEBSITE_URL}/blog/inside-the-local-skill-database"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "blog-local-skill-database" "check_blog_local_db_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Inside the Local Skill Database' "blog-title"; then
    report_fail "blog-local-skill-database" "check_blog_local_db_renders" "$url" "title-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "blog-local-skill-database" "check_blog_local_db_renders" "$url" "$ms"
  return 0
}

# ---- check_product_page_renders ---------------------------------------
# Verifies the /product comparison page renders. Uses the hero H1 text as
# a stable fingerprint — the H1 is part of the page source (not a
# Cloudinary asset), so a missing H1 means the page either failed to
# build or has been replaced. Also asserts the comparison table
# fingerprint so a render that loses the table doesn't pass.
check_product_page_renders() {
  local url="${SMOKE_WEBSITE_URL}/product"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "website-product-page" "check_product_page_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'MCP for Claude. CLI for terminals.' "product-hero"; then
    report_fail "website-product-page" "check_product_page_renders" "$url" "hero-fingerprint" "missing" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Capability comparison' "product-matrix"; then
    report_fail "website-product-page" "check_product_page_renders" "$url" "matrix-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-product-page" "check_product_page_renders" "$url" "$ms"
  return 0
}
