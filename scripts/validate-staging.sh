#!/usr/bin/env bash
# validate-staging.sh — End-to-end staging validation
#
# Chains: link to staging → push migrations → deploy all functions → health check
# Re-links to production on exit (trap handler).
#
# Usage:
#   varlock run -- ./scripts/validate-staging.sh
#
# Requires: STAGING_SUPABASE_PROJECT_REF, STAGING_SUPABASE_DB_PASSWORD,
#           SUPABASE_PROJECT_REF in environment (via Varlock)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STAGING_REF="${STAGING_SUPABASE_PROJECT_REF:?STAGING_SUPABASE_PROJECT_REF not set}"
PROD_REF="${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF not set}"
STAGING_DB_PASS="${STAGING_SUPABASE_DB_PASSWORD:-}"

# --- Trap: always re-link to production on exit ---
cleanup() {
  echo ""
  echo "Re-linking to production ($PROD_REF)..."
  npx supabase link --project-ref "$PROD_REF" 2>&1 || echo "WARNING: Failed to re-link to production"
}
trap cleanup EXIT

echo "=========================================="
echo "Staging Validation: $STAGING_REF"
echo "=========================================="

# --- Step 1: Link to staging ---
echo ""
echo "[1/4] Linking to staging..."
npx supabase link --project-ref "$STAGING_REF" 2>&1

# --- Step 2: Push migrations ---
echo ""
echo "[2/4] Pushing migrations..."
if [[ -n "$STAGING_DB_PASS" ]]; then
  SUPABASE_DB_PASSWORD="$STAGING_DB_PASS" npx supabase db push --linked 2>&1
else
  npx supabase db push --linked 2>&1
fi

# --- Step 3: Deploy all functions ---
echo ""
echo "[3/4] Deploying edge functions..."
"$SCRIPT_DIR/deploy-edge-functions.sh" --project-ref "$STAGING_REF"

# --- Step 4: Health check ---
echo ""
echo "[4/4] Running health check..."
HEALTH_URL="https://${STAGING_REF}.supabase.co/functions/v1/health"
HTTP_CODE=$(curl -s -o /tmp/staging-health-response.json -w "%{http_code}" "$HEALTH_URL")
RESPONSE=$(cat /tmp/staging-health-response.json)
rm -f /tmp/staging-health-response.json

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "  Health check PASSED (HTTP $HTTP_CODE)"
  echo "  Response: $RESPONSE"
else
  echo "  Health check FAILED (HTTP $HTTP_CODE)"
  echo "  Response: $RESPONSE"
  exit 1
fi

echo ""
echo "=========================================="
echo "STAGING VALIDATION PASSED"
echo "=========================================="
