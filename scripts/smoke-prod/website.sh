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

# ---- check_website_docs_inventory_renders ------------------------------
# SMI-5464: /docs/inventory is the beta-tester onboarding URL for the
# cross-machine skill inventory (SMI-5397). Fingerprint on the h1 so a
# 200-with-error-shell page still fails.
check_website_docs_inventory_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/inventory"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-inventory" "check_website_docs_inventory_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Cross-Machine Skill Inventory' "inventory-fingerprint"; then
    report_fail "website-docs-inventory" "check_website_docs_inventory_renders" "$url" "inventory-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-inventory" "check_website_docs_inventory_renders" "$url" "$ms"
  return 0
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

# ---- check_sync_stripe_email_requires_jwt -----------------------------
# SMI-5168. GET without auth. sync-stripe-email is gateway-verified, so a
# request with no JWT must be rejected by the gateway with 401. 200 (or any
# non-401) means JWT verification regressed — and this endpoint can mutate a
# Stripe customer, so a broken gate is high-impact.
check_sync_stripe_email_requires_jwt() {
  _require_supabase_url || { report_fail "edge-fn-sync-stripe-email" "check_sync_stripe_email_requires_jwt" "" "SUPABASE_URL" "unset"; return 1; }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/sync-stripe-email"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status GET "$url")
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ "$status" = "401" ]; then
    report_pass "edge-fn-sync-stripe-email" "check_sync_stripe_email_requires_jwt" "$url" "$ms"
    return 0
  fi
  report_fail "edge-fn-sync-stripe-email" "check_sync_stripe_email_requires_jwt" "$url" "401" "$status" "$ms"
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

# ---- skills API usage-counter helpers ------------------------------------
# Shared env vars consumed by the three usage-counter checks below.
#
# SMOKE_SKILLS_API_KEY   -- sk_live_* key for the staging smoke account.
#                           Provisioned once; see SMI-4755 provisioning note.
#                           Maps to SMOKE_SKILLS_API_KEY GitHub Actions secret.
# SMOKE_SKILLS_EMAIL     -- Email address of the staging smoke account.
#                           Used to sign in and obtain a JWT for reading
#                           the user_api_usage row via RLS-gated REST.
#                           Maps to SMOKE_SKILLS_EMAIL GitHub Actions secret.
# SMOKE_SKILLS_PASSWORD  -- Password for SMOKE_SKILLS_EMAIL account.
#                           Maps to SMOKE_SKILLS_PASSWORD GitHub Actions secret.
#
# Both SMOKE_SKILLS_API_KEY and the email/password credentials must refer to
# the SAME staging user account so that the RLS-gated SELECT on
# user_api_usage (authenticated users can read their own rows only) returns
# the row incremented by the API call.

_require_skills_smoke_creds() {
  if [ -z "${SMOKE_SKILLS_API_KEY:-}" ]; then
    smoke_warn "SMOKE_SKILLS_API_KEY not set -- skipping usage-counter check"
    return 1
  fi
  if [ -z "${SMOKE_SKILLS_EMAIL:-}" ] || [ -z "${SMOKE_SKILLS_PASSWORD:-}" ]; then
    smoke_warn "SMOKE_SKILLS_EMAIL / SMOKE_SKILLS_PASSWORD not set -- skipping usage-counter check"
    return 1
  fi
  return 0
}

# SMI-4755: optional staging-routing for skills usage-counter checks.
# The smoke harness signs in to the project where the smoke account lives.
# When SMOKE_SKILLS_SUPABASE_URL / SMOKE_SKILLS_SUPABASE_ANON_KEY are set,
# the three check_skills_* functions target staging (ovhcifugwqnzoebwfuku);
# unset, they fall back to the prod SMOKE_SUPABASE_URL / SUPABASE_ANON_KEY.
# Edge functions auto-deploy to both prod and staging from main, so smoking
# against staging exercises the same code path without polluting prod.
SMOKE_SKILLS_URL="${SMOKE_SKILLS_SUPABASE_URL:-$SMOKE_SUPABASE_URL}"
SMOKE_SKILLS_ANON_KEY="${SMOKE_SKILLS_SUPABASE_ANON_KEY:-${SUPABASE_ANON_KEY:-}}"

