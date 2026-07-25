#!/usr/bin/env bash
# SMI-5813: Regression test for the `.claude/settings.json` hook `xargs -I`
# buffer-overflow bug (BSD xargs' default 255-byte replsize, ~244-byte
# effective ceiling, well below the 4096-byte truncation these hooks
# intended to allow).
#
# Three layers, all required (per the SPARC plan's "Smoke vs CI" section —
# GNU xargs on Linux CI does NOT reproduce the BSD-specific failure, so a
# single-layer test would give false confidence on Linux CI runners):
#
#   1. Structural (OS-independent, PRIMARY regression guard): asserts none
#      of the 5 hook command strings extracted live from .claude/settings.json
#      contain `xargs -I` or `xargs -0`. Runs everywhere, fails closed.
#   2. Shimmed xargs (OS-independent, DETERMINISTIC behavioral guard): a
#      test-only `xargs` reimplementing BSD's -I replsize=255 limit is
#      placed first on PATH. The OLD (pre-fix, from git history) command
#      string is run through it and MUST fail; the NEW (live) command
#      string no longer calls xargs at all, so it trivially isn't affected
#      by the shim, and is asserted to succeed with the full untruncated
#      value reaching the downstream flag.
#   3. Real BSD xargs (macOS only, BEST-EFFORT/INFORMATIONAL): same OLD
#      command string against the actual system `xargs` binary. Skipped
#      (not failed) on Linux, since GNU xargs' `-I` has a much larger
#      practical limit and won't reproduce the failure -- that's expected,
#      not a test gap, and is logged as SKIP rather than silently omitted.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
SETTINGS_JSON="$REPO_ROOT/.claude/settings.json"

fail=0
pass=0
skip=0

assert_true() {
  local name="$1" cond="$2"
  if [ "$cond" = "0" ]; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name"
    fail=$((fail + 1))
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name (expected to find '$needle')"
    fail=$((fail + 1))
  fi
}

# -----------------------------------------------------------------------
# Layer 1: Structural — live settings.json must not contain xargs -I/-0
# -----------------------------------------------------------------------
echo "--- Layer 1: structural (OS-independent primary guard) ---"
XARGS_HITS=$(grep -c "xargs -I\|xargs -0" "$SETTINGS_JSON" || true)
assert_true "settings.json has zero xargs -I/-0 instances (found: ${XARGS_HITS:-0})" \
  "$([ "${XARGS_HITS:-0}" -eq 0 ] && echo 0 || echo 1)"
