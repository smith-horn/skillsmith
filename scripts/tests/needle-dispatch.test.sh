#!/usr/bin/env bash
# scripts/tests/needle-dispatch.test.sh — smoke tests for
# scripts/needle/dispatch.sh: the missing-binary contract (case 0, original
# SMI-5668 test) and the SMI-5700/SMI-5709 false-success + secret-scanner
# guard logic (cases 1-7). SMI-5847's bead-close + pre-flight-guard +
# zero-agent_message cases (8-14) live in the sibling
# needle-dispatch.bead-lifecycle.test.sh — split out to stay under this
# repo's 500-line-per-file limit; both source the shared fixture setup in
# scripts/tests/_lib/needle-dispatch-fixtures.sh.
#
# Usage: ./scripts/tests/needle-dispatch.test.sh

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib/needle-dispatch-fixtures.sh
source "$SELF_DIR/_lib/needle-dispatch-fixtures.sh"

FAIL_COUNT=0

# ---- Case 0 (original SMI-5668 test): missing-binary contract ----
# /usr/bin:/bin has bash + coreutils (dirname, basename, date, mktemp, cat)
# on both macOS and Linux, but not needle/bf/codex/jq — those install to
# ~/.cargo/bin, a package manager's bin dir, or an nvm shim, never /usr/bin
# or /bin. This guarantees check_binary fails on all four regardless of
# what's installed on this machine, without needing to fake out bash itself.
# Case 0's MINIMAL_PATH contract holds as long as everything new stays
# below check_binary's call site in dispatch.sh — verified true for the
# SMI-5847 pre-flight guard, which is placed well after it.
MINIMAL_PATH="/usr/bin:/bin"

set +e
PATH="$MINIMAL_PATH" "$DISPATCH" \
    --workspace /tmp \
    --title "smoke test" \
    --body-file "$SELF_DIR/needle-dispatch.test.sh" \
    >/tmp/needle-dispatch-test.out 2>&1
EXIT_CODE=$?
set -e

if [[ "$EXIT_CODE" -ne 2 ]]; then
    echo "FAIL (case 0): expected exit 2 (check_binary contract) with no binaries on PATH, got $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 0): dispatch.sh exits 2 when needle/bf/codex/jq are missing from PATH"
fi

# ---- Cases 1-5 (SMI-5700): false-success detection ----

# Case 1: sandbox-rejection stderr signature -> downgraded outcome, exit 1,
# WHEN --expect-write is set (SMI-5847: the pre-fix comment said "regardless
# of --expect-write" — now false; the downgrade is gated on --expect-write,
# see the bead-lifecycle test's case 12 for the analysis-only counterpart).
# This is still the SMI-5700 non-regression anchor for the --expect-write
# shape.
EXIT_CODE="$(run_case 1 rejected 0 "$GIT_WORKTREE_DIR" --expect-write)"
if [[ "$EXIT_CODE" -ne 1 ]] || ! grep -q "outcome=blocked-by-sandbox" /tmp/needle-dispatch-test-case1.out; then
    echo "FAIL (case 1): expected exit 1 and outcome=blocked-by-sandbox, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case1.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 1): sandbox-rejection stderr signature downgrades outcome when --expect-write is set"
fi

# Case 2: --expect-write + no diff -> flagged, exit 1.
EXIT_CODE="$(run_case 2 clean 0 "$GIT_WORKTREE_DIR" --expect-write)"
if [[ "$EXIT_CODE" -ne 1 ]] || ! grep -q "outcome=no-diff-despite-expected-write" /tmp/needle-dispatch-test-case2.out; then
    echo "FAIL (case 2): expected exit 1 and outcome=no-diff-despite-expected-write, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case2.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 2): --expect-write with no workspace diff is flagged"
fi

# Case 3: --expect-write + real diff -> success, exit 0.
EXIT_CODE="$(run_case 3 clean 1 "$GIT_WORKTREE_DIR" --expect-write)"
if [[ "$EXIT_CODE" -ne 0 ]] || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case3.out; then
    echo "FAIL (case 3): expected exit 0 and outcome=success, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case3.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 3): --expect-write with a real workspace diff reports success"
fi
rm -f "$GIT_WORKTREE_DIR/codex-output.txt"

# Case 4: analysis-only (no --expect-write) + no diff -> success, no
# regression. This is the exact shape of dispatch that worked correctly
# before SMI-5700 and must keep working identically after it.
EXIT_CODE="$(run_case 4 clean 0 "$GIT_WORKTREE_DIR")"
if [[ "$EXIT_CODE" -ne 0 ]] || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case4.out; then
    echo "FAIL (case 4): expected exit 0 and outcome=success (analysis-only, no regression), got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case4.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 4): analysis-only dispatch (no --expect-write) still reports success — no regression"