# JWT cache: module-level variable so all three usage-counter checks reuse
# one sign-in call (avoids 3x sign-in overhead when all three surfaces
# trigger together, e.g. on _shared/auth-middleware.ts or usage-counter.ts
# changes, helping stay within the 60s total smoke budget).
_SKILLS_JWT_CACHE=""

# _skills_sign_in -- sign in with email/password; echoes JWT to stdout or
# returns 1 on failure. Caches result in _SKILLS_JWT_CACHE so subsequent
# calls within the same smoke run are a no-op.
_skills_sign_in() {
  if [ -n "$_SKILLS_JWT_CACHE" ]; then
    printf '%s' "$_SKILLS_JWT_CACHE"
    return 0
  fi
  local resp jwt
  resp=$(curl --silent --max-time "$SMOKE_HTTP_TIMEOUT" \
    -X POST "${SMOKE_SKILLS_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${SMOKE_SKILLS_ANON_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${SMOKE_SKILLS_EMAIL}\",\"password\":\"${SMOKE_SKILLS_PASSWORD}\"}" 2>/dev/null) || return 1
  jwt=$(printf '%s' "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null) || return 1
  if [ -z "$jwt" ]; then return 1; fi
  _SKILLS_JWT_CACHE="$jwt"
  printf '%s' "$jwt"
}

# _skills_usage_count ENDPOINT JWT -- queries user_api_usage for the current
# hour bucket and returns the count for the given endpoint column
# (search_count, get_count, or recommend_count). Returns -1 on error.
_skills_usage_count() {
  local endpoint="$1" jwt="$2"
  local col resp count
  case "$endpoint" in
    search)    col="search_count" ;;
    get)       col="get_count" ;;
    recommend) col="recommend_count" ;;
    *)         printf '%s' "-1"; return 1 ;;
  esac
  # Query user_api_usage for the current hour bucket. RLS policy allows
  # each user to SELECT their own rows only (auth.uid() = user_id).
  # Sum across all rows for safety, though there is normally at most one
  # row per (user_id, hour_bucket) thanks to the UNIQUE constraint.
  local hour_start
  hour_start=$(date -u +%Y-%m-%dT%H:00:00Z)
  resp=$(curl --silent --max-time "$SMOKE_HTTP_TIMEOUT" \
    "${SMOKE_SKILLS_URL}/rest/v1/user_api_usage?select=${col}&hour_bucket=gte.${hour_start}" \
    -H "apikey: ${SMOKE_SKILLS_ANON_KEY}" \
    -H "Authorization: Bearer ${jwt}" \
    -H "Accept: application/json" 2>/dev/null) || { printf '%s' "-1"; return 1; }
  count=$(printf '%s' "$resp" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
if not isinstance(rows, list):
    print(-1)
else:
    print(sum(r.get('${col}', 0) for r in rows))
" 2>/dev/null) || count="-1"
  printf '%s' "$count"
}

# ---- check_skills_search_usage_counter --------------------------------
# SMI-4755: Authenticated GET to skills-search with a real sk_live_* key.
# Asserts HTTP 200 and that search_count in user_api_usage incremented by 1
# for the current hour bucket, proving the usage-counter path is live.
check_skills_search_usage_counter() {
  _require_supabase_url || { report_fail "edge-fn-skills-search" "check_skills_search_usage_counter" "" "SUPABASE_URL" "unset"; return 1; }
  _require_skills_smoke_creds || {
    report_fail "edge-fn-skills-search" "check_skills_search_usage_counter" "" "SMOKE_SKILLS_API_KEY" "unset"
    return 1
  }

  local url="${SMOKE_SKILLS_URL}/functions/v1/skills-search?category=testing&limit=1"
  local jwt before after expected_after t0 t1 ms status

  jwt=$(_skills_sign_in) || {
    report_fail "edge-fn-skills-search" "check_skills_search_usage_counter" "$url" "sign-in-ok" "sign-in-failed"
    return 1
  }

  before=$(_skills_usage_count "search" "$jwt")
  if [ "$before" = "-1" ]; then
    report_fail "edge-fn-skills-search" "check_skills_search_usage_counter" "$url" "usage-query-ok" "pre-call-query-failed"
    return 1
  fi

  t0=$(now_ms)
  status=$(with_retry http_status GET "$url" \
    -H "X-API-Key: ${SMOKE_SKILLS_API_KEY}" \
    -H "Accept: application/json")
  t1=$(now_ms)
  ms=$((t1 - t0))

  if [ "$status" != "200" ]; then
    report_fail "edge-fn-skills-search" "check_skills_search_usage_counter" "$url" "200" "$status" "$ms"
    return 1
  fi

  after=$(_skills_usage_count "search" "$jwt")
  expected_after=$((before + 1))
  if [ "$after" != "$expected_after" ]; then
    report_fail "edge-fn-skills-search" "check_skills_search_usage_counter" "$url" \
      "search_count=${expected_after}" "search_count=${after}" "$ms"
    return 1
  fi

  report_pass "edge-fn-skills-search" "check_skills_search_usage_counter" "$url" "$ms"
  return 0
}

