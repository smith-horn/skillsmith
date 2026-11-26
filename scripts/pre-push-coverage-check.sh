#!/usr/bin/env bash
# Pre-push Phase 4: Per-workspace test check
# Issues: SMI-7218, SMI-1602, SMI-2166, SMI-3502, SMI-4681, SMI-4772, SMI-4931
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
else
  VITEST_BIN="../../node_modules/.bin/vitest"
fi

# SMI-4931 / SMI-7218: run_suite (process-group sweep + in-container per-suite
# timeout), run_suite_timed, suite_budget and init_suite_budgets live in a
# sourced helper so behaviour tests can drive them with stub suites.
SUITE_RUNNER_LIB="$(dirname "$0")/lib/pre-push-suite-runner.sh"
if [ ! -r "$SUITE_RUNNER_LIB" ]; then
  echo "❌ scripts/lib/pre-push-suite-runner.sh missing — cannot run suites safely"
  exit 1
fi
# shellcheck source=lib/pre-push-suite-runner.sh
. "$SUITE_RUNNER_LIB"

# =============================================================================
# SMI-6260: docs-only classification — independent computation. This script
# runs as a separate `bash` child process of .husky/pre-push's Phase 4
# (invoked via `bash "$COVERAGE_SCRIPT"`, possibly wrapped in `timeout`), so
# it cannot inherit DOCS_ONLY/CHANGED_FILES computed by Phase 2's
# pre-push-check.sh — that's a SEPARATE child process too, and nothing it
# computes is visible here. Each caller of the shared lib sources it and
# computes its own answer, matching hook-docker-detect.sh's existing
# duplication pattern. Skips the entire per-package test loop
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
  echo "ℹ️  Skipping per-package test check — docs-only push (override: SKILLSMITH_PRE_PUSH_FORCE_FULL=1)"
  exit 0
fi

# SMI-3502: Per-workspace tests (eliminates aggregate contention)
FAILED_PACKAGES=""
WORKSPACES="core cli mcp-server enterprise"

init_suite_budgets

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
  # SMI-7218: run_suite_timed applies the per-suite budget, prints elapsed
  # seconds, and tells a timeout from a test failure.
  run_suite_timed "$pkg" "cd packages/$pkg && SKILLSMITH_PREPUSH=1 $VITEST_BIN run" || true
done

# SMI-7218 (owner decision D1): the root + colocated suite is CI-only in
# pre-push. CI (Test (root), Test (root colocated)) and post-merge-verify run it.
echo "  ℹ️  root + colocated tests are not run here: CI (Test (root), Test (root colocated)) and post-merge-verify run them. Locally: ./scripts/worktree-docker.sh exec -- npm run test:root (worktree) or docker exec skillsmith-dev-1 npm run test:root (main checkout)"

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
# SMI-7218: timed-out suites are named as such, and the one-push budget
# override comes before --no-verify (print_failure_summary, in the runner lib).
print_failure_summary "$HINT_PREFIX" "$VITEST_BIN"
exit 1
