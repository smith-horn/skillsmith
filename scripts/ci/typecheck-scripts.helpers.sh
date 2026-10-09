#!/usr/bin/env bash
# typecheck-scripts.helpers.sh -- SMI-6975 follow-up (cross-family pre-merge
# review of PR #3022). The output contract, exit policy, temp-file handling,
# and the non-test scripts/ file inventory/classification for
# scripts/ci/typecheck-scripts.sh.
#
# Split out when the main script crossed the 500-line pre-commit gate,
# following the scripts/ci convention set by typecheck-edge-functions.sh /
# typecheck-edge-functions.helpers.sh. Sourced, not executed: every function
# here reads/writes variables the caller sets, by design -- this is one
# script in two files, not a library.
#
# shellcheck shell=bash

say() { printf '%s\n' "$*"; }
field() { printf '  %-14s %s\n' "$1" "$2"; }

# RESULT answers "did the check produce a usable answer"; VERDICT answers "is
# the code clean". Conflating them is how a checker that never ran gets
# recorded as a checker that found nothing (SMI-6684's STATE/CAUSE split).
RESULT="EVALUATED"
VERDICT=""
INCONCLUSIVE_WHY=""
NEXT_ACTION=""

inconclusive() {
  RESULT="INCONCLUSIVE"
  INCONCLUSIVE_WHY="$1"
}

finish() {
  say ""
  say "[scripts-typecheck] SMI-6975"
  field "config" "$CONFIG"
  field "tsc" "${TSC_VERSION:-unknown}"
  # A substituted compiler (test seam) is never silent: a PASS from a stub must
  # be visibly a PASS from a stub.
  [[ -n "${TSC_BIN:-}" && "$TSC_BIN" != "${TSC_BIN_DEFAULT:-}" ]] && field "tsc binary" "$TSC_BIN (SUBSTITUTED via SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST)"
  # Four numbers, printed SEPARATELY, never collapsed into one (finding 1/2).
  # A plausible "263 files / PASS" proves nothing on its own -- it looks
  # identical whether tsc read the same include set this shell counted, or a
  # different one entirely.
  field "discovered" "${DISCOVERED:-?} (ts-family inventory under scripts/**, excluding scripts/tests/** and BLOCKED paths -- see 'excluded')"
  field "compiler roots" "${COMPILER_ROOTS:-?} (tsc --showConfig's own resolved files[])"
  field "checked" "${CHECKED:-?} (only set once discovered == compiler roots)"
  field "excluded" "${EXCLUDED_DESC:-?}"
  [[ -n "${ERR_FIELD:-}" ]] && field "errors" "$ERR_FIELD"
  field "RESULT" "$RESULT${INCONCLUSIVE_WHY:+ -- $INCONCLUSIVE_WHY}"
  field "VERDICT" "${VERDICT:-NONE}"
  [[ -n "$NEXT_ACTION" ]] && say "  next: $NEXT_ACTION"
  say ""
}

# No CONTEXT axis (see the main script's header). "Not checked" is not
# "safe" -- an INCONCLUSIVE result always exits non-zero, matching the
# plan's checklist item verbatim.
exit_for_inconclusive() {
  finish
  say "FATAL: the check could not run, or could not be trusted. \"Not checked\" is not \"safe\"."
  exit 1
}

# Only a whole number of seconds in 1..86400 is a usable budget. The digit
# count is capped BEFORE any arithmetic: perl's alarm() wraps at 2**32 (so
# 4294967296 arms no alarm at all) and rejects 2**31 and above, i.e. an
# oversized value would silently switch the bound off.
validate_timeout_secs() {
  if ! [[ "$TSC_TIMEOUT_SECS" =~ ^[1-9][0-9]{0,4}$ ]] || [[ "$TSC_TIMEOUT_SECS" -gt 86400 ]]; then
    inconclusive "SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS='$TSC_TIMEOUT_SECS' is not a whole number of seconds in 1..86400"
    NEXT_ACTION="unset SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS or set it to a whole number of seconds between 1 and 86400"
    exit_for_inconclusive
  fi
}