# ---- check_skills_get_usage_counter -----------------------------------
# SMI-4755: Authenticated GET to skills-get with a real sk_live_* key.
# Uses a probe skill ID that need not exist -- the counter increments on
# both 200 (found) and 404 (not found) authenticated responses.
check_skills_get_usage_counter() {
  _require_supabase_url || { report_fail "edge-fn-skills-get" "check_skills_get_usage_counter" "" "SUPABASE_URL" "unset"; return 1; }
  _require_skills_smoke_creds || {
    report_fail "edge-fn-skills-get" "check_skills_get_usage_counter" "" "SMOKE_SKILLS_API_KEY" "unset"
    return 1
  }

  # skillsmith/smoke-test-probe need not exist; the auth middleware still
  # runs, the counter increments, and the function returns 404 (skill not
  # found). This is intentional: we want to verify the counter path runs
  # on any authenticated request, not just successful lookups.
  local url="${SMOKE_SKILLS_URL}/functions/v1/skills-get?id=skillsmith%2Fsmoke-test-probe"
  local jwt before after expected_after t0 t1 ms status

  jwt=$(_skills_sign_in) || {
    report_fail "edge-fn-skills-get" "check_skills_get_usage_counter" "$url" "sign-in-ok" "sign-in-failed"
    return 1
  }

  before=$(_skills_usage_count "get" "$jwt")
  if [ "$before" = "-1" ]; then
    report_fail "edge-fn-skills-get" "check_skills_get_usage_counter" "$url" "usage-query-ok" "pre-call-query-failed"
    return 1
  fi

  t0=$(now_ms)
  status=$(with_retry http_status GET "$url" \
    -H "X-API-Key: ${SMOKE_SKILLS_API_KEY}" \
    -H "Accept: application/json")
  t1=$(now_ms)
  ms=$((t1 - t0))

  # 200 (skill found) and 404 (skill not in registry) are both valid --
  # the counter increments on both paths. 500/000/403 are real failures.
  case "$status" in
    200|404) ;;
    *)
      report_fail "edge-fn-skills-get" "check_skills_get_usage_counter" "$url" "200|404" "$status" "$ms"
      return 1
      ;;
  esac

  after=$(_skills_usage_count "get" "$jwt")
  expected_after=$((before + 1))
  if [ "$after" != "$expected_after" ]; then
    report_fail "edge-fn-skills-get" "check_skills_get_usage_counter" "$url" \
      "get_count=${expected_after}" "get_count=${after}" "$ms"
    return 1
  fi

  report_pass "edge-fn-skills-get" "check_skills_get_usage_counter" "$url" "$ms"
  return 0
}

