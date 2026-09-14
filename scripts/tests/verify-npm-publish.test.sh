#!/usr/bin/env bash
# Behavioural tests for scripts/ci/verify-npm-publish.sh (SMI-6497).
#
# Modeled on scripts/tests/deploy-detection.test.sh: stub the external
# commands the helper shells out to (npm, sleep) via a directory prepended
# to PATH, drive the helper as a real `bash scripts/ci/verify-npm-publish.sh
# <pkg> <version>` subprocess, and assert exit status + observed npm-call
# count + specific output lines.
#
# SCOPE. This file covers the verify-npm-publish.sh HELPER only (the
# in-loop probe + final-probe rescue). C4 and C6 from the SMI-6497 measured
# table belong to the SMOKE TAIL, which is now a separate workflow step
# with its own test file -- they are deliberately NOT reproduced here.
#
# NPM-CALL COUNTING. The counter lives in a FILE (one appended line per
# call, counted with `wc -l`), never a shell variable. Each npm-stub
# invocation is a brand new subprocess -- nothing about a shell variable's
# state from one invocation is visible to the next regardless of
# subshells, since the helper's own loop probe runs inside
# `LIVE=$(npm view ...)`, a command-substitution subshell. An earlier
# attempt at this harness tried to track the count in a way that did not
# survive across those process boundaries and produced a clean-looking but
# wrong table. A counter FILE, appended to and re-read with `wc -l`, is
# what actually survives.
#
# SPEED. `sleep` is stubbed to a no-op so the exhaustion path (30 in-loop
# probes + 1 final probe) costs no real time. The helper's own
# VERIFY_MAX_ATTEMPTS=30 / VERIFY_INTERVAL=10 assignments are NEVER
# overridden here -- see the budget-override case below, which exists
# specifically to prove that ambient VERIFY_MAX_ATTEMPTS/VERIFY_INTERVAL
# exports do NOT change the helper's behaviour. Do not add a test-only
# speedup env var to the helper; speed comes only from stubbing sleep.
#
# HELPER_UNDER_TEST lets a manual verification run point this harness at a
# mutated COPY of the helper (see SMI-6497's verification log) without
# ever editing the real helper. Defaults to the real one.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
HELPER="${HELPER_UNDER_TEST:-$SCRIPT_DIR/ci/verify-npm-publish.sh}"

if [ ! -f "$HELPER" ]; then
  echo "FAIL: $HELPER not found"
  exit 1
fi

fail=0

# --- stub PATH: npm + sleep ------------------------------------------------
STUBDIR=$(mktemp -d)
trap 'rm -rf "$STUBDIR"' EXIT

cat > "$STUBDIR/sleep" <<'SLEEP_STUB'
#!/usr/bin/env bash
exit 0
SLEEP_STUB
chmod +x "$STUBDIR/sleep"

# npm stub. Behaviour is selected per-case via $NPM_STUB_MODE (a file
# holding one of: succeed_first | never | final_only). Every invocation
# appends one line to $NPM_STUB_COUNTER (a file), which is how call counts
# survive across the many separate npm subprocesses the helper spawns.
cat > "$STUBDIR/npm" <<'NPM_STUB'
#!/usr/bin/env bash
echo x >> "$NPM_STUB_COUNTER"
# Record the COMPLETE argument vector, one invocation per line, with every
# argument wrapped in | delimiters. Reading only the package spec would let any
# probe flag be deleted with every case still green -- the gap the retired
# VB-R3-FRAGMENT-LOST guard covered. Recording "$*" instead is NOT enough: it
# collapses argument boundaries, so a substring test then accepts
# `--offline=false-bogus` or `prefix--no-json` as if the real flag were present.
# The delimiters make the assertion an exact-token test.
if [ -n "${NPM_STUB_ARGV:-}" ]; then
  _argv_line='|'
  for _a in "$@"; do _argv_line="${_argv_line}${_a}|"; done
  printf '%s\n' "$_argv_line" >> "$NPM_STUB_ARGV"
