#!/usr/bin/env bash
# Pre-push Phase 4: Per-workspace coverage validation
# Issues: SMI-1602, SMI-2166, SMI-3502
#
# Runs coverage per workspace to avoid aggregate I/O contention (SMI-3502).
# Matches CI behavior (npm test --workspace=packages/X).
# Previously ran all 254 test files in a single Vitest process with V8 coverage.

echo "🔍 Running pre-push coverage check..."

# SMI-3502: Per-workspace coverage (eliminates aggregate contention)
FAILED_PACKAGES=""
LAST_OUTPUT=""

# Packages with coverage thresholds (core, mcp-server, enterprise)
COVERAGE_WORKSPACES="core mcp-server enterprise"

for pkg in $COVERAGE_WORKSPACES; do
  # Guard against empty variable
  [ -z "$pkg" ] && continue

  echo "  📦 packages/$pkg (coverage)..."
  # SMI-1774: Use -w /app for worktree support
  LAST_OUTPUT=$(docker exec -w /app skillsmith-dev-1 npm run test:coverage --workspace=packages/"$pkg" 2>&1)
  if [ $? -ne 0 ]; then
    FAILED_PACKAGES="$FAILED_PACKAGES $pkg"
  fi
done

# CLI: tests only, no coverage thresholds (integration-tested, ~45% unit coverage)
echo "  📦 packages/cli (tests)..."
LAST_OUTPUT=$(docker exec -w /app skillsmith-dev-1 npm test --workspace=packages/cli 2>&1)
if [ $? -ne 0 ]; then
  FAILED_PACKAGES="$FAILED_PACKAGES cli"
fi

# Root-level tests (scripts/tests, supabase/functions)
# No coverage thresholds — these are excluded from coverage metrics.
# Uses vitest.config.root-tests.ts to avoid re-running package tests.
echo "  📦 root tests..."
LAST_OUTPUT=$(docker exec -w /app skillsmith-dev-1 npx vitest run --config vitest.config.root-tests.ts 2>&1)
if [ $? -ne 0 ]; then
  FAILED_PACKAGES="$FAILED_PACKAGES root"
fi

if [ -z "$FAILED_PACKAGES" ]; then
  echo "✅ Coverage check passed"
  exit 0
fi

echo ""

# Report all failing packages (accumulated, not break-on-first)
for pkg in $FAILED_PACKAGES; do
  if [ "$pkg" = "root" ]; then
    echo "❌ Root tests failed!"
    echo "   Run: docker exec skillsmith-dev-1 npx vitest run --config vitest.config.root-tests.ts"
  else
    echo "❌ Coverage check failed in packages/$pkg!"
    echo "   Run: docker exec skillsmith-dev-1 npm run test:coverage --workspace=packages/$pkg"
  fi
done

echo ""
echo "   Bypass: git push --no-verify"
exit 1
