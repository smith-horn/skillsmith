#!/bin/sh
# scripts/lib/check-tier-b-pairs-prepush.sh
# SMI-7201 Wave 2: pre-push Tier-B native/JS pair check. Wired into
# .husky/pre-push directly after the native-binding guard
# (check-native-modules.sh), same shape: `if ! sh "$LIB" </dev/null; then exit 1`.
#
# Runs scripts/lib/check-tier-b-pairs.mjs in the container the pre-push tests
# run in (the same run_cmd route as the native-binding guard). Outcomes:
#   exit 0 (CLEAN)          -> one line, push continues.
#   exit 1 (MISMATCH)       -> MISMATCH lines + the rebuild remedy; BLOCKS.
#   exit 2 / any other      -> the NOT-EVALUATED lines (or the status); BLOCKS.
#                              A broken state cannot be excluded, so the
#                              checker's input must be fixed (an unreadable
#                              file, semver missing); it is never read as clean.
#   not using a container   -> one loud line that the check did NOT run; push
#                              continues (the container is the subject).
#
# SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE=1 does NOT skip the check. It still
# runs; a block becomes a loud warning naming the variable and the result, and
# the push continues. Registered in docs/internal/process/guards-and-opt-outs.md.
#
# Test seam (like SKILLSMITH_NATIVE_CHECK_TEST): SKILLSMITH_TIER_B_PAIR_CHECK_TEST
# = 0|1|2|9|host forces the check's status (or the host route) without a
# container, and SKILLSMITH_TIER_B_PAIR_CHECK_TEST_KIND = worktree|main forces
# the checkout kind. The seam feeds the same rendering and exit logic below.
#
# STDIN-SILENT (never reads the pre-push refs) and READ-ONLY. POSIX sh -- no
# `local`, no `[[ ]]`, no arrays.

CHECKER=scripts/lib/check-tier-b-pairs.mjs
DISABLED=0
[ "${SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE:-}" = "1" ] && DISABLED=1

say() { printf '%s\n' "$1" >&2; }

# ---- route: a container, or not ------------------------------------------
OUT=""
RC=0
if [ -n "${SKILLSMITH_TIER_B_PAIR_CHECK_TEST:-}" ]; then
    case "$SKILLSMITH_TIER_B_PAIR_CHECK_TEST" in
        host)
            say "[tier-b-pairs] NOT RUN: this push is not using a container, so the Tier-B native/JS pair check did not run."
            exit 0
            ;;
        0) OUT="[tier-b-pairs] CLEAN 3 packages expected (3 applicable, 0 skipped for another platform), 3 pairs checked" ; RC=0 ;;
        1) OUT="[tier-b-pairs] MISMATCH path=node_modules/@img/sharp-linux-arm64 installed=0.0.0 parent=node_modules/sharp spec=^9.9.9" ; RC=1 ;;
        2) OUT="[tier-b-pairs] NOT-EVALUATED path=node_modules/@img/sharp-linux-arm64 installed package.json unreadable (EACCES)" ; RC=2 ;;
        *) OUT="" ; RC="$SKILLSMITH_TIER_B_PAIR_CHECK_TEST" ;;
    esac
    KIND="${SKILLSMITH_TIER_B_PAIR_CHECK_TEST_KIND:-main}"
else
    DETECT_LIB="$(dirname "$0")/hook-docker-detect.sh"
    if [ ! -r "$DETECT_LIB" ]; then
        say "[tier-b-pairs] NOT RUN: $DETECT_LIB is missing, so the Tier-B native/JS pair check did not run."
        exit 0
    fi
    # shellcheck source=./hook-docker-detect.sh
    . "$DETECT_LIB"
    if [ "${USE_DOCKER:-0}" != "1" ]; then
        say "[tier-b-pairs] NOT RUN: this push is not using a container, so the Tier-B native/JS pair check did not run."
        exit 0
    fi
    ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
    KIND=main
    [ -n "$ROOT" ] && [ -f "$ROOT/.git" ] && KIND=worktree
    ARGS=""
    [ "$KIND" = "worktree" ] && ARGS="--worktree"
    # Output and status captured separately; stdout is discarded because the
    # checker writes everything to stderr.
    # shellcheck disable=SC2086
    OUT="$(run_cmd node "$CHECKER" $ARGS 2>&1 >/dev/null)" || RC=$?
fi

# ---- rendering ------------------------------------------------------------
lines_with() { printf '%s\n' "$OUT" | grep -F -- "$1" || true; }

remedy() {
    if [ "$KIND" = "worktree" ]; then
        say "Remedy: run on the host from this worktree's root: docker compose --profile dev build dev && ./scripts/worktree-docker.sh stop && ./scripts/worktree-docker.sh start"
    else
        say "Remedy: run on the host from the main checkout's root: sh scripts/lib/print-deps-refresh-advice.sh \"\$PWD\", then run the sequence it prints. A rebuild alone does not change the named node_modules volume."
    fi
}

# verdict: BLOCK text for this result, or empty when the push may go on.
case "$RC" in
    0)
        CLEAN_LINE="$(lines_with "] CLEAN" | head -n 1)"
        if [ -n "$CLEAN_LINE" ]; then
            say "$CLEAN_LINE"
            exit 0
        fi
        RESULT="the check exited 0 without a CLEAN summary line, so it is not reported as clean"
        FIX="the checker's output must be fixed"
        ;;
    1)
        RESULT="MISMATCH"
        say "[tier-b-pairs] Tier-B native/JS pair MISMATCH (SMI-7201):"
        lines_with "] MISMATCH" >&2
        say "The native half no longer matches its JS parent; for example sharp then fails to load, and EmbeddingService silently serves mock embeddings."
        ;;
    2)
        RESULT="NOT-EVALUATED"
        say "[tier-b-pairs] Tier-B native/JS pair check NOT EVALUATED (SMI-7201):"
        lines_with "] NOT-EVALUATED" >&2
        FIX="the checker's input must be fixed (for example an unreadable file, or semver missing), because a broken state cannot be excluded"
        ;;
    *)
        RESULT="NOT-EVALUATED (the check exited with status $RC)"
        say "[tier-b-pairs] Tier-B native/JS pair check did not complete: exit status $RC (SMI-7201)."
        [ -z "$OUT" ] || printf '%s\n' "$OUT" >&2
        FIX="the checker's input must be fixed (node missing or a crash), because a broken state cannot be excluded"
        ;;
esac
if [ "$RC" = "0" ]; then
    say "[tier-b-pairs] Tier-B native/JS pair check NOT EVALUATED (SMI-7201): $RESULT."
fi

if [ "$DISABLED" = "1" ]; then
    say "[tier-b-pairs] WARNING: SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE=1 is set, so this result ($RESULT) does not block the push. The pairs are NOT verified."
    exit 0
fi

if [ "$RC" = "1" ]; then
    remedy
else
    say "Fix: $FIX."
fi
say "Opt-out (does not skip the check, only downgrades the block): SKILLSMITH_TIER_B_PAIR_CHECK_DISABLE=1"
exit 1
