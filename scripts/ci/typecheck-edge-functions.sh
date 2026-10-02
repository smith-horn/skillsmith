#!/usr/bin/env bash
# typecheck-edge-functions.sh -- SMI-6897. Typecheck supabase/functions/** with
# `deno check`, in the runtime that actually runs those files.
#
# WHY THIS EXISTS: nothing else checks this tree. `tsc` compiles zero files there
# (root tsconfig has "files": [] and references only the four packages), eslint
# ignores it outright (eslint.config.js globalIgnores), and there was no checker
# in CI. Vitest was the only gate over licence issuance, entitlement resolution
# and webhook handling -- all of which deploy to production on merge to main. A
# synchronous TypeError in the Stripe checkout webhook lived there ~6.5 months
# (SMI-6907) and was found only when a deno check was run by hand.
#
# Invoked as `bash scripts/ci/typecheck-edge-functions.sh`, so it does NOT
# inherit -e from the calling step and sets its own flags.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 1

# shellcheck source=scripts/_lib.sh
source "$REPO_ROOT/scripts/_lib.sh"

CONFIG="supabase/deno.json"
BASELINE="supabase/functions/typecheck-baseline.tsv"
CRYPT_SENTINEL="supabase/functions/_shared/cors.ts"
MODE="${1:-check}" # check | --update

# ---------------------------------------------------------------------------
# Context, which decides whether an inconclusive result is fatal (plan C-3).
#
#   required-ci : a merge depends on this. Inconclusive is FATAL.
#   pre-deploy  : a production deploy depends on this. Inconclusive is FATAL.
#   fork-pr     : the plaintext is unavailable and the check CANNOT run.
#                 Inconclusive is a warning, because "could not run" is honest
#                 there and failing would block every external contributor.
#   local       : a developer's machine. Inconclusive warns.
#
# "not checked" is never "safe". The only context where inconclusive is tolerated
# is the one where the check is structurally unable to run at all.
# ---------------------------------------------------------------------------
CONTEXT="${SKILLSMITH_EDGE_TYPECHECK_CONTEXT:-}"
if [[ -z "$CONTEXT" ]]; then
  if [[ -n "${SKILLSMITH_EDGE_TYPECHECK_PREDEPLOY:-}" ]]; then
    CONTEXT="pre-deploy"
  elif [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    CONTEXT="required-ci"
  else
    CONTEXT="local"
  fi
fi

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
    *)
      say "WARNING: the check could not run. Not fatal in context '$CONTEXT'."
      exit 0
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
if ! command -v deno >/dev/null 2>&1; then
  inconclusive "deno not on PATH"
  NEXT_ACTION="install Deno (denoland/setup-deno in CI; brew install deno locally)"
  exit_for_inconclusive
fi
DENO_VERSION="$(deno --version 2>/dev/null | head -1)"

if [[ ! -f "$CONFIG" ]]; then
  inconclusive "missing $CONFIG"
  NEXT_ACTION="restore $CONFIG -- without it deno falls back to the root package.json and reports phantom errors"
  exit_for_inconclusive
fi

# git-crypt: on a fork PR there is no key, so this tree is ciphertext and deno
# aborts with "The module's source code could not be parsed". That is a genuine
# cannot-run, not a clean tree -- the distinction I-4 exists for.
if has_git_crypt_magic_header "$CRYPT_SENTINEL"; then
  CRYPT_STATE="CIPHERTEXT"
  inconclusive "tree is git-crypt locked; deno cannot parse it"
  NEXT_ACTION="unlock git-crypt, or accept that fork PRs cannot run this check (pre-deploy is the backstop)"
  exit_for_inconclusive
fi
CRYPT_STATE="PLAINTEXT"

# ---------------------------------------------------------------------------
# Discovery. I-3: an empty glob exits 0, so a zero denominator is a broken
# discovery rather than a clean tree, and must be loud.
# ---------------------------------------------------------------------------
ALL_LIST="$(mktemp)"; PROD_LIST="$(mktemp)"; RAW_OUT="$(mktemp)"
trap 'rm -f "$ALL_LIST" "$PROD_LIST" "$RAW_OUT"' EXIT

find supabase/functions -name '*.ts' -type f 2>/dev/null | sort > "$ALL_LIST"
DISCOVERED="$(wc -l < "$ALL_LIST" | tr -d ' ')"