fi
CALLNUM=$(wc -l < "$NPM_STUB_COUNTER" | tr -d ' ')
MODE=$(cat "$NPM_STUB_MODE")
# args: view "<pkg>@<version>" version --no-json ... -- extract the
# requested version from the package spec (text after the LAST @, so a
# scoped @org/pkg spec is unaffected).
SPEC="$2"
REQ_VERSION="${SPEC##*@}"
case "$MODE" in
  succeed_first)
    echo "$REQ_VERSION"
    exit 0
    ;;
  never)
    echo ""
    exit 1
    ;;
  final_only)
    # Deterministic because the helper's loop is fixed at 30 attempts
    # (never honours ambient overrides -- that is what the
    # budget-override case pins): call 31 is always the final probe.
    if [ "$CALLNUM" -ge 31 ]; then
      echo "$REQ_VERSION"
    else
      echo ""
    fi
    exit 0
    ;;
  *)
    echo "npm stub: unknown NPM_STUB_MODE '$MODE'" >&2
    exit 99
    ;;
esac
NPM_STUB
chmod +x "$STUBDIR/npm"

# run_case NAME PKG VERSION NPM_MODE EXPECT_EXIT EXPECT_CALLS STDOUT_GREP [EXTRA_ENV...]
# EXTRA_ENV entries are NAME=value strings applied only to this invocation
# (used by the budget-override case).
run_case() {
  local name="$1" pkg="$2" version="$3" npm_mode="$4" \
    expect_exit="$5" expect_calls="$6" stdout_grep="$7"
  shift 7
  local casedir counter modefile actual_exit actual_calls ok=1

  casedir=$(mktemp -d)
  counter="$casedir/calls"
  : > "$counter"
  modefile="$casedir/mode"
  printf '%s' "$npm_mode" > "$modefile"

  set +e
  env "$@" PATH="$STUBDIR:$PATH" NPM_STUB_COUNTER="$counter" NPM_STUB_MODE="$modefile" \
    NPM_STUB_ARGV="$casedir/argv" \
    bash "$HELPER" "$pkg" "$version" > "$casedir/stdout" 2> "$casedir/stderr"
  actual_exit=$?
  set -e

  actual_calls=$(wc -l < "$counter" | tr -d ' ')

  [ "$actual_exit" = "$expect_exit" ] || ok=0
  [ "$actual_calls" = "$expect_calls" ] || ok=0
  if [ -n "$stdout_grep" ]; then
    grep -qF -- "$stdout_grep" "$casedir/stdout" || ok=0
  fi

  if [ "$ok" = "1" ]; then
    echo "PASS $name"
  else
    echo "FAIL $name: exit=$actual_exit(want $expect_exit) calls=$actual_calls(want $expect_calls) stdout_has='$stdout_grep'?"
    echo "  --- stdout ---"
    sed 's/^/  /' "$casedir/stdout"
    echo "  --- stderr ---"
    sed 's/^/  /' "$casedir/stderr"
    fail=1
  fi
  rm -rf "$casedir"
}

# run_missing_arg_case NAME PKG EXPECT_EXIT STDERR_GREP EXPECT_CALLS
# Separate from run_case: only ONE positional arg reaches the helper (the
# version argument is omitted, not empty), and the assertion is on stderr
# (the `set -u` unbound-variable message), not stdout.
run_missing_arg_case() {
  local name="$1" pkg="$2" expect_exit="$3" stderr_grep="$4" expect_calls="$5"
  local casedir counter modefile actual_exit actual_calls ok=1

  casedir=$(mktemp -d)
  counter="$casedir/calls"
  : > "$counter"
  modefile="$casedir/mode"
  printf '%s' "never" > "$modefile"

  set +e
  PATH="$STUBDIR:$PATH" NPM_STUB_COUNTER="$counter" NPM_STUB_MODE="$modefile" \
    bash "$HELPER" "$pkg" > "$casedir/stdout" 2> "$casedir/stderr"
  actual_exit=$?
  set -e

  actual_calls=$(wc -l < "$counter" | tr -d ' ')

  [ "$actual_exit" = "$expect_exit" ] || ok=0
  [ "$actual_calls" = "$expect_calls" ] || ok=0
  grep -qF -- "$stderr_grep" "$casedir/stderr" || ok=0

  if [ "$ok" = "1" ]; then
    echo "PASS $name"
  else
    echo "FAIL $name: exit=$actual_exit(want $expect_exit) calls=$actual_calls(want $expect_calls) stderr_has='$stderr_grep'?"
    echo "  --- stderr ---"
    sed 's/^/  /' "$casedir/stderr"
    fail=1
  fi
  rm -rf "$casedir"
}

# C1 -- npm returns the version on attempt 1.
run_case "C1_attempt1_success" "mypkg" "1.2.3" "succeed_first" \
  0 1 "verified live on npm (attempt 1)"

# C2 -- npm never returns it in-loop, but the FINAL probe rescues it.
run_case "C2_final_probe_rescue" "mypkg" "1.2.3" "final_only" \
  0 31 "(final probe)"