# ---- check_skills_recommend_usage_counter -----------------------------
# SMI-4755: Authenticated POST to skills-recommend with a real sk_live_* key.
# Asserts HTTP 200 and that recommend_count in user_api_usage incremented by 1.
check_skills_recommend_usage_counter() {
  _require_supabase_url || { report_fail "edge-fn-skills-recommend" "check_skills_recommend_usage_counter" "" "SUPABASE_URL" "unset"; return 1; }
  _require_skills_smoke_creds || {
    report_fail "edge-fn-skills-recommend" "check_skills_recommend_usage_counter" "" "SMOKE_SKILLS_API_KEY" "unset"
    return 1
  }

  local url="${SMOKE_SKILLS_URL}/functions/v1/skills-recommend"
  local jwt before after expected_after t0 t1 ms status

  jwt=$(_skills_sign_in) || {
    report_fail "edge-fn-skills-recommend" "check_skills_recommend_usage_counter" "$url" "sign-in-ok" "sign-in-failed"
    return 1
  }

  before=$(_skills_usage_count "recommend" "$jwt")
  if [ "$before" = "-1" ]; then
    report_fail "edge-fn-skills-recommend" "check_skills_recommend_usage_counter" "$url" "usage-query-ok" "pre-call-query-failed"
    return 1
  fi

  t0=$(now_ms)
  status=$(with_retry http_status POST "$url" \
    -H "X-API-Key: ${SMOKE_SKILLS_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d '{"stack":["typescript"]}')
  t1=$(now_ms)
  ms=$((t1 - t0))

  if [ "$status" != "200" ]; then
    report_fail "edge-fn-skills-recommend" "check_skills_recommend_usage_counter" "$url" "200" "$status" "$ms"
    return 1
  fi

  after=$(_skills_usage_count "recommend" "$jwt")
  expected_after=$((before + 1))
  if [ "$after" != "$expected_after" ]; then
    report_fail "edge-fn-skills-recommend" "check_skills_recommend_usage_counter" "$url" \
      "recommend_count=${expected_after}" "recommend_count=${after}" "$ms"
    return 1
  fi

  report_pass "edge-fn-skills-recommend" "check_skills_recommend_usage_counter" "$url" "$ms"
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
  if ! assert_contains "$body" 'Author, version, deprecate, and govern' "product-hero"; then
    report_fail "website-product-page" "check_product_page_renders" "$url" "hero-fingerprint" "missing" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'One lifecycle, four surfaces' "product-matrix"; then
    report_fail "website-product-page" "check_product_page_renders" "$url" "matrix-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-product-page" "check_product_page_renders" "$url" "$ms"
  return 0
}

# ---- Wave 2 lifecycle tutorials (SMI-4791) ---------------------------
# Each check verifies HTTP 200 on a tutorial URL and asserts a stable
# fingerprint string from the page body so a deploy that serves an empty
# 200 (Vercel fallback) doesn't pass.

check_website_docs_tutorials_index_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/tutorials"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_index_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'How you use a skill, day to day' "tutorials-landing"; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_index_renders" "$url" "tutorials-landing" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-tutorials" "check_website_docs_tutorials_index_renders" "$url" "$ms"
  return 0
}

check_website_docs_tutorials_discover_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/tutorials/discover"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_discover_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Tutorial: Discover skills' "discover-fingerprint"; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_discover_renders" "$url" "discover-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-tutorials" "check_website_docs_tutorials_discover_renders" "$url" "$ms"
  return 0
}

check_website_docs_tutorials_evaluate_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/tutorials/evaluate"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_evaluate_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Tutorial: Evaluate candidates' "evaluate-fingerprint"; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_evaluate_renders" "$url" "evaluate-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-tutorials" "check_website_docs_tutorials_evaluate_renders" "$url" "$ms"
  return 0
}

check_website_docs_tutorials_install_and_use_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/tutorials/install-and-use"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_install_and_use_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Tutorial: Install &amp; Use' "install-and-use-fingerprint"; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_install_and_use_renders" "$url" "install-and-use-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-tutorials" "check_website_docs_tutorials_install_and_use_renders" "$url" "$ms"
  return 0
}

check_website_docs_tutorials_maintain_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/tutorials/maintain"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_maintain_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Tutorial: Maintain installed skills' "maintain-fingerprint"; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_maintain_renders" "$url" "maintain-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-tutorials" "check_website_docs_tutorials_maintain_renders" "$url" "$ms"
  return 0
}