# Partition on "imports vitest", not on a filename pattern: one test file is not
# named *.test.ts (I-1's sibling finding). Both quote styles and a bare
# `import 'vitest'` are recognised -- review flagged that matching only the
# single-quoted `from 'vitest'` form is an assumption about repo convention.
: > "$PROD_LIST"
EXCLUDED=0
while IFS= read -r f; do
  if grep -qE "(from|import)[[:space:]]+['\"]vitest['\"]" "$f" 2>/dev/null; then
    EXCLUDED=$((EXCLUDED + 1))
  else
    printf '%s\n' "$f" >> "$PROD_LIST"
  fi
done < "$ALL_LIST"
CHECKED="$(wc -l < "$PROD_LIST" | tr -d ' ')"

if [[ "$DISCOVERED" -eq 0 || "$CHECKED" -eq 0 ]]; then
  inconclusive "zero files to check (discovered=$DISCOVERED checked=$CHECKED)"
  NEXT_ACTION="the discovery glob is broken, or the tree moved. This is NOT a clean result."
  exit_for_inconclusive
fi

# ---------------------------------------------------------------------------
# The check. Config and package discovery are both pinned explicitly: measured
# 2026-10-02, deno's config discovery is CWD-RELATIVE, so placing deno.json at
# supabase/ does nothing for a run from the repo root, which is where CI runs.
# Each control is independently sufficient; both are set because they fail
# independently (a renamed path breaks one, a discovery-precedence change the
# other).
# ---------------------------------------------------------------------------
# Lockfile policy (plan H-2). `--lock` is explicit so the gate can never silently
# fall back to auto-discovery, and `--frozen` is opt-in via the env var rather
# than hardcoded: `supabase/deno.lock` is currently INCOMPLETE (it does not cover
# the full edge-function import graph -- a known follow-on), so turning --frozen
# on before that is fixed would fail every run for a reason unrelated to types.
# Set SKILLSMITH_EDGE_TYPECHECK_FROZEN=1 to require a current lock, which is the
# intended end state once the lock is regenerated.
LOCK_ARGS=(--lock supabase/deno.lock)
if [[ -n "${SKILLSMITH_EDGE_TYPECHECK_FROZEN:-}" ]]; then
  LOCK_ARGS+=(--frozen)
  LOCK_MODE="frozen (--lock supabase/deno.lock --frozen)"
else
  LOCK_MODE="unfrozen (--lock supabase/deno.lock; lock is incomplete -- see H-2)"
fi

# shellcheck disable=SC2046
DENO_NO_PACKAGE_JSON=1 deno check --config "$CONFIG" "${LOCK_ARGS[@]}" \
  $(cat "$PROD_LIST") > "$RAW_OUT" 2>&1
DENO_RC=$?

CLEAN_OUT="$(mktemp)"; trap 'rm -f "$ALL_LIST" "$PROD_LIST" "$RAW_OUT" "$CLEAN_OUT"' EXIT
perl -pe 's/\e\[[0-9;]*m//g' "$RAW_OUT" > "$CLEAN_OUT"

# I-4: a module-graph or parser failure is NOT a low error count. Separate it
# from type diagnostics before counting anything.
if grep -qiE "^error: (Relative import|Module not found|The module|Expected|Import assertion)" "$CLEAN_OUT"; then
  inconclusive "module graph or parser failure"
  say "--- graph errors ---"
  grep -iE "^error: " "$CLEAN_OUT" | head -10
  NEXT_ACTION="resolve the graph error; the type-error count below would be meaningless"
  exit_for_inconclusive
fi
if grep -qiE "^error: (Download failed|error sending request|Import .* failed)" "$CLEAN_OUT"; then
  inconclusive "remote module fetch failed"
  NEXT_ACTION="a CDN or network failure. This is NOT a clean tree -- re-run, or fix the lockfile."
  exit_for_inconclusive
fi

# Deno prints no "Found N errors" line when there are none.
REPORTED="$(grep -oE 'Found [0-9]+ error' "$CLEAN_OUT" | grep -oE '[0-9]+' | tail -1)"
if [[ -z "$REPORTED" ]]; then
  if [[ "$DENO_RC" -eq 0 ]]; then
    REPORTED=0
  else
    inconclusive "deno exited $DENO_RC with no parseable error total"
    say "--- raw tail ---"; tail -20 "$CLEAN_OUT"
    NEXT_ACTION="unrecognised deno output -- the parser may need updating for this deno version"
    exit_for_inconclusive
  fi
fi

