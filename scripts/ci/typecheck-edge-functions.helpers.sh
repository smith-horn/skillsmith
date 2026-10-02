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
  # *_FIELD, not *_LINE: the display string for the baseline row used to be
  # BASE_LINE, one character from BASELINE -- which is the baseline FILE PATH.
  # SC2153 flagged the pair as a possible misspelling and was right to: this
  # gate's M-1 defect was a single transposition in a variable name turning
  # every inconclusive result into a pass. Renaming the one odd member to
  # BASELINE_LINE would have deepened the collision, so the whole display family
  # moved instead.
  [[ -n "${ERR_FIELD:-}" ]] && field "errors" "$ERR_FIELD"
  [[ -n "${BASE_FIELD:-}" ]] && field "baseline" "$BASE_FIELD"
  [[ -n "${DELTA_FIELD:-}" ]] && field "delta" "$DELTA_FIELD"
  field "RESULT" "$RESULT${INCONCLUSIVE_WHY:+ -- $INCONCLUSIVE_WHY}"
  field "VERDICT" "${VERDICT:-NONE}"
  [[ -n "${NEXT_ACTION:-}" ]] && say "  next: $NEXT_ACTION"
  say ""
}

# An inconclusive result exits non-zero wherever this check guards something.
#
# `fork-pr` is NOT a blanket amnesty, and treating it as one was the second half of
# H-4. Only a cause the CALLER explicitly marks tolerable there exits 0, and exactly
# one qualifies: a git-crypt-locked tree, which a fork structurally cannot decrypt.
# Every other cause -- an unparseable graph, a failed remote fetch, an attribution
# that did not reconcile -- fails closed on a fork too. Otherwise a fork PR could
# reach a green check by ANY route that makes the gate inconclusive, and a fork PR
# is the one place the input is not ours.
#
# On a genuine fork PR the crypt check fires first and the other causes are
# unreachable, so this narrowing costs nothing in the legitimate case. What it
# closes is the case where CONTEXT says `fork-pr` over a tree that is NOT locked.
#
# Passed as an argument rather than read from a variable: a variable set by one
# branch and never cleared would widen the amnesty silently, which is the shape of
# the defect this narrowing exists to remove.
exit_for_inconclusive() {
  local tolerated_on_fork=""
  [[ "${1:-}" == "--tolerated-on-fork" ]] && tolerated_on_fork=1
  finish
  case "$CONTEXT" in
    required-ci | pre-deploy)
      say "FATAL: the check could not run, and $CONTEXT depends on it. \"Not checked\" is not \"safe\"."
      exit 1
      ;;
    fork-pr)
      if [[ -n "$tolerated_on_fork" ]]; then
        say "WARNING: the check could not run, and this cause is structural on a fork PR."
        exit 0
      fi
      say "FATAL: the check could not run, for a cause a fork PR does not excuse."
      say "Only a git-crypt-locked tree is tolerated under fork-pr; this was not that."
      exit 1
      ;;
    local)
      say "WARNING: the check could not run. Not fatal in context 'local'."
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



