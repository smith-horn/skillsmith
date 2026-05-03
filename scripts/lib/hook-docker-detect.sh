#!/bin/sh
# scripts/lib/hook-docker-detect.sh
# SMI-4681: Shared Docker-vs-host detection for pre-push hook chain.
#
# Sourced by:
#   .husky/pre-push
#   scripts/pre-push-check.sh
#   scripts/pre-push-coverage-check.sh
#
# Pre-commit (.husky/pre-commit:27-109) still has its own inline copy.
# Migration tracked in SMI-4686.
#
# CONTRACT (sets these vars in caller's scope):
#   DOCKER_AVAILABLE 0|1     — whether Docker daemon + container are running
#   USE_DOCKER       0|1     — whether to actually run commands in Docker;
#                              starts as DOCKER_AVAILABLE, downgrades to 0 on
#                              fallback paths (off-tree worktree, macOS+worktree)
#   DOCKER_CONTAINER string  — always "skillsmith-dev-1"
#   CONTAINER_WD     path|"" — in-container working dir (e.g., /app or
#                              /app/.worktrees/<name>); "" for off-tree worktree
#   IS_WORKTREE      0|1     — whether invoking git checkout is a worktree
#   RUN_PREFIX       string  — human-readable prefix for fix-hint messages
#                              ("docker exec skillsmith-dev-1" or "")
#   FELL_BACK        0|1     — 1 iff USE_DOCKER was downgraded from 1 to 0
#                              by a fallback path (caller can use this to
#                              distinguish "Docker absent" from "intentional
#                              host fallback")
#
# CONTRACT (defines these functions in caller's scope):
#   run_cmd <args...>           — dispatches to docker exec or host execution
#   hook_debug <msg>            — emits to stderr if SKILLSMITH_HOOK_DEBUG=1
#
# CONTRACT (does NOT):
#   - Register EXIT/INT/TERM traps (caller's responsibility)
#   - Modify caller's options (set -e, etc.)
#   - Print routine status (only prints when state warrants user attention)
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays. Uses `[ ]` and `case`.
# Re-entrant: sourcing twice is a no-op via _HOOK_DETECT_LOADED guard.
#
# Background:
#   Docker Desktop on macOS uses virtiofs, which cannot traverse relative
#   symlinks. Worktrees use per-package node_modules symlinks (SMI-4381) so
#   workspace-pinned deps resolve correctly. Inside the container those
#   symlinks dangle and Node walks up to a different version at
#   /app/node_modules — surfaces as typecheck/lint/test failures that look
#   like real code bugs but are environmental. Linux Docker bind-mounts
#   handle relative symlinks correctly, so the fallback is macOS-only.
#
#   Host fallback works on macOS thanks to:
#     - relative symlinks (resolve correctly outside container)
#     - rebuilt better-sqlite3 native binding (SMI-4549)

# Re-entrant guard.
if [ -n "${_HOOK_DETECT_LOADED:-}" ]; then
    return 0 2>/dev/null || exit 0
fi
_HOOK_DETECT_LOADED=1

# Color codes — defined here so all callers get consistent output style.
HOOK_DETECT_BLUE='\033[0;34m'
HOOK_DETECT_YELLOW='\033[1;33m'
HOOK_DETECT_GREEN='\033[0;32m'
HOOK_DETECT_RED='\033[0;31m'
HOOK_DETECT_NC='\033[0m'

DOCKER_CONTAINER="skillsmith-dev-1"
DOCKER_AVAILABLE=0
USE_DOCKER=0
CONTAINER_WD=""
IS_WORKTREE=0
RUN_PREFIX=""
FELL_BACK=0

# Debug helper — emits to stderr when SKILLSMITH_HOOK_DEBUG=1.
hook_debug() {
    if [ "${SKILLSMITH_HOOK_DEBUG:-}" = "1" ]; then
        printf 'hook-debug: %s\n' "$1" >&2
    fi
}