# Test-only seam: lets the suite substitute a stub compiler. It is honoured
# ONLY under vitest (VITEST=true), because a stub that passes --version and
# --showConfig through and exits 0 for the compile turns the gate into a
# silent PASS. Anywhere else it is ignored with a stderr line, and any
# honoured substitution is printed by finish().
resolve_tsc_bin() {
  TSC_BIN_DEFAULT="$REPO_ROOT/node_modules/.bin/tsc"
  TSC_BIN="$TSC_BIN_DEFAULT"
  [[ -n "${SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST:-}" ]] || return 0
  if [[ "${VITEST:-}" == "true" ]]; then
    TSC_BIN="$SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST"
  else
    printf '[scripts-typecheck] SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST ignored: it is honoured only under vitest (VITEST=true)\n' >&2
  fi
}

# Runs "$@" under a perl alarm of $TSC_TIMEOUT_SECS. perl, not coreutils
# `timeout`: stock macOS (where pre-commit runs) has neither `timeout` nor
# `gtimeout`, while /usr/bin/perl exists on macOS and in the Linux container/CI.
# The alarm survives exec, so SIGALRM terminates the command itself and the
# shell reports 142 (128+14); 127 means exec failed. SIGALRM is reset to its
# default AND unblocked first: an inherited SIG_IGN (a parent's `trap '' ALRM`)
# or an inherited blocked mask both survive exec and would otherwise make the
# alarm a no-op, silently losing the bound.
run_bounded() {
  /usr/bin/perl -e 'use POSIX (); $SIG{ALRM}="DEFAULT"; POSIX::sigprocmask(POSIX::SIG_UNBLOCK(), POSIX::SigSet->new(POSIX::SIGALRM())); alarm shift; exec @ARGV or exit 127' "$TSC_TIMEOUT_SECS" "$@"
}

# INCONCLUSIVE when a run_bounded call (status $1) was killed by the alarm;
# $2 names which call, so the cause is not just "tsc".
exit_if_bounded_timeout() {
  [[ "$1" -eq 142 ]] || return 0
  inconclusive "$2 did not finish within ${TSC_TIMEOUT_SECS}s (killed by SIGALRM, exit 142) -- timeout"
  NEXT_ACTION="the compiler hung or the host is badly overloaded; re-run, or raise SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS (max 86400) if the tree legitimately grew"
  exit_for_inconclusive
}

# tsc present, executable and recognisable; sets TSC_VERSION. Output goes to a
# file, not a command substitution: a hung stub's orphaned child would hold a
# substitution's pipe open past the alarm.
check_tsc_ready() {
  if [[ ! -x "$TSC_BIN" ]]; then
    inconclusive "tsc not found or not executable at $TSC_BIN"
    NEXT_ACTION="npm install from the HOST in the main checkout (never inside a worktree container's node_modules, which is read-only by design)"
    exit_for_inconclusive
  fi
  mktemp_or_die TSC_VERSION_OUT
  run_bounded "$TSC_BIN" --version >"$TSC_VERSION_OUT" 2>&1
  local rc=$?
  exit_if_bounded_timeout "$rc" "tsc --version"
  if [[ "$rc" -ne 0 ]] || ! grep -qE '^Version [0-9]+\.[0-9]+\.[0-9]+' "$TSC_VERSION_OUT"; then
    inconclusive "tsc --version produced no recognisable version string"
    say "--- raw ---"
    head -5 "$TSC_VERSION_OUT"
    NEXT_ACTION="confirm $TSC_BIN is a real, uncorrupted TypeScript compiler"
    exit_for_inconclusive
  fi
  TSC_VERSION="$(head -1 "$TSC_VERSION_OUT")"
}

