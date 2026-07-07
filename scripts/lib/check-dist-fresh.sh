#!/bin/sh
# scripts/lib/check-dist-fresh.sh
# SMI-5548: dist-freshness sentinel.
#
# Answers "does packages/<pkg>/dist/ satisfy the current source?" without
# invoking Turborepo, mirroring the content-hash sentinel idiom already used
# by scripts/lib/check-node-modules-fresh.sh (deps) and
# scripts/submodule-hash.sh (enterprise cache-invalidation).
#
# CRITICAL: dist is NOT symlinked into worktrees — a worktree's
# packages/<pkg>/dist directories are simply ABSENT. The SMI-5548 Docker
# default route resolves @skillsmith/* (and their dist/ output) against the
# MAIN checkout, not the worktree. So this gate always operates on the MAIN
# checkout (resolved via git rev-parse --git-common-dir, exactly like
# check-node-modules-fresh.sh's _MAIN_CHECKOUT), never the worktree tree —
# see DIST_ROOT below.
#
# Two modes:
#   --write-sentinel  (postbuild) — for each package whose dist/ dir exists,
#                     write the current inputs hash to
#                     dist/.skillsmith-dist-hash. Idempotent, fail-soft.
#   default (check)   (hooks)     — for each package whose dist/ dir exists,
#                     compare its sentinel to the current inputs hash;
#                     mismatch (or missing sentinel) → drift. Any drift across
#                     the four packages → print a banner listing the stale
#                     packages and `exit 1`. No dist/ dirs at all (fresh
#                     clone, nothing built yet) → `exit 0` (existsSync guards
#                     elsewhere handle a missing dist). Honors
#                     SKILLSMITH_SKIP_DIST_FRESHNESS=1 → exit 0 immediately.
#
# Inputs hash per package = git ls-tree HEAD over:
#   - packages/<pkg>/src, packages/<pkg>/package.json,
#     packages/<pkg>/tsconfig.json (the package's own build inputs)
#   - PLUS a global segment covering turbo.json's globalDependencies that
#     matter here: root tsconfig.json + packages/enterprise/.submodule-hash.
#     (turbo.json also lists package-lock.json as a globalDependency, but we
#     deliberately EXCLUDE it — the separate deps-freshness gate
#     (check-node-modules-fresh.sh) already covers package-lock.json drift;
#     including it here would just duplicate that gate under a different
#     banner.)
# All paths are hashed in a single `git ls-tree | git hash-object --stdin`
# stream (the same technique as scripts/submodule-hash.sh), so any change to
# any input path changes the resulting hash.
#
# READ-ONLY in check mode (P-5 invariant, matching check-node-modules-fresh.sh):
# never runs `npm run build`, never mutates dist/, never rewrites the
# sentinel. The ONLY write path is --write-sentinel (build time).
#
# Fail-soft: any git / hash-tooling failure silently skips that package
# (never manufactures a false drift) — this gate must never false-block a
# push/commit because of an environmental git hiccup.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

SENTINEL_NAME=".skillsmith-dist-hash"
PACKAGES="core mcp-server enterprise cli"

# --- DIST_ROOT resolution (MAIN checkout when in a worktree) -----------------
# Mirrors check-node-modules-fresh.sh's _MAIN_CHECKOUT logic: in a worktree,
# --git-dir and --git-common-dir differ; --git-common-dir's parent is the
# MAIN checkout. Outside a worktree (main repo, or a standalone clone),
# --show-toplevel already points at the right root.
#
# SMI-5564: IS_WORKTREE is captured here (not just DIST_ROOT) so the
# drift-detected tail below can distinguish "my push is from a worktree, and
# this drift is main's own unrelated build staleness" (non-blocking warning)
# from "I'm pushing FROM main itself, so main's dist freshness IS the thing
# being pushed" (still blocking).
DIST_ROOT=""
IS_WORKTREE=0
if _gcd="$(git rev-parse --git-common-dir 2>/dev/null)" \
    && _gd="$(git rev-parse --git-dir 2>/dev/null)" \
    && [ -n "$_gcd" ] && [ "$_gcd" != "$_gd" ]; then
    DIST_ROOT="$(cd "$_gcd/.." 2>/dev/null && pwd || echo '')"
    IS_WORKTREE=1
fi
if [ -z "$DIST_ROOT" ]; then
    DIST_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
fi
if [ -z "$DIST_ROOT" ]; then
    # Not a git checkout at all (e.g. extracted tarball) — fall back to this
    # script's grandparent (scripts/lib/ → repo root).
    DIST_ROOT="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd || echo '')"
fi

# Nothing usable to hash against — fail-soft, never false-block.
[ -n "$DIST_ROOT" ] || exit 0

# Compute the build-inputs hash for one package. Prints the hash (may be
# empty on any git/tooling failure — callers must treat empty as "skip").
_dist_inputs_hash() {
    pkg="$1"
    # Capture ls-tree output + status SEPARATELY. Piping ls-tree straight into
    # hash-object masks an ls-tree failure: empty input hashes to the empty-blob
    # id (e69de29b…) with exit 0, which looks like a valid hash and could
    # false-drift a check. Return empty on any git failure so the caller's
    # `[ -n "$hash" ]` fail-soft guard trips. (SMI-5548 plan-review.)
    _tree="$(git -C "$DIST_ROOT" ls-tree HEAD \
        tsconfig.json \
        packages/enterprise/.submodule-hash \
        "packages/$pkg/src" \
        "packages/$pkg/package.json" \
        "packages/$pkg/tsconfig.json" \
        2>/dev/null)" || return 0
    [ -n "$_tree" ] || return 0
    printf '%s' "$_tree" | git -C "$DIST_ROOT" hash-object --stdin 2>/dev/null
}

