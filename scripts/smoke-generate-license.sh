#!/usr/bin/env bash
# SMI-4744 — Post-deploy smoke test for generate-license (Individual tier).
#
# Signs in as the dedicated smoke test account, generates a license key,
# verifies the response, and revokes the key. Requires varlock secrets.
#
# Usage:
#   varlock run -- ./scripts/smoke-generate-license.sh
#
# Required env (loaded by varlock):
#   SUPABASE_URL
#   SUPABASE_ANON_KEY
#   SUPABASE_SERVICE_ROLE_KEY
#   TEST_SMOKE_INDIVIDUAL_EMAIL
#   TEST_SMOKE_INDIVIDUAL_PASSWORD
#
# Exit codes: 0 = pass, 1 = fail

set -euo pipefail

: "${SUPABASE_URL:?must be set}"
: "${SUPABASE_ANON_KEY:?must be set}"
: "${SUPABASE_SERVICE_ROLE_KEY:?must be set}"
: "${TEST_SMOKE_INDIVIDUAL_EMAIL:?must be set — run scripts/setup_smoke_user.py to provision}"
: "${TEST_SMOKE_INDIVIDUAL_PASSWORD:?must be set — run scripts/setup_smoke_user.py to provision}"

TIMEOUT=10

_curl() {
  curl --silent --max-time "$TIMEOUT" "$@"
}

echo "[smoke:generate-license] Signing in as ${TEST_SMOKE_INDIVIDUAL_EMAIL}..."
SESSION=$(_curl -X POST \
  "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_SMOKE_INDIVIDUAL_EMAIL}\",\"password\":\"${TEST_SMOKE_INDIVIDUAL_PASSWORD}\"}")

ACCESS_TOKEN=$(echo "$SESSION" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
if [ -z "$ACCESS_TOKEN" ]; then
  echo "[smoke:generate-license] FAIL — sign-in failed (check TEST_SMOKE_INDIVIDUAL_PASSWORD in varlock)"
  exit 1
fi
echo "[smoke:generate-license] Sign-in OK"

echo "[smoke:generate-license] Calling generate-license..."
RESULT=$(_curl -X POST \
  "${SUPABASE_URL}/functions/v1/generate-license" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"name":"smoke-test-key"}')

KEY_PREFIX=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('key_prefix',''))" 2>/dev/null)
KEY_ID=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null)
TIER=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tier',''))" 2>/dev/null)
ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null)

if [ -z "$KEY_PREFIX" ] || [ "$KEY_PREFIX" = "None" ]; then
  echo "[smoke:generate-license] FAIL — no key_prefix in response"
  echo "$RESULT"
  exit 1
fi

echo "[smoke:generate-license] Key generated — prefix=${KEY_PREFIX}, tier=${TIER}, id=${KEY_ID}"

if [ -n "$KEY_ID" ] && [ "$KEY_ID" != "None" ]; then
  echo "[smoke:generate-license] Revoking smoke key ${KEY_ID}..."
  _curl -X PATCH \
    "${SUPABASE_URL}/rest/v1/license_keys?id=eq.${KEY_ID}" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"status":"revoked"}' > /dev/null
  echo "[smoke:generate-license] Key revoked."
fi

echo "[smoke:generate-license] PASS"
