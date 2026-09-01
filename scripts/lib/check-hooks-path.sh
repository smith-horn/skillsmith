#!/bin/sh
# scripts/lib/check-hooks-path.sh
# SMI-6334 Wave 2 Step 2: hooksPath-resolution drift + per-tree stub-coverage
# guard, invoked from .husky/pre-push beside the existing freshness guards.
#
# core.hooksPath is repo-SHARED state (one value in $GIT_COMMON_DIR/config,
# read by the main checkout and every linked worktree). SMI-6334's fix is a
# single RELATIVE value ('.husky/_'), which git resolves against the
# toplevel of the INVOKING tree -- so an ABSOLUTE value (drift, or a value
# written from a different tree) silently routes every hook invocation
# through whichever tree it happens to point at. See
# docs/internal/implementation/smi-6334-worktree-hookspath-fix.md for the
# full root-cause writeup.
#
# Two independent checks, both advisory (WARN, never BLOCK). A false
# positive here must never wedge a push -- core.hooksPath is shared state,
# so a buggy hard-fail here would affect every worktree and the main
# checkout simultaneously, exactly the blast radius this whole fix is
# trying to shrink, not grow:
#
#   (a) hooksPath-resolution drift: resolves the effective core.hooksPath
#       against THIS tree's toplevel; warns if it resolves OUTSIDE this
#       tree.
#   (b) per-tree stub coverage (GPT-5.6-Sol plan-review addition,
#       2026-09-01): scripts/audit-standards.mjs Check 64 validates stub
#       coverage for only ONE tree at a time (whichever branch it happens
#       to run against) -- it cannot centrally sweep every currently-active
#       worktree branch, each of which may be on independently-diverged
#       .husky/ content. This check re-runs the same assertion against THIS
#       invoking tree, at the moment it matters most: a push attempt.
#
# STDIN-SILENT: this script reads no stdin. The caller (.husky/pre-push)
# additionally redirects fd 0 from /dev/null, matching every other
# freshness/health guard in that hook, so it can never consume the pre-push
# refs. READ-ONLY (P-5): never writes core.hooksPath or any .husky/ file --
# that repair is ensure_hooks_path_relative()'s job (scripts/_lib.sh),
# invoked from create-worktree.sh / repair-worktrees.sh, not this script.
#
# Escape hatch: SKILLSMITH_SKIP_HOOKS_PATH_CHECK=1.
#
# POSIX sh -- no `local`, no `[[ ]]`, no arrays (same discipline as
# check-dist-fresh.sh / check-node-modules-fresh.sh).

if [ "${SKILLSMITH_SKIP_HOOKS_PATH_CHECK:-0}" = "1" ]; then
    exit 0
fi

TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
# Fail-soft: not a git checkout, or git unavailable -- nothing to check,
# never manufacture a false warning.
[ -n "$TOPLEVEL" ] || exit 0

HOOKS_PATH_RAW="$(git config --get core.hooksPath 2>/dev/null || echo '')"
# If core.hooksPath were unset, .husky/pre-push (this script's caller) would
# never have been invoked in the first place -- but fail-soft rather than
# assume that can't happen.
[ -n "$HOOKS_PATH_RAW" ] || exit 0

