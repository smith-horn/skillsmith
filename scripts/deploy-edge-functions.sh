#!/usr/bin/env bash
# deploy-edge-functions.sh — Deploy all Supabase Edge Functions to a target project
#
# Usage:
#   ./scripts/deploy-edge-functions.sh --project-ref <ref>
#
# Validates the provided ref against known refs in .env before deploying.
# Reads verify_jwt config from supabase/config.toml.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Parse arguments ---
PROJECT_REF=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --project-ref)
      PROJECT_REF="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 --project-ref <ref>"
      echo ""
      echo "Deploys all 25 Supabase Edge Functions to the specified project."
      echo "Validates ref against STAGING_SUPABASE_PROJECT_REF and SUPABASE_PROJECT_REF in .env."
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1"
      echo "Usage: $0 --project-ref <ref>"
      exit 1
      ;;
  esac
done

if [[ -z "$PROJECT_REF" ]]; then
  echo "ERROR: --project-ref is required"
  echo "Usage: $0 --project-ref <ref>"
  exit 1
fi

# --- Validate ref against known refs ---
KNOWN_REFS=()
if [[ -n "${STAGING_SUPABASE_PROJECT_REF:-}" ]]; then
  KNOWN_REFS+=("$STAGING_SUPABASE_PROJECT_REF")
fi
if [[ -n "${SUPABASE_PROJECT_REF:-}" ]]; then
  KNOWN_REFS+=("$SUPABASE_PROJECT_REF")
fi

if [[ ${#KNOWN_REFS[@]} -gt 0 ]]; then
  REF_VALID=false
  for known in "${KNOWN_REFS[@]}"; do
    if [[ "$PROJECT_REF" == "$known" ]]; then
      REF_VALID=true
      break
    fi
  done
  if [[ "$REF_VALID" == "false" ]]; then
    echo "ERROR: Unknown project ref: $PROJECT_REF"
    echo "Known refs: ${KNOWN_REFS[*]}"
    echo "Set STAGING_SUPABASE_PROJECT_REF or SUPABASE_PROJECT_REF in .env"
    exit 1
  fi
fi

# --- Functions that require --no-verify-jwt (from supabase/config.toml) ---
NO_VERIFY_JWT_FUNCTIONS=(
  admin-grant-subscription
  checkout
  contact-submit
  create-portal-session
  early-access-signup
  email-inbound
  events
  generate-license
  health
  list-invoices
  regenerate-license
  skills-get
  skills-outreach-preferences
  skills-recommend
  skills-search
  stats
  stripe-webhook
)

# --- Functions that use default JWT verification ---
VERIFY_JWT_FUNCTIONS=(
  alert-notify
  expire-complimentary
  indexer
  ops-report
  process-pending-subscription
  skills-outreach
  skills-refresh-metadata
  update-seat-count
)

echo "Deploying 25 edge functions to project: $PROJECT_REF"
echo "=================================================="

DEPLOYED=0
FAILED=0

deploy_function() {
  local func_name="$1"
  local no_verify_jwt="$2"

  local args=(functions deploy "$func_name" --project-ref "$PROJECT_REF")
  if [[ "$no_verify_jwt" == "true" ]]; then
    args+=(--no-verify-jwt)
  fi

  echo -n "  Deploying $func_name..."
  if npx supabase "${args[@]}" 2>&1; then
    echo " OK"
    DEPLOYED=$((DEPLOYED + 1))
  else
    echo " FAILED"
    FAILED=$((FAILED + 1))
    return 1
  fi
}

echo ""
echo "--- Functions with --no-verify-jwt ---"
for func in "${NO_VERIFY_JWT_FUNCTIONS[@]}"; do
  deploy_function "$func" "true"
done

echo ""
echo "--- Functions with JWT verification ---"
for func in "${VERIFY_JWT_FUNCTIONS[@]}"; do
  deploy_function "$func" "false"
done

echo ""
echo "=================================================="
echo "Deployed: $DEPLOYED | Failed: $FAILED | Total: $((DEPLOYED + FAILED))"

if [[ $FAILED -gt 0 ]]; then
  echo "ERROR: $FAILED function(s) failed to deploy"
  exit 1
fi

echo "All 25 functions deployed successfully."