# C-1, a Critical fail-open found by the cross-family gate and required by the
# plan all along. `awk` returns EVERY matching row, so a duplicated baseline path
# made `base_count` the string "5\n5"; both `-gt` and `-lt` then threw an
# arithmetic syntax error, and because this script deliberately has no `set -e`,
# execution continued with NEW_ERRORS empty and the gate reached PASS, exit 0.
# A duplicated row could therefore hide any number of new errors in that file.
#
# Validated with awk rather than an associative array, because macOS ships bash
# 3.2 and this script must run there (measured: an earlier mapfile call died
# locally while CI's bash 4 stayed green).
#
# Sets BASELINE_BAD to a human-readable reason, empty when the file is sound.
validate_baseline() {
  local file="$1" prod="$2"
  BASELINE_BAD=""
  [[ -f "$file" ]] || { BASELINE_BAD="missing"; return 1; }

  BASELINE_BAD="$(awk -F'\t' -v prodlist="$prod" '
    BEGIN {
      while ((getline p < prodlist) > 0) is_prod[p] = 1
    }
    {
      n++
      if (NF != 2)                      { bad = bad "\n  row " NR ": expected <count>\\t<path>, got " NF " field(s)"; next }
      if ($1 !~ /^[0-9]+$/)             { bad = bad "\n  row " NR ": count is not a non-negative integer: " $1; next }
      if ($1 + 0 == 0)                  { bad = bad "\n  row " NR ": count is 0 -- a zeroed row must be deleted, not kept"; next }
      if ($2 == "")                     { bad = bad "\n  row " NR ": empty path"; next }
      if ($2 ~ /^\//)                   { bad = bad "\n  row " NR ": absolute path (must be repo-relative): " $2; next }
      if (seen[$2]++)                   { bad = bad "\n  row " NR ": DUPLICATE path (this is the C-1 fail-open): " $2; next }
      if (prev != "" && $2 < prev)      { bad = bad "\n  row " NR ": not path-sorted (" prev " then " $2 ")" }
      if (!($2 in is_prod))             { bad = bad "\n  row " NR ": path is not in the checked set (deleted, renamed, or excluded?): " $2 }
      prev = $2
      total += $1
    }
    END {
      if (n == 0) bad = bad "\n  file is empty"
      if (bad != "") printf "%s", bad
    }
  ' "$file")"

  [[ -z "$BASELINE_BAD" ]]
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
    DELTA_FIELD="committed exclusion list disagrees with detected vitest imports"
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

# Compare the current per-file counts against the baseline and decide the verdict.
# Lives here only because of the 500-line gate; it reads and sets the caller's
# variables and exits the process itself, by design -- this is one script in two
# files, not a library.
compare_to_baseline() {
  if [[ ! -f "$BASELINE" ]]; then
    BASE_FIELD="absent"
    if [[ "$REPORTED" -eq 0 ]]; then
      VERDICT="PASS (zero errors, no baseline needed)"
      finish
      exit 0
    fi
    VERDICT="FAIL"
    NEXT_ACTION="no baseline exists. Generate one deliberately: bash scripts/ci/typecheck-edge-functions.sh --update"
    finish
    exit 1
  fi

  BASE_TOTAL="$(awk -F'\t' '{s += $1} END {print s + 0}' "$BASELINE")"
  BASE_FILES="$(wc -l < "$BASELINE" | tr -d ' ')"
  BASE_FIELD="$BASE_FILES files / $BASE_TOTAL errors"

  NEW_ERRORS=""; NEW_FILES=0; IMPROVED=""; MISSING=""
  while IFS=$'\t' read -r cur_count cur_path; do
    [[ -z "${cur_path:-}" ]] && continue
    base_count="$(awk -F'\t' -v p="$cur_path" '$2 == p {print $1}' "$BASELINE")"
    if [[ -z "$base_count" ]]; then
      NEW_ERRORS+=$'\n'"  NEW FILE    $cur_path ($cur_count)"
      NEW_FILES=$((NEW_FILES + 1))
    elif [[ "$cur_count" -gt "$base_count" ]]; then
      NEW_ERRORS+=$'\n'"  INCREASED   $cur_path ($base_count -> $cur_count)"
    elif [[ "$cur_count" -lt "$base_count" ]]; then
      IMPROVED+=$'\n'"  improved    $cur_path ($base_count -> $cur_count)"
    fi
  done < "$BY_FILE"

  # A baselined path that no longer appears is EITHER fixed OR renamed, and the
  # mechanism cannot tell which. Report it separately from a new error so the two
  # are not conflated (D-16).
  while IFS=$'\t' read -r _ base_path; do
    [[ -z "${base_path:-}" ]] && continue
    if ! awk -F'\t' -v p="$base_path" '$2 == p {found = 1} END {exit !found}' "$BY_FILE"; then
      MISSING+=$'\n'"  gone        $base_path -- fixed, or RENAMED (the mechanism cannot tell)"
    fi
  done < "$BASELINE"

  DELTA_FIELD="$NEW_FILES newly-failing files / $(printf '%s' "$NEW_ERRORS" | grep -c . || true) regressions"

  if [[ -n "$NEW_ERRORS" ]]; then
    VERDICT="FAIL"
    finish
    say "New or increased errors -- this is the ratchet, and it blocks:$NEW_ERRORS"
    [[ -n "$MISSING" ]] && { say ""; say "Also, baselined paths no longer reporting:$MISSING"; \
      say "If one of those is the RENAME of a file listed above, that is the SMI-6704 R10 case:"; \
      say "edit the baseline deliberately and say so in the commit. --update will refuse it."; }
    say ""
    say "next: fix the error, or -- only if it is a rename -- adjust the baseline by hand with a stated reason."
    exit 1
  fi

  if [[ -n "$IMPROVED" || -n "$MISSING" ]]; then
    VERDICT="PASS (improved -- rerun with --update to lower the baseline)"
    finish
    say "Improvements:$IMPROVED$MISSING"
    exit 0
  fi

  VERDICT="PASS (at baseline)"
  finish
  exit 0
}
