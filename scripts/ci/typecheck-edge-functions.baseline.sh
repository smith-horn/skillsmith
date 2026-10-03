#!/usr/bin/env bash
# typecheck-edge-functions.baseline.sh -- SMI-6897. Everything about the baseline:
# the comparability predicate, the file validator, the `--update` ratchet, and the
# comparison that produces the verdict.
#
# THE THIRD FILE, and the reason is worth stating because the obvious reading is
# over-modularisation. It is not modularity; it is the hard 500-line pre-commit
# gate. The main script and its first sibling both crossed it while applying the
# round-3 cross-family findings, and the alternative was deleting the comments
# that explain why each guard exists -- which are the only reason the next person
# will not remove a guard that looks redundant. Two of this gate's three
# Criticals were reintroductions of a defect whose fix was already in the file,
# so those comments are load-bearing.
#
# Sourced, not executed: every function here reads variables the caller sets and
# exits the process itself, by design. One script in three files, not a library.
#
# shellcheck shell=bash
#
# SC2034 across this file: VERDICT, BASE_FIELD, DELTA_FIELD and NEXT_ACTION are
# set here and read by `finish` in the helpers sibling. shellcheck analyses each
# file alone and cannot follow a `source`, so it reports every one as unused.
# Suppressed with the reason stated, so nobody resolves the warning by deleting
# an assignment the report depends on.
# shellcheck disable=SC2034

# One predicate, used by BOTH comparison sites. Round 3: the UNCOMPARABLE arm
# guarded `compare_to_baseline` and `apply_update_ratchet` reached arithmetic
# directly, so "each barrier guards a different surface" was not true of the
# ratchet. A 20-digit count passes a canonical-integer test and still overflows
# base-10 forcing -- measured, it evaluates to 7766279631452241919 -- and a wide
# enough value wraps negative, making a real increase look like no change.
#
# Width bound matches validate_baseline's, so the two cannot drift.
is_comparable_count() {
  [[ "${1:-}" =~ ^(0|[1-9][0-9]*)$ ]] && [[ "${#1}" -le 6 ]]
}

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
      # C1, from the round-2 cross-family gate, and it is C-1 REPRODUCED INSIDE
      # THE FUNCTION WRITTEN TO CLOSE C-1. The old pattern accepted "08", which
      # awk reads as 8 but bash reads as octal -- and 08 is not octal, so
      # `[[ 9 -gt 08 ]]` throws "value too great for base". BOTH comparison arms
      # throw, both are therefore false, and with no `set -e` the run falls
      # through to "unchanged, at baseline". Measured: an 08 allowance against a
      # current 500 reported PASS (at baseline), exit 0.
      #
      # The width bound is the other half of the same defect: bash wraps past
      # 2^63, so a 20-digit allowance made a current 5 report as "improved".
      # Six digits is far above the 59 this baseline holds and far below where
      # wrapping begins.
      if ($1 !~ /^(0|[1-9][0-9]*)$/)    { bad = bad "\n  row " NR ": count is not a canonical non-negative integer -- no leading zeros, because bash reads 08 as octal and throws: " $1; next }
      if (length($1) > 6)               { bad = bad "\n  row " NR ": count has " length($1) " digits; a comparison that wide wraps silently in bash: " $1; next }
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

