#!/usr/bin/env bash
# Pre-push Phase 4: Per-workspace test validation
# Issues: SMI-1602, SMI-2166, SMI-3502
#
# Runs tests per workspace to avoid aggregate I/O contention (SMI-3502).
# Matches CI behavior (npm test --workspace=packages/X).
# Previously ran all 254 test files in a single Vitest process with V8 coverage.
#
# Coverage thresholds remain in the root vitest.config.ts for:
#   - CI enforcement (npm run test:coverage on main branch)
#   - Local verification (npm run test:coverage)
# Per-workspace thresholds are not enforced here because colocated src/ tests
# cause OOM in CI when added to package configs (core: 147 files + memory benchmarks).

echo "🔍 Running pre-push test check..."

# SMI-3502: Per-workspace tests (eliminates aggregate contention)
FAILED_PACKAGES=""
WORKSPACES="core cli mcp-server enterprise"

for pkg in $WORKSPACES; do
  # Guard against empty variable
  [ -z "$pkg" ] && continue

  echo "  📦 packages/$pkg..."
  # SMI-1774: Use -w /app for worktree support
  LAST_OUTPUT=$(docker exec -w /app skillsmith-dev-1 npm test --workspace=packages/"$pkg" 2>&1)
  if [ $? -ne 0 ]; then
    FAILED_PACKAGES="$FAILED_PACKAGES $pkg"
  fi
done

# Root-level tests + colocated src/ tests
# Uses vitest.config.root-tests.ts to avoid re-running workspace tests/ directories.
echo "  📦 root + colocated tests..."
LAST_OUTPUT=$(docker exec -w /app skillsmith-dev-1 npx vitest run --config vitest.config.root-tests.ts 2>&1)
if [ $? -ne 0 ]; then
  FAILED_PACKAGES="$FAILED_PACKAGES root"
fi

if [ -z "$FAILED_PACKAGES" ]; then
  echo "✅ Test check passed"
  exit 0
fi

echo ""

# Report all failing packages (accumulated, not break-on-first)
for pkg in $FAILED_PACKAGES; do
  if [ "$pkg" = "root" ]; then
    echo "❌ Root/colocated tests failed!"
    echo "   Run: docker exec skillsmith-dev-1 npx vitest run --config vitest.config.root-tests.ts"
  else
    echo "❌ Tests failed in packages/$pkg!"
    echo "   Run: docker exec skillsmith-dev-1 npm test --workspace=packages/$pkg"
  fi
done

echo ""
echo "   Bypass: git push --no-verify"
exit 1
