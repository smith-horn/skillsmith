#!/bin/bash
# SMI-753: Pre-push Security Checks (Optimized)
# Comprehensive security validation before pushing code
# Optimization: Single test run captures both output and exit code

# Don't use set -e - we handle errors manually for better control

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo ""
echo "🔒 Running pre-push security checks..."
echo ""

# Track overall status
CHECKS_FAILED=0

# =============================================================================
# CHECK 1: Security Test Suite (Optimized - single run)
# =============================================================================
echo "📋 Running security test suite..."

# Run tests once, capture both output and exit code
TEST_OUTPUT=$(docker exec skillsmith-dev-1 npm test -- packages/core/tests/security/ 2>&1) || TEST_STATUS=$?
TEST_STATUS=${TEST_STATUS:-0}

# Display relevant output (filter for test results)
echo "$TEST_OUTPUT" | grep -E "(PASS|FAIL|✓|✗|Error|test)" || true

# Check status based on exit code (more reliable than parsing output)
if [ $TEST_STATUS -ne 0 ]; then
  echo -e "${RED}✗ Security tests failed${NC}"
  CHECKS_FAILED=1
else
  echo -e "${GREEN}✓ Security tests passed${NC}"
fi
echo ""

# =============================================================================
# CHECK 2: npm audit (Optimized - single run with Docker)
# =============================================================================
echo "🔍 Running npm audit (high severity and above)..."

# Run audit once, capture both output and exit code
AUDIT_OUTPUT=$(docker exec skillsmith-dev-1 npm audit --audit-level=high 2>&1) || AUDIT_STATUS=$?
AUDIT_STATUS=${AUDIT_STATUS:-0}

if [ $AUDIT_STATUS -ne 0 ]; then
  # Show audit output only on failure
  echo "$AUDIT_OUTPUT"
  echo -e "${RED}✗ High-severity vulnerabilities detected${NC}"
  echo -e "${YELLOW}Run 'docker exec skillsmith-dev-1 npm audit fix' to resolve issues${NC}"
  CHECKS_FAILED=1
else
  echo -e "${GREEN}✓ No high-severity vulnerabilities found${NC}"
fi
echo ""

# =============================================================================
# CHECK 3: Hardcoded Secrets Detection
# =============================================================================
echo "🔑 Checking for hardcoded secrets..."

# Patterns to detect (common secret patterns)
SECRET_PATTERNS=(
  # API Keys and Tokens
  "api[_-]?key[[:space:]]*=[[:space:]]*['\"][a-zA-Z0-9_-]{20,}['\"]"
  "secret[_-]?key[[:space:]]*=[[:space:]]*['\"][a-zA-Z0-9_-]{20,}['\"]"
  "access[_-]?token[[:space:]]*=[[:space:]]*['\"][a-zA-Z0-9_-]{20,}['\"]"
  "auth[_-]?token[[:space:]]*=[[:space:]]*['\"][a-zA-Z0-9_-]{20,}['\"]"

  # AWS
  "AKIA[0-9A-Z]{16}"
  "aws[_-]?secret[_-]?access[_-]?key"

  # Generic secrets (not in .env files)
  "password[[:space:]]*=[[:space:]]*['\"][^'\"]{8,}['\"]"
  "passwd[[:space:]]*=[[:space:]]*['\"][^'\"]{8,}['\"]"

  # Linear API (specific to this project)
  "LINEAR_API_KEY[[:space:]]*=[[:space:]]*['\"]lin_api_[a-zA-Z0-9]{32,}['\"]"

  # GitHub tokens
  "gh[ps]_[a-zA-Z0-9]{36,}"

  # Private keys
  "-----BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY-----"
)

SECRETS_FOUND=0

# Files to exclude from secret scanning
EXCLUDE_FILES=(
  "*.test.ts"
  "*.test.js"
  "*.spec.ts"
  "*.spec.js"
  ".env.example"
  ".env.schema"
  "package-lock.json"
  "*.md"
)

# Directories to exclude from secret scanning
EXCLUDE_DIRS=(
  "node_modules"
  ".git"
  ".swarm"
  "docs"
  "dist"
)

# =============================================================================
# Read .security-scan-ignore for additional exclusions
# This file contains paths to files that may trigger false positives because
# they contain detection patterns (regex), token format documentation, or
# test fixtures with mock credentials - not actual secrets.
# =============================================================================
IGNORE_FILE=".security-scan-ignore"
ADDITIONAL_EXCLUDES=()

if [ -f "$IGNORE_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines and comments
    if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    # Trim whitespace
    line=$(echo "$line" | xargs)
    if [ -n "$line" ]; then
      ADDITIONAL_EXCLUDES+=("$line")
    fi
  done < "$IGNORE_FILE"
fi

# Build exclude arguments for grep
GREP_EXCLUDE=""
for pattern in "${EXCLUDE_FILES[@]}"; do
  GREP_EXCLUDE="$GREP_EXCLUDE --exclude=$pattern"
done
for dir in "${EXCLUDE_DIRS[@]}"; do
  GREP_EXCLUDE="$GREP_EXCLUDE --exclude-dir=$dir"
done

# Add exclusions from .security-scan-ignore
# These patterns may be:
#   - Specific files: path/to/file.ts
#   - Glob patterns: **/tests/fixtures/**
#   - Wildcard patterns: **/*.fixture.*
for pattern in "${ADDITIONAL_EXCLUDES[@]}"; do
  # Check if it's a directory pattern (ends with ** or /)
  if [[ "$pattern" == *"/**" || "$pattern" == */ ]]; then
    # Extract directory name from pattern like **/tests/fixtures/**
    dir_pattern=$(echo "$pattern" | sed 's/\*\*\///g' | sed 's/\/\*\*//g' | sed 's/\/$//g')
    if [ -n "$dir_pattern" ]; then
      GREP_EXCLUDE="$GREP_EXCLUDE --exclude-dir=$dir_pattern"
    fi
  elif [[ "$pattern" == *"*"* ]]; then
    # It's a glob pattern for files (e.g., **/*.fixture.*)
    # Convert to grep --exclude format
    file_pattern=$(echo "$pattern" | sed 's/\*\*\///g')
    GREP_EXCLUDE="$GREP_EXCLUDE --exclude=$file_pattern"
  else
    # It's a specific file path
    GREP_EXCLUDE="$GREP_EXCLUDE --exclude=$pattern"
  fi
done

# Scan for each pattern
for pattern in "${SECRET_PATTERNS[@]}"; do
  # Use grep with Perl regex for better pattern matching
  if grep -r -n -E $GREP_EXCLUDE "$pattern" . 2>/dev/null; then
    SECRETS_FOUND=1
  fi
done

if [ $SECRETS_FOUND -eq 1 ]; then
  echo -e "${RED}✗ Potential hardcoded secrets detected${NC}"
  echo -e "${YELLOW}Please use environment variables or Varlock for secrets${NC}"
  CHECKS_FAILED=1
else
  echo -e "${GREEN}✓ No hardcoded secrets detected${NC}"
fi
echo ""

# =============================================================================
# FINAL RESULT
# =============================================================================
if [ $CHECKS_FAILED -eq 1 ]; then
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${RED}❌ Security checks FAILED - Push blocked${NC}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo "Fix the issues above before pushing, or use:"
  echo "  git push --no-verify  (NOT RECOMMENDED)"
  echo ""
  exit 1
else
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}✅ All security checks passed${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  exit 0
fi
