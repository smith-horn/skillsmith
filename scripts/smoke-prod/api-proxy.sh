#!/usr/bin/env bash
# SMI-5601 — api-proxy header round-trip fidelity smoke surface.
#
# Sourced (not executed) by scripts/smoke-prod.sh via surfaces.json. Depends on
# lib.sh helpers (http/report/timing) already being sourced by the orchestrator.
#
# Why this exists: SMI-5598 shipped a bug (live 2026-01-23 -> 2026-07-08, ~5.5
# months) where the Vercel reverse-proxy in front of the Supabase edge functions
# (api.skillsmith.app) silently dropped the client's auth header on the way in
# and the edge function's X-RateLimit-* headers on the way back out. It went
# undetected because smoke-prod had ZERO coverage of the api-proxy surface. This
# canary closes that gap by exercising a real round-trip through the proxy on
# every smoke run and asserting BOTH directions of header fidelity.
#
# Conventions: ASCII-only, all HTTP bounded by lib.sh's SMOKE_HTTP_TIMEOUT.

# shellcheck shell=bash

# Base URL for the api-proxy under test. Overridable so this check can be
# pointed at a local mock (header-drop simulation) during development /
# verification. Default: the production proxy.
SMOKE_API_PROXY_BASE="${SMOKE_API_PROXY_BASE:-https://api.skillsmith.app}"

# _api_proxy_probe URL [curl-args...]
# Echoes the HTTP status code on line 1, then the raw response headers. Body is
# discarded. "000" status on connection failure (so with_retry can retry).
_api_proxy_probe() {
  local url="$1"
  shift
  local tmp code
  tmp=$(mktemp)
  code=$(curl --silent --show-error \
    --max-time "$SMOKE_HTTP_TIMEOUT" \
    --output /dev/null \
    --dump-header "$tmp" \
    --write-out '%{http_code}' \
    "$@" \
    "$url" 2>/dev/null) || code="000"
  printf '%s\n' "$code"
  cat "$tmp"
  rm -f "$tmp"
}

# ---- check_api_proxy_header_fidelity ----------------------------------
# Round-trips a real authenticated search request through the proxy using the
# PUBLIC Supabase anon key and asserts the SMI-5598 header-forwarding fix holds
# in both directions:
#
#   Forward (request header survives): a request carrying the anon key is
#   handled on the authenticated code path (HTTP 200 when under the tier limit,
#   429 when the 30/min community limit is exhausted). If the proxy DROPS the
#   auth header, the edge function falls back to the anonymous trial path and
#   returns HTTP 401 "Free trial exhausted" — the exact SMI-5598 symptom. So a
#   401 here is the header-drop signature; 200/429 mean the header round-tripped.
#
#   Backward (response header survives): the edge function's rate limiter always
#   emits X-RateLimit-Limit on the authenticated path. SMI-5598 stripped these
#   on the way back out, so their presence proves response-header fidelity.
#
# Secret-free (anon key is public, already used by other smoke checks) and
# robust to the anon-key bucket being rate-limited (429 is treated as a pass).
check_api_proxy_header_fidelity() {
  local surface="api-proxy" check="check_api_proxy_header_fidelity"
  local anon="${SUPABASE_ANON_KEY:-}"
  if [ -z "$anon" ]; then
    # Graceful skip: this is an always-run canary, so a missing key in a
    # local/dev context must not fail unrelated smoke runs. CI supplies the key.
    smoke_warn "$check: SUPABASE_ANON_KEY unset — skipping api-proxy header-fidelity canary"
    return 0
  fi

  local url="${SMOKE_API_PROXY_BASE}/functions/v1/skills-search?query=git&limit=1"
  local t0 t1 ms resp status headers
  t0=$(now_ms)
  resp=$(with_retry _api_proxy_probe "$url" \
    -H "apikey: ${anon}" \
    -H "Authorization: Bearer ${anon}")
  t1=$(now_ms)
  ms=$((t1 - t0))

  status=$(printf '%s' "$resp" | head -n1)
  headers=$(printf '%s' "$resp" | tail -n +2)

  # Forward direction: 401 means the auth header was dropped and the request
  # was downgraded to the anonymous trial path (SMI-5598 symptom).
  if [ "$status" = "401" ]; then
    report_fail "$surface" "$check" "$url" \
      "authenticated (200|429)" "401 (auth header dropped -> trial downgrade)" "$ms"
    return 1
  fi
  if [ "$status" != "200" ] && [ "$status" != "429" ]; then
    report_fail "$surface" "$check" "$url" "200|429" "$status" "$ms"
    return 1
  fi

  # Backward direction: the rate limiter's response headers must survive the
  # trip back through the proxy.
  if ! printf '%s' "$headers" | grep -iq '^x-ratelimit-limit:'; then
    report_fail "$surface" "$check" "$url" \
      "x-ratelimit-limit header present" "missing (response headers dropped)" "$ms"
    return 1
  fi

  report_pass "$surface" "$check" "$url" "$ms"
  return 0
}
