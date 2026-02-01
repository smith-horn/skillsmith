#!/bin/bash
# Validates that GitHub branch protection matches the IaC file
# Usage: ./scripts/validate-branch-protection.sh [--fix|--dry-run|--help]

set -e

# Parse arguments
FIX_MODE=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --fix)
      FIX_MODE=true
      shift
      ;;
    --dry-run)
      FIX_MODE=false
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--fix|--dry-run|--help]"
      echo ""
      echo "Options:"
      echo "  --fix      Apply IaC file to fix drift (with confirmation)"
      echo "  --dry-run  Show drift without applying (default)"
      echo "  --help     Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

IAC_FILE=".github/branch-protection.json"
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "Smith-Horn/skillsmith")}"
BRANCH="main"

echo "Validating branch protection for $REPO/$BRANCH..."

# Check if IaC file exists
if [ ! -f "$IAC_FILE" ]; then
  echo "❌ IaC file not found: $IAC_FILE"
  exit 1
fi

# Fetch full branch protection from GitHub
PROTECTION=$(gh api "repos/$REPO/branches/$BRANCH/protection" \
  -H "Accept: application/vnd.github+json" 2>/dev/null)

if [ -z "$PROTECTION" ]; then
  echo "❌ Could not fetch branch protection from GitHub"
  echo "   Check: gh auth status"
  exit 1
fi

MISMATCH=0

# 1. Validate required_status_checks.contexts
EXPECTED_CONTEXTS=$(jq -r '.required_status_checks.contexts | sort | .[]' "$IAC_FILE")
ACTUAL_CONTEXTS=$(echo "$PROTECTION" | jq -r '.required_status_checks.contexts | sort | .[]')

if [ "$EXPECTED_CONTEXTS" != "$ACTUAL_CONTEXTS" ]; then
  echo "❌ required_status_checks.contexts mismatch:"
  echo ""
  echo "Expected (from $IAC_FILE):"
  echo "$EXPECTED_CONTEXTS" | sed 's/^/  - /'
  echo ""
  echo "Actual (from GitHub):"
  echo "$ACTUAL_CONTEXTS" | sed 's/^/  - /'
  MISMATCH=1
fi

# 2. Validate required_status_checks.strict
EXPECTED_STRICT=$(jq -r '.required_status_checks.strict' "$IAC_FILE")
ACTUAL_STRICT=$(echo "$PROTECTION" | jq -r '.required_status_checks.strict')

if [ "$EXPECTED_STRICT" != "$ACTUAL_STRICT" ]; then
  echo "❌ required_status_checks.strict: expected $EXPECTED_STRICT, got $ACTUAL_STRICT"
  MISMATCH=1
fi

# 3. Validate enforce_admins
EXPECTED_ENFORCE_ADMINS=$(jq -r '.enforce_admins' "$IAC_FILE")
ACTUAL_ENFORCE_ADMINS=$(echo "$PROTECTION" | jq -r '.enforce_admins.enabled')

if [ "$EXPECTED_ENFORCE_ADMINS" != "$ACTUAL_ENFORCE_ADMINS" ]; then
  echo "❌ enforce_admins: expected $EXPECTED_ENFORCE_ADMINS, got $ACTUAL_ENFORCE_ADMINS"
  MISMATCH=1
fi

# 4. Validate allow_force_pushes
EXPECTED_FORCE_PUSHES=$(jq -r '.allow_force_pushes' "$IAC_FILE")
ACTUAL_FORCE_PUSHES=$(echo "$PROTECTION" | jq -r '.allow_force_pushes.enabled')

if [ "$EXPECTED_FORCE_PUSHES" != "$ACTUAL_FORCE_PUSHES" ]; then
  echo "❌ allow_force_pushes: expected $EXPECTED_FORCE_PUSHES, got $ACTUAL_FORCE_PUSHES"
  MISMATCH=1
fi

# 5. Validate allow_deletions
EXPECTED_DELETIONS=$(jq -r '.allow_deletions' "$IAC_FILE")
ACTUAL_DELETIONS=$(echo "$PROTECTION" | jq -r '.allow_deletions.enabled')

if [ "$EXPECTED_DELETIONS" != "$ACTUAL_DELETIONS" ]; then
  echo "❌ allow_deletions: expected $EXPECTED_DELETIONS, got $ACTUAL_DELETIONS"
  MISMATCH=1
fi

# Report results
if [ $MISMATCH -eq 0 ]; then
  echo "✅ All branch protection settings match IaC file"
  echo ""
  echo "Required checks ($(echo "$ACTUAL_CONTEXTS" | wc -l | tr -d ' ')):"
  echo "$ACTUAL_CONTEXTS" | sed 's/^/  - /'
  echo ""
  echo "Settings:"
  echo "  - strict: $ACTUAL_STRICT"
  echo "  - enforce_admins: $ACTUAL_ENFORCE_ADMINS"
  echo "  - allow_force_pushes: $ACTUAL_FORCE_PUSHES"
  echo "  - allow_deletions: $ACTUAL_DELETIONS"
  exit 0
else
  echo ""

  if [ "$FIX_MODE" = true ]; then
    echo "Branch protection drift detected."
    read -p "Apply fix from $IAC_FILE? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      gh api "repos/$REPO/branches/$BRANCH/protection" -X PUT --input "$IAC_FILE"
      echo "✅ Branch protection updated"
      exit 0
    else
      echo "Aborted"
      exit 1
    fi
  else
    echo "To fix, run:"
    echo "  $0 --fix"
    echo ""
    echo "Or manually apply via GitHub API:"
    echo "  gh api repos/$REPO/branches/$BRANCH/protection -X PUT --input $IAC_FILE"
    exit 1
  fi
fi
