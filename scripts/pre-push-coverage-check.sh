#!/usr/bin/env bash
# Pre-push Phase 4: Per-workspace test validation
# Issues: SMI-1602, SMI-2166, SMI-3502, SMI-4681, SMI-4772, SMI-4931
#
# Runs tests per workspace to avoid aggregate I/O contention (SMI-3502).
# Invokes the root vitest binary directly (SMI-4772) instead of `npm --workspace=`,
# which resolves vitest via SMI-4381 per-package symlinks that dangle under
# macOS Docker Desktop virtiofs (vitest exits 234).
# Previously ran all 254 test files in a single Vitest process with V8 coverage.
#
# SMI-4681: source shared detection so macOS+worktree falls back to host
# instead of testing main repo HEAD inside the container.
#
# SMI-4931: per-suite process-group sweep. Each suite runs inside its own
# process group (`set -m`) so leaked vitest worker / product-spawned child
# processes can be SIGKILLed by process group before the next suite starts —
# prevents leaked-worker accumulation from flaking later suites. Opt out with
# SKILLSMITH_PRE_PUSH_NO_PG_SWEEP=1.
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

# SMI-4931: run one vitest suite inside its own process group, then sweep that
# group so leaked worker / product-spawned child processes cannot accumulate and
# pressure later suites. Under `set -m` the backgrounded job's PID ($_vp) IS its
# process-group ID, so the sweep needs no `ps` lookup (the dev container ships
# none). SIGKILL is used because leaked vitest/product processes may carry
# SIGTERM handlers (SMI-4667 signal-cascade lineage). `set -m` runs only inside
# this `bash -c` child, never the top-level hook shell.
# Escape hatch: SKILLSMITH_PRE_PUSH_NO_PG_SWEEP=1 reverts to a plain invocation.
run_suite() {
  # $1 — a shell command string for one vitest suite (may contain `cd ... &&`).
  if [ "${SKILLSMITH_PRE_PUSH_NO_PG_SWEEP:-0}" = "1" ]; then
    run_cmd bash -c "$1"
    return $?
  fi
  # shellcheck disable=SC2016  # single-quoted ON PURPOSE: $1/$_vp/$_ec must
  # expand in the inner `bash -c` child (whichever context run_cmd dispatches
  # to), never in this top-level hook shell.
  run_cmd bash -c '
    set -m
    ( eval "$1" ) &
    _vp=$!
    wait "$_vp"; _ec=$?
    kill -KILL -- -"$_vp" 2>/dev/null
    exit "$_ec"
  ' _ "$1"
}

echo "🔍 Running pre-push test check..."

# SMI-3502: Per-workspace tests (eliminates aggregate contention)
FAILED_PACKAGES=""
WORKSPACES="core cli mcp-server enterprise"

for pkg in $WORKSPACES; do
  # Guard against empty variable
  [ -z "$pkg" ] && continue

  echo "  📦 packages/$pkg..."
  # SMI-4772: invoke root vitest binary directly. `npm --workspace=` would
  # resolve vitest via packages/<pkg>/node_modules/.bin/vitest, a SMI-4381
  # symlink chain that dangles under macOS Docker Desktop virtiofs and exits 234.
  if ! SUITE_OUTPUT=$(run_suite "cd packages/$pkg && ../../node_modules/.bin/vitest run" 2>&1); then
    FAILED_PACKAGES="$FAILED_PACKAGES $pkg"
    echo "$SUITE_OUTPUT"
  fi
done

# Root-level tests + colocated src/ tests
# Uses vitest.config.root-tests.ts to avoid re-running workspace tests/ directories.
# SMI-4931: invoke the root vitest binary directly (the four-pkg loop above
# already does, per SMI-4772; the root suite was the lone `npx` holdout — `npx`
# adds a process generation the process-group sweep would otherwise have to cover).
echo "  📦 root + colocated tests..."
if ! SUITE_OUTPUT=$(run_suite "./node_modules/.bin/vitest run --config vitest.config.root-tests.ts" 2>&1); then
  FAILED_PACKAGES="$FAILED_PACKAGES root"
  echo "$SUITE_OUTPUT"
fi

if [ -z "$FAILED_PACKAGES" ]; then
  echo "✅ Test check passed"
  exit 0
fi

echo ""

# Report all failing packages (accumulated, not break-on-first).
# Fix-hint commands branch on RUN_PREFIX so host fallback shows host commands.
# SMI-4931: the hints intentionally print the plain suite command, NOT the
# `set -m` process-group-sweep wrapper run_suite() uses — the bare command is
# what a human re-runs to debug a single suite.
HINT_PREFIX=""
if [ -n "$RUN_PREFIX" ]; then
  HINT_PREFIX="$RUN_PREFIX "
fi
for pkg in $FAILED_PACKAGES; do
  if [ "$pkg" = "root" ]; then
    echo "❌ Root/colocated tests failed!"
    echo "   Run: ${HINT_PREFIX}./node_modules/.bin/vitest run --config vitest.config.root-tests.ts"
  else
    echo "❌ Tests failed in packages/$pkg!"
    echo "   Run: ${HINT_PREFIX}bash -c \"cd packages/$pkg && ../../node_modules/.bin/vitest run\""
  fi
done

echo ""
echo "   Bypass: git push --no-verify"
exit 1
