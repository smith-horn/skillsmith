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
TSC_BIN="$REPO_ROOT/node_modules/.bin/tsc"

say() { printf '%s\n' "$*"; }
field() { printf '  %-14s %s\n' "$1" "$2"; }

# RESULT answers "did the check produce a usable answer"; VERDICT answers "is
# the code clean". Conflating them is how a checker that never ran gets
# recorded as a checker that found nothing (plan finding 6 / CLAUDE.md
# SMI-6684's STATE/CAUSE split).
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
  # Four numbers, printed SEPARATELY, never collapsed into one (finding 1/2).
  # A plausible "263 files / PASS" proves nothing on its own -- it looks
  # identical whether tsc read the same include set this shell counted, or a
  # different one entirely.
  field "discovered" "${DISCOVERED:-?} (find over scripts/**/*.{ts,mts,cts,tsx}, minus scripts/tests/**)"
  field "compiler roots" "${COMPILER_ROOTS:-?} (tsc --showConfig's own resolved files[])"
  field "checked" "${CHECKED:-?} (only set once discovered == compiler roots)"
  field "excluded" "${EXCLUDED_DESC:-?}"
  [[ -n "${ERR_FIELD:-}" ]] && field "errors" "$ERR_FIELD"
  field "RESULT" "$RESULT${INCONCLUSIVE_WHY:+ -- $INCONCLUSIVE_WHY}"
  field "VERDICT" "${VERDICT:-NONE}"
  [[ -n "$NEXT_ACTION" ]] && say "  next: $NEXT_ACTION"
  say ""
}

# No CONTEXT axis (see header). "Not checked" is not "safe" -- an INCONCLUSIVE
# result always exits non-zero, matching the plan's checklist item verbatim.
exit_for_inconclusive() {
  finish
  say "FATAL: the check could not run, or could not be trusted. \"Not checked\" is not \"safe\"."
  exit 1
}

# ---------------------------------------------------------------------------
# Temp files. Explicit creation-failure handling (finding 6's own taxonomy
# names this), because an unchecked `$(mktemp)` failure leaves the variable
# empty and every later redirect into "" fails somewhere downstream with a
# confusing, differently-worded error instead of a named INCONCLUSIVE cause.
# ---------------------------------------------------------------------------
TMP_FILES=()
mktemp_or_die() {
  local t
  t="$(mktemp 2>/dev/null)" || true
  if [[ -z "$t" || ! -f "$t" ]]; then
    inconclusive "mktemp failed to create a temp file"
    NEXT_ACTION="check /tmp disk space and permissions"
    exit_for_inconclusive
  fi
  TMP_FILES+=("$t")
  printf '%s' "$t"
}
trap 'rm -f "${TMP_FILES[@]:-}"' EXIT

# ---------------------------------------------------------------------------
# Preconditions: tsc present, executable, and recognisable (finding 6).
# Resolved as a direct binary path rather than via `npx`, so a missing
# devDependency fails as "not found" rather than npx silently reaching for a
# network install.
# ---------------------------------------------------------------------------
if [[ ! -x "$TSC_BIN" ]]; then
  inconclusive "tsc not found or not executable at node_modules/.bin/tsc"
  NEXT_ACTION="npm install from the HOST in the main checkout (never inside a worktree container's node_modules, which is read-only by design)"
  exit_for_inconclusive
fi

TSC_VERSION_RAW="$("$TSC_BIN" --version 2>&1)"
TSC_VERSION_RC=$?
if [[ "$TSC_VERSION_RC" -ne 0 ]] || ! printf '%s' "$TSC_VERSION_RAW" | grep -qE '^Version [0-9]+\.[0-9]+\.[0-9]+'; then
  inconclusive "tsc --version produced no recognisable version string"
  say "--- raw ---"; printf '%s\n' "$TSC_VERSION_RAW" | head -5
  NEXT_ACTION="confirm node_modules/.bin/tsc is a real, uncorrupted TypeScript compiler"
  exit_for_inconclusive
fi
TSC_VERSION="$(printf '%s' "$TSC_VERSION_RAW" | head -1)"

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
# Discovery, derivation 1: find over the intended roots.
# ---------------------------------------------------------------------------
DISCOVERED_LIST="$(mktemp_or_die)"
find scripts \( -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \) -type f \
  -not -path '*/node_modules/*' -not -path '*/dist/*' \
  -not -path 'scripts/tests/*' 2>/dev/null | sort > "$DISCOVERED_LIST"
DISCOVERED="$(wc -l < "$DISCOVERED_LIST" | tr -d ' ')"

