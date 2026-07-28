#!/usr/bin/env bash
# scripts/tests/needle-dispatch.bead-lifecycle.test.sh — SMI-5847 tests for
# scripts/needle/dispatch.sh's bead-close, stale-bead pre-flight guard, and
# zero-agent_message downgrade (cases 8-14). Split from the original
# needle-dispatch.test.sh (which keeps case 0 and the SMI-5700/5709 cases
# 1-7) to stay under this repo's 500-line-per-file limit; both source the
# shared fixture setup in scripts/tests/_lib/needle-dispatch-fixtures.sh.
#
# Usage: ./scripts/tests/needle-dispatch.bead-lifecycle.test.sh

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib/needle-dispatch-fixtures.sh
source "$SELF_DIR/_lib/needle-dispatch-fixtures.sh"

FAIL_COUNT=0

# Case 8: analysis-only success -> the bead is ACTUALLY closed. Against the
# pre-fix stateless fake ('bf show' hardcoded to [{"status":"done"}]), a
# no-op close would have passed this assertion invisibly — exactly the
# production defect (66/66 real dispatches left in_progress forever).
EXIT_CODE="$(run_case 8 clean 0 "$GIT_WORKTREE_DIR")"
BEAD_STATUS_8="$(PATH="$TEST_PATH" bf show test-bead-1 --format json --workspace "$GIT_WORKTREE_DIR" | jq -r '.[0].status')"
if [[ "$EXIT_CODE" -ne 0 ]] \
    || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case8.out \
    || [[ "$BEAD_STATUS_8" != "closed" ]] \
    || ! grep -q "bead_closed=yes" <<<"$(last_log_block)"; then
    echo "FAIL (case 8): expected exit 0, outcome=success, the bead's real state to be 'closed' (got '$BEAD_STATUS_8'), and bead_closed=yes in the log, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case8.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 8): analysis-only success actually closes the bead (bf show -> closed, bead_closed=yes)"
fi

# Case 9: a 'bf close' failure (FAKE_CLOSE_FAIL=1) is non-fatal -- the
# dispatch still succeeds (exit 0), the results-log line is still written,
# and a loud WARNING names the manual remediation command. Pins the '|| true'
# load-bearing detail in needle_close_bead()/lib.sh.
EXIT_CODE="$(FAKE_CLOSE_FAIL=1 run_case 9 clean 0 "$GIT_WORKTREE_DIR")"
if [[ "$EXIT_CODE" -ne 0 ]] \
    || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case9.out \
    || ! grep -q "WARNING: bead .* is NOT closed" /tmp/needle-dispatch-test-case9.out \
    || ! grep -q "bf close test-bead-1 --workspace" /tmp/needle-dispatch-test-case9.out \
    || ! grep -q "bead_closed=no" <<<"$(last_log_block)"; then
    echo "FAIL (case 9): expected exit 0, outcome=success, a NOT-closed WARNING with the manual remediation command, and bead_closed=no in the log, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case9.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 9): a 'bf close' failure is non-fatal — dispatch still succeeds, log block still written, WARNING names the manual remediation"
fi

# Case 10: pre-flight refusal on a pre-seeded stale (in_progress) bead ->
# exit 2, message names the stale bead, and 'bf create' is NEVER invoked
# (the guard must refuse before dispatch.sh commits to creating its own
# bead).
rm -rf "$GIT_WORKTREE_DIR/.beads"
PATH="$TEST_PATH" bf init --workspace "$GIT_WORKTREE_DIR" >/dev/null
STALE_ID_10="$(PATH="$TEST_PATH" bf create --title "stale case10" --description "d" --workspace "$GIT_WORKTREE_DIR")"
PATH="$TEST_PATH" bf update "$STALE_ID_10" --status in_progress --workspace "$GIT_WORKTREE_DIR" >/dev/null
: > "$FAKE_BF_CALL_LOG"
set +e
FAKE_SCENARIO=clean FAKE_TOUCH_FILE=0 PATH="$TEST_PATH" "$DISPATCH" \
    --workspace "$GIT_WORKTREE_DIR" \
    --title "fixture case 10" \
    --body-file "$BODY_FILE" \
    --timeout 5 \
    >/tmp/needle-dispatch-test-case10.out 2>&1
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 2 ]] \
    || ! grep -q "$STALE_ID_10" /tmp/needle-dispatch-test-case10.out \
    || grep -q "^bf create " "$FAKE_BF_CALL_LOG"; then
    echo "FAIL (case 10): expected exit 2, a refusal naming $STALE_ID_10, and 'bf create' never invoked, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case10.out >&2
    echo "--- bf call log ---" >&2
    cat "$FAKE_BF_CALL_LOG" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 10): pre-flight guard refuses (exit 2) on a pre-seeded in_progress bead, names it, and never reaches 'bf create'"
fi