# C3 -- npm never returns it at all: full budget exhausted, ::error:: line.
run_case "C3_exhausted_error" "mypkg" "1.2.3" "never" \
  1 31 "::error::"

# C5 -- PINNED DEFECT (SMI-6655, SMI-6497 D-4/FT-5). VERSION="" makes the
# helper's very first comparison '' = '' true without ever confirming a
# real version landed on npm. This asserts CURRENT, KNOWN-WRONG behaviour
# -- it is preserved deliberately per D-4, not endorsed as correct by this
# test passing. If SMI-6655 is fixed, this case's expectations (1 call,
# exit 0) must change along with the fix.
run_case "C5_empty_version_FT5_defect_SMI6655" "mypkg" "" "never" \
  0 1 "verified live on npm (attempt 1)"

# M4a -- version argument missing entirely. `set -u` turns the missing
# positional parameter into an immediate failure before npm is ever
# invoked (0 calls) -- this is what stops a missing arg from silently
# degrading into the same shape as the C5 defect via an
# accidentally-empty VERSION.
run_missing_arg_case "M4a_missing_version_arg" "mypkg" 1 "unbound variable" 0

# M4b -- both arguments present and normal: behaves exactly like C1 (same
# code path -- see the verification report). Kept as its own case because
# it is the explicit "this still works normally" contrast to M4a, not
# because it exercises different logic.
run_case "M4b_both_args_normal" "otherpkg" "9.9.9" "succeed_first" \
  0 1 "verified live on npm (attempt 1)"

# Budget-override -- ambient VERIFY_MAX_ATTEMPTS/VERIFY_INTERVAL exports
# must NOT change the helper's behaviour. The values chosen (2 attempts /
# 1s interval) would collapse the exhaustion path to 3 npm calls and a "2
# attempts over 2s" error IF the helper honoured them. It doesn't: the
# helper hardcodes the production budget unconditionally, so the observed
# numbers must still be the 30-attempt/300s production budget.
run_case "budget_override_ignored" "mypkg" "1.2.3" "never" \
  1 31 "30 attempts over 300s" "VERIFY_MAX_ATTEMPTS=2" "VERIFY_INTERVAL=1"

# Registry-safety flags. SMI-6493's whole point is that an unpinned probe agrees
# with a redirected publish and both go green while npmjs never received the
# release. The retired VB-R3-FRAGMENT-LOST guard is what used to stop one of
# these being dropped; this case is its successor. It asserts on EVERY recorded
# invocation, so it covers the loop probe and the final probe alike -- pinning
# only one of the two would leave the other free to drift.
REQUIRED_FLAGS='--no-json --offline=false --prefer-offline=false --registry=https://registry.npmjs.org'
flagdir=$(mktemp -d)
: > "$flagdir/calls"
printf '%s' never > "$flagdir/mode"
: > "$flagdir/argv"
set +e
PATH="$STUBDIR:$PATH" NPM_STUB_COUNTER="$flagdir/calls" NPM_STUB_MODE="$flagdir/mode" \
  NPM_STUB_ARGV="$flagdir/argv" \
  bash "$HELPER" mypkg 1.2.3 > "$flagdir/stdout" 2> "$flagdir/stderr"
set -e
flag_calls=$(wc -l < "$flagdir/argv" | tr -d ' ')
flag_ok=1
# 31 = 30 in-loop probes + 1 final probe. If this drifts, the case below is
# silently checking fewer invocations than it claims to.
[ "$flag_calls" = "31" ] || flag_ok=0
# Exact-token match: "|--no-json|" cannot be satisfied by "--no-json=maybe" or
# by a longer argument that merely contains the flag as a substring.
for f in $REQUIRED_FLAGS; do
  missing=$(grep -cvF -- "|$f|" "$flagdir/argv" || true)
  [ "$missing" = "0" ] || { flag_ok=0; echo "  missing exact argument '$f' on $missing/$flag_calls invocation(s)"; }
done
if [ "$flag_ok" = "1" ]; then
  echo "PASS registry_flags_pinned_on_every_probe ($flag_calls/31 invocations, 4/4 flags)"
else
  echo "FAIL registry_flags_pinned_on_every_probe: calls=$flag_calls(want 31)"
  fail=1
fi
rm -rf "$flagdir"

if [ "$fail" -eq 1 ]; then
  echo ""
  echo "FAILURES above"
  exit 1
fi

echo ""
echo "all 8 cases passed"
