#!/bin/bash
# scripts/worktree-check.sh
# Run lint/typecheck in a worktree context
#
# Usage: ./scripts/worktree-check.sh [worktree-path]
# If no path provided, uses current directory
#
# This script runs checks that DON'T require Docker (lint, typecheck, format)
# For tests requiring native modules, push and use CI.

set -e

WORKTREE_PATH="${1:-.}"
cd "$WORKTREE_PATH"

# Verify we're in a git worktree or repo
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: Not in a git repository or worktree"
  exit 1
fi

# Show context
BRANCH=$(git branch --show-current)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Worktree Check: $(pwd)"
echo "Branch: $BRANCH"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# These checks don't need Docker (no native modules)
echo "[1/3] Running TypeScript check..."
npx tsc --noEmit
echo "  ✓ TypeScript check passed"

echo ""
echo "[2/3] Running ESLint..."
npx eslint . --max-warnings 0
echo "  ✓ ESLint passed"

echo ""
echo "[3/3] Running Prettier check..."
npx prettier --check "**/*.{ts,tsx,js,jsx,json,md,yml,yaml}" --ignore-path .prettierignore
echo "  ✓ Prettier check passed"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All worktree checks passed"
echo ""
echo "Note: For tests with native modules (better-sqlite3, onnxruntime),"
echo "push the branch and verify in CI."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