# Case 11: same pre-seeded stale bead, but with
# SKILLSMITH_NEEDLE_STALE_BEAD_GUARD_DISABLE=1 -> the guard is skipped (skip
# warning present) and the dispatch proceeds to success for its OWN new
# bead.
rm -rf "$GIT_WORKTREE_DIR/.beads"
PATH="$TEST_PATH" bf init --workspace "$GIT_WORKTREE_DIR" >/dev/null
STALE_ID_11="$(PATH="$TEST_PATH" bf create --title "stale case11" --description "d" --workspace "$GIT_WORKTREE_DIR")"
PATH="$TEST_PATH" bf update "$STALE_ID_11" --status in_progress --workspace "$GIT_WORKTREE_DIR" >/dev/null
: > "$FAKE_OUTCOME_FILE"
set +e
SKILLSMITH_NEEDLE_STALE_BEAD_GUARD_DISABLE=1 FAKE_SCENARIO=clean FAKE_TOUCH_FILE=0 PATH="$TEST_PATH" "$DISPATCH" \
    --workspace "$GIT_WORKTREE_DIR" \
    --title "fixture case 11" \
    --body-file "$BODY_FILE" \
    --timeout 5 \
    >/tmp/needle-dispatch-test-case11.out 2>&1
EXIT_CODE=$?
set -e
if [[ "$EXIT_CODE" -ne 0 ]] \
    || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case11.out \
    || ! grep -q "SKILLSMITH_NEEDLE_STALE_BEAD_GUARD_DISABLE=1" /tmp/needle-dispatch-test-case11.out; then
    echo "FAIL (case 11): expected exit 0, outcome=success, and the guard-skip warning, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case11.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 11): SKILLSMITH_NEEDLE_STALE_BEAD_GUARD_DISABLE=1 skips the pre-flight guard and the dispatch proceeds"
fi

# Case 12: analysis-only (no --expect-write) + patch-rejected sandbox
# signature -> outcome STAYS success, sandbox_write_rejected=yes recorded
# in the log, and the stdout note flags it as incidental — today (pre-fix)
# this exits 1. The Wave 2 core regression test.
EXIT_CODE="$(run_case 12 rejected 0 "$GIT_WORKTREE_DIR")"
LOG_BLOCK_12="$(last_log_block)"
if [[ "$EXIT_CODE" -ne 0 ]] \
    || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case12.out \
    || ! grep -q "note=incidental-write-rejected" /tmp/needle-dispatch-test-case12.out \
    || ! grep -q "sandbox_write_rejected=yes" <<<"$LOG_BLOCK_12"; then
    echo "FAIL (case 12): expected exit 0, outcome=success, note=incidental-write-rejected, and sandbox_write_rejected=yes in the log, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case12.out >&2
    echo "--- log block ---" >&2
    echo "$LOG_BLOCK_12" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 12): analysis-only dispatch with an incidental sandbox write-rejection still reports success"
fi

# Case 13: the outcome-classified event is NEVER written (worker
# exits/crashes before classifying) -> exit 1 AND the bead still ends up
# closed. Pins the "close on every terminal path, including the
# poll-deadline-expiry path" decision (Wave 1 Step 4) so a refactor can't
# silently reverse it back into an orphan on this path.
EXIT_CODE="$(run_case 13 no_outcome 0 "$GIT_WORKTREE_DIR")"
BEAD_STATUS_13="$(PATH="$TEST_PATH" bf show test-bead-1 --format json --workspace "$GIT_WORKTREE_DIR" | jq -r '.[0].status')"
if [[ "$EXIT_CODE" -ne 1 ]] \
    || [[ "$BEAD_STATUS_13" != "closed" ]] \
    || ! grep -q "bead_closed=yes" <<<"$(last_log_block)"; then
    echo "FAIL (case 13): expected exit 1, the bead's real state to be 'closed' (got '$BEAD_STATUS_13'), and bead_closed=yes in the log, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case13.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 13): the bead is closed even when the poll loop never finds a classified outcome"
fi

# Case 14: zero-agent_message downgrade (Wave 2 Step 3).
# 14a: stdout.txt has no agent_message item on an otherwise-success run ->
# downgraded to success-without-agent-message, exit 1.
EXIT_CODE="$(FAKE_NO_AGENT_MESSAGE=1 run_case 14 clean 0 "$GIT_WORKTREE_DIR")"
if [[ "$EXIT_CODE" -ne 1 ]] || ! grep -q "outcome=success-without-agent-message" /tmp/needle-dispatch-test-case14.out; then
    echo "FAIL (case 14a): expected exit 1 and outcome=success-without-agent-message, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case14.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 14a): a success run with no agent_message in stdout.txt is downgraded"
fi

# 14b: stdout.txt DOES have an agent_message -> stays success. The default
# fixture shape (same as case 4/8), re-asserted here as case 14's own
# non-regression control so 14a's downgrade can't be a fixture artifact.
EXIT_CODE="$(run_case 14 clean 0 "$GIT_WORKTREE_DIR")"
if [[ "$EXIT_CODE" -ne 0 ]] || ! grep -q "outcome=success" /tmp/needle-dispatch-test-case14.out; then
    echo "FAIL (case 14b): expected exit 0 and outcome=success with an agent_message present, got exit $EXIT_CODE" >&2
    cat /tmp/needle-dispatch-test-case14.out >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
else
    echo "PASS (case 14b): a success run WITH an agent_message in stdout.txt is not downgraded"
fi

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

echo "PASS: all needle-dispatch.bead-lifecycle.test.sh cases passed"
