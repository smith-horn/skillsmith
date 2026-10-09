#!/usr/bin/env bash
# typecheck-scripts.sh -- SMI-6975. Typecheck non-test scripts/**/*.{ts,mts,cts,tsx}
# against tsconfig.scripts.json, which root tsconfig.json never pulls in ("files":
# [], references only the four packages/* projects).
#
# WHY THIS EXISTS: it bit PR #3020 hours before the plan behind this gate was
# written. A renderer-signature change in packages/doc-retrieval-mcp put three
# live TS2345 errors into scripts/session-priming-query.ts (451 lines, runs on
# every SessionStart) and `npm run typecheck` exited 0 -- worse, the pre-commit
# hook printed "Running full typecheck (non-package changes detected)... tsc
# --build ... TypeScript check passed (full)", which reads as "checked BECAUSE
# you touched those files". A wrong instrument does not fail; it answers.
#
# SMI-6975 FOLLOW-UP (cross-family pre-merge review of PR #3022, 2026-10-06):
# this gate's own first PR had the exact defect it exists to prevent. Two
# scripts (scripts/linear/create-warning-issues.ts, scripts/run-sql.ts) import
# @linear/sdk and pg -- NEITHER PACKAGE IS INSTALLED -- and PR #3022 shipped
# handwritten ambient .d.ts files inventing a contract for both, so the gate
# certified two scripts that cannot actually run. Fixed by excluding both from
# tsconfig.scripts.json (deleting the invented .d.ts files) and reporting the
# exclusion explicitly in this script's own "excluded" output, not just in the
# config -- see build_scripts_inventory()/compose_excluded_desc() in
# typecheck-scripts.helpers.sh. The same review also found: unchecked
# find/perl/grep exit status that could turn a real failure into a false PASS
# (fixed throughout below); two independent scope derivations (this file's
# find, and tsconfig.scripts.json's include) that silently omitted the same
# extension category, so a new .js/.jsx file would reconcile and pass
# unnoticed (fixed via the extension-inventory classification in the helpers
# file, which fails INCONCLUSIVE on anything it does not explicitly
# classify); a mktemp wrapper whose cleanup never ran because it updated a
# subshell's copy of its own bookkeeping array; and a `$?` read one line too
# late that always evaluated to the wrong command's status.
#
# Modelled on scripts/ci/typecheck-edge-functions.sh (read that file's own
# exit-policy table; this follows its RESULT/VERDICT shape, not a re-derivation
# of it) with one deliberate simplification: there is no CONTEXT axis here.
# typecheck-edge-functions.sh's fork-pr tolerance exists because
# supabase/functions/** is git-crypt encrypted and a fork has no key -- a cause
# that cannot occur for scripts/**, which git-crypt never touches (CLAUDE.md
# "Git-Crypt (Narrowed Scope)": only supabase/functions/ and
# supabase/migrations/ are encrypted). Building a git-crypt sentinel check here
# would be a check against a condition that is structurally impossible for this
# tree -- the wrong-instrument failure this whole plan exists to avoid, just
# aimed at the gate's own code instead of the thing it checks. So: INCONCLUSIVE
# always exits non-zero, in every context, full stop.
#
# Invoked as `bash scripts/ci/typecheck-scripts.sh`, so it does NOT inherit -e
# from the calling step and sets its own flags.
set -uo pipefail

# -P: tsc reports paths relative to its own resolved CWD; a logical pwd under a
# symlinked checkout could still diverge from what `find` (run from the same
# REPO_ROOT) reports, which is exactly the mismatch finding 1 exists to catch.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$REPO_ROOT" || exit 1

CONFIG="tsconfig.scripts.json"
# Wall-clock budget, in seconds, for EACH tsc call (--version, --showConfig and
# the full compile). The default must stay well above a normal run, and a
# timeout is INCONCLUSIVE, never PASS. Accepted range is checked in
# validate_timeout_secs().
TSC_TIMEOUT_SECS="${SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS:-600}"

