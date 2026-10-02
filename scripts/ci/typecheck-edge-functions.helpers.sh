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


# Resolve which files this gate checks, and refuse if the committed partition and
# the detected one disagree. Lives here rather than in the main script only because
# of the 500-line gate; it reads and sets the caller's variables by design.
#
# Sets: EXCLUDED, CHECKED, and the contents of PROD_LIST.
resolve_partition() {
  # THE PARTITION IS COMMITTED DATA, NOT INFERRED FROM FILE CONTENT.
  #
  # Governance round 2 (C-1) measured the bypass that makes this necessary: when the
  # partition was computed by grepping each file for a vitest import, adding a
  # three-line COMMENT mentioning `'vitest'` to a production file removed it from the
  # denominator. Matched pair, identical files but for the comment: `checked 216 /
  # FAIL / exit 1` versus `checked 215 / PASS / exit 0`. `RESULT` stayed `EVALUATED`,
  # so it presented as a conclusive clean result, and the summary's `checked` count
  # returned to its pre-probe value, so a reviewer diffing run summaries saw nothing.
  #
  # Worse, it self-laundered: the file's baselined row then reported `gone -- fixed,
  # or RENAMED` with `PASS (improved)`, and `--update` dropped the row without
  # refusing. A vitest mention added to `create-portal-session/index.ts` (14
  # baselined errors) would have passed, reported an improvement, and permanently
  # removed that file from the gate with no artifact recording it.
  #
  # So the excluded set lives in a committed file, and a change to the partition is
  # a reviewable diff. The content-based detection still runs -- as a CROSS-CHECK,
  # not as the source of truth -- and any disagreement is loud.
  #
  # ONE FILE MAKES THIS WORSE THAN IT LOOKS, and it is the reason this fix is not
  # merely tidy. `_shared/resend-inbound.signature-contract.deno.ts` carries two
  # `/// <reference lib=...>` directives, and those are PROGRAM-WIDE: they supply
  # `deno.ns` and `dom` to every file in the compilation unit. Measured at tree
  # scale -- bare 60 errors versus 59 under this gate's config, a delta of one, where
  # a single file measured in isolation moves from 10 errors to 0. So if THAT file
  # were dropped from the checked set, the lib set would collapse for all 215 files
  # at once, not just for itself. Of the 215 ways to exercise C-1, one is an order of
  # magnitude worse than the rest.
  EXCLUDE_LIST="supabase/functions/typecheck-exclude.txt"
  if [[ ! -f "$EXCLUDE_LIST" ]]; then
    inconclusive "missing $EXCLUDE_LIST"
    NEXT_ACTION="restore the committed exclusion list; the partition must not be inferred from file content (C-1)"
    exit_for_inconclusive
  fi

  # Production = discovered minus committed-excluded. `comm` needs sorted input;
  # both sides are sorted. -f disables globbing so a metachar in a path cannot
  # expand (m-2).
  set -f
  comm -23 "$ALL_LIST" <(sort "$EXCLUDE_LIST") > "$PROD_LIST"
  EXCLUDED="$(wc -l < "$EXCLUDE_LIST" | tr -d ' ')"
  CHECKED="$(wc -l < "$PROD_LIST" | tr -d ' ')"

  # Separate from the DISCOVERED guard above: this one means the exclusion list
  # swallowed the entire tree, which is a different fault with a different cause.
  if [[ "$CHECKED" -eq 0 ]]; then
    inconclusive "every discovered file is excluded (discovered=$DISCOVERED excluded=$EXCLUDED)"
    NEXT_ACTION="the exclusion list covers the whole tree. This is NOT a clean result."
    exit_for_inconclusive
  fi

  # Cross-check: what WOULD content detection say? A disagreement means either a new
  # test file needs adding to the list, or someone put a vitest mention in a
  # production file. Either way a human decides, and neither silently shrinks the
  # denominator.
  DETECTED="$(mktemp)"
  : > "$DETECTED"
  while IFS= read -r f; do
    if grep -qE "(from|import)[[:space:]]+['\"]vitest['\"]" "$f" 2>/dev/null; then
      printf '%s\n' "$f" >> "$DETECTED"
    fi
  done < "$ALL_LIST"

  PARTITION_DIFF="$(comm -3 <(sort "$EXCLUDE_LIST") <(sort "$DETECTED") || true)"
  rm -f "$DETECTED"
  set +f

  # A partition disagreement is a VERDICT, not an INCONCLUSIVE result, and that
  # distinction was wrong in the first version of this fix. The check ran perfectly
  # and found something suspicious -- that is a statement about the tree, not about
  # whether the checker worked. Classifying it as INCONCLUSIVE made it merely WARN in
  # `local` context, so a developer adding a vitest mention to a production file
  # would have seen a warning and shipped it; only CI would have objected. It now
  # fails in EVERY context, which is the whole point of C-1.
  if [[ -n "$PARTITION_DIFF" ]]; then
    VERDICT="FAIL (partition changed)"
    DELTA_LINE="committed exclusion list disagrees with detected vitest imports"
    finish
    say "The set of files this gate checks has changed, and that set is committed data."
    say ""
    say "--- in the committed list but no longer importing vitest (left column),"
    say "    or importing vitest but not in the list (right column) ---"
    printf '%s\n' "$PARTITION_DIFF" | head -20
    say ""
    say "If this is a genuine NEW TEST FILE: add it to $EXCLUDE_LIST in a reviewed commit."
    say "If a PRODUCTION file merely MENTIONS vitest -- in a comment or a string --"
    say "remove the mention. Do NOT add a production file to the list: that silently"
    say "deletes it from this gate's denominator, which is the bypass C-1 recorded."
    exit 1
  fi
}