# ---------------------------------------------------------------------------
# Temp files (finding 7). `TMP_FILES+=("$t")` used to run inside a
# `VAR="$(mktemp_or_die)"` command SUBSTITUTION -- bash runs the right-hand
# side of `$(...)` in a SUBSHELL, so that append landed on the subshell's own
# copy of TMP_FILES and vanished the instant the subshell exited. The parent
# shell's TMP_FILES was never touched, so the EXIT trap below had nothing to
# remove: every temp file created this way leaked. Fixed by taking the
# CALLER's variable name and writing into it with `printf -v` in the CURRENT
# shell (bash's dynamic scoping resolves `local` vars up the call stack, so
# this reaches the caller's own `local outvar` correctly) -- no subshell, no
# command substitution, so the TMP_FILES append below runs in the same shell
# that the EXIT trap reads.
# ---------------------------------------------------------------------------
TMP_FILES=()
mktemp_or_die() {
  local __outvar="$1"
  local t
  t="$(mktemp 2>/dev/null)" || true
  if [[ -z "$t" || ! -f "$t" ]]; then
    inconclusive "mktemp failed to create a temp file"
    NEXT_ACTION="check /tmp disk space and permissions"
    exit_for_inconclusive
  fi
  TMP_FILES+=("$t")
  printf -v "$__outvar" '%s' "$t"
}
trap 'rm -f "${TMP_FILES[@]:-}"' EXIT

# ---------------------------------------------------------------------------
# Extension inventory / classification (finding 4). The OLD discovery `find`
# in the main script and tsconfig.scripts.json's `include` independently
# spelled the SAME four extensions, so adding e.g. scripts/new-tool.js
# produced equal sets on BOTH sides and a clean PASS -- the two derivations
# encoded the same assumption rather than checking it. This classifies EVERY
# file under non-test scripts/ against a closed table and fails INCONCLUSIVE
# on anything the table does not name, instead of silently excluding it.
# ---------------------------------------------------------------------------

# Measured against the live tree (2026-10-06): .sh .md .sql .log .json
# .template .yaml .txt .sha256 .ps1 .ignore .bat. Deliberately NOT a catch-all
# "anything that isn't code" -- an extension this list doesn't name is
# UNKNOWN, not auto-excluded, forcing a conscious classification decision
# instead of the silent fall-through this finding is about.
_scripts_is_known_noncode_ext() {
  case "$1" in
    .sh | .md | .sql | .log | .json | .template | .yaml | .txt | .sha256 | .ps1 | .ignore | .bat) return 0 ;;
    *) return 1 ;;
  esac
}

# .mjs/.cjs ONLY -- measured present today (135 / 2) and explicitly excluded
# as "not TypeScript", not inferred from a general "looks like JS" rule.
# .js/.jsx are deliberately NOT in this set: 0 of either exist today, so
# pre-classifying them would be guessing, not measuring. The live controls in
# scripts/tests/ci/typecheck-scripts-gate.test.ts plant an unknown extension
# (.probeext) AND a .js file under scripts/; both must go INCONCLUSIVE, not
# silently land in this bucket.
_scripts_is_known_excluded_js_ext() {
  case "$1" in
    .mjs | .cjs) return 0 ;;
    *) return 1 ;;
  esac
}

_scripts_is_ts_family_ext() {
  case "$1" in
    .ts | .mts | .cts | .tsx) return 0 ;;
    *) return 1 ;;
  esac
}

# BLOCKER fix (cross-family pre-merge review of PR #3022, 2026-10-06): both
# @linear/sdk and pg are not installed anywhere in this repo -- confirmed via
# `npm ls @linear/sdk` / `npm ls pg` (both "(empty)"), a repo-wide
# package.json grep, and a package-lock.json grep, all empty. See
# tsconfig.scripts.json's matching `exclude` entry and comment. These two
# scripts cannot actually run and must not be certified by this gate.
_scripts_is_blocked_path() {
  case "$1" in
    scripts/linear/create-warning-issues.ts | scripts/run-sql.ts) return 0 ;;
    *) return 1 ;;
  esac
}