# Two files, per the 500-line gate (CLAUDE.md "CI Health Requirements"). The
# guard below fails loudly if the sibling did not load -- with no `set -e`, a
# failed `source` would NOT abort; it would leave every helper function
# undefined and surface as "command not found" mid-check instead of a clear
# fatal message.
# shellcheck source=scripts/ci/typecheck-scripts.helpers.sh
source "$REPO_ROOT/scripts/ci/typecheck-scripts.helpers.sh"
if ! declare -F finish >/dev/null || ! declare -F exit_for_inconclusive >/dev/null \
  || ! declare -F mktemp_or_die >/dev/null || ! declare -F build_scripts_inventory >/dev/null \
  || ! declare -F count_tests_excluded >/dev/null || ! declare -F compose_excluded_desc >/dev/null \
  || ! declare -F run_bounded >/dev/null || ! declare -F check_tsc_ready >/dev/null \
  || ! declare -F classify_compile_status >/dev/null || ! declare -F verify_compiler_read_roots >/dev/null \
  || ! declare -F print_tsc_tail >/dev/null; then
  printf '[scripts-typecheck] FATAL: typecheck-scripts.helpers.sh did not load\n' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Preconditions: tsc present, executable, and recognisable (finding 6).
# Resolved as a direct binary path rather than via `npx`, so a missing
# devDependency fails as "not found" rather than npx silently reaching for a
# network install.
# ---------------------------------------------------------------------------
validate_timeout_secs
resolve_tsc_bin
check_tsc_ready

if [[ ! -f "$CONFIG" ]]; then
  inconclusive "missing $CONFIG"
  NEXT_ACTION="restore $CONFIG at the repo root"
  exit_for_inconclusive
fi
if [[ ! -r "$CONFIG" ]]; then
  inconclusive "$CONFIG exists but is not readable"
  NEXT_ACTION="fix permissions on $CONFIG"
  exit_for_inconclusive
fi

# ---------------------------------------------------------------------------
# Discovery, derivation 1: the classified file inventory (finding 4), plus
# the separately-scoped scripts/tests/** count, plus the BLOCKER-fix
# exclusion report (finding 4 / BLOCKER). All three functions exit via
# exit_for_inconclusive() on their own failure modes; nothing below runs
# unless all three returned normally.
# ---------------------------------------------------------------------------
build_scripts_inventory
count_tests_excluded
compose_excluded_desc

# ---------------------------------------------------------------------------
# Discovery, derivation 2: tsc's OWN resolved file list. `--showConfig` is run
# BEFORE the real compile for a measured reason, not a style preference: a
# syntactically-broken tsconfig makes a full `tsc -p` invocation hang and then
# OOM-crash (measured against TS 5.9.3 -- V8 heap exhaustion on a malformed
# JSON config, ~45s to FATAL ERROR), while `--showConfig` on the same bad input
# fails fast and cleanly (exit 1, TS1136, no hang). Gating the expensive call
# behind the cheap one's success is what keeps "config invalid" a clean
# INCONCLUSIVE arm instead of a wedged CI job.
# ---------------------------------------------------------------------------
mktemp_or_die SHOWCONFIG_OUT
mktemp_or_die SHOWCONFIG_ERR
# Captures the --showConfig parser's stderr. Previously /dev/null, which meant
# the single run that needed a diagnostic was the one run that discarded it.
mktemp_or_die NODE_PARSE_ERR
# shellcheck disable=SC2153 # SHOWCONFIG_ERR IS assigned, by mktemp_or_die's
# `printf -v "$__outvar"` above -- shellcheck can't see an assignment made
# by name through a function argument, and its misspelling heuristic flags
# the nearby SHOWCONFIG_RC as the "intended" name instead.
run_bounded "$TSC_BIN" --showConfig -p "$CONFIG" >"$SHOWCONFIG_OUT" 2>"$SHOWCONFIG_ERR"
SHOWCONFIG_RC=$?
exit_if_bounded_timeout "$SHOWCONFIG_RC" "tsc --showConfig"
if [[ "$SHOWCONFIG_RC" -ne 0 ]]; then
  inconclusive "tsc --showConfig failed (exit $SHOWCONFIG_RC) -- $CONFIG is invalid or unreadable to tsc"
  # Measured directly (Step 5 red-test, a zero-matching `include`): tsc's
  # TS18003 "No inputs were found" for THIS failure mode prints to STDOUT, not
  # stderr -- so a stderr-only display here would show an empty block while
  # the real, useful diagnostic sat in $SHOWCONFIG_OUT the whole time. Both
  # streams are shown because this failure's channel is not reliably stderr.
  say "--- showConfig output (stdout then stderr) ---"
  head -20 "$SHOWCONFIG_OUT"
  head -20 "$SHOWCONFIG_ERR"
  NEXT_ACTION="fix $CONFIG; the full compile would be meaningless (or could hang) until this resolves"
  exit_for_inconclusive
