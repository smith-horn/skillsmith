#!/bin/sh
# scripts/lib/hook-docker-detect.sh
# SMI-4681: Shared Docker-vs-host detection for pre-push hook chain.
#
# Sourced by:
#   .husky/pre-commit
#   .husky/pre-push
#   scripts/pre-push-check.sh
#   scripts/pre-push-coverage-check.sh
#   scripts/lib/check-native-modules.sh
#   scripts/lib/check-container-deps-fresh.sh (SMI-6006)
#
# CORRECTION (SMI-6006, found during review): this comment previously said
# pre-commit "still has its own inline copy" (SMI-4686). That was stale —
# .husky/pre-commit:33 sources this file directly. Any change here reaches
# pre-commit too; pre-commit's OWN guards built on top of it (the
# node_modules/dist freshness checks) are separately, explicitly WARN-only —
# see .husky/pre-commit's own comments — never make this file itself do
# anything mutating, since pre-commit sourcing it must stay read-only.
#
# CONTRACT (sets these vars in caller's scope):
#   DOCKER_AVAILABLE 0|1     — whether Docker daemon + the resolved
#                              container are running
#   USE_DOCKER       0|1     — whether to actually run commands in Docker;
#                              starts as DOCKER_AVAILABLE, downgrades to 0 on
#                              fallback paths (off-tree worktree always; a
#                              worktree whose own container isn't running
#                              either hard-fails or falls back to host,
#                              gated by change-tier — see SMI-5570/SMI-5074
#                              below; SKILLSMITH_PRE_PUSH_HOST=1 forces host)
#   DOCKER_CONTAINER string  — "skillsmith-dev-1" for the main checkout;
#                              the worktree's OWN dedicated container
#                              (e.g. "<name>-dev-1") for an in-tree worktree
#                              — SMI-5570/SMI-5074, see Background below
#   CONTAINER_WD     path|"" — in-container working dir; "/app" whenever
#                              USE_DOCKER=1 (both main and a worktree's own
#                              container mount themselves at /app directly);
#                              "" for an off-tree worktree
#   IS_WORKTREE      0|1     — whether invoking git checkout is a worktree
#   RUN_PREFIX       string  — human-readable prefix for fix-hint messages
#                              ("docker exec <container>" or "")
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
#   SMI-5548 made routing an in-tree worktree's pre-push through Docker the
#   default (host execution had proven unreliable — native ABI drift, and
#   the SMI-4769 GIT_* env leak into child vitest processes). But SMI-5548's
#   Docker route targeted `skillsmith-dev-1` (the MAIN checkout's own
#   long-lived container) reached via the worktree's nested
#   `.worktrees/<name>/` path — SMI-5570/SMI-5074 traced this precisely via
#   /proc/self/mountinfo: Docker's mount(2) follows symlinks when resolving
#   a bind mount's destination, so the SMI-4381 relative node_modules
#   symlinks (sized for the HOST's worktree nesting depth) resolve, when
#   reached through main's own /app tree, to MAIN'S OWN real
#   packages/<pkg>/node_modules — not the worktree's. This is silent
#   cross-contamination, not a resolution failure: a worktree's pre-push
#   checks, routed this way, execute against whatever dependency/build
#   state main's shared container happens to be in, not the worktree
#   branch's own committed changes. A pass proves nothing about the
#   worktree's own state; a fail doesn't necessarily indict it. This is a
#   generic Docker/Linux-kernel mount(2) behavior, not macOS/virtiofs
#   specific — it affects any Docker host, though the routing below only
#   needed restructuring where it previously assumed Darwin-only relevance.
#
#   SMI-5570/SMI-5074's fix: route an in-tree worktree's pre-push through
#   the WORKTREE'S OWN dedicated container (SMI-5559's `worktree-docker.sh
#   resolve`/`exec` convention) instead of main's shared one. If the
#   worktree's own container isn't running, do not silently fall through to
#   main's container (that's the exact bug being fixed) — either hard-fail
#   with the worktree-docker.sh remediation message, or fall back to host,
#   gated by change-tier (docs-only pushes don't warrant the friction) and
#   an explicit opt-out (see SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE
#   below). Host fallback's own reliability caveats (native ABI, SMI-4769
#   GIT_* leak) are unchanged from SMI-5548's own analysis — it remains
#   available for Docker-down / off-tree worktrees / explicit opt-out only.

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
# Returns: "/app" (main repo or in-tree worktree — both route to their OWN
# container per SMI-5570/SMI-5074, so both mount themselves at /app
# directly), or "" (off-tree worktree — e.g. ~/scratch/foo — where no
# bind mount can cover the path at all).
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
        "$_HOOK_REPO_ROOT"/*)   printf '/app' ;;
        *)                      printf '' ;;
    esac
}

# Detect worktree state.
if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ]; then
    IS_WORKTREE=1
fi

CONTAINER_WD=$(compute_container_wd)

# SMI-5570/SMI-5074: resolve the container this worktree's OWN checkout
# should target, via worktree-docker.sh's canonical resolve subcommand
# (shells out rather than reimplementing get_worktree_name()'s bash-only
# branch-sanitization logic in this POSIX sh file — see Background).
# Prints "<container_name> <resolved_from>" to stdout; exit 0/1 = running/not.
_HOOK_WORKTREE_ROOT=""
_HOOK_RESOLVE_OUT=""
_HOOK_RESOLVED_CONTAINER=""
_HOOK_RESOLVED_RUNNING=0
if [ "$IS_WORKTREE" = "1" ] && [ -n "$CONTAINER_WD" ]; then
    _HOOK_WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
    # scripts/worktree-docker.sh is a tracked file, present in this
    # worktree's own checkout — no need to reach into main's checkout.
    if [ -n "$_HOOK_WORKTREE_ROOT" ] && [ -x "$_HOOK_WORKTREE_ROOT/scripts/worktree-docker.sh" ]; then
        if _HOOK_RESOLVE_OUT=$("$_HOOK_WORKTREE_ROOT/scripts/worktree-docker.sh" resolve "$_HOOK_WORKTREE_ROOT" 2>/dev/null); then
            _HOOK_RESOLVED_RUNNING=1
        fi
        _HOOK_RESOLVED_CONTAINER=$(printf '%s' "$_HOOK_RESOLVE_OUT" | cut -d' ' -f1)
    fi
fi

if [ -n "$_HOOK_RESOLVED_CONTAINER" ]; then
    DOCKER_CONTAINER="$_HOOK_RESOLVED_CONTAINER"
fi

# Determine state — three independent signals:
#   - DOCKER_AVAILABLE: is Docker daemon + the resolved container running?
#   - NEEDS_FALLBACK: must we run on host because Docker can't (or
#     shouldn't) serve the worktree correctly? (off-tree worktree; a
#     worktree's own container not running and hard-fail isn't warranted)
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
    if [ "$IS_WORKTREE" = "1" ] && [ -n "$_HOOK_RESOLVED_CONTAINER" ]; then
        if [ "$_HOOK_RESOLVED_RUNNING" = "1" ]; then
            DOCKER_AVAILABLE=1
        else
            hook_debug "Worktree's own container '${DOCKER_CONTAINER}' not running"
        fi
    elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DOCKER_CONTAINER}$"; then
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

# SMI-5570/SMI-5074: in-tree worktree, Docker daemon present, but this
# worktree's OWN container isn't running (or wasn't resolvable). Applies on
# ANY OS — the underlying mechanism (main's shared container silently
# substituting its own state) is not macOS-specific; see Background.
#
# Three branches, mirroring SMI-4767/SMI-5548's existing precedence:
#   1. SKILLSMITH_PRE_PUSH_DOCKER=1 — strict opt-in, hard-fails if the
#      worktree's own container isn't up (pre-existing SMI-4767 behavior,
#      now targeting the worktree's own container instead of main's).
#   2. Default — hard-fail with worktree-docker.sh's own remediation
#      message, UNLESS this push is docs-only (SMI-4249-style
#      classification — see DOCS_ONLY below) or
#      SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1 is set, in which case
#      fall back to host (with a loud warning) instead.
#   3. SKILLSMITH_PRE_PUSH_HOST=1 — explicit opt-out, always falls back to
#      host regardless of change-tier.
#
#   Precedence: SKILLSMITH_PRE_PUSH_DOCKER=1 (hard-fail, no override) wins
#   over SKILLSMITH_PRE_PUSH_HOST=1 wins over the change-tier gate.
if [ "$IS_WORKTREE" = "1" ] && command -v docker >/dev/null 2>&1 && [ "$DOCKER_AVAILABLE" = "0" ] && [ -n "$CONTAINER_WD" ]; then
    if [ "${SKILLSMITH_PRE_PUSH_DOCKER:-0}" = "1" ]; then
        printf "${HOOK_DETECT_RED}❌ SKILLSMITH_PRE_PUSH_DOCKER=1 set, but this worktree's own container ('${DOCKER_CONTAINER}') is not running.${HOOK_DETECT_NC}\n" >&2
        printf "${HOOK_DETECT_YELLOW}   Start it: cd ${_HOOK_WORKTREE_ROOT:-.} && docker compose --profile dev up -d${HOOK_DETECT_NC}\n" >&2
        printf "${HOOK_DETECT_YELLOW}   Or unset the env var to fall back to host (will hit SMI-4767 leak).${HOOK_DETECT_NC}\n" >&2
        exit 1
    elif [ "${SKILLSMITH_PRE_PUSH_HOST:-0}" = "1" ]; then
        NEEDS_FALLBACK=1
        printf "${HOOK_DETECT_YELLOW}📂 SKILLSMITH_PRE_PUSH_HOST=1 — falling back to host execution${HOOK_DETECT_NC}\n"
    else
        # SMI-4249-style docs-only classification (mirrored from
        # scripts/pre-push-check.sh; duplication accepted per that file's
        # own drift note — worst case is a false-positive hard-fail on an
        # edge-case path, never a false-negative skip of the guard).
        _HOOK_DOCS_ONLY=0
        _HOOK_SAFE_REGEX='^(docs/|\.claude/development/|\.claude/templates/|\.github/(ISSUE_TEMPLATE/|CODEOWNERS|PULL_REQUEST_TEMPLATE\.md)|LICENSE$|.*\.md$|\.gitmodules$)'
        if _HOOK_UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
            _HOOK_CHANGED_FILES=$(git diff --name-only "$_HOOK_UPSTREAM..HEAD" 2>/dev/null || true)
        else
            git fetch origin main --quiet 2>/dev/null || true
            _HOOK_CHANGED_FILES=$(git diff --name-only origin/main..HEAD 2>/dev/null || true)
        fi
        if [ -n "$_HOOK_CHANGED_FILES" ]; then
            _HOOK_UNSAFE=$(printf '%s\n' "$_HOOK_CHANGED_FILES" | grep -vE "$_HOOK_SAFE_REGEX" || true)
            if [ -z "$_HOOK_UNSAFE" ]; then
                _HOOK_DOCS_ONLY=1
            fi
        fi

        if [ "${SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE:-0}" = "1" ] || [ "$_HOOK_DOCS_ONLY" = "1" ]; then
            NEEDS_FALLBACK=1
            if [ "$_HOOK_DOCS_ONLY" = "1" ]; then
                printf "${HOOK_DETECT_YELLOW}📂 Docs-only push — falling back to host execution instead of hard-failing (worktree's own container '${DOCKER_CONTAINER}' isn't running)${HOOK_DETECT_NC}\n"
            else
                printf "${HOOK_DETECT_YELLOW}📂 SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1 — falling back to host execution${HOOK_DETECT_NC}\n"
            fi
        else
            # Exact remediation message worktree-docker.sh's own `exec`
            # subcommand prints, per VP Design review — one dialect, not a
            # second phrasing of the same guidance.
            printf "${HOOK_DETECT_RED}❌ Container '${DOCKER_CONTAINER}' is not running for ${_HOOK_WORKTREE_ROOT:-this worktree} (resolved from worktree branch).${HOOK_DETECT_NC}\n" >&2
            printf "\n" >&2
            printf "${HOOK_DETECT_YELLOW}Start it first:${HOOK_DETECT_NC}\n" >&2
            printf "${HOOK_DETECT_YELLOW}  cd ${_HOOK_WORKTREE_ROOT:-.} && docker compose --profile dev up -d${HOOK_DETECT_NC}\n" >&2
            printf "\n" >&2
            printf "${HOOK_DETECT_YELLOW}Escape hatches:${HOOK_DETECT_NC}\n" >&2
            printf "${HOOK_DETECT_YELLOW}  SKILLSMITH_PRE_PUSH_HOST=1 git push       # fall back to host this once${HOOK_DETECT_NC}\n" >&2
            printf "${HOOK_DETECT_YELLOW}  SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1 git push  # always fall back for this push${HOOK_DETECT_NC}\n" >&2
            exit 1
        fi
    fi
fi

# macOS + worktree host-fallback path (SMI-4381/4681/5548): Docker daemon
# itself is down entirely, or an in-tree worktree hit the fallback branch
# above. Native-binding preflight only matters for the host route.
if [ "$NEEDS_FALLBACK" = "1" ] && [ "$IS_WORKTREE" = "1" ] && [ -n "$CONTAINER_WD" ]; then
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

    # SMI-4912: host-platform native-package self-heal. The host
    # node_modules can carry Linux-only rollup/esbuild prebuilts (when
    # node_modules was populated in a Linux context), so the host vitest
    # run dies with "Cannot find module @rollup/rollup-darwin-arm64".
    # Probe and auto-repair before the caller runs vitest on the host.
    # The rollup probe loads its native binding at require-time; esbuild
    # resolves its binary lazily, so transformSync('') is needed to force
    # the platform-binary spawn (a bare require is a false-negative).
    if ! node -e "require('rollup')" >/dev/null 2>&1 ||
       ! node -e "require('esbuild').transformSync('')" >/dev/null 2>&1; then
        printf "${HOOK_DETECT_YELLOW}🔧 Host platform native packages missing (rollup/esbuild).${HOOK_DETECT_NC}\n"
        printf "${HOOK_DETECT_YELLOW}   Auto-repairing via scripts/repair-host-native-deps.sh …${HOOK_DETECT_NC}\n"
        _HOOK_REPAIR_TOP=$(git rev-parse --show-toplevel 2>/dev/null)
        if [ -n "$_HOOK_REPAIR_TOP" ] && [ -x "$_HOOK_REPAIR_TOP/scripts/repair-host-native-deps.sh" ]; then
            "$_HOOK_REPAIR_TOP/scripts/repair-host-native-deps.sh" \
                || printf "${HOOK_DETECT_YELLOW}   Repair did not complete — host run may fail; bypass: git push --no-verify${HOOK_DETECT_NC}\n"
        else
            printf "${HOOK_DETECT_YELLOW}   Repair script not found — skipping; host run may fail.${HOOK_DETECT_NC}\n"
        fi
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

hook_debug "DOCKER_AVAILABLE=$DOCKER_AVAILABLE USE_DOCKER=$USE_DOCKER FELL_BACK=$FELL_BACK IS_WORKTREE=$IS_WORKTREE CONTAINER_WD=$CONTAINER_WD DOCKER_CONTAINER=$DOCKER_CONTAINER"

# run_cmd: dispatch to Docker or host based on USE_DOCKER. DOCKER_CONTAINER
# has already been resolved (and, for a worktree, verified running) above
# via worktree-docker.sh's canonical resolver — no re-resolution here.
run_cmd() {
    if [ "$USE_DOCKER" = "1" ]; then
        docker exec -w "$CONTAINER_WD" "$DOCKER_CONTAINER" "$@"
    else
        "$@"
    fi
}
