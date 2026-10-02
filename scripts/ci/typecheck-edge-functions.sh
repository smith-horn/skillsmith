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

# -P: deno reports PHYSICAL paths, so a logical pwd under a symlinked checkout
# would never match the prefix and every path would fail to reduce (m-1).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$REPO_ROOT" || exit 1

# shellcheck source=scripts/_lib.sh
source "$REPO_ROOT/scripts/_lib.sh"

# There is no `set -e`, so a failed source would NOT abort -- it would leave
# has_git_crypt_magic_header undefined, `if ! has_...` would take the false
# branch, and a git-crypt LOCKED tree would be labelled PLAINTEXT (m-5).
if ! declare -F has_git_crypt_magic_header >/dev/null; then
  printf '[edge-typecheck] FATAL: scripts/_lib.sh did not provide has_git_crypt_magic_header\n' >&2
  exit 1
fi

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

# M-1: validated against a closed set, because the `case` below has no
# default-deny and an unrecognised value fell through to the warn arm. Measured:
# `requried-ci` (one transposition) turned all six INCONCLUSIVE branches into
# exit 0. That made SETTING this variable strictly riskier than omitting it,
# since the auto-detected fallback is the safe one -- and nothing typechecks a
# string in YAML.
case "$CONTEXT" in
  required-ci | pre-deploy | fork-pr | local) ;;
  *)
    printf '[edge-typecheck] FATAL: unknown CONTEXT %s -- expected one of: required-ci pre-deploy fork-pr local\n' "$CONTEXT" >&2
    exit 1
    ;;
esac

# The output contract and exit policy live in a sibling, per the 500-line gate.
# shellcheck source=scripts/ci/typecheck-edge-functions.helpers.sh
source "$REPO_ROOT/scripts/ci/typecheck-edge-functions.helpers.sh"

if ! declare -F finish >/dev/null || ! declare -F exit_for_inconclusive >/dev/null \
  || ! declare -F resolve_partition >/dev/null || ! declare -F validate_baseline >/dev/null \
  || ! declare -F compare_to_baseline >/dev/null; then
  printf '[edge-typecheck] FATAL: helpers did not load\n' >&2
  exit 1
fi

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
  NEXT_ACTION="expected on a fork PR (no GIT_CRYPT_KEY). Wave 5's pre-deploy arm is the backstop. If this fires on an internal PR, the unlock step failed -- investigate that."
  # H-4: this used to warn in EVERY context, which the cross-family gate called
  # unsafe and it was right. Key presence is not proof that an invocation is a
  # fork, one mutable sentinel decided the outcome before any file was checked,
  # and the job set `required-ci` unconditionally -- forks included -- so the
  # carve-out was reachable exactly where it must not be.
  #
  # Ciphertext is now tolerated ONLY under `fork-pr`, and CI selects that context
  # from GitHub's own event metadata (`pull_request.head.repo.fork`) rather than
  # from anything this script can observe. Under required-ci or pre-deploy a
  # locked tree means the unlock step failed, which is a real fault.
  if [[ "$CONTEXT" == "fork-pr" ]]; then
    # Caught by reading the plan's own P-4 row 6 against this implementation: a
    # fork PR runs in GitHub Actions, so CONTEXT auto-resolves to `required-ci` --
    # and the job set it explicitly anyway -- which would have failed the gate on
    # EVERY external contribution. A fork has no GIT_CRYPT_KEY by design, so this
    # is not a degraded environment to fail closed on; it is the one case where
    # "cannot run" is structurally true and unfixable by the contributor.
    NEXT_ACTION="nothing for the contributor to do -- a fork has no GIT_CRYPT_KEY by design. Wave 5's pre-deploy arm is the backstop for code that arrives this way."
  else
    NEXT_ACTION="a locked tree in context '$CONTEXT' means the git-crypt unlock failed -- investigate that. Only fork-pr tolerates ciphertext, and CI selects it from the event payload."
  fi
  # Ciphertext is the ONE cause marked tolerable on a fork, so that decision lives
  # in exit_for_inconclusive's own matrix rather than in an inline `exit 0` here --
  # an inline exit is how the pre-H-4 version came to override every context at
  # once. Tolerating it cannot mask a real failure where it matters: both deploy
  # jobs carry a `Verify git-crypt key present` step that hard-fails when the key
  # is absent, so the tree is never ciphertext in the pre-deploy context.
  exit_for_inconclusive --tolerated-on-fork
fi
CRYPT_STATE="PLAINTEXT"

# ---------------------------------------------------------------------------
# Discovery. I-3: an empty glob exits 0, so a zero denominator is a broken
# discovery rather than a clean tree, and must be loud.
# ---------------------------------------------------------------------------
ALL_LIST="$(mktemp)"; PROD_LIST="$(mktemp)"; RAW_OUT="$(mktemp)"
trap 'rm -f "$ALL_LIST" "$PROD_LIST" "$RAW_OUT"' EXIT

