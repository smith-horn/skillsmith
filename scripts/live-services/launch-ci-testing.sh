#!/bin/bash
# Launch script for Workstream 1: CI/Testing
cd "$(dirname "$0")/../.."
cd ../worktrees/live-svc-ci-testing 2>/dev/null || { echo "ERROR: Worktree not found. Run worktree creation first."; exit 1; }

git fetch origin main && git rebase origin/main

cat << 'PROMPT'
================================================================================
WORKSTREAM 1: CI/Testing (SMI-1582, SMI-1583, SMI-1584)
================================================================================

## Issues
- SMI-1582: Add fresh install CI test for CLI releases (P0)
- SMI-1583: Add partial API response mocks to test suite (P1)
- SMI-1584: Fix E2E tests with hardcoded path detection (P1)

## Key Files
- .github/workflows/ci.yml
- packages/core/tests/fixtures/api-responses.ts (new)
- packages/cli/tests/e2e/*.test.ts

## Coordination
- No cross-stream dependencies
- Use Docker: docker exec skillsmith-dev-1 npm test

## When Complete
1. Run: docker exec skillsmith-dev-1 npm run preflight
2. Commit with conventional format
3. Push and create PR
4. Notify queen coordinator
================================================================================
PROMPT

claude
