#!/usr/bin/env bash
#
# Phase 5: Release & Publishing Execution Script
# ================================================
# Creates a worktree and launches Claude Code for Phase 5 npm publishing tasks.
#
# CRITICAL PATH: This phase blocks Phase 7 and all commercial tiers.
#
# Usage:
#   ./scripts/phases/phase-5-release.sh [--dry-run]
#
# Prerequisites (MANUAL):
#   1. npm login completed with 2FA
#   2. LINEAR_API_KEY set in environment (via Varlock)
#   3. Docker container running
#   4. GitHub CLI authenticated (gh auth login)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKTREE_DIR="$PROJECT_ROOT/../worktrees"
WORKTREE_NAME="phase-5-release"
WORKTREE_PATH="$WORKTREE_DIR/$WORKTREE_NAME"
BRANCH_NAME="phase-5/release-publishing"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[DRY-RUN] Would execute the following steps..."
fi

echo "=============================================="
echo "Phase 5: Release & Publishing Setup"
echo "=============================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo "Checking prerequisites..."

# 1. npm authentication
if ! npm whoami &>/dev/null; then
  echo -e "${RED}ERROR: npm not authenticated. Run 'npm login' first.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ npm authenticated as: $(npm whoami)${NC}"

# 2. Docker container
if ! docker ps --filter name=skillsmith-dev-1 --format "{{.Status}}" | grep -q "Up"; then
  echo -e "${YELLOW}⚠ Docker container not running. Starting...${NC}"
  if [[ "$DRY_RUN" == "false" ]]; then
    cd "$PROJECT_ROOT"
    docker compose --profile dev up -d
    sleep 5
  fi
fi
echo -e "${GREEN}✓ Docker container running${NC}"

# 3. GitHub CLI
if ! gh auth status &>/dev/null; then
  echo -e "${RED}ERROR: GitHub CLI not authenticated. Run 'gh auth login' first.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ GitHub CLI authenticated${NC}"

# 4. LINEAR_API_KEY (check via Varlock if available)
if command -v varlock &>/dev/null; then
  if ! varlock load --quiet 2>/dev/null; then
    echo -e "${YELLOW}⚠ Varlock validation failed. Ensure LINEAR_API_KEY is set.${NC}"
  else
    echo -e "${GREEN}✓ Varlock environment validated${NC}"
  fi
fi

echo ""
echo "Creating worktree for Phase 5..."

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would create: $WORKTREE_PATH"
  echo "[DRY-RUN] Branch: $BRANCH_NAME"
else
  # Ensure we're on latest main
  cd "$PROJECT_ROOT"
  git fetch origin main
  git checkout main
  git pull origin main

  # Create worktree directory
  mkdir -p "$WORKTREE_DIR"

  # Check if worktree already exists
  if git worktree list | grep -q "$WORKTREE_PATH"; then
    echo -e "${YELLOW}Worktree already exists. Using existing worktree.${NC}"
  else
    # Create the worktree
    git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" 2>/dev/null || \
      git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
  fi

  cd "$WORKTREE_PATH"
  git fetch origin main
  git rebase origin/main || true
fi

echo ""
echo -e "${GREEN}Worktree created at: $WORKTREE_PATH${NC}"
echo ""

# Generate the prompt
cat << 'PHASE5_PROMPT'
================================================================================
PHASE 5: RELEASE & PUBLISHING
================================================================================
Session: phase-5-release
Branch: phase-5/release-publishing
Priority: P0 - CRITICAL PATH (Blocks Phase 7 and commercialization)

## OBJECTIVE
Publish all Skillsmith packages to npm and create the GitHub App for scaled imports.

## ISSUES TO COMPLETE

### P0 - Must Complete (Blocking)

1. SMI-814: Publish @skillsmith/core to npm
   - Location: packages/core
   - Must publish FIRST (others depend on it)
   - Tasks:
     - [ ] Update package.json version
     - [ ] Ensure all tests pass
     - [ ] Build production bundle
     - [ ] npm publish --access public

2. SMI-811: Publish @skillsmith/mcp-server to npm
   - Location: packages/mcp-server
   - Depends on: @skillsmith/core published
   - Tasks:
     - [ ] Update dependency to npm version of core
     - [ ] Update package.json version
     - [ ] Build and test
     - [ ] npm publish --access public

3. SMI-812: Publish @skillsmith/cli to npm
   - Location: packages/cli
   - Depends on: @skillsmith/core published
   - Tasks:
     - [ ] Update dependency to npm version of core
     - [ ] Update package.json version
     - [ ] Build and test
     - [ ] npm publish --access public

### P1 - Should Complete

4. SMI-878: Create GitHub App (15K req/hr)
   - Purpose: Scale skill imports beyond personal access token limits
   - Tasks:
     - [ ] Create GitHub App at github.com/settings/apps
     - [ ] Configure permissions (Contents: read, Metadata: read)
     - [ ] Generate private key
     - [ ] Store credentials securely (Varlock)
     - [ ] Update code to use App authentication

## EXECUTION ORDER (Sequential)

1. @skillsmith/core first (no external deps)
2. @skillsmith/mcp-server second (depends on core)
3. @skillsmith/cli third (depends on core)
4. GitHub App creation (independent but lower priority)

## DOCKER REQUIREMENT

ALL commands must run in Docker:
  docker exec skillsmith-dev-1 npm run build
  docker exec skillsmith-dev-1 npm test
  docker exec skillsmith-dev-1 npm run typecheck

For npm publish (run from host, not Docker):
  cd packages/core && npm publish --access public

## VERIFICATION CHECKLIST

After publishing each package:
  - [ ] Package appears on npmjs.com/@skillsmith/<package>
  - [ ] Can install via: npm install @skillsmith/<package>
  - [ ] Version matches package.json

## WHEN DONE

1. Update all issues to Done in Linear
2. Create PR from this branch
3. Notify Phase 7 session that npm packages are published
4. Merge PR to main

================================================================================
PHASE5_PROMPT

if [[ "$DRY_RUN" == "false" ]]; then
  echo ""
  echo "To start working on Phase 5:"
  echo ""
  echo "  cd $WORKTREE_PATH"
  echo "  claude"
  echo ""
  echo "Then paste the above prompt or reference this issue context."
fi
