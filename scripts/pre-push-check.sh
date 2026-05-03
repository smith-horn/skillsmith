#!/bin/bash
# SMI-753: Pre-push Security Checks (Optimized)
# SMI-1366: Improved Docker developer experience with graceful fallback
# SMI-4681: Source shared Docker-vs-host detection helper
# Comprehensive security validation before pushing code
# Optimization: Single test run captures both output and exit code

# Don't use set -e - we handle errors manually for better control

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo "🔒 Running pre-push security checks..."
echo ""

# Track overall status
CHECKS_FAILED=0

# =============================================================================
# SMI-1366 + SMI-4681: Docker-vs-host detection via shared helper.
# Helper sets DOCKER_AVAILABLE, USE_DOCKER, FELL_BACK, CONTAINER_WD,
# DOCKER_CONTAINER, RUN_PREFIX and defines run_cmd. Replaces the previous
# in-script detection block (which hardcoded `-w /app` and missed worktree
# semantics). Graceful degradation: missing helper falls back to today's
# `-w /app` path so worktrees on pre-SMI-4681 branches don't break.
# =============================================================================
HOOK_DETECT_LIB="$(dirname "$0")/lib/hook-docker-detect.sh"
if [ -r "$HOOK_DETECT_LIB" ]; then
  # shellcheck source=lib/hook-docker-detect.sh
  . "$HOOK_DETECT_LIB"
else
  echo -e "${YELLOW}⚠️  scripts/lib/hook-docker-detect.sh missing — using legacy in-container path${NC}"
  USE_DOCKER=1
  CONTAINER_WD="/app"
  DOCKER_CONTAINER="skillsmith-dev-1"
  run_cmd() {
    docker exec -w "$CONTAINER_WD" "$DOCKER_CONTAINER" "$@"
  }
fi

if [ "$USE_DOCKER" = "1" ]; then
  echo -e "${BLUE}🐳 Using Docker container: ${DOCKER_CONTAINER} (cwd: ${CONTAINER_WD})${NC}"
elif [ "${FELL_BACK:-0}" = "1" ]; then
  echo -e "${BLUE}🖥️  Using host execution (worktree fallback)${NC}"
else
  echo -e "${YELLOW}⚠️  Docker container not running — using local environment${NC}"
fi
echo ""

# =============================================================================
# SMI-2442: Detect git-crypt smudge filter artifacts
# Git-crypt smudge filter can create persistent dirty files (binary diffs)
# that trigger false positives in format checks (e.g., npm run preflight)
# =============================================================================
SMUDGE_ARTIFACT_COUNT=0

if [ -f .gitattributes ] && grep -q "filter=git-crypt" .gitattributes 2>/dev/null; then
  # Guard: Only check if git-crypt is unlocked (locked state = no smudge artifacts)
  if command -v git-crypt &> /dev/null && git-crypt status 2>/dev/null | grep -q "not encrypted"; then
    # Count files that appear modified but are binary (smudge artifacts)
    while IFS= read -r file; do
      if [ -n "$file" ] && [ -f "$file" ] && file "$file" | grep -q "data\|binary"; then
        SMUDGE_ARTIFACT_COUNT=$((SMUDGE_ARTIFACT_COUNT + 1))
      fi
    done < <(git diff --name-only 2>/dev/null)

    if [ $SMUDGE_ARTIFACT_COUNT -gt 0 ]; then
      echo -e "${YELLOW}⚠️  Detected ${SMUDGE_ARTIFACT_COUNT} git-crypt smudge artifacts${NC}"
      echo -e "${YELLOW}   These are expected in git-crypt repos and do not affect push safety.${NC}"
      echo -e "${YELLOW}   Encrypted paths are excluded from Prettier via .prettierignore.${NC}"
    fi
  fi
fi
echo ""

# SMI-4681: run_cmd is now provided by scripts/lib/hook-docker-detect.sh
# (sourced above). The previous local definition hardcoded `-w /app` and
# missed worktree semantics; the helper's definition uses $CONTAINER_WD
# so Linux Docker + worktree gets the correct in-container path and
# macOS + worktree falls back to host.

# =============================================================================
# SMI-4249: Detect docs-only / submodule-pointer pushes
# Skip npm audit (CHECK 2) when no file in the push could introduce a
# production dependency. CHECKS 1 (security tests) and 3 (hardcoded secrets)
# remain unconditional.
#
# SAFE_REGEX matches files that cannot introduce production deps:
#   - docs/**, **/*.md (including submodule pointer to docs/internal)
#   - .claude/development/**, .claude/templates/**
#   - LICENSE, .github/ISSUE_TEMPLATE/**, .github/CODEOWNERS, PR template
#   - .gitmodules (submodule pointer bumps only)
#
# Drift note: CI mirrors similar logic in scripts/ci/classify-changes.ts.
# Keeping in bash (no tsx dep). Worst case of drift is false-positive audit
# run on a docs-only push (safe; never a false-negative skip).
# =============================================================================
DOCS_ONLY=0
SAFE_REGEX='^(docs/|\.claude/development/|\.claude/templates/|\.github/(ISSUE_TEMPLATE/|CODEOWNERS|PULL_REQUEST_TEMPLATE\.md)|LICENSE$|.*\.md$|\.gitmodules$)'

if UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
  CHANGED_FILES=$(git diff --name-only "$UPSTREAM..HEAD" 2>/dev/null || true)
else
  # No upstream set — likely first push of a new branch. Diff against origin/main.
  git fetch origin main --quiet 2>/dev/null || true
  CHANGED_FILES=$(git diff --name-only origin/main..HEAD 2>/dev/null || true)
fi

if [ -n "$CHANGED_FILES" ]; then
  UNSAFE=$(printf '%s\n' "$CHANGED_FILES" | grep -vE "$SAFE_REGEX" || true)
  if [ -z "$UNSAFE" ]; then
    DOCS_ONLY=1
  fi
fi

# =============================================================================
# CHECK 1: Security Test Suite (Optimized - single run)
# SMI-1366: Uses run_cmd for Docker/local fallback
# =============================================================================
echo "📋 Running security test suite..."

# Run tests once, capture both output and exit code
TEST_OUTPUT=$(run_cmd npm test -- packages/core/tests/security/ 2>&1) || TEST_STATUS=$?
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
# CHECK 2: npm audit (Optimized - single run)
# SMI-1255: Only audit production dependencies, skip devDependencies
# SMI-1366: Uses run_cmd for Docker/local fallback
# SMI-4249: Skip entirely for docs-only / submodule-pointer pushes
# Dev tools like vercel CLI have transitive vulnerabilities that don't affect production
# =============================================================================
if [ $DOCS_ONLY -eq 1 ]; then
  echo -e "${BLUE}ℹ️  Skipping npm audit — docs-only push (no production dependency change)${NC}"
  echo ""
else
  echo "🔍 Running npm audit (production dependencies, high severity)..."

  # Run audit once, capture both output and exit code
  # --omit=dev skips devDependencies (vercel, tsx, etc.) which have known vulnerabilities
  # that don't affect production code
  AUDIT_OUTPUT=$(run_cmd npm audit --audit-level=high --omit=dev 2>&1) || AUDIT_STATUS=$?
  AUDIT_STATUS=${AUDIT_STATUS:-0}

  if [ $AUDIT_STATUS -ne 0 ]; then
    # SMI-2369: Distinguish network errors from actual vulnerabilities
    # Network errors should warn but not block the push
    if echo "$AUDIT_OUTPUT" | grep -qiE "getaddrinfo|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|request to .* failed"; then
      echo -e "${YELLOW}⚠️  npm audit skipped - network unavailable${NC}"
      echo -e "${YELLOW}   DNS or network error detected inside container.${NC}"
      echo -e "${YELLOW}   CI will run npm audit on push. To fix locally:${NC}"
      echo -e "${YELLOW}   docker network prune -f && docker compose --profile dev restart${NC}"
      # Don't set CHECKS_FAILED - network errors are non-blocking
    else
      # Real vulnerabilities found - block the push
      echo "$AUDIT_OUTPUT"
      echo -e "${RED}✗ High-severity vulnerabilities detected${NC}"
      if [ $USE_DOCKER -eq 1 ]; then
        echo -e "${YELLOW}Run 'docker exec $DOCKER_CONTAINER npm audit fix' to resolve issues${NC}"
      else
        echo -e "${YELLOW}Run 'npm audit fix' to resolve issues${NC}"
      fi
      CHECKS_FAILED=1
    fi
  else
    echo -e "${GREEN}✓ No high-severity vulnerabilities found${NC}"
  fi
  echo ""
fi

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

# Build a grep -v filter for specific file paths from ignore file
IGNORE_FILTER=""
for pattern in "${ADDITIONAL_EXCLUDES[@]}"; do
  # Only handle specific file paths (not globs)
  if [[ "$pattern" != *"*"* && "$pattern" != */ ]]; then
    if [ -n "$IGNORE_FILTER" ]; then
      IGNORE_FILTER="$IGNORE_FILTER|$pattern"
    else
      IGNORE_FILTER="$pattern"
    fi
  fi
done

# Scan for each pattern
for pattern in "${SECRET_PATTERNS[@]}"; do
  # Use grep with Perl regex for better pattern matching
  MATCHES=$(grep -r -n -E $GREP_EXCLUDE "$pattern" . 2>/dev/null || true)

  # Filter out ignored file paths
  if [ -n "$IGNORE_FILTER" ] && [ -n "$MATCHES" ]; then
    MATCHES=$(echo "$MATCHES" | grep -v -E "$IGNORE_FILTER" || true)
  fi

  if [ -n "$MATCHES" ]; then
    echo "$MATCHES"
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