# Matches bash's own `case *.ext)` glob semantics -- the same engine `find
# -name '*.ext'` uses -- so there is no second regex dialect that could
# disagree with the first (finding 1's reconciliation principle, applied
# here too). A file with no dot (ext="") or a dotfile with only a leading dot
# (e.g. a hypothetical bare ".env") both fall through every known case below
# to UNKNOWN, which is correct: neither is classified today.
_scripts_ext_of() {
  local base="${1##*/}"
  if [[ "$base" == *.* ]]; then
    printf '.%s' "${base##*.}"
  fi
}

# Populates (globals): DISCOVERED_LIST (path to a sorted file list),
# DISCOVERED (count), MJS_COUNT, CJS_COUNT, NONCODE_COUNT, BLOCKED_COUNT,
# BLOCKED_PATHS (array). Exits via exit_for_inconclusive() -- does not return
# control to the caller -- on any find/sort failure or any unclassified
# extension.
build_scripts_inventory() {
  local all_err sorted
  mktemp_or_die all_err
  mktemp_or_die sorted

  # find | sort, exactly as the original discovery did -- but every stage's
  # OWN exit status is captured via PIPESTATUS immediately after, not
  # inferred from the pipeline's combined status (finding 2: a pipeline's
  # status is its LAST command's unless each stage is read separately).
  # LC_ALL=C is load-bearing, not hygiene. This list is set-compared against one
  # built by JavaScript's .sort(), which is code-unit order. Shell `sort` uses
  # locale collation, and the two disagree on punctuation-adjacent names:
  # measured, en_CA.UTF-8 gives "a_b.ts a-b.ts a.ts A.ts ab.ts" while both
  # LC_ALL=C and node give "A.ts a-b.ts a.ts a_b.ts ab.ts". Without this, one
  # such filename pair makes the gate INCONCLUSIVE on a macOS host while CI
  # (LANG unset) stays green -- it fails closed, so it is a diagnosis cost
  # rather than a correctness hole, but an expensive one.
  find scripts -type f \
    -not -path '*/node_modules/*' -not -path '*/dist/*' \
    -not -path 'scripts/tests/*' \
    2>"$all_err" | LC_ALL=C sort >"$sorted"
  local -a inv_status=("${PIPESTATUS[@]}")
  if [[ "${inv_status[0]}" -ne 0 ]]; then
    inconclusive "find over scripts/ failed (exit ${inv_status[0]})"
    say "--- stderr ---"
    head -20 "$all_err"
    NEXT_ACTION="investigate the find error above -- this is not a zero-files result"
    exit_for_inconclusive
  fi
  if [[ "${inv_status[1]}" -ne 0 ]]; then
    inconclusive "sort of the scripts/ file inventory failed (exit ${inv_status[1]})"
    NEXT_ACTION="re-run; if it persists, sort is failing on this host (disk, locale, or memory)"
    exit_for_inconclusive
  fi

  mktemp_or_die DISCOVERED_LIST
  MJS_COUNT=0
  CJS_COUNT=0
  NONCODE_COUNT=0
  BLOCKED_COUNT=0
  BLOCKED_PATHS=()
  local -a unknown_paths=()
  local path ext

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    ext="$(_scripts_ext_of "$path")"
    if _scripts_is_blocked_path "$path"; then
      BLOCKED_COUNT=$((BLOCKED_COUNT + 1))
      BLOCKED_PATHS+=("$path")
    elif _scripts_is_ts_family_ext "$ext"; then
      printf '%s\n' "$path" >>"$DISCOVERED_LIST"
    elif _scripts_is_known_excluded_js_ext "$ext"; then
      case "$ext" in
        .mjs) MJS_COUNT=$((MJS_COUNT + 1)) ;;
        .cjs) CJS_COUNT=$((CJS_COUNT + 1)) ;;
      esac
    elif _scripts_is_known_noncode_ext "$ext"; then
      NONCODE_COUNT=$((NONCODE_COUNT + 1))
    else
      unknown_paths+=("$path")
    fi
  done <"$sorted"

  if [[ "${#unknown_paths[@]}" -gt 0 ]]; then
    inconclusive "${#unknown_paths[@]} file(s) under non-test scripts/ have an extension this gate does not classify"
    say "--- unclassified ---"
    printf '  %s\n' "${unknown_paths[@]}" | head -20
    NEXT_ACTION="classify the extension(s) above in scripts/ci/typecheck-scripts.helpers.sh (checked ts-family, known-excluded JS, or known-non-code) before this can pass -- do not silently ignore it"
    exit_for_inconclusive
  fi

  DISCOVERED="$(wc -l <"$DISCOVERED_LIST" | tr -d ' ')"
  if [[ "$DISCOVERED" -eq 0 ]]; then
    inconclusive "zero files discovered under scripts/**/*.{ts,mts,cts,tsx} (excluding scripts/tests/** and BLOCKED paths)"
    NEXT_ACTION="the discovery glob is broken, or the tree moved. This is NOT a clean result."
    exit_for_inconclusive
  fi
}

