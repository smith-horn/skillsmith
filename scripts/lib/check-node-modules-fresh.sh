#!/bin/sh
# scripts/lib/check-node-modules-fresh.sh
# SMI-5343 / SMI-5344: node_modules freshness sentinel.
#
# Answers "does the installed node_modules satisfy the current
# package-lock.json?" without a network round-trip, mirroring the content-hash
# sentinel idiom already used by scripts/submodule-hash.sh.
#
# Two modes:
#   --write-sentinel  (postinstall) — write sha256(package-lock.json) →
#                     node_modules/.skillsmith-deps-hash. Idempotent, fail-soft.
#   default (check)   (hooks)        — if the sentinel is absent → drift
#                     ("dependencies not installed — run npm install"); else
#                     compare sha256(package-lock.json) to the sentinel:
#                     equal → fresh (exit 0); differ → drift (exit 1).
#                     Honors SKILLSMITH_SKIP_DEPS_FRESHNESS=1 → fresh.
#
# READ-ONLY in check mode (P-5 invariant): never runs npm install, never
# mutates node_modules, never rewrites the sentinel. A worktree commit must not
# mutate the shared main tree a parallel session may be mid-test on. The ONLY
# write path is --write-sentinel (install time).
#
# Why a sha256 sentinel and not `cmp node_modules/.package-lock.json
# package-lock.json`: npm's hidden lockfile omits the root "" workspace key, so
# byte-cmp diverges by npm design even after a clean `npm ci` (verified
# 2026-06-22, npm 10.9.7 — first hidden entry is node_modules/@ai-sdk/google).
#
# Worktree-symlink semantics: in a worktree, node_modules (hence the sentinel)
# is the MAIN checkout's (symlinked by create-worktree.sh), written at main's
# last install; package-lock.json is the WORKTREE branch's own file. Equal
# hashes ⇒ main's tree satisfies the worktree's lockfile (fresh); differing
# hashes ⇒ the worktree added/changed a dep the symlinked tree lacks (drift →
# "install in main"). This is the desired semantics.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

SENTINEL_NAME=".skillsmith-deps-hash"
# SMI-6496 Fix 2 (Wave 1, shadow-only): a second sentinel, alongside the raw
# one, storing a normalized "shadow hash" that neutralizes workspace-self
# version bumps. Written whenever the raw sentinel is (see --write-sentinel
# below); used only to LABEL a drift already decided by the raw hash — see
# the "shadow-hash diagnostic label" block near the bottom of this file.
SENTINEL_SHADOW_NAME=".skillsmith-deps-hash-shadow"

# --- repo-root resolution (robust from main repo OR a worktree) -------------
# package-lock.json is hashed against the CURRENT working tree (the worktree's
# own branch file when invoked from a worktree). node_modules is the symlink at
# the same toplevel, which (in a worktree) points into the main checkout.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
if [ -z "$REPO_ROOT" ]; then
    # Not a git checkout (e.g. extracted tarball) — fall back to this script's
    # grandparent (scripts/lib/ → repo root).
    REPO_ROOT="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd || echo '')"
fi

LOCKFILE="$REPO_ROOT/package-lock.json"
SENTINEL="$REPO_ROOT/node_modules/$SENTINEL_NAME"
SENTINEL_SHADOW="$REPO_ROOT/node_modules/$SENTINEL_SHADOW_NAME"
NORMALIZE_SCRIPT="$REPO_ROOT/scripts/lib/normalize-lockfile-for-freshness.mjs"
PACKAGE_JSON="$REPO_ROOT/package.json"

# sha256 helper — prefer sha256sum (Linux/Docker), fall back to shasum -a 256
# (macOS host). Prints the bare hash (hex), nothing else.
_lockfile_sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$LOCKFILE" 2>/dev/null | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$LOCKFILE" 2>/dev/null | cut -d' ' -f1
    else
        printf ''
    fi
}