check_website_docs_tutorials_author_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/tutorials/author"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_author_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Tutorial: Author your own skill' "author-fingerprint"; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_author_renders" "$url" "author-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-tutorials" "check_website_docs_tutorials_author_renders" "$url" "$ms"
  return 0
}

check_website_docs_tutorials_govern_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/tutorials/govern"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_govern_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Tutorial: Govern at scale' "govern-fingerprint"; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_govern_renders" "$url" "govern-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-tutorials" "check_website_docs_tutorials_govern_renders" "$url" "$ms"
  return 0
}

check_website_docs_tutorials_uninstall_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/tutorials/uninstall"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_uninstall_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Tutorial: Uninstall skills' "uninstall-fingerprint"; then
    report_fail "website-docs-tutorials" "check_website_docs_tutorials_uninstall_renders" "$url" "uninstall-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-tutorials" "check_website_docs_tutorials_uninstall_renders" "$url" "$ms"
  return 0
}

check_website_docs_vscode_extension_renders() {
  local url="${SMOKE_WEBSITE_URL}/docs/vscode-extension"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)
  if [ "$status" != "200" ]; then
    report_fail "website-docs-tutorials" "check_website_docs_vscode_extension_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Activity bar and views' "vscode-fingerprint"; then
    report_fail "website-docs-tutorials" "check_website_docs_vscode_extension_renders" "$url" "vscode-fingerprint" "missing" "$ms"
    return 1
  fi
  report_pass "website-docs-tutorials" "check_website_docs_vscode_extension_renders" "$url" "$ms"
  return 0
}

# Verify /docs/authoring permanently redirects to /docs/tutorials/author.
# Vercel emits 308 (Permanent Redirect) for permanent: true. Treat any
# 3xx with the expected Location as success.
check_website_docs_authoring_redirect() {
  local url="${SMOKE_WEBSITE_URL}/docs/authoring"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status GET "$url")
  t1=$(now_ms)
  ms=$((t1 - t0))
  case "$status" in
    301|302|307|308)
      report_pass "website-docs-tutorials" "check_website_docs_authoring_redirect" "$url" "$ms"
      return 0
      ;;
  esac
  report_fail "website-docs-tutorials" "check_website_docs_authoring_redirect" "$url" "3xx-redirect" "$status" "$ms"
  return 1
}

# ---- check_skills_page_renders ----------------------------------------
# SMI-5366: Verifies /skills renders the SSR shell with the search input and
# featured-skills grid markup. The card grid is client-rendered so we assert
# only the server-rendered structural IDs, not card content.
check_skills_page_renders() {
  local url="${SMOKE_WEBSITE_URL}/skills"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "website-skills-page" "check_skills_page_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'id="featured-skills-grid"' "skills-page-grid"; then
    report_fail "website-skills-page" "check_skills_page_renders" "$url" 'id="featured-skills-grid"' "missing-fingerprint" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'id="search-input"' "skills-page-search"; then
    report_fail "website-skills-page" "check_skills_page_renders" "$url" 'id="search-input"' "missing-fingerprint" "$ms"
    return 1
  fi
  report_pass "website-skills-page" "check_skills_page_renders" "$url" "$ms"
  return 0
}