# scripts/tests/** is a DIFFERENT scope than the inventory above (it is
# excluded FROM that inventory, not a member of it), so it gets its own,
# separately status-checked find rather than being folded into the loop
# above.
count_tests_excluded() {
  local out err
  mktemp_or_die out
  mktemp_or_die err
  find scripts/tests \( -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \) -type f \
    >"$out" 2>"$err"
  local rc=$?
  if [[ "$rc" -ne 0 ]]; then
    inconclusive "find over scripts/tests failed (exit $rc)"
    NEXT_ACTION="an instrument failure, not a finding about the tree -- do NOT read it as a clean result. This count only feeds the 'excluded' report, but a wrong value there would misstate what the gate did NOT check -- which is the half a reader trusts silently."
    say "--- stderr ---"
    head -20 "$err"
    exit_for_inconclusive
  fi
  TESTS_EXCLUDED="$(wc -l <"$out" | tr -d ' ')"
}

# Derives the displayed "excluded" line from the inventory counts above
# (finding 4) rather than from fixed prose -- the BLOCKED paths are named
# explicitly, not just counted, so the exclusion stays visible in the gate's
# own output rather than buried only in tsconfig.scripts.json (the BLOCKER
# fix's own reporting requirement).
# The reason a given path is blocked, keyed BY PATH rather than stated once
# for the whole list. The earlier form hardcoded "neither @linear/sdk nor pg is
# an installed dependency" beside every entry, so a third exclusion added for
# any other reason would have printed a confidently false explanation next to
# it -- a wrong instrument answering rather than failing. An unrecognised path
# says so instead of inheriting someone else's reason.
_scripts_blocked_reason() {
  case "$1" in
    scripts/linear/create-warning-issues.ts) printf '@linear/sdk is not an installed dependency' ;;
    scripts/run-sql.ts) printf 'pg is not an installed dependency' ;;
    *) printf 'reason not recorded in _scripts_blocked_reason -- add one' ;;
  esac
}

compose_excluded_desc() {
  local blocked_list="" p
  if [[ "${#BLOCKED_PATHS[@]}" -gt 0 ]]; then
    # NOT `IFS=', '; "${arr[*]}"` -- `"$*"` joins with only the FIRST
    # character of IFS, silently dropping the space. printf + trim the
    # trailing separator is the form that actually produces "a, b, c".
    for p in "${BLOCKED_PATHS[@]}"; do
      blocked_list+="$p ($(_scripts_blocked_reason "$p")), "
    done
    blocked_list="${blocked_list%, }"
  fi
  EXCLUDED_DESC="BLOCKED: $BLOCKED_COUNT file(s) excluded as unresolvable -- $blocked_list (see tsconfig.scripts.json) + scripts/tests/** ($TESTS_EXCLUDED .ts-family files, SMI-7006) + $MJS_COUNT non-test .mjs + $CJS_COUNT non-test .cjs (measured, not TypeScript) + $NONCODE_COUNT non-code file(s) (.sh/.md/.sql/etc, measured, out of scope for a typecheck gate) -- computed dynamic import()/require() targets are also out of reach of any static resolver (plan finding 7)"
}
