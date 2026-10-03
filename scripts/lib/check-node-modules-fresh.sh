#!/bin/sh
# scripts/lib/check-node-modules-fresh.sh
# SMI-5343 / SMI-5344: node_modules freshness sentinel.
# SMI-6606 / SMI-6614 (ADR-158): one classifier, --classify, decides
# fresh|cosmetic|real|unknown for every consumer (this script's own check
# mode, .husky/post-merge, .husky/post-checkout, the SMI-6006 container
# self-heal, scripts/regen-lockfile.sh's advice text). See
# docs/internal/adr/158-lockfile-drift-classifier-single-install-oracle.md
# and docs/internal/implementation/smi-6614-6606-lockfile-drift-classifier.md.
#
# Answers "does the installed node_modules satisfy the current
# package-lock.json?" without a network round-trip, mirroring the content-hash
# sentinel idiom already used by scripts/submodule-hash.sh.
#
# Three modes:
#   --write-sentinel  (postinstall) — write sha256(package-lock.json) →
#                     node_modules/.skillsmith-deps-hash, plus a normalized
#                     "shadow hash" (see SENTINEL_SHADOW_NAME below) →
#                     node_modules/.skillsmith-deps-hash-shadow. Idempotent,
#                     fail-soft.
#   --classify        (hooks, guards) — READ-ONLY. Prints exactly one of
#                     fresh|cosmetic|real|unknown to stdout and exits 0. Every
#                     consumer that decides install-or-not, or block-or-not,
#                     on a lockfile delta calls this instead of re-deriving
#                     its own answer. Never honors
#                     SKILLSMITH_SKIP_DEPS_FRESHNESS — that var is a
#                     check-mode-only escape hatch, applied by check mode
#                     below BEFORE this is consulted.
#   default (check)   (hooks) — re-expresses the SAME classifier's verdict as
#                     a pass/fail: fresh/cosmetic → exit 0 (cosmetic prints
#                     one informational line); real/unknown → exit 1 with the
#                     drift banner + the shared refresh advice
#                     (print-deps-refresh-advice.sh). Honors
#                     SKILLSMITH_SKIP_DEPS_FRESHNESS=1 → exit 0. Two fail-soft
#                     exits predate the classifier and are unchanged: no
#                     lockfile, no hashing tool → exit 0 silently (pinned by
#                     scripts/tests/check-node-modules-fresh.test.ts's
#                     P-6 FAIL-SOFT case) — --classify reports `unknown` for
#                     both instead of guessing.
#
# READ-ONLY in --classify and check mode (P-5 invariant): never runs npm
# install, never mutates node_modules, never rewrites the sentinel. A
# worktree commit must not mutate the shared main tree a parallel session may
# be mid-test on. The ONLY write path is --write-sentinel (install time) —
# per ADR-158's "the sentinel stays install-time evidence" decision, nothing
# else writes it, including a cosmetic verdict.
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
# hashes ⇒ the worktree added/changed a dep the symlinked tree lacks (drift).
# This is the desired semantics, unaffected by the classifier flip.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

SENTINEL_NAME=".skillsmith-deps-hash"
# SMI-6496 Fix 2: a second sentinel, alongside the raw one, storing a
# normalized "shadow hash" that neutralizes workspace-self version bumps.
# Written whenever the raw sentinel is (see --write-sentinel below). Since
# SMI-6606/SMI-6614 (ADR-158) this is no longer diagnostic-only — --classify
# and check mode both use it to distinguish `cosmetic` from `real` drift.
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
ADVICE_SCRIPT="$REPO_ROOT/scripts/lib/print-deps-refresh-advice.sh"

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

# Shadow-hash helper (SMI-6496 Fix 2). Fail-soft: any problem here prints
# nothing and the caller must treat that as "shadow hash unavailable" — the
# classifier below reads that as `unknown`, never as `cosmetic`.
_shadow_hash() {
    [ "${SKILLSMITH_DEPS_FRESHNESS_SHADOW_HASH_DISABLE:-0}" = "1" ] && { printf ''; return; }
    command -v node >/dev/null 2>&1 || { printf ''; return; }
    [ -r "$NORMALIZE_SCRIPT" ] || { printf ''; return; }
    [ -r "$PACKAGE_JSON" ] || { printf ''; return; }
    node "$NORMALIZE_SCRIPT" "$LOCKFILE" "$PACKAGE_JSON" 2>/dev/null
}

# --- classifier (SMI-6606 / SMI-6614, ADR-158) -------------------------------
# Prints exactly one of: fresh | cosmetic | real | unknown. Pure function of
# on-disk state — never mutates anything. See the token table in the plan
# doc's "What Changes" § 1.
_classify() {
    if [ ! -f "$LOCKFILE" ]; then
        echo unknown
        return 0
    fi

    _cur_hash="$(_lockfile_sha256)"
    if [ -z "$_cur_hash" ]; then
        echo unknown
        return 0
    fi

    if [ ! -f "$SENTINEL" ]; then
        echo unknown
        return 0
    fi
    _sentinel_hash="$(cat "$SENTINEL" 2>/dev/null || echo '')"
    if [ "$_sentinel_hash" = "$_cur_hash" ]; then
        echo fresh
        return 0
    fi

    # Raw differs — only the shadow hash can tell cosmetic from real. Both a
    # stored shadow sentinel and a freshly-computed current shadow hash are
    # required to compare; anything missing falls through to `unknown` below
    # (fail-soft — never guess `cosmetic`).
    if [ -f "$SENTINEL_SHADOW" ]; then
        _sentinel_shadow_hash="$(cat "$SENTINEL_SHADOW" 2>/dev/null || echo '')"
        _cur_shadow_hash="$(_shadow_hash)"
        if [ -n "$_sentinel_shadow_hash" ] && [ -n "$_cur_shadow_hash" ]; then
            if [ "$_sentinel_shadow_hash" = "$_cur_shadow_hash" ]; then
                echo cosmetic
            else
                echo real
            fi
            return 0
        fi
    fi

    echo unknown
}

