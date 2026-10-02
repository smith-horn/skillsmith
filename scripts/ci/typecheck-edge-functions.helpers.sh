#!/usr/bin/env bash
# typecheck-edge-functions.helpers.sh -- SMI-6897. The output contract and exit
# policy for scripts/ci/typecheck-edge-functions.sh.
#
# Split out when the main script crossed the hard 500-line pre-commit gate,
# following the scripts/ci convention set by check-submodule-pointer.sh and its
# .helpers.sh sibling. Sourced, not executed: every function here reads variables
# the caller sets, by design -- this is one script in two files, not a library.
#
# shellcheck shell=bash

say() { printf '%s\n' "$*"; }
field() { printf '  %-12s %s\n' "$1" "$2"; }

# RESULT answers "did the check produce a usable answer"; VERDICT answers "is the
# tree acceptable". They are separate axes on purpose: conflating them is how a
# checker that never ran gets recorded as a checker that found nothing
# (SMI-6684's STATE/CAUSE split, SMI-6704 Item 8).
RESULT="EVALUATED"
VERDICT=""
INCONCLUSIVE_WHY=""

inconclusive() {
  RESULT="INCONCLUSIVE"
  INCONCLUSIVE_WHY="$1"
}

finish() {
  say ""
  say "[edge-typecheck] SMI-6897"
  field "context" "$CONTEXT"
  field "config" "$CONFIG (explicit --config; DENO_NO_PACKAGE_JSON=1)"
  field "lock" "${LOCK_MODE:-not reached}"
  field "deno" "${DENO_VERSION:-unknown}"
  field "discovered" "${DISCOVERED:-?} .ts under supabase/functions"
  field "excluded" "${EXCLUDED:-?} (vitest-importing -- Node runtime, not Deno)"
  field "checked" "${CHECKED:-?} files"
  field "crypt" "${CRYPT_STATE:-?} (sentinel $CRYPT_SENTINEL)"
  [[ -n "${ERR_LINE:-}" ]] && field "errors" "$ERR_LINE"
  [[ -n "${BASE_LINE:-}" ]] && field "baseline" "$BASE_LINE"
  [[ -n "${DELTA_LINE:-}" ]] && field "delta" "$DELTA_LINE"
  field "RESULT" "$RESULT${INCONCLUSIVE_WHY:+ -- $INCONCLUSIVE_WHY}"
  field "VERDICT" "${VERDICT:-NONE}"
  [[ -n "${NEXT_ACTION:-}" ]] && say "  next: $NEXT_ACTION"
  say ""
}

# An inconclusive result exits non-zero wherever this check guards something.
exit_for_inconclusive() {
  finish
  case "$CONTEXT" in
    required-ci | pre-deploy)
      say "FATAL: the check could not run, and $CONTEXT depends on it. \"Not checked\" is not \"safe\"."
      exit 1
      ;;
    fork-pr | local)
      say "WARNING: the check could not run. Not fatal in context '$CONTEXT'."
      exit 0
      ;;
    *)
      # Unreachable -- CONTEXT is validated at startup. Fails CLOSED anyway,
      # because the alternative is a silent pass (M-1).
      say "FATAL: unvalidated context '$CONTEXT' reached the exit policy."
      exit 1
      ;;
  esac
}