# H-3: `-name '*.ts'` alone left a .tsx production file invisible -- not
# discovered, not checked, and perfectly consistent with the committed
# partition, so the gate would report PASS over an unchecked deployed file.
# Deno accepts .ts, .tsx, .mts and .cts, so all four are discovered. If a
# future Deno adds another, the assertion below is what catches it rather than
# silence.
find supabase/functions \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \) \
  -type f 2>/dev/null | sort > "$ALL_LIST"

# Assert there is no OTHER TypeScript-ish extension we are silently skipping.
#
# The exclusion list is DERIVED from running this probe against the committed tree,
# not guessed: `*.ts?` matches `typecheck-baseline.tsv` -- this gate's own baseline
# -- so without `tsv` here the probe reports a finding on every clean run. It did,
# and only a known-negative control showed it: the first version of this line had a
# quoting error that made the command substitution fail, leaving UNKNOWN_TS empty,
# so the assertion silently passed and the false positive stayed invisible. Two
# defects, one masking the other, in the code written to make silence impossible.
UNKNOWN_TS="$(find supabase/functions -type f \( -name '*.ts?' -o -name '*.?ts' \) \
  2>/dev/null | grep -vE '\.(ts|tsx|mts|cts|tsv)$')"
if [[ -n "$UNKNOWN_TS" ]]; then
  # Captured in full, truncated only for display -- a `head` on the capture would
  # have decided the verdict from a truncated set, and also closed the pipe early.
  UNKNOWN_N="$(printf '%s\n' "$UNKNOWN_TS" | grep -c .)"
  inconclusive "$UNKNOWN_N unrecognised TypeScript-like extension(s) under supabase/functions"
  say "--- not covered by the discovery glob (showing up to 20 of $UNKNOWN_N) ---"
  printf '%s\n' "$UNKNOWN_TS" | head -20
  NEXT_ACTION="extend the discovery glob, or confirm these are not deployed. An undiscovered file is an unchecked file."
  exit_for_inconclusive
fi
DISCOVERED="$(wc -l < "$ALL_LIST" | tr -d ' ')"

# I-3 FIRST, before anything derived from the file list. Measured: when the find
# expression matched nothing, the PARTITION check fired first and reported
# "exclusion list disagrees" -- so this arm, which exists specifically so the
# empty-denominator case ships observed (plan P-4 row 3), was unreachable. Still
# exit 1 either way, but the diagnosis named the wrong cause, and a dead arm is
# not an observed one.
#
# An empty glob makes bare `deno check` exit 0, so a zero denominator must never
# read as a clean tree.
if [[ "$DISCOVERED" -eq 0 ]]; then
  inconclusive "zero .ts files discovered under supabase/functions"
  NEXT_ACTION="the discovery glob is broken, or the tree moved. This is NOT a clean result."
  exit_for_inconclusive
fi

# The partition is resolved by a helper, per the 500-line gate. It sets EXCLUDED,
# CHECKED and PROD_LIST, and exits non-zero itself if the committed and detected
# partitions disagree -- see resolve_partition() for why that is a VERDICT and not
# an inconclusive result.
resolve_partition


# ---------------------------------------------------------------------------
# The check. Config and package discovery are both pinned explicitly: measured
# 2026-10-02, deno's config discovery is CWD-RELATIVE, so placing deno.json at
# supabase/ does nothing for a run from the repo root, which is where CI runs.
# Each control is independently sufficient; both are set because they fail
# independently (a renamed path breaks one, a discovery-precedence change the
# other).
# ---------------------------------------------------------------------------
# Lockfile policy (plan H-2). A CHECK MUST NOT WRITE. `deno check --lock <path>`
# without `--frozen` *updates* the lockfile when it disagrees with the real import
# graph, which would leave a tracked file modified after a read-only gate run --
# a dirty tree in CI, and an unexplained ~150-line diff for a developer running
# this locally for the first time.
#
# So the default is `--no-lock`: no lockfile is read and none can be written. That
# gives up reproducibility, which is a real cost and is why H-2 asked for a
# lockfile model rather than silence. The honest position today is that
# `supabase/deno.lock` does not cover the full edge-function import graph (a known
# follow-on), so pinning against it would verify almost nothing while risking a
# write.
#
# `SKILLSMITH_EDGE_TYPECHECK_FROZEN=1` switches to `--lock <path> --frozen`, which
# is read-only by construction -- it ERRORS on a stale lock rather than rewriting
# it. That is the intended end state once the lock is regenerated, and it is the
# only lock mode this gate will ever run in, because it is the only one that
# cannot mutate the tree.
#
# Not attributed, stated as unknown: a modified `supabase/deno.lock` and a stray
# root `deno.lock` were observed in this worktree during development. Re-running
# this gate against a restored lockfile does NOT reproduce either, so the cause is
# not established and is not being guessed at. `--no-lock` removes the question.
if [[ -n "${SKILLSMITH_EDGE_TYPECHECK_FROZEN:-}" ]]; then
  LOCK_ARGS=(--lock supabase/deno.lock --frozen)
  LOCK_MODE="frozen (--lock supabase/deno.lock --frozen; read-only, errors on stale)"