fi

# Case 5: non-git --workspace -> diff check is skipped cleanly, no crash,
# even with --expect-write set (the guard must not let an unguarded git
# call abort the script under set -euo pipefail). Also confirms the
# SMI-5847 pre-flight guard's 'bf count'/'bf list' calls work fine against
# a non-git scratch directory too (they never touch git at all).
EXIT_CODE="$(run_case 5 clean 0 "$NONGIT_SCRATCH_DIR" --expect-write)"
if [[ "$EXIT_CODE" -ne 0 ]] || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case5.out; then
    echo "FAIL (case 5): expected exit 0 and outcome=success (non-git workspace, diff check skipped), got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case5.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 5): non-git --workspace skips the diff check without crashing"
fi

# ---- Cases 6-7 (SMI-5709): secret-scanner compatibility guard ----
# A 50-char hex run (matches [A-Za-z0-9/_-], mirrors a realistic long
# token/path) — distinct characters, not a repeated single char, so "the
# full run never appears in output" is a meaningful assertion rather than
# trivially true/false from repetition.
LONG_RUN="$(openssl rand -hex 25)"
LONG_RUN_BODY_FILE="$(mktemp)"
printf 'some prompt text\n%s\nmore prompt text\n' "$LONG_RUN" > "$LONG_RUN_BODY_FILE"

# Case 6: title contains a 44+ char run -> guard fires before any bf/codex
# invocation, exit 1, output shows a redacted preview (contains the ellipsis
# marker) but never the full matched run.
set +e
PATH="$TEST_PATH" "$DISPATCH" \
    --workspace "$GIT_WORKTREE_DIR" \
    --title "$LONG_RUN" \
    --body-file "$BODY_FILE" \
    --timeout 5 \
    >/tmp/needle-dispatch-test-case6.out 2>&1
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 1 ]] \
    || ! grep -q "…" /tmp/needle-dispatch-test-case6.out \
    || grep -qF "$LONG_RUN" /tmp/needle-dispatch-test-case6.out; then
    echo "FAIL (case 6): expected exit 1, a redacted (…) preview, and the full run absent from output, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case6.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 6): a 44+ char run in the title fails fast with a redacted preview, never the full match"
fi

# Case 7: same long run, but in the body, with the guard disabled via its
# registered opt-out var -> guard is skipped (no redaction message), and
# the dispatch proceeds through the faked bf/needle stack to success.
#
# FAKE_OUTCOME_FILE must be reset here (this case bypasses run_case, which
# would otherwise do it): case 5's own run left a real "outcome.classified"
# event in it, and without a reset dispatch.sh's poll loop finds that STALE
# event on its very first check, before the backgrounded fake 'needle run'
# for THIS case has had a chance to write test-bead-2's trace files —
# dispatch.sh then SIGTERMs it mid-execution (caught live: the killed
# process never reached its own stdout.txt write, which Wave 2 Step 3's
# zero-agent_message check then correctly, but confusingly, flagged).
: > "$FAKE_OUTCOME_FILE"
EXIT_CODE="$(SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1 FAKE_SCENARIO=clean FAKE_TOUCH_FILE=0 PATH="$TEST_PATH" "$DISPATCH" \
    --workspace "$GIT_WORKTREE_DIR" \
    --title "fixture case 7" \
    --body-file "$LONG_RUN_BODY_FILE" \
    --timeout 5 \
    >/tmp/needle-dispatch-test-case7.out 2>&1; echo $?)"
if [[ "$EXIT_CODE" -ne 0 ]] \
    || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case7.out \
    || ! grep -q "SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1" /tmp/needle-dispatch-test-case7.out; then
    echo "FAIL (case 7): expected exit 0, outcome=success, and the opt-out warning, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case7.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 7): SKILLSMITH_NEEDLE_SECRET_GUARD_DISABLE=1 skips the guard and the dispatch proceeds"
fi
rm -f "$LONG_RUN_BODY_FILE"

# ---- Results-log isolation regression (Wave 3 Step 3) ----
REAL_RESULTS_SNAPSHOT_AFTER="$(snapshot_real_results_dir)"
if [[ "$REAL_RESULTS_SNAPSHOT_BEFORE" != "$REAL_RESULTS_SNAPSHOT_AFTER" ]]; then
    echo "FAIL (results-log isolation): scripts/needle/results/ changed during this test run — SKILLSMITH_NEEDLE_RESULTS_DIR isolation is broken; test fakes are polluting the operator's real dispatch log" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (results-log isolation): scripts/needle/results/ is unchanged after this test run"
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
    echo "FAILED: $FAIL_COUNT case(s) failed" >&2
    exit 1
fi

echo "PASS: all needle-dispatch.test.sh cases passed"