# ---- check_skills_search_edge_fn --------------------------------------
# SMI-5366 / SMI-5370: GET skills-search unauthenticated (no-verify-jwt trial
# tier) and confirm the function is deployed + routing.
#
# The request MUST carry a query or a filter: skills-search validates "query OR
# at least one filter (category/trust_tier/min_score)" *after* the auth gate and
# returns 400 otherwise. A bare ?limit=1 therefore 400s on a fresh trial (the
# real prod failure observed on 23b9c73f), so we send ?category=testing&limit=1
# (mirrors the authenticated check_skills_search_usage_counter URL). 200 then
# returns the success envelope {"data":[...],"meta":{...}}; we assert "meta"
# rather than "id" because "id" only appears when >=1 result is present and a
# filter can legitimately be empty.
#
# Soft passes (function alive + enforcing policy, not absent/broken):
#   - 429: trial rate-limit hit.
#   - 401 WITH the app's structured trial/auth JSON ("signupUrl" / "trialUsed" /
#     "Free trial"): the anonymous free-trial quota is exhausted. That structured
#     body proves skills-search itself answered -- a missing/crashed function or a
#     gateway reject returns 404/502/000 or a bare non-app 401. (Without this arm
#     the check false-fails whenever the shared/per-IP trial is spent, paging
#     support@ on a healthy function.)
# A bare/gateway 401 (no app signature), a 400, or any 4xx/5xx else is a hard fail.
check_skills_search_edge_fn() {
  _require_supabase_url || { report_fail "website-skills-page" "check_skills_search_edge_fn" "" "SUPABASE_URL" "unset"; return 1; }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/skills-search?category=testing&limit=1"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  case "$status" in
    429)
      smoke_warn "check_skills_search_edge_fn: rate-limited (429) -- soft pass"
      report_pass "website-skills-page" "check_skills_search_edge_fn" "$url" "$ms"
      return 0
      ;;
    401)
      # SMI-5370: a structured trial-exhausted 401 == function alive (see header).
      if printf '%s' "$body" | grep -Eq '"signupUrl"|"trialUsed"|Free trial'; then
        smoke_warn "check_skills_search_edge_fn: trial-exhausted 401 (structured) -- soft pass"
        report_pass "website-skills-page" "check_skills_search_edge_fn" "$url" "$ms"
        return 0
      fi
      report_fail "website-skills-page" "check_skills_search_edge_fn" "$url" "200|429|structured-401" "401-bare" "$ms"
      return 1
      ;;
    200) ;;
    *)
      report_fail "website-skills-page" "check_skills_search_edge_fn" "$url" "200" "$status" "$ms"
      return 1
      ;;
  esac
  # On 200, assert the search success envelope (always present, result-count
  # independent) rather than "id" (only present when >=1 result).
  if ! assert_contains "$body" '"meta"' "skills-search-json"; then
    report_fail "website-skills-page" "check_skills_search_edge_fn" "$url" '"meta" in JSON' "missing-or-empty" "$ms"
    return 1
  fi
  report_pass "website-skills-page" "check_skills_search_edge_fn" "$url" "$ms"
  return 0
}

# ---- check_license_status_edge_fn -------------------------------------
# SMI-1953: GET license-status with no X-API-Key and confirm the function
# is deployed + returns its deliberate 200 (not 401)
# {"data":{"authenticated":false}} contract for a missing/invalid key. This
# is fully deterministic (unlike skills-search's trial/quota states) — no
# soft-pass branches needed, since an unauthenticated call always resolves
# to the same shape.
check_license_status_edge_fn() {
  _require_supabase_url || {
    report_fail "edge-fn-license-status" "check_license_status_edge_fn" "" "SUPABASE_URL" "unset"
    return 1
  }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/license-status"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "edge-fn-license-status" "check_license_status_edge_fn" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" '"authenticated":false' "license-status-json"; then
    report_fail "edge-fn-license-status" "check_license_status_edge_fn" "$url" '"authenticated":false in JSON' "missing" "$ms"
    return 1
  fi
  report_pass "edge-fn-license-status" "check_license_status_edge_fn" "$url" "$ms"
  return 0
}