# Shadow-hash helper (SMI-6496 Fix 2). Fail-soft (M4 in the plan): any
# problem here prints nothing and the caller must treat that as "shadow hash
# unavailable" — fall back to no label, never to "treat as fresh".
_shadow_hash() {
    [ "${SKILLSMITH_DEPS_FRESHNESS_SHADOW_HASH_DISABLE:-0}" = "1" ] && { printf ''; return; }
    command -v node >/dev/null 2>&1 || { printf ''; return; }
    [ -r "$NORMALIZE_SCRIPT" ] || { printf ''; return; }
    [ -r "$PACKAGE_JSON" ] || { printf ''; return; }
    node "$NORMALIZE_SCRIPT" "$LOCKFILE" "$PACKAGE_JSON" 2>/dev/null
}

# --- mode: --write-sentinel (install time only) -----------------------------
if [ "${1:-}" = "--write-sentinel" ]; then
    # Fail-soft: a missing lockfile / node_modules during a fragile install
    # transaction must never abort the install. The caller appends `|| true`.
    [ -f "$LOCKFILE" ] || exit 0
    [ -d "$REPO_ROOT/node_modules" ] || exit 0
    NEW_HASH="$(_lockfile_sha256)"
    [ -n "$NEW_HASH" ] || exit 0

    # SMI-6496 Fix 2 (Wave 1, shadow-only): compute and store the shadow hash
    # unconditionally, independent of the idempotent raw-sentinel skip below
    # — an install right after this feature ships must not wait for the next
    # real lockfile change before a shadow sentinel exists. Best-effort: a
    # failure here (see _shadow_hash's fail-soft contract) never blocks or
    # fails the raw sentinel write that follows.
    NEW_SHADOW="$(_shadow_hash)"
    if [ -n "$NEW_SHADOW" ]; then
        printf '%s\n' "$NEW_SHADOW" > "$SENTINEL_SHADOW" 2>/dev/null || true
    fi

    # Idempotent: skip the write when unchanged (avoids needless mtime churn
    # that a parallel session's freshness check might observe).
    if [ -f "$SENTINEL" ]; then
        OLD_HASH="$(cat "$SENTINEL" 2>/dev/null || echo '')"
        [ "$OLD_HASH" = "$NEW_HASH" ] && exit 0
    fi
    printf '%s\n' "$NEW_HASH" > "$SENTINEL" 2>/dev/null || exit 0
    exit 0
fi

# --- mode: default (check) — READ-ONLY --------------------------------------
# Escape hatch for a false positive (env drift the developer is sure is benign).
if [ "${SKILLSMITH_SKIP_DEPS_FRESHNESS:-0}" = "1" ]; then
    exit 0
fi

# No lockfile to compare against — nothing to enforce (fail-soft, treat fresh).
[ -f "$LOCKFILE" ] || exit 0

CUR_HASH="$(_lockfile_sha256)"
# Hashing tool unavailable — cannot enforce; fail-soft to avoid false drift.
[ -n "$CUR_HASH" ] || exit 0

DRIFT_REASON=""
SHADOW_LABEL=""
if [ ! -f "$SENTINEL" ]; then
    DRIFT_REASON="dependencies not installed"
else
    SENTINEL_HASH="$(cat "$SENTINEL" 2>/dev/null || echo '')"
    if [ "$SENTINEL_HASH" != "$CUR_HASH" ]; then
        DRIFT_REASON="node_modules is stale vs package-lock.json"
        # SMI-6496 Fix 2 (Wave 1, shadow-only, OUTPUT-ONLY): this only picks
        # which diagnostic label to print alongside the drift decision
        # already made above — it never changes that decision. Both a
        # stored shadow sentinel and a freshly-computed current shadow hash
        # are required to compare; anything missing leaves SHADOW_LABEL
        # empty (fail-soft — no label, never a wrong one).
        if [ -f "$SENTINEL_SHADOW" ]; then
            SENTINEL_SHADOW_HASH="$(cat "$SENTINEL_SHADOW" 2>/dev/null || echo '')"
            CUR_SHADOW_HASH="$(_shadow_hash)"
            if [ -n "$SENTINEL_SHADOW_HASH" ] && [ -n "$CUR_SHADOW_HASH" ]; then
                if [ "$SENTINEL_SHADOW_HASH" = "$CUR_SHADOW_HASH" ]; then
                    SHADOW_LABEL="Cosmetic-only drift detected — package-lock.json changed but only in workspace-self version fields (release-cadence bump). npm install is likely NOT required for this. Still blocking pending SMI-6496 Wave 2 (shadow soak in progress, see guards-and-opt-outs.md)."
                else
                    SHADOW_LABEL="Real dependency change detected (not workspace-version-only) — npm install required."
                fi
            fi
        fi
    fi
