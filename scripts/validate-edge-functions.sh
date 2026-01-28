#!/bin/bash
# SMI-1903: Validate Edge Function structure and configuration
# This script ensures all Edge Functions have proper structure and are configured correctly.
#
# Checks:
# 1. Each function directory has an index.ts file
# 2. Each anonymous function is listed in config.toml with verify_jwt = false
# 3. No orphaned function configurations
#
# Usage:
#   ./scripts/validate-edge-functions.sh
#   ./scripts/validate-edge-functions.sh --check-deployment  # Requires SUPABASE_ACCESS_TOKEN

set -e

FUNCTIONS_DIR="supabase/functions"
CONFIG_FILE="supabase/config.toml"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Edge Functions that should have verify_jwt = false (anonymous access)
ANONYMOUS_FUNCTIONS=(
  "early-access-signup"
  "contact-submit"
  "stats"
  "skills-search"
  "skills-get"
  "skills-recommend"
  "stripe-webhook"
  "events"
  "health"
)

# Edge Functions that require authentication
AUTHENTICATED_FUNCTIONS=(
  "checkout"
  "create-portal-session"
  "list-invoices"
  "update-seat-count"
  "generate-license"
  "regenerate-license"
)

# Service role functions (scheduled jobs, internal)
SERVICE_ROLE_FUNCTIONS=(
  "indexer"
  "skills-refresh-metadata"
  "ops-report"
  "alert-notify"
  "email-inbound"
)

echo ""
echo "=== Edge Function Validation ==="
echo ""

ERRORS=0
WARNINGS=0

# Get list of function directories (excluding _shared and hidden files)
FUNCTION_DIRS=$(ls -d "$FUNCTIONS_DIR"/*/ 2>/dev/null | xargs -n1 basename | grep -v "^_" || true)

if [ -z "$FUNCTION_DIRS" ]; then
  echo -e "${RED}ERROR: No Edge Functions found in $FUNCTIONS_DIR${NC}"
  exit 1
fi

TOTAL_FUNCTIONS=$(echo "$FUNCTION_DIRS" | wc -w | tr -d ' ')
echo "Found $TOTAL_FUNCTIONS Edge Functions"
echo ""

# Check 1: Each function directory has index.ts
echo "Checking function structure..."
for fn in $FUNCTION_DIRS; do
  if [ ! -f "$FUNCTIONS_DIR/$fn/index.ts" ]; then
    echo -e "${RED}  ✗ $fn: Missing index.ts${NC}"
    ((ERRORS++))
  else
    echo -e "${GREEN}  ✓ $fn: index.ts exists${NC}"
  fi
done
echo ""

# Check 2: Verify anonymous functions are in config.toml
echo "Checking anonymous function configuration..."
for fn in "${ANONYMOUS_FUNCTIONS[@]}"; do
  if [ -d "$FUNCTIONS_DIR/$fn" ]; then
    # Check if function has verify_jwt = false in config.toml
    if grep -q "\[functions.$fn\]" "$CONFIG_FILE" 2>/dev/null; then
      # Function is configured, check verify_jwt
      # Use sed to extract section - awk range pattern fails because [functions.x] matches both start and end patterns
      SECTION=$(sed -n "/\[functions\.$fn\]/,/^\[/p" "$CONFIG_FILE" | head -5)
      if echo "$SECTION" | grep -q "verify_jwt = false"; then
        echo -e "${GREEN}  ✓ $fn: verify_jwt = false${NC}"
      else
        echo -e "${YELLOW}  ⚠ $fn: Not configured with verify_jwt = false (may need --no-verify-jwt on deploy)${NC}"
        ((WARNINGS++))
      fi
    else
      echo -e "${YELLOW}  ⚠ $fn: Not in config.toml (deploy with --no-verify-jwt)${NC}"
      ((WARNINGS++))
    fi
  fi
done
echo ""

# Check 3: List functions not categorized
echo "Checking function categorization..."
ALL_CATEGORIZED=("${ANONYMOUS_FUNCTIONS[@]}" "${AUTHENTICATED_FUNCTIONS[@]}" "${SERVICE_ROLE_FUNCTIONS[@]}")
for fn in $FUNCTION_DIRS; do
  FOUND=0
  for cat_fn in "${ALL_CATEGORIZED[@]}"; do
    if [ "$fn" = "$cat_fn" ]; then
      FOUND=1
      break
    fi
  done
  if [ $FOUND -eq 0 ]; then
    echo -e "${YELLOW}  ⚠ $fn: Not categorized (add to ANONYMOUS, AUTHENTICATED, or SERVICE_ROLE list)${NC}"
    ((WARNINGS++))
  fi
done
echo ""

# Check 4: Deployment check (optional, requires SUPABASE_ACCESS_TOKEN)
if [ "$1" = "--check-deployment" ]; then
  echo "Checking deployment status..."
  if [ -z "$SUPABASE_ACCESS_TOKEN" ] || [ -z "$SUPABASE_PROJECT_REF" ]; then
    echo -e "${YELLOW}  ⚠ SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF not set, skipping deployment check${NC}"
  else
    DEPLOYED=$(supabase functions list --project-ref "$SUPABASE_PROJECT_REF" 2>/dev/null | tail -n +2 | awk '{print $1}' || true)
    for fn in $FUNCTION_DIRS; do
      if echo "$DEPLOYED" | grep -q "^$fn$"; then
        echo -e "${GREEN}  ✓ $fn: Deployed${NC}"
      else
        echo -e "${RED}  ✗ $fn: NOT DEPLOYED${NC}"
        ((ERRORS++))
      fi
    done
  fi
  echo ""
fi

# Summary
echo "=== Summary ==="
echo "Total functions: $TOTAL_FUNCTIONS"
echo -e "Errors: ${RED}$ERRORS${NC}"
echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"
echo ""

if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}Validation FAILED${NC}"
  exit 1
fi

if [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}Validation PASSED with warnings${NC}"
  exit 0
fi

echo -e "${GREEN}Validation PASSED${NC}"
exit 0