else
  LOCK_ARGS=(--no-lock)
  LOCK_MODE="no-lock (cannot read or write a lockfile; see H-2 for why)"
fi

# Paths are passed via an array, not an unquoted $(cat), which would word-split a
# path containing a space (m-2). Measured: 0 of 363 paths contain a space or a glob
# metachar today, so this is latent -- fixed because "latent" means "until someone
# adds one".
#
# Built with a read loop rather than `mapfile`: mapfile is a bash-4 builtin and
# macOS ships bash 3.2 as /bin/bash. Measured -- the mapfile form died with
# "mapfile: command not found" on every local run while working in CI's bash 4,
# i.e. it broke exactly the environment a developer uses and left CI looking
# healthy. Worse, it crashed BEFORE the report, so three red-test cases exited 1
# for the wrong reason and had to be re-run; a kill only counts when it is
# attributable to the mutation (SMI-6932).
PROD_PATHS=()
while IFS= read -r _p; do
  PROD_PATHS+=("$_p")
done < "$PROD_LIST"
DENO_NO_PACKAGE_JSON=1 deno check --config "$CONFIG" "${LOCK_ARGS[@]}" \
  "${PROD_PATHS[@]}" > "$RAW_OUT" 2>&1
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
# M-3: under --frozen a stale lock produces neither a graph error nor a type
# total, and was being reported as "the parser may need updating". Its own arm,
# with its own next action.
if grep -qiE "lockfile|lock file|out of date|--frozen" "$CLEAN_OUT" \
  && ! grep -qE '^TS[0-9]+ \[ERROR\]' "$CLEAN_OUT"; then
  inconclusive "lockfile is stale or incomplete under --frozen"
  say "--- lockfile diagnostic ---"; grep -iE "lockfile|lock file|out of date" "$CLEAN_OUT" | head -5
  NEXT_ACTION="regenerate supabase/deno.lock, or unset SKILLSMITH_EDGE_TYPECHECK_FROZEN. This is NOT a type error and NOT a parser bug."
  exit_for_inconclusive
fi
# Patterns taken from deno 2.3.6's real output, not guessed (plan P-4 row 7).
# Note "error sending request" is INDENTED under its parent line, so this is
# deliberately unanchored.
if grep -qiE "(^error: (Failed loading|Download failed)|error sending request for url|connection refused|dns error|Import .* failed)" "$CLEAN_OUT"; then
  inconclusive "remote module fetch failed"
  NEXT_ACTION="a CDN or network failure. This is NOT a clean tree -- re-run, or fix the lockfile."
  exit_for_inconclusive
fi

