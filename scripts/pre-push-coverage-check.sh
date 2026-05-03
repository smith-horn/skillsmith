#!/usr/bin/env bash
# Pre-push Phase 4: Per-workspace test validation
# Issues: SMI-1602, SMI-2166, SMI-3502, SMI-4681
#
# Runs tests per workspace to avoid aggregate I/O contention (SMI-3502).
# Matches CI behavior (npm test --workspace=packages/X).
# Previously ran all 254 test files in a single Vitest process with V8 coverage.
#
# SMI-4681: source shared detection so macOS+worktree falls back to host
# instead of testing main repo HEAD inside the container.
#
# Coverage thresholds remain in the root vitest.config.ts for:
#   - CI enforcement (npm run test:coverage on main branch)
#   - Local verification (npm run test:coverage)
# Per-workspace thresholds are not enforced here because colocated src/ tests
# cause OOM in CI when added to package configs (core: 147 files + memory benchmarks).

# Source shared Docker-vs-host detection (SMI-4681). Graceful degradation: if
# the helper file is missing (push from a branch predating SMI-4681), warn and
# fall back to today's hardcoded `-w /app` path.
HOOK_DETECT_LIB="$(dirname "$0")/lib/hook-docker-detect.sh"
if [ -r "$HOOK_DETECT_LIB" ]; then
  # shellcheck source=lib/hook-docker-detect.sh
  . "$HOOK_DETECT_LIB"
else
  echo "⚠️  scripts/lib/hook-docker-detect.sh missing — using legacy in-container path"
  USE_DOCKER=1
  CONTAINER_WD="/app"
  DOCKER_CONTAINER="skillsmith-dev-1"
  RUN_PREFIX="docker exec ${DOCKER_CONTAINER}"
  run_cmd() {
    docker exec -w "$CONTAINER_WD" "$DOCKER_CONTAINER" "$@"
  }
fi

echo "🔍 Running pre-push test check..."

# SMI-3502: Per-workspace tests (eliminates aggregate contention)
FAILED_PACKAGES=""
WORKSPACES="core cli mcp-server enterprise"

for pkg in $WORKSPACES; do
  # Guard against empty variable
  [ -z "$pkg" ] && continue

  echo "  📦 packages/$pkg..."
  LAST_OUTPUT=$(run_cmd npm test --workspace=packages/"$pkg" 2>&1)
  if [ $? -ne 0 ]; then
    FAILED_PACKAGES="$FAILED_PACKAGES $pkg"
  fi
done

# Root-level tests + colocated src/ tests
# Uses vitest.config.root-tests.ts to avoid re-running workspace tests/ directories.
echo "  📦 root + colocated tests..."
LAST_OUTPUT=$(run_cmd npx vitest run --config vitest.config.root-tests.ts 2>&1)
if [ $? -ne 0 ]; then
  FAILED_PACKAGES="$FAILED_PACKAGES root"
fi

if [ -z "$FAILED_PACKAGES" ]; then
  echo "✅ Test check passed"
  exit 0
fi

echo ""

# Report all failing packages (accumulated, not break-on-first).
# Fix-hint commands branch on RUN_PREFIX so host fallback shows host commands.
HINT_PREFIX=""
if [ -n "$RUN_PREFIX" ]; then
  HINT_PREFIX="$RUN_PREFIX "
fi
for pkg in $FAILED_PACKAGES; do
  if [ "$pkg" = "root" ]; then
    echo "❌ Root/colocated tests failed!"
    echo "   Run: ${HINT_PREFIX}npx vitest run --config vitest.config.root-tests.ts"
  else
    echo "❌ Tests failed in packages/$pkg!"
    echo "   Run: ${HINT_PREFIX}npm test --workspace=packages/$pkg"
  fi
done

echo ""
echo "   Bypass: git push --no-verify"
exit 1