# I-5, measured five times and the most reliable failure on this surface: a
# derived count that looks credible and is wrong. Take the FIRST location per
# error header -- five blocks carry a second "the expected type comes from" line,
# and counting locations instead of errors over-reports.
BY_FILE="$(mktemp)"
trap 'rm -f "$ALL_LIST" "$PROD_LIST" "$RAW_OUT" "$CLEAN_OUT" "$BY_FILE"' EXIT
# Paths are made relative by stripping the KNOWN repo root, not by matching a
# repo name. Measured 2026-10-02: a `.*/skillsmith/` strip yields
# `supabase/...` in a plain checkout but `.worktrees/<name>/supabase/...` in a
# worktree, so the committed baseline would be environment-dependent and CI
# would read all 22 baselined files as new. The baseline must be byte-identical
# wherever it is generated.
awk -v root="$REPO_ROOT/" '
  /^TS[0-9]+ \[ERROR\]/ { want = 1; next }
  want && /^[[:space:]]+at file:\/\// {
    line = $0
    sub(/^[[:space:]]+at file:\/\//, "", line)
    sub(/:[0-9]+:[0-9]+$/, "", line)
    if (index(line, root) == 1) line = substr(line, length(root) + 1)
    print line
    want = 0
  }
' "$CLEAN_OUT" | sort | uniq -c | awk '{print $1"\t"$2}' | sort -k2,2 > "$BY_FILE"

# Any path that did not reduce to a repo-relative one is a bug in the stripping,
# not a file outside the repo: every entry in PROD_LIST came from a repo-relative
# find. Fail loudly rather than commit an absolute path into a shared baseline.
if grep -qE $'\t''/' "$BY_FILE"; then
  inconclusive "an error path did not reduce to repo-relative"
  say "--- offending rows ---"; grep -E $'\t''/' "$BY_FILE" | head -5
  NEXT_ACTION="the REPO_ROOT prefix strip failed; a baseline written now would not match CI"
  exit_for_inconclusive
fi

ATTRIB="$(awk -F'\t' '{s += $1} END {print s + 0}' "$BY_FILE")"
ERR_FILES="$(wc -l < "$BY_FILE" | tr -d ' ')"

# HARD FAIL, not a warning (plan review). This assertion is the only thing that
# has ever caught a wrong attribution here; two of five wrong derivations looked
# entirely plausible and only arithmetic against deno's own total exposed them.
if [[ "$ATTRIB" -ne "$REPORTED" ]]; then
  ERR_LINE="$REPORTED total / $ATTRIB attributed across $ERR_FILES files   [MISMATCH]"
  inconclusive "attribution ($ATTRIB) does not reconcile with the reported total ($REPORTED)"
  NEXT_ACTION="the output parser is wrong for this deno version. Do NOT trust the per-file numbers. Raw output retained above."
  say "--- raw tail, for the parser fix ---"; tail -20 "$CLEAN_OUT"
  exit_for_inconclusive
fi
ERR_LINE="$REPORTED total / $ATTRIB attributed across $ERR_FILES files   [RECONCILED]"

# ---------------------------------------------------------------------------
# --update: a RATCHET, not a rewrite (plan D-16). It may lower a count and drop
# a zeroed row. It may NOT add a row or raise an allowance -- a developer
# following the documented remedy must not be able to legitimize a regression.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "--update" ]]; then
  if [[ -f "$BASELINE" ]]; then
    REFUSALS=""
    while IFS=$'\t' read -r new_count new_path; do
      [[ -z "${new_path:-}" ]] && continue
      old_count="$(awk -F'\t' -v p="$new_path" '$2 == p {print $1}' "$BASELINE")"
      if [[ -z "$old_count" ]]; then
        REFUSALS+=$'\n'"  NEW FILE    $new_path ($new_count) -- not in the baseline"
      elif [[ "$new_count" -gt "$old_count" ]]; then
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
  cp "$BY_FILE" "$BASELINE"
  VERDICT="BASELINE UPDATED"
  BASE_LINE="$ERR_FILES files / $REPORTED errors (written)"
  finish
  exit 0
fi

# ---------------------------------------------------------------------------
# Compare against the baseline. The ratchet BLOCKS: no continue-on-error.
# ---------------------------------------------------------------------------
if [[ ! -f "$BASELINE" ]]; then
  BASE_LINE="absent"
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
BASE_LINE="$BASE_FILES files / $BASE_TOTAL errors"

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

DELTA_LINE="$NEW_FILES newly-failing files / $(printf '%s' "$NEW_ERRORS" | grep -c . || true) regressions"

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