# Compute in-container working directory.
# Returns: "/app" (main repo), "/app/.worktrees/<name>" (in-tree worktree),
# or "" (off-tree worktree — e.g. ~/scratch/foo).
compute_container_wd() {
    _HOOK_WT_TOP=$(git rev-parse --show-toplevel 2>/dev/null)
    _HOOK_GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
    if [ -z "$_HOOK_WT_TOP" ] || [ -z "$_HOOK_GIT_COMMON" ]; then
        printf ''
        return
    fi
    _HOOK_REPO_ROOT=$(git -C "$_HOOK_GIT_COMMON/.." rev-parse --show-toplevel 2>/dev/null)
    if [ -z "$_HOOK_REPO_ROOT" ]; then
        printf ''
        return
    fi
    case "$_HOOK_WT_TOP" in
        "$_HOOK_REPO_ROOT")     printf '/app' ;;
        "$_HOOK_REPO_ROOT"/*)   printf '/app%s' "${_HOOK_WT_TOP#$_HOOK_REPO_ROOT}" ;;
        *)                      printf '' ;;
    esac
}

# Detect worktree state.
if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
    IS_WORKTREE=1
fi

CONTAINER_WD=$(compute_container_wd)

# Determine state — three independent signals:
#   - DOCKER_AVAILABLE: is Docker daemon + container running at all?
#   - NEEDS_FALLBACK: must we run on host because Docker can't see/serve the
#     worktree correctly? (off-tree worktree, or macOS+worktree)
#   - USE_DOCKER: derived; 1 iff DOCKER_AVAILABLE && !NEEDS_FALLBACK
#
# Decision matrix for USE_DOCKER:
#   Docker_up + no_fallback       → USE_DOCKER=1, FELL_BACK=0 (in-container)
#   Docker_up + fallback          → USE_DOCKER=0, FELL_BACK=1 (intentional host)
#   Docker_down + no_fallback     → USE_DOCKER=0, FELL_BACK=0 (caller skips or runs host)
#   Docker_down + fallback        → USE_DOCKER=0, FELL_BACK=1 (must use host)
#
# This separates "Docker absent" from "intentional host fallback" so callers
# can decide whether to skip (preserve old "Docker down → warn and skip" UX
# for in-tree main repo) or run on host (worktree fallback always runs).
if command -v docker >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DOCKER_CONTAINER}$"; then
        DOCKER_AVAILABLE=1
    else
        hook_debug "Docker container '${DOCKER_CONTAINER}' not running"
    fi
fi

NEEDS_FALLBACK=0

# Off-tree worktree: bind-mount only covers paths under repo root.
if [ "$IS_WORKTREE" = "1" ] && [ -z "$CONTAINER_WD" ]; then
    NEEDS_FALLBACK=1
    printf "${HOOK_DETECT_YELLOW}📂 Worktree outside repo root — falling back to host execution${HOOK_DETECT_NC}\n"
    printf "${HOOK_DETECT_YELLOW}   (Docker bind-mount only covers paths under repo root)${HOOK_DETECT_NC}\n"
fi

# macOS + worktree: virtiofs cannot traverse relative symlinks (SMI-4381).
# Always fall back here, regardless of Docker availability — running in
# Docker would silently fail with wrong dep versions.
if [ "$IS_WORKTREE" = "1" ] && [ "$(uname)" = "Darwin" ]; then
    NEEDS_FALLBACK=1
    printf "${HOOK_DETECT_YELLOW}📂 Worktree on macOS — falling back to host execution (SMI-4381 / SMI-4681)${HOOK_DETECT_NC}\n"
    printf "${HOOK_DETECT_YELLOW}   Per-package node_modules symlinks are not traversable in${HOOK_DETECT_NC}\n"
    printf "${HOOK_DETECT_YELLOW}   Docker Desktop's virtiofs. Host resolution works correctly.${HOOK_DETECT_NC}\n"

    # SMI-4681 change #15: native-binding preflight on host fallback.
    # If host node_modules / per-package symlinks were never set up (fresh
    # clone without `npm install --ignore-scripts` or `repair-worktrees.sh`),
    # surface the repair path BEFORE format/coverage produces a cryptic
    # Node module-resolution error. Symlink OR real dir both qualify;
    # symlink target need not be eagerly resolved here.
    if [ ! -e "node_modules" ]; then
        printf "${HOOK_DETECT_RED}❌ Host node_modules missing in worktree.${HOOK_DETECT_NC}\n"
        printf "${HOOK_DETECT_YELLOW}   Run: ./scripts/repair-worktrees.sh${HOOK_DETECT_NC}\n"
        printf "${HOOK_DETECT_YELLOW}   Bypass: git push --no-verify${HOOK_DETECT_NC}\n"
        exit 1
    fi
fi

if [ "$NEEDS_FALLBACK" = "1" ]; then
    FELL_BACK=1
    USE_DOCKER=0
elif [ "$DOCKER_AVAILABLE" = "1" ]; then
    USE_DOCKER=1
else
    USE_DOCKER=0
fi

# RUN_PREFIX for fix-hint messages.
# Callers append the user-runnable command, e.g.:
#   echo "Fix: $RUN_PREFIX npm run format"
# When USE_DOCKER=0, the prefix is empty so the hint reads "Fix: npm run format".
if [ "$USE_DOCKER" = "1" ]; then
    RUN_PREFIX="docker exec ${DOCKER_CONTAINER}"
else
    RUN_PREFIX=""
fi

hook_debug "DOCKER_AVAILABLE=$DOCKER_AVAILABLE USE_DOCKER=$USE_DOCKER FELL_BACK=$FELL_BACK IS_WORKTREE=$IS_WORKTREE CONTAINER_WD=$CONTAINER_WD"

# run_cmd: dispatch to Docker or host based on USE_DOCKER.
run_cmd() {
    if [ "$USE_DOCKER" = "1" ]; then
        docker exec -w "$CONTAINER_WD" "$DOCKER_CONTAINER" "$@"
    else
        "$@"
    fi
}