fi

# Fresh — exit silently (the hooks expect a quiet pass).
[ -z "$DRIFT_REASON" ] && exit 0

# --- drift: print the canonical actionable message --------------------------
# Reuse the hook color vars when sourced; define safe fallbacks for standalone.
RED="${RED:-${HOOK_DETECT_RED:-\033[0;31m}}"
YELLOW="${YELLOW:-${HOOK_DETECT_YELLOW:-\033[1;33m}}"
NC="${NC:-${HOOK_DETECT_NC:-\033[0m}}"

# This check runs ON THE HOST in both hooks (invoked via `sh`, not `run_cmd`),
# so it measures the host node_modules tree (in a worktree, that is the MAIN
# checkout's tree, symlinked in). This repo keeps TWO trees on macOS — the
# Docker container's and the host's — and a stale lockfile usually leaves BOTH
# behind, so we advise refreshing both rather than guessing from env vars that
# (a) may be unset here and (b) don't cross the host/container boundary anyway.
# The host install for a worktree must run in the MAIN checkout (its host
# node_modules is a symlink there) — resolve that path from git, not from env.
_MAIN_CHECKOUT=""
if _gcd="$(git rev-parse --git-common-dir 2>/dev/null)" \
    && _gd="$(git rev-parse --git-dir 2>/dev/null)" \
    && [ -n "$_gcd" ] && [ "$_gcd" != "$_gd" ]; then
    _MAIN_CHECKOUT="$(cd "$_gcd/.." 2>/dev/null && pwd || echo '')"
fi

printf '\n'
printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf "${RED}  ✗ Dependencies Out Of Date (node_modules stale vs package-lock.json)${NC}\n"
printf "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
printf '\n'
printf '  Your installed node_modules no longer matches package-lock.json.\n'
printf '  This is an environment issue, not a problem with your changes.\n'
printf '  (%s)\n' "$DRIFT_REASON"
if [ -n "$SHADOW_LABEL" ]; then
    printf '  %s\n' "$SHADOW_LABEL"
fi
printf '\n'
printf "  ${YELLOW}How to fix${NC} — refresh the installed deps to match package-lock.json:\n"
printf '    docker exec skillsmith-dev-1 npm install   # container tree (Docker build/typecheck)\n'
printf '\n'
printf '  Host tree: a bare npm install will not clear this guard. This repo sets\n'
printf '  ignore-scripts=true in .npmrc, so npm install also skips the postinstall\n'
printf '  step that writes the sentinel this guard reads. Run the script that writes\n'
printf '  the sentinel directly instead:\n'
if [ -n "$_MAIN_CHECKOUT" ]; then
    printf '    ( cd "%s" \\\n        && ./scripts/regen-lockfile.sh )   # host tree, from the MAIN checkout\n' "$_MAIN_CHECKOUT"
else
    printf '    ./scripts/regen-lockfile.sh                 # host tree\n'
fi
printf '\n'
printf '  Stale-detection false positive? Re-run with:\n'
printf "    ${YELLOW}SKILLSMITH_SKIP_DEPS_FRESHNESS=1 git commit${NC}   (or git push)\n"
printf '\n'
# NOTE: deliberately NO `--no-verify` footer here. For an environmental drift,
# --no-verify is the wrong tool — it also skips prettier/lint/gitleaks. The
# ~10-second `npm install` above is the actual fix, so we never advertise the
# footgun that a stale tree must not manufacture pressure toward (SMI-5344 #1).

exit 1