# --- mode: --write-sentinel (install time only) -----------------------------
if [ "${1:-}" = "--write-sentinel" ]; then
    # Fail-soft: a missing lockfile / node_modules during a fragile install
    # transaction must never abort the install. The caller appends `|| true`.
    [ -f "$LOCKFILE" ] || exit 0
    [ -d "$REPO_ROOT/node_modules" ] || exit 0
    NEW_HASH="$(_lockfile_sha256)"
    [ -n "$NEW_HASH" ] || exit 0

    # Compute and store the shadow hash unconditionally, independent of the
    # idempotent raw-sentinel skip below — an install must not wait for the
    # next real lockfile change before a shadow sentinel exists. Best-effort:
    # a failure here (see _shadow_hash's fail-soft contract) never blocks or
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

# --- mode: --classify (SMI-6606 / SMI-6614) — READ-ONLY ----------------------
if [ "${1:-}" = "--classify" ]; then
    _classify
    exit 0
fi

# --- mode: default (check) — READ-ONLY --------------------------------------
# Escape hatch for a false positive (env drift the developer is sure is
# benign). Does NOT apply to --classify above — that mode always reports the
# real verdict.
if [ "${SKILLSMITH_SKIP_DEPS_FRESHNESS:-0}" = "1" ]; then
    exit 0
fi

# No lockfile to compare against — nothing to enforce (fail-soft, treat fresh).
[ -f "$LOCKFILE" ] || exit 0

CUR_HASH="$(_lockfile_sha256)"
# Hashing tool unavailable — cannot enforce; fail-soft to avoid false drift.
[ -n "$CUR_HASH" ] || exit 0

VERDICT="$(_classify)"

case "$VERDICT" in
    fresh)
        exit 0
        ;;
    cosmetic)
        printf 'package-lock.json changed only in workspace-self version fields; installed dependencies still match. No install needed.\n'
        exit 0
        ;;
esac

# real, unknown, or (defensively) anything else _classify could somehow
# print — block with the drift banner.
if [ ! -f "$SENTINEL" ]; then
    DRIFT_REASON="dependencies not installed"
else
    DRIFT_REASON="node_modules is stale vs package-lock.json"
fi
SHADOW_LABEL=""
if [ "$VERDICT" = "real" ]; then
    SHADOW_LABEL="Real dependency change detected (not workspace-version-only) — npm install required."
fi

# --- drift: print the canonical actionable message --------------------------
# Reuse the hook color vars when sourced; define safe fallbacks for standalone.
RED="${RED:-${HOOK_DETECT_RED:-\033[0;31m}}"
YELLOW="${YELLOW:-${HOOK_DETECT_YELLOW:-\033[1;33m}}"
NC="${NC:-${HOOK_DETECT_NC:-\033[0m}}"

# This check runs ON THE HOST in both hooks (invoked via `sh`, not `run_cmd`),
# so it measures the host node_modules tree (in a worktree, that is the MAIN
# checkout's tree, symlinked in). Resolve the main-checkout path from git, not
# from env, for the advice text below.
_MAIN_CHECKOUT=""
if _gcd="$(git rev-parse --git-common-dir 2>/dev/null)" \
    && _gd="$(git rev-parse --git-dir 2>/dev/null)" \
    && [ -n "$_gcd" ] && [ "$_gcd" != "$_gd" ]; then
    _MAIN_CHECKOUT="$(cd "$_gcd/.." 2>/dev/null && pwd || echo '')"
fi
ADVICE_MAIN="$_MAIN_CHECKOUT"
[ -n "$ADVICE_MAIN" ] || ADVICE_MAIN="$REPO_ROOT"

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
printf '\n'
if [ -r "$ADVICE_SCRIPT" ]; then
    sh "$ADVICE_SCRIPT" "$ADVICE_MAIN"
else
    printf '  ( cd "%s" && ./scripts/regen-lockfile.sh )\n' "$ADVICE_MAIN"
fi
printf '\n'
printf "  ${YELLOW}Careful:${NC} running --write-sentinel or regen-lockfile.sh directly from a\n"
printf '  worktree stamps the shared MAIN checkout'\''s tree (node_modules there is a\n'
printf '  symlink into main) — run the refresh steps above from the MAIN checkout path\n'
printf '  shown, not from this worktree.\n'
printf '\n'
printf '  Stale-detection false positive? Re-run with:\n'
printf "    ${YELLOW}SKILLSMITH_SKIP_DEPS_FRESHNESS=1 git commit${NC}   (or git push)\n"
printf '\n'
# NOTE: deliberately NO `--no-verify` footer here. For an environmental drift,
# --no-verify is the wrong tool — it also skips prettier/lint/gitleaks. The
# refresh sequence above is the actual fix, so we never advertise the
# footgun that a stale tree must not manufacture pressure toward (SMI-5344 #1).

exit 1
