#!/bin/bash
# SMI-1342: Pre-push Uncommitted Changes Verification
# Warns developers when they have uncommitted changes before pushing
#
# This prevents scenarios where local work is lost during git operations
# (like git reset) because it hadn't been committed and pushed yet.
#
# Exit codes:
#   0 - No uncommitted changes, or user confirmed to proceed
#   1 - User chose not to push (to commit changes first)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}📋 Checking for uncommitted changes...${NC}"
echo ""

# Track what we find
HAS_STAGED=0
HAS_UNSTAGED=0
HAS_UNTRACKED=0
STAGED_COUNT=0
UNSTAGED_COUNT=0
UNTRACKED_COUNT=0

# =============================================================================
# CHECK 1: Staged changes (added to index but not committed)
# =============================================================================
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null)
if [ -n "$STAGED_FILES" ]; then
  HAS_STAGED=1
  STAGED_COUNT=$(echo "$STAGED_FILES" | wc -l | tr -d ' ')
fi

# =============================================================================
# CHECK 2: Unstaged changes (modified but not added)
# =============================================================================
UNSTAGED_FILES=$(git diff --name-only 2>/dev/null)
if [ -n "$UNSTAGED_FILES" ]; then
  HAS_UNSTAGED=1
  UNSTAGED_COUNT=$(echo "$UNSTAGED_FILES" | wc -l | tr -d ' ')
fi

# =============================================================================
# CHECK 3: Untracked files (new files not added to git)
# Exclude common patterns that are typically not committed
# =============================================================================
UNTRACKED_FILES=$(git ls-files --others --exclude-standard 2>/dev/null | \
  grep -v -E '(\.DS_Store|\.swarm/|node_modules/|dist/|coverage/|\.env$|\.env\.local$)' || true)
if [ -n "$UNTRACKED_FILES" ]; then
  HAS_UNTRACKED=1
  UNTRACKED_COUNT=$(echo "$UNTRACKED_FILES" | wc -l | tr -d ' ')
fi

# =============================================================================
# REPORT FINDINGS
# =============================================================================
if [ $HAS_STAGED -eq 0 ] && [ $HAS_UNSTAGED -eq 0 ] && [ $HAS_UNTRACKED -eq 0 ]; then
  echo -e "${GREEN}✓ Working directory is clean${NC}"
  echo ""
  exit 0
fi

# We have uncommitted changes - show warning
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}⚠️  WARNING: You have uncommitted changes${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Show staged changes
if [ $HAS_STAGED -eq 1 ]; then
  echo -e "${BOLD}Staged changes (${STAGED_COUNT} files):${NC}"
  echo "$STAGED_FILES" | head -10 | sed 's/^/  📝 /'
  if [ $STAGED_COUNT -gt 10 ]; then
    echo "  ... and $((STAGED_COUNT - 10)) more files"
  fi
  echo ""
fi

# Show unstaged changes
if [ $HAS_UNSTAGED -eq 1 ]; then
  echo -e "${BOLD}Unstaged changes (${UNSTAGED_COUNT} files):${NC}"
  echo "$UNSTAGED_FILES" | head -10 | sed 's/^/  📄 /'
  if [ $UNSTAGED_COUNT -gt 10 ]; then
    echo "  ... and $((UNSTAGED_COUNT - 10)) more files"
  fi
  echo ""
fi

# Show untracked files
if [ $HAS_UNTRACKED -eq 1 ]; then
  echo -e "${BOLD}Untracked files (${UNTRACKED_COUNT} files):${NC}"
  echo "$UNTRACKED_FILES" | head -10 | sed 's/^/  📁 /'
  if [ $UNTRACKED_COUNT -gt 10 ]; then
    echo "  ... and $((UNTRACKED_COUNT - 10)) more files"
  fi
  echo ""
fi

# =============================================================================
# CONTEXT: Why this matters
# =============================================================================
echo -e "${BLUE}ℹ️  Why this matters:${NC}"
echo "   These changes exist only on your local machine. If you run"
echo "   commands like 'git reset' or 'git checkout', they could be lost."
echo "   Consider committing important changes before pushing."
echo ""

# =============================================================================
# CHECK IF RUNNING IN CI OR NON-INTERACTIVE MODE
# =============================================================================
if [ ! -t 0 ]; then
  # Non-interactive (CI/CD or piped input) - proceed with warning
  echo -e "${YELLOW}Running in non-interactive mode - proceeding with push${NC}"
  echo ""
  exit 0
fi

# =============================================================================
# PROMPT USER FOR CONFIRMATION
# =============================================================================
echo -e "${BOLD}Options:${NC}"
echo "  y - Yes, push anyway (changes will remain local)"
echo "  n - No, abort push (to commit changes first)"
echo "  c - Show git status for more details"
echo ""

while true; do
  read -p "Do you want to proceed with push? [y/n/c]: " -n 1 -r REPLY
  echo ""

  case "$REPLY" in
    [Yy])
      echo ""
      echo -e "${GREEN}✓ Proceeding with push...${NC}"
      echo ""
      exit 0
      ;;
    [Nn])
      echo ""
      echo -e "${YELLOW}Push aborted. Suggested next steps:${NC}"
      echo "  1. Review changes: git status"
      echo "  2. Stage changes:  git add <files>"
      echo "  3. Commit:         git commit -m \"message\""
      echo "  4. Then push:      git push"
      echo ""
      echo "Or to push without this check:"
      echo "  git push --no-verify"
      echo ""
      exit 1
      ;;
    [Cc])
      echo ""
      echo -e "${BLUE}━━━━━━━━━━ git status ━━━━━━━━━━${NC}"
      git status
      echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
      echo ""
      ;;
    *)
      echo "Please enter y, n, or c"
      ;;
  esac
done