# I-3 class (same shape as the reference gate): an empty include matches
# nothing, tsc reports zero errors, and that is indistinguishable from a clean
# tree unless a zero denominator is caught and named explicitly first.
if [[ "$DISCOVERED" -eq 0 ]]; then
  inconclusive "zero files discovered under scripts/**/*.{ts,mts,cts,tsx} (excluding scripts/tests/**)"
  NEXT_ACTION="the discovery glob is broken, or the tree moved. This is NOT a clean result."
  exit_for_inconclusive
fi

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
SHOWCONFIG_OUT="$(mktemp_or_die)"
SHOWCONFIG_ERR="$(mktemp_or_die)"
"$TSC_BIN" --showConfig -p "$CONFIG" > "$SHOWCONFIG_OUT" 2>"$SHOWCONFIG_ERR"
SHOWCONFIG_RC=$?
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

COMPILER_ROOTS_LIST="$(mktemp_or_die)"
# Node, not jq/grep: --showConfig emits real JSON and `files` entries are
# "./scripts/..." -- the leading "./" must be stripped before comparing
# byte-for-byte against find's un-prefixed output.
if ! node -e '
  const fs = require("fs");
  let raw, cfg;
  try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch { process.exit(3); }
  try { cfg = JSON.parse(raw); } catch { process.exit(4); }
  if (!cfg || !Array.isArray(cfg.files)) process.exit(5);
  const rel = cfg.files.map((f) => String(f).replace(/^\.\//, "")).sort();
  process.stdout.write(rel.length ? rel.join("\n") + "\n" : "");
' "$SHOWCONFIG_OUT" > "$COMPILER_ROOTS_LIST" 2>/dev/null; then
  NODE_PARSE_RC=$?
  inconclusive "could not parse tsc --showConfig output as a files[] array (node exit $NODE_PARSE_RC)"
  NEXT_ACTION="inspect $SHOWCONFIG_OUT's content shape -- this tsc version may have changed --showConfig's output format"
  exit_for_inconclusive
fi
COMPILER_ROOTS="$(wc -l < "$COMPILER_ROOTS_LIST" | tr -d ' ')"
if [[ "$COMPILER_ROOTS" -eq 0 ]]; then
  inconclusive "tsc --showConfig resolved zero files for $CONFIG"
  NEXT_ACTION="the compiler's own include/exclude resolved to nothing. This is NOT a clean result."
  exit_for_inconclusive
fi

# ---------------------------------------------------------------------------
# THE reconciliation (finding 1). Not a count comparison -- a SET comparison.
# Two different counts that happen to both be 263 would still be a bug; two
# IDENTICAL sorted file lists are the only thing that rules out "tsc read a
# different include, a different config, or ran from a different cwd" while
# this shell's `find` read what the developer expects.
# ---------------------------------------------------------------------------
SET_DIFF="$(diff "$DISCOVERED_LIST" "$COMPILER_ROOTS_LIST" || true)"
if [[ -n "$SET_DIFF" ]]; then
  inconclusive "discovered set (find) and compiler roots (tsc --showConfig) disagree -- scope could not be validated"
  say "--- diff (< find-only, > tsc-only) ---"
  printf '%s\n' "$SET_DIFF" | head -20
  NEXT_ACTION="reconcile $CONFIG's include/exclude against this script's find expression. A set mismatch is not a zero -- it means the thing that ran is not the thing that was intended."
  exit_for_inconclusive
fi
CHECKED="$DISCOVERED"

# ---------------------------------------------------------------------------
# Excluded scope, reported rather than implied (finding 3/7 -- a gate named
# "scripts typecheck" that silently covers a subset reads as covering the
# whole directory). Measured live every run, not copied from the plan doc --
# a count written into a comment starts rotting the moment the tree changes.
# ---------------------------------------------------------------------------
TESTS_EXCLUDED="$(find scripts/tests \( -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \) \
  -type f 2>/dev/null | wc -l | tr -d ' ')"
MJS_EXCLUDED="$(find scripts -name '*.mjs' -type f -not -path 'scripts/tests/*' 2>/dev/null | wc -l | tr -d ' ')"
CJS_EXCLUDED="$(find scripts -name '*.cjs' -type f -not -path 'scripts/tests/*' 2>/dev/null | wc -l | tr -d ' ')"
EXCLUDED_DESC="scripts/tests/** ($TESTS_EXCLUDED .ts-family files, SMI-7006) + $MJS_EXCLUDED non-test .mjs + $CJS_EXCLUDED non-test .cjs (not TypeScript; computed dynamic import()/require() targets are also out of reach of any static resolver -- see the plan's finding 7 audit)"

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
TSC_RAW="$(mktemp_or_die)"
"$TSC_BIN" -p "$CONFIG" --pretty > "$TSC_RAW" 2>&1
TSC_RC=$?

TSC_CLEAN="$(mktemp_or_die)"
# Strip ANSI + NUL before any pattern match, for the same reason the edge-
# function gate does: a NUL byte can make some greps silently stop matching,
# and --pretty's color codes sit INSIDE diagnostic lines (between "error" and
# "TSxxxx", measured directly) rather than only around them.
perl -pe 's/\e\[[0-9;]*m//g; tr/\000//d' "$TSC_RAW" > "$TSC_CLEAN"

# A bare `error TSxxxx:` line with NO leading "path:line:col - " prefix is a
# GLOBAL/structural failure (e.g. TS2688 "Cannot find type definition file for
# 'node'"), not a per-file code diagnostic -- measured directly by breaking
# `types` in a scratch tsconfig. Checked BEFORE any counting, same ordering as
# the reference gate's module-graph-error check, because the error/attribution
# counts below would be meaningless if the compiler never got past loading its
# own configuration.
if grep -qE '^error TS[0-9]+:' "$TSC_CLEAN"; then
  inconclusive "module-resolution or global configuration failure (a diagnostic with no file:line:col -- not one of the 37/N per-file findings)"
  say "--- global diagnostic(s) ---"
  grep -A3 -E '^error TS[0-9]+:' "$TSC_CLEAN" | head -20
  NEXT_ACTION="resolve the global error first; any per-file count below would be meaningless"
  exit_for_inconclusive
fi

# REPORTED: tsc's own total, from the "Found N error(s) ..." line. Measured
# across three distinct shapes on TS 5.9.3 -- "Found 1 error in <path>:<line>"
# (singular, ALWAYS this form for exactly one error, regardless of project
# size), "Found N errors in M files." (plural, N>=2), and "Found 1 error."
# (bare, for a diagnostic with no project-file location at all). The anchor
# "^Found [0-9]+ errors?" matches the leading count in all three without ever
# trying to parse what follows it.
FOUND_LINES="$(grep -cE '^Found [0-9]+ errors?\b' "$TSC_CLEAN")"
if [[ "$FOUND_LINES" -eq 0 ]]; then
  if [[ "$TSC_RC" -eq 0 ]]; then
    REPORTED=0
  else
    inconclusive "tsc exited $TSC_RC with no parseable 'Found' total"
    say "--- raw tail ---"; tail -20 "$TSC_CLEAN"
    NEXT_ACTION="unrecognised tsc output for this version -- the parser above may need updating"
    exit_for_inconclusive
  fi
elif [[ "$FOUND_LINES" -eq 1 ]]; then
  REPORTED="$(grep -oE '^Found [0-9]+' "$TSC_CLEAN" | grep -oE '[0-9]+')"
else
  inconclusive "$FOUND_LINES 'Found' summary lines -- output shape unexpected, possibly truncated"
  say "--- raw tail ---"; tail -20 "$TSC_CLEAN"
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
# 6) is covered without a separate `timeout` wrapper: an unexpected status is
# already everything this check needs to know.
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
# "path:line:col - error TSxxxx: message" (measured); a continuation/context
# line never starts with "scripts/", so this counts exactly one line per
# diagnostic block, matching REPORTED's own unit.
ATTRIB="$(grep -cE '^scripts/[^:]+:[0-9]+:[0-9]+ - error TS[0-9]+:' "$TSC_CLEAN")"
BY_FILE="$(mktemp_or_die)"
grep -E '^scripts/[^:]+:[0-9]+:[0-9]+ - error TS[0-9]+:' "$TSC_CLEAN" \
  | sed -E 's/^(scripts\/[^:]+):.*/\1/' | sort | uniq -c \
  | awk '{n=$1; $1=""; sub(/^ /, ""); printf "%d\t%s\n", n, $0}' | sort -t$'\t' -k1,1nr > "$BY_FILE"
ERR_FILES="$(wc -l < "$BY_FILE" | tr -d ' ')"

# The hard reconciliation itself (finding 1/6). Two independently-derived
# counts -- tsc's own summary line, and this script's count of diagnostic
# headers -- must agree before either is trusted.
if [[ "$ATTRIB" -ne "$REPORTED" ]]; then
  ERR_FIELD="$REPORTED total / $ATTRIB attributed across $ERR_FILES files   [MISMATCH]"
  inconclusive "attribution ($ATTRIB) does not reconcile with tsc's own reported total ($REPORTED)"
  NEXT_ACTION="the header-line parser above is wrong for this tsc version/output shape. Do not trust the per-file numbers."
  say "--- raw tail, for the parser fix ---"; tail -20 "$TSC_CLEAN"
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