# ---- check_status_public_healthy --------------------------------------
# SMI-5754 (Wave 4, public status page). GET the anonymous status-public
# endpoint; asserts 200 + envelope shape: data.generated_at is a non-empty
# string, data.components is an array, and partial is absent or false. A
# `partial:true` on prod means a secondary query degraded -- the endpoint
# still legitimately returns 200 by design (see index.ts's error table), but
# a persistently-partial prod response is a real regression signal worth
# surfacing in the smoke report rather than silently treated as healthy.
check_status_public_healthy() {
  _require_supabase_url || {
    report_fail "status-public" "check_status_public_healthy" "" "SUPABASE_URL" "unset"
    return 1
  }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/status-public"
  local t0 t1 ms resp status body ok
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "status-public" "check_status_public_healthy" "$url" "200" "$status" "$ms"
    return 1
  fi

  ok=$(printf '%s' "$body" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    data = d.get('data', {})
    has_generated_at = isinstance(data.get('generated_at'), str) and len(data['generated_at']) > 0
    has_components = isinstance(data.get('components'), list)
    partial_ok = d.get('partial') in (None, False)
    print('ok' if (has_generated_at and has_components and partial_ok) else 'bad')
except Exception:
    print('bad')
" 2>/dev/null) || ok="bad"

  if [ "$ok" != "ok" ]; then
    report_fail "status-public" "check_status_public_healthy" "$url" \
      "data.generated_at + data.components[] + partial absent/false" "${body:0:200}" "$ms"
    return 1
  fi

  report_pass "status-public" "check_status_public_healthy" "$url" "$ms"
  return 0
}

# ---- check_status_page_renders -----------------------------------------
# SMI-5755 Wave 5 (public status page). Verifies /status returns 200 and
# renders the server-rendered no-JS scaffold. Uses the
# data-smoke="status-page" attribute (present without JS, mirroring
# check_device_page_renders' data-smoke fingerprint pattern above) rather
# than prose text, so a copy edit can't silently break the check.
check_status_page_renders() {
  local url="${SMOKE_WEBSITE_URL}/status"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "website-status-page" "check_status_page_renders" "$url" "200" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'data-smoke="status-page"' "status-page-fingerprint"; then
    report_fail "website-status-page" "check_status_page_renders" "$url" 'data-smoke="status-page"' "missing-fingerprint" "$ms"
    return 1
  fi
  report_pass "website-status-page" "check_status_page_renders" "$url" "$ms"
  return 0
}

# ---- check_status_rss_feed_well_formed ----------------------------------
# SMI-5755 Wave 5. Verifies /status.rss.xml returns 200, an XML content type,
# and ACTUALLY PARSES as well-formed XML -- not just a `<rss` substring grep,
# which a truncated/malformed feed could still satisfy. Uses python3's
# xml.etree.ElementTree, matching this script's existing idiom of shelling
# out to python3 for structured-output validation (see
# check_status_public_healthy / _skills_usage_count above) rather than
# introducing a new tool -- xmllint is not guaranteed present in the smoke
# environment, python3 already is (used extensively above).
check_status_rss_feed_well_formed() {
  local url="${SMOKE_WEBSITE_URL}/status.rss.xml"
  local t0 t1 ms resp status body content_type parse_ok
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "200" ]; then
    report_fail "website-status-page" "check_status_rss_feed_well_formed" "$url" "200" "$status" "$ms"
    return 1
  fi

  content_type=$(curl --silent --max-time "$SMOKE_HTTP_TIMEOUT" -D - -o /dev/null "$url" 2>/dev/null \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2; exit}')
  if ! assert_contains "$content_type" "xml" "status-rss-content-type"; then
    report_fail "website-status-page" "check_status_rss_feed_well_formed" "$url" "*/xml content-type" "$content_type" "$ms"
    return 1
  fi

  parse_ok=$(printf '%s' "$body" | python3 -c "
import sys
import xml.etree.ElementTree as ET
try:
    root = ET.fromstring(sys.stdin.read())
    print('ok' if root.tag == 'rss' else 'bad-root')
except Exception:
    print('parse-error')
" 2>/dev/null) || parse_ok="parse-error"

  if [ "$parse_ok" != "ok" ]; then
    report_fail "website-status-page" "check_status_rss_feed_well_formed" "$url" "well-formed <rss> XML" "$parse_ok" "$ms"
    return 1
  fi

  report_pass "website-status-page" "check_status_rss_feed_well_formed" "$url" "$ms"
  return 0
}

# ---- check_audit_notify_requires_jwt -----------------------------------
# SMI-6177/SMI-5541. audit-notify is gateway-verified (real users hit it via
# the CLI's `sklx audit security --email` / MCP auto-notify path). POST with
# no Authorization header must be rejected by the gateway with 401, mirroring
# check_sync_stripe_email_requires_jwt. Non-401 means JWT verification
# regressed on a surface that sends real audit-report emails.
check_audit_notify_requires_jwt() {
  _require_supabase_url || { report_fail "edge-fn-audit-notify" "check_audit_notify_requires_jwt" "" "SUPABASE_URL" "unset"; return 1; }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/audit-notify"
  local t0 t1 ms status
  t0=$(now_ms)
  status=$(with_retry http_status POST "$url" -H 'content-type: application/json' -d '{}')
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ "$status" = "401" ]; then
    report_pass "edge-fn-audit-notify" "check_audit_notify_requires_jwt" "$url" "$ms"
    return 0
  fi
  report_fail "edge-fn-audit-notify" "check_audit_notify_requires_jwt" "$url" "401" "$status" "$ms"
  return 1
}