# Compare the current per-file counts against the baseline and decide the verdict.
# --------------------------------------------------------------------------
# `--update`, the RATCHET. Lives here for the same reason compare_to_baseline
# does -- the 500-line gate, not modularity. It reads and sets the caller's
# variables and exits the process itself: one script in two files.
#
# It may lower a count and drop a zeroed row. It may NOT add a row or raise an
# allowance (plan D-16), so a developer following the documented remedy cannot
# legitimize a regression.
apply_update_ratchet() {
  if [[ -f "$BASELINE" ]]; then
    REFUSALS=""
    while IFS=$'\t' read -r new_count new_path; do
      [[ -z "${new_path:-}" ]] && continue
      old_count="$(awk -F'\t' -v p="$new_path" '$2 == p {print $1}' "$BASELINE")"
      if [[ -z "$old_count" ]]; then
        REFUSALS+=$'\n'"  NEW FILE    $new_path ($new_count) -- not in the baseline"
      elif ! is_comparable_count "$new_count" || ! is_comparable_count "$old_count"; then
        # Round 3: this site reached arithmetic with no canonical check, so a
        # value that overflows base-10 forcing could make an increase look flat
        # and let the RATCHET raise an allowance. Same predicate as the
        # comparison path, so the two cannot drift.
        #
        # UNREACHABLE TODAY, and said plainly because dead safety code that reads
        # as live is its own defect. `validate_baseline` runs before this and
        # rejects a non-canonical or over-wide baseline count, so `old_count` is
        # always canonical here; `new_count` comes from `uniq -c`, which cannot
        # emit anything else. A red-test aimed at this arm was caught by the
        # validator first -- correctly. It stays because the validator is one
        # edit away from not running, and because the comparison path's identical
        # arm was unreachable by the same argument right up until C1 showed a
        # route through it.
        REFUSALS+=$'\n'"  UNCOMPARABLE $new_path (measured '$new_count' against baseline '$old_count')"
      elif [[ "$((10#$new_count))" -gt "$((10#$old_count))" ]]; then
        # 10#, per C1: without it an `08` allowance let the RATCHET raise a
        # count, which its own contract says it may not do.
        REFUSALS+=$'\n'"  INCREASED   $new_path ($old_count -> $new_count)"
      fi
    done < "$BY_FILE"
    if [[ -n "$REFUSALS" ]]; then
      VERDICT="REFUSED"
      finish
      say "--update REFUSED: a ratchet may only lower counts and drop zeroed rows.$REFUSALS"
      say ""
      say "If a baselined file was RENAMED, this is expected and the mechanism cannot tell"
      say "the difference (SMI-6704 R10). The rename report above names the missing old row;"
      say "edit the baseline deliberately and say so in the commit. Do not auto-accept."
      exit 1
    fi
  fi
  # M-5: validate and replace under a lock, then rename atomically. Without
  # this, two concurrent updates could each validate against allowance 5, write
  # 1 and 4 in either order, and leave the committed allowance RAISED to 4 while
  # both runs reported a successful ratchet.
  LOCK="$BASELINE.lock"
  if ! MKDIR_ERR="$(mkdir "$LOCK" 2>&1)"; then
    # `mkdir` fails for TWO reasons and they need opposite remedies. Measured
    # while red-testing the write path: with the directory read-only, mkdir fails
    # because it cannot create anything there, and the first version of this
    # branch reported "another --update holds $LOCK" and told the reader to remove
    # a lock that does not exist. The existence test is what separates them --
    # mkdir's own non-zero status cannot, since it is the same status for both.
    if [[ -d "$LOCK" ]]; then
      VERDICT="REFUSED (another --update holds $LOCK)"
      finish
      say "Another --update is in progress. If none is, remove $LOCK -- it holds no state."
    else
      VERDICT="REFUSED (cannot create the lock; baseline unchanged)"
      finish
      say "The lock could not be created and no lock is present, so this is not contention:"
      say "  $MKDIR_ERR"
      say "Check that $(dirname "$BASELINE") is writable and has free space, then re-run."
    fi
    exit 1
  fi
  # ONE release path, and it clears ownership BEFORE releasing.
  #
  # The previous version set `LOCK_HELD=1` here and released the lock with a bare
  # `rmdir` at each exit, with the trap as a backstop gated on that flag. The
  # round-3 cross-family gate found the hole, and it is a defect inside the fix
  # for the hole before it: the flag was never CLEARED, so after an explicit
  # release the trap still believed it owned a lock. Interleaving:
  #
  #   1. A acquires the lock.           4. A's EXIT trap fires, flag still set,
  #   2. A releases it explicitly.         and removes B's lock.
  #   3. B acquires the same lock.      5. C acquires while B is still writing.
  #
  # Two writers then pass the under-lock snapshot check independently and the
  # later write can restore a HIGHER allowance while both report success -- the
  # exact outcome the mutex exists to prevent, reintroduced by its own cleanup.
  #
  # So ownership is cleared first and the release happens in one function called
  # from every path, trap included. A release that FAILS keeps the flag clear but
  # is reported, because a lock that outlives its owner blocks the next run with
  # a message naming a file nobody can explain.
  LOCK_HELD=1
  release_lock() {
    [[ -z "${LOCK_HELD:-}" ]] && return 0
    LOCK_HELD=""
    # The RETURN STATUS is the signal. An earlier draft also set a
    # LOCK_STUCK variable that nothing read; shellcheck caught it.
    rmdir "$LOCK" 2>/dev/null
  }
  # Normal exit and any trappable termination. NOT SIGKILL, which runs nothing --
  # a lock surviving that is recovered by hand, and the refusal message says so.
  trap 'rm -f "$ALL_LIST" "$PROD_LIST" "$RAW_OUT" "$CLEAN_OUT" "$BY_FILE" \
        "${BASELINE_SNAPSHOT:-}" "$BASELINE.tmp.$$"
        release_lock || true
        true' EXIT
  # Re-read under the lock: the file may have changed since validation.
  if ! cmp -s "$BASELINE" "$BASELINE_SNAPSHOT"; then
    release_lock
    VERDICT="REFUSED (baseline changed during validation)"
    finish
    say "The baseline changed while this run was validating. Re-run."
    exit 1
  fi
  # The status of this write is CHECKED, and that is the whole point of the line.
  # Written first as `cp … && mv …` on its own: with no `set -e` a failed cp or mv
  # short-circuits the && and execution simply CONTINUES to the lines below, which
  # report "BASELINE UPDATED" and exit 0 over an untouched file. Found by sweeping
  # this script's own exit-0 paths -- the third instance in this work of a
  # discarded status producing a success report, after C-1 and the H-3 quoting
  # error. A full disk, a read-only tree or a perms change all take that branch.
  if ! cp "$BY_FILE" "$BASELINE.tmp.$$" || ! mv -f "$BASELINE.tmp.$$" "$BASELINE"; then
    rm -f "$BASELINE.tmp.$$"
    release_lock
    VERDICT="FAILED TO WRITE (baseline unchanged)"
    finish
    say "Could not write $BASELINE. It is UNCHANGED -- nothing was ratcheted."
    say "Check free space and that the tree is writable, then re-run."
    exit 1
  fi
  # A failed release must NOT report a successful ratchet: the write landed, but
  # the next run will refuse on a lock with no owner, so say so now.
  if ! release_lock; then
    VERDICT="BASELINE UPDATED, BUT THE LOCK COULD NOT BE RELEASED"
    finish
    say "The baseline was written. $LOCK could not be removed -- remove it by hand."
    exit 1
  fi
  VERDICT="BASELINE UPDATED"
  BASE_FIELD="$ERR_FILES files / $REPORTED errors (written)"
  finish
  exit 0
}

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
    # THE FALL-THROUGH IS THE MECHANISM BEHIND BOTH CRITICALS, so it is closed
    # structurally rather than by guarding its inputs again. C-1 (a duplicated
    # path making the count "5\\n5") and C1 (a leading zero read as octal) were
    # different inputs with one shape: an arithmetic comparison that THROWS is
    # FALSE, so two throwing arms both decline and execution reaches the benign
    # "unchanged, at baseline" branch. Measured on bash 3.2: $((10#abc)),
    # $((10#1e3)) and $((10#"5 6")) all throw, and $((10#)) on an empty string
    # quietly yields 0.
    #
    # The validator rejects every one of those on the committed side, which makes
    # this arm unreachable today. It is here because the NEXT unvalidated operand
    # -- a future generator, a hand-edit between validation and comparison -- must
    # fail loudly instead of passing quietly, and because an input guard protecting
    # a silent fall-through is one edit away from protecting nothing.
    elif ! is_comparable_count "$cur_count" || ! is_comparable_count "$base_count"; then
      NEW_ERRORS+=$'\n'"  UNCOMPARABLE $cur_path (measured '$cur_count' against baseline '$base_count')"
      NEW_FILES=$((NEW_FILES + 1))
    # 10# forces base 10 on both operands (C1). Belt and braces with the
    # validator's regex above and the arm immediately below: each guards a
    # different surface, and the comparison is only reached once both operands
    # are known canonical.
    elif [[ "$((10#$cur_count))" -gt "$((10#$base_count))" ]]; then
      NEW_ERRORS+=$'\n'"  INCREASED   $cur_path ($base_count -> $cur_count)"
    elif [[ "$((10#$cur_count))" -lt "$((10#$base_count))" ]]; then
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