BOUNDED_WRAPPER_HOOKS=$(jq '
  [.hooks.PreToolUse[], .hooks.PostToolUse[]]
  | map(.hooks[]
    | select(.command | contains("claude-hooks-log-wrapper.sh"))
    | select(.timeout > 0 and .timeout <= 5))
  | length
' "$SETTINGS_JSON")
assert_true "all 4 wrapper hooks have an explicit timeout of at most 5s (found: $BOUNDED_WRAPPER_HOOKS)" \
  "$([ "$BOUNDED_WRAPPER_HOOKS" -eq 4 ] && echo 0 || echo 1)"

# -----------------------------------------------------------------------
# Layer 2: shimmed xargs — deterministic OS-independent behavioral guard
# -----------------------------------------------------------------------
echo ""
echo "--- Layer 2: shimmed xargs (deterministic, OS-independent) ---"

SHIM_DIR=$(mktemp -d)
trap 'rm -rf "$SHIM_DIR"' EXIT

cat > "$SHIM_DIR/xargs" << 'SHIM_EOF'
#!/usr/bin/env bash
# Test-only shim reimplementing BSD xargs' documented -I replsize=255
# default (man xargs: "-S replsize ... The default for replsize is 255.").
# Only supports the -I {} form this repo's hooks used; anything else falls
# through to the real system xargs so this shim doesn't break other callers
# on PATH during the test run.
#
# Bash (not POSIX sh) deliberately, for real arrays -- substituting {}
# within each already-tokenized argv element and re-exec'ing that array
# directly (not concatenating into one string and re-splitting it) is
# required to preserve argv element boundaries when an element contains
# shell-meaningful characters like nested quotes (the real `sh -c '...'`
# hook payloads do). This is a TEST fixture only; the wrapper script under
# test stays POSIX sh and is separately verified under dash.
#
# The length check is against each argv element's length AFTER
# substitution, not the raw replacement text's length alone -- empirically
# verified against real BSD xargs (see Layer 3 below): a replacement as
# short as ~90 bytes still fails once embedded in the `sh -c 'CMD="{}"; ...'`
# template, because the template itself is long enough that the combined
# per-argv-element length crosses 255.
REPLSIZE=255
if [ "$1" = "-I" ]; then
  shift
  REPL="$1"
  shift
  INPUT=$(cat)
  args=()
  for a in "$@"; do
    subst="${a//$REPL/$INPUT}"
    if [ ${#subst} -ge "$REPLSIZE" ]; then
      echo "xargs: command line cannot be assembled, too long" >&2
      exit 1
    fi
    args+=("$subst")
  done
  exec "${args[@]}"
fi
exec /usr/bin/xargs "$@"
SHIM_EOF
chmod +x "$SHIM_DIR/xargs"

# The OLD (pre-fix) PreToolUse:Bash command string, transcribed verbatim
# from the live file's content before SMI-5813's fix (verified byte-for-byte
# against `.claude/settings.json` during plan-review, and re-verified against
# git history at authoring time). Deliberately NOT read via `git show HEAD~N`
# -- squash-merging this PR collapses history to one commit, so any relative
# HEAD~N offset that works today silently breaks the moment this lands on
# main, and a shallow CI checkout may not even have the needed history at
# all. A literal fixture is the only form of "the old command" that stays
# correct regardless of how this repo's history is later rewritten.
OLD_CMD='cat | jq -r '\''.tool_input.command // empty'\'' | head -c 4096 | tr '\''\n'\'' '\'' '\'' | xargs -I {} sh -c '\''CMD="{}"; if [ -n "$CMD" ]; then node node_modules/ruflo/bin/ruflo.js hooks pre-command --command "$CMD" --validate-safety true --prepare-resources true 2>/dev/null || true; fi'\'''

TEST_INPUT=$(python3 -c "import json; print(json.dumps({'tool_input':{'command':'git commit -m \"a moderately long commit message that exceeds the buffer\" --allow-empty'}}))")

OLD_OUT=$(printf '%s' "$TEST_INPUT" | PATH="$SHIM_DIR:$PATH" sh -c "$OLD_CMD" 2>&1)
OLD_RC=$?
assert_true "OLD command fails under shimmed BSD-behavior xargs (rc=$OLD_RC)" "$([ "$OLD_RC" -ne 0 ] && echo 0 || echo 1)"
assert_contains "OLD failure message matches the real reported bug" "$OLD_OUT" "command line cannot be assembled, too long"

# -----------------------------------------------------------------------
# New (live, post-fix) command string: no xargs involved at all, so the
# shim is irrelevant to it -- assert success + full untruncated value.
# -----------------------------------------------------------------------
NEW_CMD=$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[0].command' "$SETTINGS_JSON")
assert_true "live command string no longer references xargs" \
  "$(printf '%s' "$NEW_CMD" | grep -q "xargs" && echo 1 || echo 0)"

STUB_DIR=$(mktemp -d)
mkdir -p "$STUB_DIR/node_modules/ruflo/bin" "$STUB_DIR/scripts"
# The live call site routes through the real wrapper script (Part B) -- copy
# it into the stub project dir so this integration test exercises the real
# xargs-removal -> wrapper -> ruflo pipeline end-to-end, not just a fragment.
cp "$REPO_ROOT/scripts/claude-hooks-log-wrapper.sh" "$STUB_DIR/scripts/claude-hooks-log-wrapper.sh"
chmod +x "$STUB_DIR/scripts/claude-hooks-log-wrapper.sh"
cat > "$STUB_DIR/node_modules/ruflo/bin/ruflo.js" << 'NODE_EOF'
#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync('/tmp/claude-hooks-regression-argv-capture.json', JSON.stringify(process.argv.slice(2)));
process.exit(0);
NODE_EOF
rm -f /tmp/claude-hooks-regression-argv-capture.json
mkdir -p "$STUB_DIR/fakehome"
(cd "$STUB_DIR" && printf '%s' "$TEST_INPUT" | CLAUDE_PROJECT_DIR="$STUB_DIR" HOME="$STUB_DIR/fakehome" sh -c "$NEW_CMD" >/dev/null 2>&1)
NEW_RC=$?
assert_true "NEW command string succeeds (rc=$NEW_RC)" "$([ "$NEW_RC" -eq 0 ] && echo 0 || echo 1)"
if [ -f /tmp/claude-hooks-regression-argv-capture.json ]; then
  CAPTURED=$(cat /tmp/claude-hooks-regression-argv-capture.json)
  assert_contains "full untruncated command value reached the downstream --command flag" \
    "$CAPTURED" "a moderately long commit message that exceeds the buffer"
  rm -f /tmp/claude-hooks-regression-argv-capture.json
else
  echo "FAIL argv capture file was not written (NEW command may not have invoked ruflo.js)"
  fail=$((fail + 1))
fi
rm -rf "$STUB_DIR"

# -----------------------------------------------------------------------
# Layer 3: real BSD xargs — macOS only, best-effort/informational
# -----------------------------------------------------------------------
echo ""
echo "--- Layer 3: real system xargs (best-effort, macOS-only) ---"
if [ "$(uname -s)" = "Darwin" ]; then
  REAL_OUT=$(printf '%s' "$TEST_INPUT" | sh -c "$OLD_CMD" 2>&1)
  REAL_RC=$?
  assert_true "real BSD xargs fails on the OLD command (rc=$REAL_RC)" "$([ "$REAL_RC" -ne 0 ] && echo 0 || echo 1)"
  assert_contains "real BSD xargs failure message matches the actual reported bug" "$REAL_OUT" "command line cannot be assembled, too long"
else
  echo "SKIP real BSD xargs check -- not running on Darwin (GNU xargs on Linux does not reproduce this failure; expected, see SPARC plan doc's Smoke vs CI section)"
  skip=$((skip + 1))
fi

echo ""
echo "===== Results: $pass passed, $fail failed, $skip skipped ====="
[ "$fail" -eq 0 ] || exit 1