# --- mode: --write-sentinel (build time only) --------------------------------
if [ "${1:-}" = "--write-sentinel" ]; then
    for pkg in $PACKAGES; do
        DIST_DIR="$DIST_ROOT/packages/$pkg/dist"
        [ -d "$DIST_DIR" ] || continue

        NEW_HASH="$(_dist_inputs_hash "$pkg")"
        [ -n "$NEW_HASH" ] || continue

        SENTINEL="$DIST_DIR/$SENTINEL_NAME"
        # Idempotent: skip the write when unchanged (avoids needless mtime
        # churn a parallel session's freshness check might observe).
        if [ -f "$SENTINEL" ]; then
            OLD_HASH="$(cat "$SENTINEL" 2>/dev/null || echo '')"
            [ "$OLD_HASH" = "$NEW_HASH" ] && continue
        fi
        printf '%s\n' "$NEW_HASH" > "$SENTINEL" 2>/dev/null || true
    done
    # Fail-soft: a build sentinel write must never fail the build.
    exit 0
fi

# --- mode: default (check) — READ-ONLY ---------------------------------------
# Escape hatch for a false positive (env drift the developer is sure is benign).
if [ "${SKILLSMITH_SKIP_DIST_FRESHNESS:-0}" = "1" ]; then
    exit 0
fi

DRIFTED=""
ANY_DIST_EXISTS=0

for pkg in $PACKAGES; do
    DIST_DIR="$DIST_ROOT/packages/$pkg/dist"
    [ -d "$DIST_DIR" ] || continue
    ANY_DIST_EXISTS=1

    CUR_HASH="$(_dist_inputs_hash "$pkg")"
    # Hashing tool / git unavailable for this package — fail-soft: skip rather
    # than manufacture a false drift.
    [ -n "$CUR_HASH" ] || continue

    SENTINEL="$DIST_DIR/$SENTINEL_NAME"
    if [ ! -f "$SENTINEL" ]; then
        DRIFTED="$DRIFTED $pkg"
        continue
    fi
    SENTINEL_HASH="$(cat "$SENTINEL" 2>/dev/null || echo '')"
    if [ "$SENTINEL_HASH" != "$CUR_HASH" ]; then
        DRIFTED="$DRIFTED $pkg"
    fi
done

# Fresh clone / nothing built yet — nothing to enforce. Missing-dist call
# sites elsewhere already guard via existsSync.
[ "$ANY_DIST_EXISTS" = "0" ] && exit 0

# Fresh — exit silently (the hooks expect a quiet pass).
[ -z "$DRIFTED" ] && exit 0

# --- drift: print the canonical actionable message ---------------------------
# Reuse the hook color vars when sourced; define safe fallbacks for standalone.
RED="${RED:-${HOOK_DETECT_RED:-\033[0;31m}}"
YELLOW="${YELLOW:-${HOOK_DETECT_YELLOW:-\033[1;33m}}"
NC="${NC:-${HOOK_DETECT_NC:-\033[0m}}"

# SMI-5564: this check always resolves DIST_ROOT to the MAIN checkout (see
# the header comment — worktrees have no dist/ of their own by design). A
# worktree pushing an UNRELATED branch has no way to have caused main's own
# dist to go stale, so a hard block here is a false positive for that case —
# it's a main-checkout maintenance concern, not a per-branch push-safety one.
# Pushing directly from the main checkout is the one case where "is main's
# dist fresh" and "is my push safe" are genuinely the same question, so that
# case keeps the original blocking behavior unchanged.
if [ "$IS_WORKTREE" = "1" ]; then
    printf '\n'
    printf "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
    printf "${YELLOW}  ⚠ WARNING (non-blocking — push proceeded)${NC}\n"
    printf "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
    printf '\n'
    printf '  The MAIN checkout'"'"'s built dist/ for the following package(s) no\n'
    printf '  longer matches its source. This is unrelated to the branch you just\n'
    printf '  pushed from this worktree — it is a main-checkout maintenance item,\n'
    printf '  not something this push caused or something you need to fix now:\n'
    printf '\n'
    for pkg in $DRIFTED; do
        printf '    - packages/%s/dist\n' "$pkg"
    done
    printf '\n'
    printf "  To fix (from the MAIN checkout, not this worktree):\n"
    printf '    ./scripts/worktree-docker.sh exec %s -- npm run build\n' "$DIST_ROOT"
    printf '\n'
    exit 0
fi

printf '\n'
printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf "${RED}  ✗ Stale Build Output (dist/ out of date vs source)${NC}\n"
printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf '\n'
printf '  The built dist/ for the following package(s) no longer matches\n'
printf '  their source (src/, package.json, tsconfig.json, or a shared build\n'
printf '  input — root tsconfig.json / packages/enterprise/.submodule-hash):\n'
printf '\n'
for pkg in $DRIFTED; do
    printf '    - packages/%s/dist\n' "$pkg"
done
printf '\n'
printf "  ${YELLOW}How to fix${NC} — rebuild so dist/ matches source:\n"
printf '    docker exec skillsmith-dev-1 npm run build   # container tree (Docker build/typecheck/test route)\n'
printf '    npm run build                                 # host tree, if you also build there\n'
printf '\n'
printf '  Stale-detection false positive? Re-run with:\n'
printf "    ${YELLOW}SKILLSMITH_SKIP_DIST_FRESHNESS=1${NC} (git commit / git push)\n"
printf '\n'
# NOTE: deliberately NO `--no-verify` footer here, matching
# check-node-modules-fresh.sh — --no-verify also skips prettier/lint/gitleaks,
# which is the wrong tool for an environmental "you forgot to rebuild" drift.

exit 1
