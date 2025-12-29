#!/bin/bash
# SMI-727: Pre-push Security Checks
# Comprehensive security validation before pushing code

set -e  # Exit on first error

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
# CHECK 1: Security Test Suite
# =============================================================================
echo "📋 Running security test suite..."
if npm test -- packages/core/tests/security/ 2>&1 | grep -E "(PASS|FAIL|✓|✗)" || true; then
  if npm test -- packages/core/tests/security/ --reporter=verbose 2>&1 | grep -q "FAIL"; then
    echo -e "${RED}✗ Security tests failed${NC}"
    CHECKS_FAILED=1
  else
    echo -e "${GREEN}✓ Security tests passed${NC}"
  fi
else
  echo -e "${GREEN}✓ Security tests passed${NC}"
fi
echo ""

# =============================================================================
# CHECK 2: npm audit
# =============================================================================
echo "🔍 Running npm audit (high severity and above)..."
if npm audit --audit-level=high 2>&1; then
  echo -e "${GREEN}✓ No high-severity vulnerabilities found${NC}"
else
  AUDIT_EXIT=$?
  if [ $AUDIT_EXIT -ne 0 ]; then
    echo -e "${RED}✗ High-severity vulnerabilities detected${NC}"
    echo -e "${YELLOW}Run 'npm audit fix' to resolve issues${NC}"
    CHECKS_FAILED=1
  fi
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
EXCLUDE_PATTERNS=(
  "*.test.ts"
  "*.test.js"
  "*.spec.ts"
  "*.spec.js"
  ".env.example"
  ".env.schema"
  "package-lock.json"
  "node_modules/*"
  ".git/*"
  "docs/*"
  "*.md"
)

# Build exclude arguments for grep
GREP_EXCLUDE=""
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
  GREP_EXCLUDE="$GREP_EXCLUDE --exclude=$pattern"
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