case "$HOOKS_PATH_RAW" in
    /*) HOOKS_DIR_ABS="$HOOKS_PATH_RAW" ;;
    *)  HOOKS_DIR_ABS="$TOPLEVEL/$HOOKS_PATH_RAW" ;;
esac

# Reuse the hook color vars when sourced from .husky/pre-push; safe
# fallbacks for standalone invocation (matches check-dist-fresh.sh).
YELLOW="${YELLOW:-${HOOK_DETECT_YELLOW:-\033[1;33m}}"
NC="${NC:-${HOOK_DETECT_NC:-\033[0m}}"

# --- Check (a): hooksPath resolution drift ----------------------------------
case "$HOOKS_DIR_ABS" in
    "$TOPLEVEL"/*|"$TOPLEVEL")
        : # resolves inside this tree -- healthy, nothing to warn about
        ;;
    *)
        printf '\n'
        printf "${YELLOW}------------------------------------------------------------${NC}\n"
        printf "${YELLOW}  WARNING (non-blocking -- push proceeded, SMI-6334)${NC}\n"
        printf "${YELLOW}------------------------------------------------------------${NC}\n"
        printf '\n'
        printf '  core.hooksPath resolves OUTSIDE this tree -- every hook (and every\n'
        printf '  script it references) is silently running the WRONG tree copy:\n'
        printf '\n'
        printf '    This tree (git rev-parse --show-toplevel): %s\n' "$TOPLEVEL"
        printf '    core.hooksPath resolves to:                %s\n' "$HOOKS_DIR_ABS"
        printf '\n'
        printf '  Fix (repo-shared value -- one command fixes every worktree AND the\n'
        printf '  main checkout at once):\n'
        printf '    ./scripts/repair-worktrees.sh\n'
        printf '  or directly:\n'
        printf '    git config core.hooksPath .husky/_\n'
        printf '\n'
        printf "  Disable: ${YELLOW}SKILLSMITH_HOOKS_PATH_HEAL_DISABLE=1${NC} (repair) / "
        printf "${YELLOW}SKILLSMITH_SKIP_HOOKS_PATH_CHECK=1${NC} (this warning)\n"
        printf '\n'
        ;;
esac

# --- Check (b): per-tree stub coverage (GPT-5.6-Sol plan-review addition) ---
# For every .husky/<hook> body in THIS tree, assert .husky/_/<hook> exists
# and is non-trivial (>= MIN_STUB_BYTES). Mirrors audit-standards.mjs Check
# 64's threshold exactly (39 bytes is the real, shipped husky stub; well
# under that is truncated/empty, not a legitimately short stub).
MIN_STUB_BYTES=10
HUSKY_DIR="$TOPLEVEL/.husky"
MISSING_STUBS=""

if [ -d "$HUSKY_DIR" ]; then
    for hook_path in "$HUSKY_DIR"/*; do
        [ -f "$hook_path" ] || continue
        hook="$(basename "$hook_path")"
        stub_path="$HUSKY_DIR/_/$hook"
        if [ ! -f "$stub_path" ]; then
            MISSING_STUBS="$MISSING_STUBS $hook(missing)"
            continue
        fi
        size="$(wc -c < "$stub_path" 2>/dev/null | tr -d ' ')"
        case "$size" in
            ''|*[!0-9]*) MISSING_STUBS="$MISSING_STUBS $hook(unreadable)" ;;
            *)
                if [ "$size" -lt "$MIN_STUB_BYTES" ]; then
                    MISSING_STUBS="$MISSING_STUBS $hook(trivial:${size}b)"
                fi
                ;;
        esac
    done
fi

if [ -n "$MISSING_STUBS" ]; then
    printf '\n'
    printf "${YELLOW}------------------------------------------------------------${NC}\n"
    printf "${YELLOW}  WARNING (non-blocking -- push proceeded, SMI-6334)${NC}\n"
    printf "${YELLOW}------------------------------------------------------------${NC}\n"
    printf '\n'
    printf '  One or more .husky/<hook> bodies in THIS tree have no matching,\n'
    printf '  non-trivial .husky/_/<hook> dispatch stub. Once core.hooksPath is the\n'
    printf '  relative literal .husky/_, a hook with no stub is silently SKIPPED by\n'
    printf '  git entirely (not routed anywhere -- just never run):\n'
    printf '\n'
    printf '   %s\n' "$MISSING_STUBS"
    printf '\n'
    printf '  Fix: re-add the missing .husky/_/<hook> stub(s) -- same shape as the\n'
    printf '  existing ones (a two-line "#!/usr/bin/env sh" dispatcher sourcing\n'
    printf '  .husky/_/h) -- commit them, and confirm they are executable.\n'
    printf '\n'
    printf "  Disable this warning: ${YELLOW}SKILLSMITH_SKIP_HOOKS_PATH_CHECK=1${NC}\n"
    printf '\n'
fi

exit 0
