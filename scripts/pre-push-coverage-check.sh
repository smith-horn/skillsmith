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

# SMI-5548: on the Docker route, the worktree's relative node_modules/.bin
# path resolves through the SMI-4381 per-package symlink chain, which is
# EINVAL under Docker Desktop's virtiofs from inside the container (the
# worktree's own node_modules is itself a symlink into the main checkout).
# Mirror the absolute-path pattern already used in pre-push-check.sh:125-137
# (SMI-4772/4820): pin to /app/node_modules when USE_DOCKER=1; host execution
# still resolves the relative path fine (real symlinks, not virtiofs-mediated).
if [ "$USE_DOCKER" = "1" ]; then
  VITEST_BIN="/app/node_modules/.bin/vitest"        # absolute: worktree node_modules symlink is EINVAL under virtiofs (SMI-5548)
  VITEST_BIN_ROOT="/app/node_modules/.bin/vitest"   # same — root step's cwd is repo root, not packages/<pkg>
else
  VITEST_BIN="../../node_modules/.bin/vitest"
  VITEST_BIN_ROOT="./node_modules/.bin/vitest"
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

# =============================================================================
# SMI-6260: docs-only classification — independent computation. This script
# runs as a separate `bash` child process of .husky/pre-push's Phase 4
# (invoked via `bash "$COVERAGE_SCRIPT"`, possibly wrapped in `timeout`), so
# it cannot inherit DOCS_ONLY/CHANGED_FILES computed by Phase 2's
# pre-push-check.sh — that's a SEPARATE child process too, and nothing it
# computes is visible here. Each caller of the shared lib sources it and
# computes its own answer, matching hook-docker-detect.sh's existing
# duplication pattern. Skips the entire per-package + root coverage loop
# below when docs-only; override with SKILLSMITH_PRE_PUSH_FORCE_FULL=1.
# =============================================================================
DOCS_ONLY_LIB="$(dirname "$0")/lib/docs-only-patterns.sh"
if [ -r "$DOCS_ONLY_LIB" ]; then
  # shellcheck source=lib/docs-only-patterns.sh
  . "$DOCS_ONLY_LIB"
fi

if UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
  CHANGED_FILES=$(git diff --name-only "$UPSTREAM..HEAD" 2>/dev/null || true)
else
  git fetch origin main --quiet 2>/dev/null || true
  CHANGED_FILES=$(git diff --name-only origin/main..HEAD 2>/dev/null || true)
fi

DOCS_ONLY=0
if command -v is_docs_only >/dev/null 2>&1; then
  if printf '%s\n' "$CHANGED_FILES" | is_docs_only; then
    DOCS_ONLY=1
  fi
else
  echo "⚠️  scripts/lib/docs-only-patterns.sh missing — treating push as full (non-docs-only)"
fi

echo "🔍 Running pre-push test check..."

if [ "$DOCS_ONLY" = "1" ] && [ "${SKILLSMITH_PRE_PUSH_FORCE_FULL:-0}" != "1" ]; then
  echo "ℹ️  Skipping per-package coverage — docs-only push (override: SKILLSMITH_PRE_PUSH_FORCE_FULL=1)"
  exit 0
fi

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
  # SMI-5548: marks a local pre-push run so dist-dependent spawn/integration
  # tests can SKIP (loudly) when dist is absent — worktrees have no built
  # dist/. CI does not set this env var, so it still builds/runs them and
  # fails loudly on a real build-order regression.
  if ! SUITE_OUTPUT=$(run_suite "cd packages/$pkg && SKILLSMITH_PREPUSH=1 $VITEST_BIN run" 2>&1); then
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
# SMI-5548: see per-pkg loop comment above — SKILLSMITH_PREPUSH=1 gates the
# local-only skip of dist-dependent spawn/integration tests.
if ! SUITE_OUTPUT=$(run_suite "SKILLSMITH_PREPUSH=1 $VITEST_BIN_ROOT run --config vitest.config.root-tests.ts" 2>&1); then
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
    echo "   Run: ${HINT_PREFIX}${VITEST_BIN_ROOT} run --config vitest.config.root-tests.ts"
  else
    echo "❌ Tests failed in packages/$pkg!"
    echo "   Run: ${HINT_PREFIX}bash -c \"cd packages/$pkg && ${VITEST_BIN} run\""
  fi
done

echo ""
echo "   Bypass: git push --no-verify"
exit 1