# Deno prints no "Found N errors" line when there are none.
# M-2, measured on the exact CI pin: deno prints `Found 2 errors.` for two but
# NO "Found" line at all for ONE. So a tree with a single remaining error --
# precisely this gate's success condition as the baseline burns down -- fell into
# "no parseable error total" and told the developer the parser was broken.
# Invisible to the Wave-1 red-tests because 59 pre-existing errors guarantee the
# total exceeds 1 today. Count headers before declaring the output unparseable.
REPORTED="$(grep -oE 'Found [0-9]+ error' "$CLEAN_OUT" | grep -oE '[0-9]+' | tail -1)"
# H-2, and this is a defect my OWN M-2 fix introduced. Deriving REPORTED from
# the header count makes it the same quantity attribution is derived from, so
# reconciliation stops being independent and becomes self-referential. Round 2
# had reasoned that truncation is safe because `Found N errors.` is the last
# line, so losing it routes to "unparseable". The cross-family gate inverted
# that: losing the total ACTIVATES the self-reconciling fallback, so a truncated
# run whose surviving header/location pairs are complete reconciles perfectly
# and can pass if the prefix sits inside baseline allowances.
#
# So the fallback is narrowed to the ONE measured Deno special case it exists
# for: exactly one error header, with the exit status a type error produces.
# Two or more headers and no total means truncation or changed wording, and
# that is inconclusive rather than counted.
if [[ -z "$REPORTED" ]]; then
  HEADER_COUNT="$(grep -cE '^TS[0-9]+ \[ERROR\]' "$CLEAN_OUT")"
  if [[ "$HEADER_COUNT" -eq 1 && "$DENO_RC" -eq 1 ]]; then
    # Measured on deno 2.3.6: one error prints no "Found" line; two print
    # "Found 2 errors.". This is that case and only that case.
    REPORTED=1
  elif [[ "$HEADER_COUNT" -gt 1 ]]; then
    inconclusive "$HEADER_COUNT error headers but no reported total -- output truncated, or deno's wording changed"
    NEXT_ACTION="do NOT trust a count derived from the headers alone; it would reconcile against itself. Re-run, or update the parser for this deno version."
    say "--- raw tail ---"; tail -20 "$CLEAN_OUT"
    exit_for_inconclusive
  elif [[ "$DENO_RC" -eq 0 ]]; then
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
trap 'rm -f "$ALL_LIST" "$PROD_LIST" "$RAW_OUT" "$CLEAN_OUT" "$BY_FILE" "${BASELINE_SNAPSHOT:-}"' EXIT
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
  ERR_FIELD="$REPORTED total / $ATTRIB attributed across $ERR_FILES files   [MISMATCH]"
  inconclusive "attribution ($ATTRIB) does not reconcile with the reported total ($REPORTED)"
  NEXT_ACTION="the output parser is wrong for this deno version. Do NOT trust the per-file numbers. Raw output retained above."
  say "--- raw tail, for the parser fix ---"; tail -20 "$CLEAN_OUT"
  exit_for_inconclusive
fi
ERR_FIELD="$REPORTED total / $ATTRIB attributed across $ERR_FILES files   [RECONCILED]"

# ---------------------------------------------------------------------------
# --update: a RATCHET, not a rewrite (plan D-16). It may lower a count and drop
# a zeroed row. It may NOT add a row or raise an allowance -- a developer
# following the documented remedy must not be able to legitimize a regression.
# ---------------------------------------------------------------------------
# C-1: VALIDATE the baseline before it is compared against or rewritten. A
# duplicated path made awk return two numbers, both numeric comparisons threw an
# arithmetic error, and with no `set -e` the run continued and reached PASS -- so a
# duplicate row could hide any number of new errors in that file. Validation also
# catches a zeroed row kept instead of deleted, an absolute path, an unsorted file,
# and a path that is no longer in the checked set (deleted, renamed, or newly
# excluded -- the shape that otherwise reads as an "improvement").
BASELINE_SNAPSHOT="$(mktemp)"
if [[ -f "$BASELINE" ]]; then
  cp "$BASELINE" "$BASELINE_SNAPSHOT"
  if ! validate_baseline "$BASELINE" "$PROD_LIST"; then
    VERDICT="FAIL (baseline malformed)"
    BASE_FIELD="$(wc -l < "$BASELINE" | tr -d ' ') rows -- REJECTED"
    finish
    say "The baseline is not a valid ratchet file, so no comparison against it can be trusted:"
    printf '%s\n' "$BASELINE_BAD"
    say ""
    say "Fix the rows above. This refuses rather than guessing, because the specific"
    say "failure this check exists for -- a DUPLICATE path -- silently suppressed real"
    say "regressions by making both numeric comparisons error out."
    exit 1
  fi
fi

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
  # M-5: validate and replace under a lock, then rename atomically. Without
  # this, two concurrent updates could each validate against allowance 5, write
  # 1 and 4 in either order, and leave the committed allowance RAISED to 4 while
  # both runs reported a successful ratchet.
  LOCK="$BASELINE.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    VERDICT="REFUSED (another --update holds $LOCK)"
    finish
    say "Another --update is in progress. If none is, remove $LOCK -- it holds no state."
    exit 1
  fi
  # Re-read under the lock: the file may have changed since validation.
  if ! cmp -s "$BASELINE" "$BASELINE_SNAPSHOT"; then
    rmdir "$LOCK"
    VERDICT="REFUSED (baseline changed during validation)"
    finish
    say "The baseline changed while this run was validating. Re-run."
    exit 1
  fi
  cp "$BY_FILE" "$BASELINE.tmp.$$" && mv -f "$BASELINE.tmp.$$" "$BASELINE"
  rmdir "$LOCK"
  VERDICT="BASELINE UPDATED"
  BASE_FIELD="$ERR_FILES files / $REPORTED errors (written)"
  finish
  exit 0
fi

# ---------------------------------------------------------------------------
# Compare against the baseline. The ratchet BLOCKS: no continue-on-error.
# ---------------------------------------------------------------------------
# The comparison and its verdicts live in the helper, per the 500-line gate. It
# exits the process itself.
compare_to_baseline