fi

mktemp_or_die COMPILER_ROOTS_LIST
# Node, not jq/grep: --showConfig emits real JSON and `files` entries are
# "./scripts/..." -- the leading "./" must be stripped before comparing
# byte-for-byte against find's un-prefixed output.
# shellcheck disable=SC2153 # NODE_PARSE_ERR IS assigned, by mktemp_or_die's
# `printf -v "$__outvar"` above -- the same false positive already documented
# for SHOWCONFIG_ERR; shellcheck offers the nearby NODE_PARSE_RC as the
# "intended" spelling. Placed before `node -e`, not before the quote that
# closes it: that closing quote is the END of this command's single-quoted
# JS argument, so a comment there lands INSIDE the JavaScript.
node -e '
  const fs = require("fs");
  let raw, cfg;
  try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch { process.exit(3); }
  try { cfg = JSON.parse(raw); } catch { process.exit(4); }
  if (!cfg || !Array.isArray(cfg.files)) process.exit(5);
  const rel = cfg.files.map((f) => String(f).replace(/^\.\//, "")).sort();
  process.stdout.write(rel.length ? rel.join("\n") + "\n" : "");
' "$SHOWCONFIG_OUT" >"$COMPILER_ROOTS_LIST" 2>"$NODE_PARSE_ERR"
# Finding 8: `NODE_PARSE_RC=$?` used to be read INSIDE `if ! node ...; then`,
# where `$?` is the exit status of `!`, not of `node` -- `!` negates, so
# landing in that branch (node genuinely failed) always left `$?` at 0, and
# the message always printed "node exit 0" regardless of node's real status.
# Fixed by capturing node's status immediately, THEN branching on the
# captured value.
NODE_PARSE_RC=$?
if [[ "$NODE_PARSE_RC" -ne 0 ]]; then
  inconclusive "could not parse tsc --showConfig output as a files[] array (node exit $NODE_PARSE_RC)"
  # The content is dumped INLINE rather than named by path: $SHOWCONFIG_OUT is
  # an mktemp file the EXIT trap removes, so a next-action telling the reader
  # to "inspect" it points at a path that no longer exists by the time they
  # read the line. The one run that needed a diagnostic must keep it.
  say "--- node stderr ---"
  head -20 "$NODE_PARSE_ERR"
  say "--- first 20 lines of the --showConfig output that could not be parsed ---"
  head -20 "$SHOWCONFIG_OUT"
  NEXT_ACTION="compare the shape above against the expected { files: [...] } -- this tsc version may have changed --showConfig's output format"
  exit_for_inconclusive
fi
COMPILER_ROOTS="$(wc -l <"$COMPILER_ROOTS_LIST" | tr -d ' ')"
# Defence in depth: the tsc this repo pins fails inside --showConfig (TS18003)
# for an empty or non-matching include before this arm is reached, so no test
# can drive it. It stays for a tsc that reports zero files instead of failing.
if [[ "$COMPILER_ROOTS" -eq 0 ]]; then
  inconclusive "tsc --showConfig resolved zero files for $CONFIG"
  NEXT_ACTION="the compiler's own include/exclude resolved to nothing. This is NOT a clean result."
  exit_for_inconclusive
fi

# ---------------------------------------------------------------------------
# THE reconciliation (finding 1). Not a count comparison -- a SET comparison.
# Two different counts that happen to both be 268 would still be a bug; two
# IDENTICAL sorted file lists are the only thing that rules out "tsc read a
# different include, a different config, or ran from a different cwd" while
# this shell's inventory read what the developer expects.
# ---------------------------------------------------------------------------
# `diff` exits 0 (identical) / 1 (differ) / >=2 (ERROR). The >=2 case writes
# nothing to stdout, so an earlier `$(diff ... || true)` shape left SET_DIFF
# empty for TWO different reasons and an emptiness test took the "sets agree"
# branch -- a silent success on the one comparison this header calls the
# reconciliation. Reproduced with a `diff` stub exiting 2: the gate printed
# PASS and claimed `checked 266 (only set once discovered == compiler roots)`
# when that equality had never been established. Status is now read, not
# inferred from emptiness.
SET_DIFF="$(diff "$DISCOVERED_LIST" "$COMPILER_ROOTS_LIST")"
SET_DIFF_RC=$?
if [[ "$SET_DIFF_RC" -ge 2 ]]; then
  inconclusive "the set comparison itself failed (diff exit $SET_DIFF_RC) -- the two file lists were never compared, so scope is unvalidated"
  NEXT_ACTION="this is a failure of the instrument, not a finding about the tree. Check that both temp lists exist and are readable, then re-run. Do NOT read this as 'the sets agree'."
  exit_for_inconclusive
fi
if [[ "$SET_DIFF_RC" -eq 1 ]]; then
  inconclusive "discovered set (inventory) and compiler roots (tsc --showConfig) disagree -- scope could not be validated"
  say "--- diff (< inventory-only, > tsc-only) ---"
  printf '%s\n' "$SET_DIFF" | head -20
  NEXT_ACTION="reconcile $CONFIG's include/exclude against this script's inventory. A set mismatch is not a zero -- it means the thing that ran is not the thing that was intended."
  exit_for_inconclusive
fi
# Reached only on SET_DIFF_RC == 0, i.e. the lists are genuinely identical.
CHECKED="$DISCOVERED"

# ---------------------------------------------------------------------------
# The check itself. --pretty is not cosmetic here: it is the ONLY tsc output
# mode measured to print an independent "Found N error(s)..." summary line at
# all -- plain `tsc -p` prints bare diagnostics with no total, which would
# force REPORTED to be derived from the same lines ATTRIB counts (the exact
# self-referential trap typecheck-edge-functions.helpers.sh's own H-2 comment
# warns against). --pretty's summary is computed by tsc itself, independently
# of how this script parses per-file lines, so the two can actually disagree
# if either parser is wrong.
# ---------------------------------------------------------------------------
mktemp_or_die TSC_RAW
# Bounded by run_bounded (perl alarm); see its definition for why. Output goes to
# a file, never a pipe: a compiler that forks a survivor would hold a pipe open
# past the alarm. --listFiles records the program this run actually compiled.
run_bounded "$TSC_BIN" -p "$CONFIG" --pretty --listFiles >"$TSC_RAW" 2>&1
TSC_RC=$?
exit_if_bounded_timeout "$TSC_RC" "the full tsc compile"
classify_compile_status "$TSC_RC"

mktemp_or_die TSC_CLEAN
# Strip ANSI + NUL before any pattern match, for the same reason the edge-
# function gate does: a NUL byte can make some greps silently stop matching,
# and --pretty's color codes sit INSIDE diagnostic lines (between "error" and
# "TSxxxx", measured directly) rather than only around them.
perl -pe 's/\e\[[0-9;]*m//g; tr/\000//d' "$TSC_RAW" >"$TSC_CLEAN"
# Finding 2: perl's own exit status was never read. A perl crash mid-stream
# (OOM, killed, disk full writing $TSC_CLEAN) would leave $TSC_CLEAN empty or
# truncated with nothing downstream the wiser -- checked immediately, not
# inferred from whatever a later grep happens to find in the damaged output.
PERL_RC=$?
if [[ "$PERL_RC" -ne 0 ]]; then
  inconclusive "the ANSI/NUL-strip (perl) failed (exit $PERL_RC) -- \$TSC_CLEAN cannot be trusted"
  # Same reason as the --showConfig arm: name nothing the trap has deleted.
  say "--- first 20 lines of the raw tsc output perl could not process ---"
  head -20 "$TSC_RAW"
  NEXT_ACTION="re-run; if it persists, perl is broken on this host, or the raw output above is not what perl expected"
  exit_for_inconclusive
fi

# A bare `error TSxxxx:` line with NO leading "path:line:col - " prefix is a
# GLOBAL/structural failure (e.g. TS2688 "Cannot find type definition file for
# 'node'"), not a per-file code diagnostic -- measured directly by breaking
# `types` in a scratch tsconfig. Checked BEFORE any counting, same ordering as
# the reference gate's module-graph-error check, because the error/attribution
# counts below would be meaningless if the compiler never got past loading its
# own configuration.
grep -qE '^error TS[0-9]+:' "$TSC_CLEAN"
GLOBAL_ERR_RC=$?
# grep -q: 0 = matched, 1 = no match (legitimate -- most runs), 2 = a REAL
# grep error (e.g. an unreadable file). Finding 2: a plain `if grep -q ...;
# then` cannot tell 1 apart from 2 -- both are "false" to `if`, so a genuine
# grep failure would have silently taken the "no global error" branch.
if [[ "$GLOBAL_ERR_RC" -ge 2 ]]; then
  inconclusive "the global-diagnostic-shape grep failed (exit $GLOBAL_ERR_RC)"
  NEXT_ACTION="an instrument failure, not a finding about the tree -- do NOT read it as a clean result. Exit >=2 from grep means grep itself errored (unreadable input, or a pattern this grep build rejects), not 'no match'. Confirm \$TSC_CLEAN is readable and re-run."
  exit_for_inconclusive
fi
if [[ "$GLOBAL_ERR_RC" -eq 0 ]]; then
  inconclusive "module-resolution or global configuration failure (a diagnostic with no file:line:col -- not one of the per-file findings)"
  say "--- global diagnostic(s) ---"
  grep -A3 -E '^error TS[0-9]+:' "$TSC_CLEAN" | head -20
  NEXT_ACTION="resolve the global error first; any per-file count below would be meaningless"
  exit_for_inconclusive
fi

# Every discovered root must be in the program tsc compiled: tsc re-expands
# `include` at compile time, so a file removed since the inventory is dropped
# silently and the run would still PASS.
verify_compiler_read_roots

# REPORTED: tsc's own total, from the "Found N error(s) ..." line. Measured
# across three distinct shapes on TS 5.9.3 -- "Found 1 error in <path>:<line>"
# (singular, ALWAYS this form for exactly one error, regardless of project
# size), "Found N errors in M files." (plural, N>=2), and "Found 1 error."
# (bare, for a diagnostic with no project-file location at all). The anchor
# "^Found [0-9]+ errors?" matches the leading count in all three without ever
# trying to parse what follows it. The boundary is spelled out as a bracket
# expression rather than `\b`, which POSIX ERE does not define; this gate runs
# under both GNU grep (container, CI) and BSD grep (macOS host).
FOUND_LINES="$(grep -cE '^Found [0-9]+ errors?([^[:alnum:]_]|$)' "$TSC_CLEAN")"
FOUND_LINES_RC=$?
if [[ "$FOUND_LINES_RC" -ge 2 ]]; then
  inconclusive "the 'Found N errors' summary-line grep failed (exit $FOUND_LINES_RC)"
  NEXT_ACTION="an instrument failure, not a finding about the tree -- do NOT read it as a clean result. Exit >=2 is a grep error, not a missing summary line -- a missing line is exit 1 and handled separately below. Confirm the cleaned tsc output is readable and re-run."
  exit_for_inconclusive
fi
if [[ "$FOUND_LINES" -eq 0 ]]; then
  if [[ "$TSC_RC" -eq 0 ]]; then
    REPORTED=0
  else
    inconclusive "tsc exited $TSC_RC with no parseable 'Found' total"
    say "--- raw tail ---"
    print_tsc_tail
    NEXT_ACTION="unrecognised tsc output for this version -- the parser above may need updating"
    exit_for_inconclusive
  fi
elif [[ "$FOUND_LINES" -eq 1 ]]; then
  # This pipeline runs INSIDE a command substitution, so PIPESTATUS (set by
  # a pipeline run directly in the current shell, as above) does not apply
  # here -- the subshell `$(...)` creates has its own PIPESTATUS, which never
  # reaches the parent's array. `$?` immediately after the assignment is the
  # right instrument instead: pipefail (set at the top of this script) is a
  # shell option, and shell options ARE inherited into command-substitution
  # subshells, so `$?` already reflects the pipeline's own pipefail-combined
  # status collapsed to a single value -- sufficient here because, unlike
  # the grep -c calls above, neither stage has a legitimate non-zero outcome
  # by construction (FOUND_LINES == 1 already proved exactly one "Found N"
  # line exists, and that line contains digits by the pattern that found
  # it), so ANY non-zero is a genuine error.
  REPORTED="$(grep -oE '^Found [0-9]+' "$TSC_CLEAN" | grep -oE '[0-9]+')"
  REPORTED_RC=$?
  if [[ "$REPORTED_RC" -ne 0 ]]; then
    inconclusive "could not extract the error count from the 'Found N' summary line (pipeline exit $REPORTED_RC)"
    NEXT_ACTION="an instrument failure, not a finding about the tree -- do NOT read it as a clean result. A 'Found N' line was located just above, so the line exists and only the number extraction failed. \$REPORTED_RC is the pipeline's combined status via pipefail, so either grep stage can be the culprit; inspect the summary line's shape for this tsc version."
    exit_for_inconclusive
  fi
else
  inconclusive "$FOUND_LINES 'Found' summary lines -- output shape unexpected, possibly truncated"
  say "--- raw tail ---"
  print_tsc_tail
  NEXT_ACTION="do not trust a count derived from this; re-run, or update the parser for this tsc version"
  exit_for_inconclusive
fi

# Status-vs-output contract (finding 6/e). Measured directly, repeatedly,
# against TS 5.9.3 with noEmit set: 0 errors -> exit 0, N>0 errors -> exit 2 --
# NOT exit 1. This is where this gate's contract DIFFERS from
# typecheck-edge-functions.sh's deno contract (0 clean / 1 errors) -- tsc's own
# ExitStatus enum names 2 as DiagnosticsPresent_OutputsGenerated even under
# --noEmit, and that was confirmed against this exact invocation, not assumed
# from deno's behaviour or from TypeScript's documentation. Any OTHER pairing
# -- a crash, a kill signal, a timeout, a version with a different contract --
# means the run cannot be trusted, which is how "signal or timeout" (finding
# 6) is covered here: the compile is bounded by the perl alarm above (timeout
# and signal kills are classified immediately after it), and any other
# unexpected status is already everything this check needs to know.
if [[ "$REPORTED" -eq 0 && "$TSC_RC" -ne 0 ]]; then
  inconclusive "reported 0 errors but exited $TSC_RC -- the compiler did not complete cleanly"
  NEXT_ACTION="a zero-error reading from a non-zero exit is not a clean tree. Re-run; if it persists, tsc is crashing after emitting output."
  exit_for_inconclusive
fi
if [[ "$REPORTED" -gt 0 && "$TSC_RC" -ne 2 ]]; then
  inconclusive "reported $REPORTED errors but exited $TSC_RC, not 2 -- the measured tsc contract for this config is 0 (clean) / 2 (diagnostics present); any other status means the process did not complete"
  NEXT_ACTION="do not trust the count below. Re-run; if it persists, tsc's exit contract changed for this version and the check above needs updating."
  exit_for_inconclusive
fi

# ATTRIB: per-file diagnostic HEADERS only. --pretty's header shape is
# "path:line:col - error TSxxxx: message" (measured); continuation and code-frame
# lines are indented, so requiring a non-whitespace first character counts
# exactly one line per diagnostic block, matching REPORTED's own unit.
#
# The anchor is deliberately ANY path, not '^scripts/'. 16 non-test scripts
# import ../../packages/core/src/..., so packages/ sources enter the program:
# measured with --listFiles, 1402 program files of which 110 are non-.d.ts
# sources under packages/, and skipLibCheck only skips .d.ts, so those 110 are
# fully checked. A '^scripts/' anchor cannot see a diagnostic in any of them --
# REPORTED would be 1 and ATTRIB 0, firing the mismatch arm below with a
# next-action blaming the header parser, which would be correct code and the
# wrong suspect. Worst case: an error reachable only under this config's
# options, where tsc --build passes, this half goes INCONCLUSIVE accusing
# itself, and the real diagnostic is never named.
#
# A path can contain ':', so the anchor is the `:line:col - error TS` suffix, not
# the first colon. The by-file sed below cuts at that same suffix.
ATTRIB_RE='^[^[:space:]].*:[0-9]+:[0-9]+ - error TS[0-9]+:'
ATTRIB="$(grep -cE "$ATTRIB_RE" "$TSC_CLEAN")"
ATTRIB_RC=$?
if [[ "$ATTRIB_RC" -ge 2 ]]; then
  inconclusive "the per-file attribution count grep failed (exit $ATTRIB_RC)"
  NEXT_ACTION="an instrument failure, not a finding about the tree -- do NOT read it as a clean result. Check \$ATTRIB_RE above is still a valid ERE for this grep build; a pattern error and an unreadable input both surface as >=2."
  exit_for_inconclusive
fi

# Split for reporting: a diagnostic outside scripts/ is in-program but not in
# this gate's nominal scope, and saying so is more useful than a bare total.
ATTRIB_SCRIPTS="$(grep -cE '^scripts/.+:[0-9]+:[0-9]+ - error TS[0-9]+:' "$TSC_CLEAN")"
ATTRIB_SCRIPTS_RC=$?
if [[ "$ATTRIB_SCRIPTS_RC" -ge 2 ]]; then
  inconclusive "the scripts/-scoped attribution count grep failed (exit $ATTRIB_SCRIPTS_RC)"
  NEXT_ACTION="an instrument failure, not a finding about the tree -- do NOT read it as a clean result. This count is only used to split the total for reporting, but it is not skippable: without it the 'outside scripts/' line would be computed from a bogus subtraction."
  exit_for_inconclusive
fi
ATTRIB_OUTSIDE=$(( ATTRIB - ATTRIB_SCRIPTS ))

mktemp_or_die BY_FILE
grep -E "$ATTRIB_RE" "$TSC_CLEAN" \
  | sed -E 's/:[0-9]+:[0-9]+ - error TS[0-9]+:.*$//' | sort | uniq -c \
  | awk '{n=$1; $1=""; sub(/^ /, ""); printf "%d\t%s\n", n, $0}' | sort -t$'\t' -k1,1nr >"$BY_FILE"
BY_FILE_STATUS=("${PIPESTATUS[@]}")
# Finding 2: six stages, each checked. Stage 0 (grep) legitimately returns 1
# when ATTRIB is 0 -- a clean tree -- so only >=2 there is an error; every
# other stage (sed/sort/uniq/awk/sort) has no legitimate non-zero outcome at
# all, so ANY non-zero there is routed to INCONCLUSIVE.
if [[ "${BY_FILE_STATUS[0]}" -ge 2 ]]; then
  inconclusive "the per-file attribution grep failed (exit ${BY_FILE_STATUS[0]})"
  NEXT_ACTION="an instrument failure, not a finding about the tree -- do NOT read it as a clean result. Stage 0 of the by-file pipeline. Exit 1 here is legitimate (no diagnostics) and is NOT routed here; only >=2 is."
  exit_for_inconclusive
fi
for _by_file_stage in 1 2 3 4 5; do
  _by_file_rc="${BY_FILE_STATUS[$_by_file_stage]:-1}"
  if [[ "$_by_file_rc" -ne 0 ]]; then
    inconclusive "the per-file attribution pipeline's stage $_by_file_stage (sed/sort/uniq/awk) failed (exit $_by_file_rc)"
    NEXT_ACTION="an instrument failure, not a finding about the tree -- do NOT read it as a clean result. Stages 1-5 are sed/sort/uniq/awk/sort, none of which has a legitimate non-zero outcome, so ANY non-zero is routed here. Stage numbering is left-to-right from 0."
    exit_for_inconclusive
  fi
done
ERR_FILES="$(wc -l <"$BY_FILE" | tr -d ' ')"

# The hard reconciliation itself (finding 1/6). Two independently-derived
# counts -- tsc's own summary line, and this script's count of diagnostic
# headers -- must agree before either is trusted.
if [[ "$ATTRIB" -ne "$REPORTED" ]]; then
  ERR_FIELD="$REPORTED total / $ATTRIB attributed across $ERR_FILES files   [MISMATCH]"
  inconclusive "attribution ($ATTRIB) does not reconcile with tsc's own reported total ($REPORTED)"
  NEXT_ACTION="the header-line parser above is wrong for this tsc version/output shape. Do not trust the per-file numbers. (The anchor matches ANY path, not just scripts/, so a diagnostic in an imported packages/ source is NOT an explanation for this mismatch -- those are counted. See the 'outside scripts/' line if present.)"
  say "--- raw tail, for the parser fix ---"
  print_tsc_tail
  exit_for_inconclusive
fi

# A diagnostic outside scripts/ is real and checked -- 110 non-.d.ts packages/
# sources are in this program -- but it is not in the gate's nominal scope, so
# name it rather than letting it hide inside a bare total.
if [[ "$ATTRIB_OUTSIDE" -gt 0 ]]; then
  say "  outside scripts/  $ATTRIB_OUTSIDE of $ATTRIB diagnostic(s) are in imported sources (packages/**), which this config fully type-checks"
fi

# Backstop: every path that sets RESULT=INCONCLUSIVE must have exited above. If
# one fell through, a PASS here would read RESULT INCONCLUSIVE / VERDICT PASS /
# exit 0. Refuse rather than render it.
if [[ "$RESULT" != "EVALUATED" ]]; then
  NEXT_ACTION="gate bug: an INCONCLUSIVE arm fell through to the verdict without exiting; report it, do not trust this run"
  exit_for_inconclusive
fi

if [[ "$REPORTED" -eq 0 ]]; then
  ERR_FIELD="0 total / 0 attributed   [RECONCILED]"
  VERDICT="PASS"
  finish
  exit 0
fi

ERR_FIELD="$REPORTED total / $ATTRIB attributed across $ERR_FILES files   [RECONCILED]"
VERDICT="FAIL"
finish
say "--- by file (error count, descending) ---"
cat "$BY_FILE"
say ""
say "Fix these -- no @ts-expect-error to reach green, no widening to any to silence a genuine"
say "mismatch (SMI-7006 already shows where that habit ends: 22 unused directives on the test side)."
exit 1
