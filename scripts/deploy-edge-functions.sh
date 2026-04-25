#!/usr/bin/env bash
# deploy-edge-functions.sh — Deploy Supabase Edge Functions to a target project
#
# Usage:
#   ./scripts/deploy-edge-functions.sh --project-ref <ref> [--functions <name1,name2,...>]
#
# Validates the provided ref against known refs in .env before deploying.
# When --functions is omitted, deploys all 30 functions.
# When --functions is provided, deploys only the listed functions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Parse arguments ---
PROJECT_REF=""
FILTER_FUNCTIONS=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --project-ref)
      PROJECT_REF="$2"
      shift 2
      ;;
    --functions)
      FILTER_FUNCTIONS="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 --project-ref <ref> [--functions <name1,name2,...>]"
      echo ""
      echo "Deploys Supabase Edge Functions to the specified project."
      echo "When --functions is omitted, deploys all 30 functions."
      echo "When --functions is provided, deploys only the listed functions."
      echo ""
      echo "Options:"
      echo "  --project-ref <ref>           Target Supabase project reference (required)"
      echo "  --functions <name1,name2,...>  Deploy only these functions (comma-separated)"
      echo ""
      echo "Validates ref against STAGING_SUPABASE_PROJECT_REF and SUPABASE_PROJECT_REF."
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1"
      echo "Usage: $0 --project-ref <ref> [--functions <name1,name2,...>]"
      exit 1
      ;;
  esac
done

if [[ -z "$PROJECT_REF" ]]; then
  echo "ERROR: --project-ref is required"
  echo "Usage: $0 --project-ref <ref> [--functions <name1,name2,...>]"
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
  advance-notice-email
  auth-device-code
  auth-device-token
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
  auth-device-approve
  auth-device-preview
  expire-complimentary
  indexer
  ops-report
  process-pending-subscription
  skills-outreach
  skills-refresh-metadata
  update-seat-count
  webhook-dlq
)

# --- Filter to specific functions if --functions provided ---
if [[ -n "$FILTER_FUNCTIONS" ]]; then
  IFS=',' read -ra REQUESTED <<< "$FILTER_FUNCTIONS"
  FILTERED_NO_VERIFY=()
  FILTERED_VERIFY=()

  for req in "${REQUESTED[@]}"; do
    FOUND=false
    for func in "${NO_VERIFY_JWT_FUNCTIONS[@]}"; do
      if [[ "$req" == "$func" ]]; then
        FILTERED_NO_VERIFY+=("$func")
        FOUND=true
        break
      fi
    done
    if [[ "$FOUND" == "false" ]]; then
      for func in "${VERIFY_JWT_FUNCTIONS[@]}"; do
        if [[ "$req" == "$func" ]]; then
          FILTERED_VERIFY+=("$func")
          FOUND=true
          break
        fi
      done
    fi
    if [[ "$FOUND" == "false" ]]; then
      echo "WARNING: Unknown function '$req' — skipping"
    fi
  done

  NO_VERIFY_JWT_FUNCTIONS=("${FILTERED_NO_VERIFY[@]}")
  VERIFY_JWT_FUNCTIONS=("${FILTERED_VERIFY[@]}")
  TOTAL=$((${#NO_VERIFY_JWT_FUNCTIONS[@]} + ${#VERIFY_JWT_FUNCTIONS[@]}))
  echo "Deploying $TOTAL edge function(s) to project: $PROJECT_REF"
else
  TOTAL=30
  echo "Deploying all 30 edge functions to project: $PROJECT_REF"
fi

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

if [[ ${#NO_VERIFY_JWT_FUNCTIONS[@]} -gt 0 ]]; then
  echo ""
  echo "--- Functions with --no-verify-jwt ---"
  for func in "${NO_VERIFY_JWT_FUNCTIONS[@]}"; do
    deploy_function "$func" "true"
  done
fi

if [[ ${#VERIFY_JWT_FUNCTIONS[@]} -gt 0 ]]; then
  echo ""
  echo "--- Functions with JWT verification ---"
  for func in "${VERIFY_JWT_FUNCTIONS[@]}"; do
    deploy_function "$func" "false"
  done
fi

echo ""
echo "=================================================="
echo "Deployed: $DEPLOYED | Failed: $FAILED | Total: $((DEPLOYED + FAILED))"

if [[ $FAILED -gt 0 ]]; then
  echo "ERROR: $FAILED function(s) failed to deploy"
  exit 1
fi

echo "All $TOTAL function(s) deployed successfully."
