#!/bin/bash
# Validates that GitHub branch protection matches the IaC file
# Usage: ./scripts/validate-branch-protection.sh

set -e

IAC_FILE=".github/branch-protection.json"
REPO="Smith-Horn/skillsmith"
BRANCH="main"

echo "Validating branch protection for $REPO/$BRANCH..."

# Check if IaC file exists
if [ ! -f "$IAC_FILE" ]; then
  echo "❌ IaC file not found: $IAC_FILE"
  exit 1
fi

# Get expected checks from IaC (sorted)
EXPECTED=$(jq -r '.required_status_checks.contexts | sort | .[]' "$IAC_FILE")

# Get actual checks from GitHub (sorted)
ACTUAL=$(gh api "repos/$REPO/branches/$BRANCH/protection/required_status_checks" \
  -H "Accept: application/vnd.github+json" 2>/dev/null | jq -r '.contexts | sort | .[]')

if [ -z "$ACTUAL" ]; then
  echo "❌ Could not fetch branch protection from GitHub"
  echo "   Check: gh auth status"
  exit 1
fi

# Compare
if [ "$EXPECTED" = "$ACTUAL" ]; then
  echo "✅ Branch protection matches IaC file"
  echo ""
  echo "Required checks ($(echo "$ACTUAL" | wc -l | tr -d ' ')):"
  echo "$ACTUAL" | sed 's/^/  - /'
  exit 0
else
  echo "❌ Branch protection DOES NOT match IaC file"
  echo ""
  echo "Expected (from $IAC_FILE):"
  echo "$EXPECTED" | sed 's/^/  - /'
  echo ""
  echo "Actual (from GitHub):"
  echo "$ACTUAL" | sed 's/^/  - /'
  echo ""
  echo "To fix, run:"
  echo "  gh api repos/$REPO/branches/$BRANCH/protection -X PUT --input $IAC_FILE"
  exit 1
fi