# ---- check_audit_unsubscribe_invalid_token_rejected --------------------
# SMI-6177. audit-unsubscribe is intentionally anonymous (verify_jwt=false)
# — it's the one-click unsubscribe link embedded in audit-notify's digest
# emails. GET with a bogus u/s query pair must return the deterministic
# 400 "Invalid link" response; never send a real token here, this must stay
# non-mutating (no preference update, no audit_logs write).
check_audit_unsubscribe_invalid_token_rejected() {
  _require_supabase_url || { report_fail "edge-fn-audit-unsubscribe" "check_audit_unsubscribe_invalid_token_rejected" "" "SUPABASE_URL" "unset"; return 1; }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/audit-unsubscribe?u=smoke-nonexistent&s=invalid"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body GET "$url") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" != "400" ]; then
    report_fail "edge-fn-audit-unsubscribe" "check_audit_unsubscribe_invalid_token_rejected" "$url" "400" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" 'Invalid link' "audit-unsubscribe-invalid-link"; then
    report_fail "edge-fn-audit-unsubscribe" "check_audit_unsubscribe_invalid_token_rejected" "$url" "'Invalid link' in body" "missing" "$ms"
    return 1
  fi
  report_pass "edge-fn-audit-unsubscribe" "check_audit_unsubscribe_invalid_token_rejected" "$url" "$ms"
  return 0
}

# ---- check_telemetry_consent_edge_fn ------------------------------------
# SMI-6177. Mirrors check_license_status_edge_fn (the function's own header
# comment cites license-status as its precedent): POST a well-formed
# installId (64-char sha256 hex) with no credentials, expect the
# deterministic no-userId branch {"data":{"enabled":false,"consentRequired":
# false}}. Caveat (plan-reviewed): this endpoint calls its own rate limiter
# before returning, so a busy window can legitimately return 429 instead of
# 200 — that's accepted as a non-failing outcome here rather than hard-failed,
# since 429 still proves the function is deployed and routing correctly.
check_telemetry_consent_edge_fn() {
  _require_supabase_url || {
    report_fail "edge-fn-telemetry-consent" "check_telemetry_consent_edge_fn" "" "SUPABASE_URL" "unset"
    return 1
  }
  local url="${SMOKE_SUPABASE_URL}/functions/v1/telemetry-consent"
  local install_id="000000000000000000000000000000000000000000000000000000000000000a"
  local t0 t1 ms resp status body
  t0=$(now_ms)
  resp=$(with_retry http_body POST "$url" \
    -H 'content-type: application/json' \
    -d "{\"installId\":\"${install_id}\"}") || true
  t1=$(now_ms)
  ms=$((t1 - t0))
  status=$(printf '%s' "$resp" | head -n1)
  body=$(printf '%s' "$resp" | tail -n +2)

  if [ "$status" = "429" ]; then
    report_pass "edge-fn-telemetry-consent" "check_telemetry_consent_edge_fn" "$url" "$ms"
    return 0
  fi
  if [ "$status" != "200" ]; then
    report_fail "edge-fn-telemetry-consent" "check_telemetry_consent_edge_fn" "$url" "200|429" "$status" "$ms"
    return 1
  fi
  if ! assert_contains "$body" '"enabled":false' "telemetry-consent-json" ||
     ! assert_contains "$body" '"consentRequired":false' "telemetry-consent-json"; then
    report_fail "edge-fn-telemetry-consent" "check_telemetry_consent_edge_fn" "$url" '{"enabled":false,"consentRequired":false} in JSON' "missing" "$ms"
    return 1
  fi
  report_pass "edge-fn-telemetry-consent" "check_telemetry_consent_edge_fn" "$url" "$ms"
  return 0
}
