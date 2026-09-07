#!/usr/bin/env bash
# scripts/tests/check-container-deps-fresh-lock.test.sh
# SMI-6006 — scripts/lib/check-container-deps-fresh-inner.sh lock-contention
# tests (Scenarios 5-9): live-lock-wait, dead-lock-reclaim, a truly
# concurrent barrier-synchronized race, the multi-reclaimer TOCTOU race, and
# ownership-token unit tests.
#
# SMI-6437: split out of check-container-deps-fresh.test.sh, which had grown
# to 464/500 lines before that plan's new native-module-verification
# scenarios — this cluster is topically self-contained (it exercises the
# mkdir-based lock mechanism, not the dispatcher's own RC/probe handling),
# which is why it's the natural split boundary. Sources the same shared
# setup as the sibling file, mirroring the
# scripts/tests/_lib/needle-dispatch-fixtures.sh precedent.
#
# Run: bash scripts/tests/check-container-deps-fresh-lock.test.sh
#
# File-wide: every scenario below sets
# FAKE_* / SKILLSMITH_* vars that are read only inside run_guard() (defined
# in the sourced fixtures file), and reads $pass/$fail (assigned by that
# same file's assert_eq()). Shellcheck's cross-file dataflow analysis
# resolves this correctly for all but the LAST assignment of each name in
# this file — a moving target as scenarios are added/removed — so this is
# suppressed file-wide rather than chased line-by-line (empirically
# confirmed: the original, pre-split single file had zero such warnings,
# since run_guard()'s own reads and every assignment lived in the same
# file; splitting is what exposed this specific shellcheck limitation).
# shellcheck disable=SC2034,SC2154

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib/check-container-deps-fresh-fixtures.sh
source "$SELF_DIR/_lib/check-container-deps-fresh-fixtures.sh"

# =========================================================================
# Scenario 5: lock held by a live PID — waiter fails safely, no npm install
# =========================================================================
MAIN5="$TMP_ROOT/main5"
APP5="$TMP_ROOT/app5"
setup_main_repo "$MAIN5"
setup_fake_app_dir "$APP5" stale
mkdir -p "$APP5/node_modules/.skillsmith-deps-lock"
# A live process to be the "owner" — this test script's own PID is alive
# for the duration of this scenario.
printf '%s:%s\n' "$$" "$(date +%s)" > "$APP5/node_modules/.skillsmith-deps-lock/owner"
FAKE_APP_DIR="$APP5"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
SKILLSMITH_LOCK_MAX_TRIES=2
SKILLSMITH_LOCK_SLEEP_SECS=0
rc=$(run_guard "$MAIN5")
SKILLSMITH_LOCK_MAX_TRIES=45
SKILLSMITH_LOCK_SLEEP_SECS=2
assert_eq "S5: lock held by live PID -> guard fails (not silently proceeding)" "1" "$rc"
assert_eq "S5: npm install NOT called while waiting on a live lock" "0" "$(npm_call_count)"
rm -rf "$APP5/node_modules/.skillsmith-deps-lock"

# =========================================================================
# Scenario 6: lock held by a dead PID — reclaimed, self-heal proceeds
# =========================================================================
MAIN6="$TMP_ROOT/main6"
APP6="$TMP_ROOT/app6"
setup_main_repo "$MAIN6"
setup_fake_app_dir "$APP6" stale
mkdir -p "$APP6/node_modules/.skillsmith-deps-lock"
# A definitely-dead PID (a backgrounded subshell, waited on so it's reaped).
( : ) &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null || true
printf '%s:%s\n' "$DEAD_PID" "$(date +%s)" > "$APP6/node_modules/.skillsmith-deps-lock/owner"
FAKE_APP_DIR="$APP6"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
rc=$(run_guard "$MAIN6")
assert_eq "S6: lock held by dead PID is reclaimed, self-heal proceeds" "0" "$rc"
assert_eq "S6: npm install called exactly once after reclaim" "1" "$(npm_call_count)"
NEW_HASH6=$(cat "$APP6/node_modules/.skillsmith-deps-hash")
EXPECTED_HASH6=$(sha256sum "$APP6/package-lock.json" | cut -d' ' -f1)
assert_eq "S6: sentinel rewritten after reclaim" "$EXPECTED_HASH6" "$NEW_HASH6"

# =========================================================================
# Scenario 7: two truly concurrent invocations against a stale (no existing
# lock) tree, synchronized with a BARRIER rather than a hopeful sleep — B is
# only started once A's own fake npm has recorded that it actually began
# installing, so this deterministically proves the lock (not scheduling
# luck) is what keeps B from also installing. Per review: a sleep-based
# "widen the window" approach could pass even for an unlocked implementation
# if B merely happened to start after A finished.
# =========================================================================
MAIN7A="$TMP_ROOT/main7a"
MAIN7B="$TMP_ROOT/main7b"
APP7="$TMP_ROOT/app7"
setup_main_repo "$MAIN7A"
setup_main_repo "$MAIN7B"
setup_fake_app_dir "$APP7" stale
# No ambient FAKE_APP_DIR here (SMI-6437 cleanup): both subshell invocations
# below set their own FAKE_APP_DIR="$APP7" inline, so an ambient copy here
# would never be read (same genuinely-unused pattern as Scenario 8's own
# cleanup further down in this file).
FAKE_DOCKER_LOG_A=$(mktemp)
FAKE_DOCKER_LOG_B=$(mktemp)
: > "$NPM_CALL_LOG"
FAKE_NPM_DELAY=2   # A stays "inside" the install long enough for B to attempt entry

LOG_A="$TMP_ROOT/s7-a.rc"
LOG_B="$TMP_ROOT/s7-b.rc"
( cd "$MAIN7A" && FAKE_APP_DIR="$APP7" FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG_A" FAKE_NPM_DELAY="$FAKE_NPM_DELAY" SKILLSMITH_NATIVE_CHECK_TEST=ok "$GUARD" </dev/null; echo $? > "$LOG_A" ) &
PID_A=$!

# Barrier: block here until A's fake npm has actually recorded a call —
# proves B starts DURING A's install, not merely "probably around the same
# time". 10s cap so a genuine regression fails the test instead of hanging.
barrier_tries=0
while [ ! -s "$NPM_CALL_LOG" ] && [ "$barrier_tries" -lt 100 ]; do
  sleep 0.1
  barrier_tries=$((barrier_tries + 1))
done
assert_eq "S7: barrier — A's install actually started before B launches" "yes" "$([ -s "$NPM_CALL_LOG" ] && echo yes || echo no)"

( cd "$MAIN7B" && FAKE_APP_DIR="$APP7" FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG_B" FAKE_NPM_DELAY="$FAKE_NPM_DELAY" SKILLSMITH_NATIVE_CHECK_TEST=ok "$GUARD" </dev/null; echo $? > "$LOG_B" ) &
PID_B=$!
wait "$PID_A" "$PID_B"
FAKE_NPM_DELAY=0
RC_A=$(cat "$LOG_A"); RC_B=$(cat "$LOG_B")
assert_eq "S7: invocation A exits 0" "0" "$RC_A"
assert_eq "S7: invocation B exits 0" "0" "$RC_B"
assert_eq "S7: npm install called exactly once despite B starting mid-install" "1" "$(npm_call_count)"

# =========================================================================
# Scenario 8: two waiters observe the SAME dead-owner lock and race to
# reclaim it, while a fresh acquirer may slip in between — this is the
# multi-reclaimer TOCTOU this design's RECLAIM_DIR mutex exists to close.
# Deterministic guarantee is weaker than Scenario 7 (no barrier point exists
# mid-mkdir to synchronize on), but two processes launched back-to-back
# against the same pre-seeded dead lock reliably contend for the SAME
# reclaim window in practice — the assertion that matters is that exactly
# ONE self-heal (one npm install) ever results, never zero, never more than
# one, and never a corrupted lock state that hangs both.
# =========================================================================
MAIN8A="$TMP_ROOT/main8a"
MAIN8B="$TMP_ROOT/main8b"
APP8="$TMP_ROOT/app8"
setup_main_repo "$MAIN8A"
setup_main_repo "$MAIN8B"
setup_fake_app_dir "$APP8" stale
mkdir -p "$APP8/node_modules/.skillsmith-deps-lock"
( : ) &
DEAD_PID8=$!
wait "$DEAD_PID8" 2>/dev/null || true
printf '%s:0\n' "$DEAD_PID8" > "$APP8/node_modules/.skillsmith-deps-lock/owner"
# Genuinely unused ambient assignment removed here (SMI-6437 cleanup): both
# subshell invocations below set their own FAKE_APP_DIR="$APP8" inline —
# this one had no reader even in the original pre-split file, just masked
# by run_guard()'s genuine reads for OTHER scenarios being in the same file.
: > "$NPM_CALL_LOG"

LOG_8A="$TMP_ROOT/s8-a.rc"
LOG_8B="$TMP_ROOT/s8-b.rc"
( cd "$MAIN8A" && FAKE_APP_DIR="$APP8" FAKE_DOCKER_LOG="$(mktemp)" SKILLSMITH_NATIVE_CHECK_TEST=ok "$GUARD" </dev/null; echo $? > "$LOG_8A" ) &
PID_8A=$!
( cd "$MAIN8B" && FAKE_APP_DIR="$APP8" FAKE_DOCKER_LOG="$(mktemp)" SKILLSMITH_NATIVE_CHECK_TEST=ok "$GUARD" </dev/null; echo $? > "$LOG_8B" ) &
PID_8B=$!
wait "$PID_8A" "$PID_8B"
RC_8A=$(cat "$LOG_8A"); RC_8B=$(cat "$LOG_8B")
assert_eq "S8: invocation A exits 0" "0" "$RC_8A"
assert_eq "S8: invocation B exits 0" "0" "$RC_8B"
assert_eq "S8: exactly one self-heal resulted from the dead-lock reclaim race" "1" "$(npm_call_count)"
assert_eq "S8: no lock left behind after both finish" "no" "$([ -d "$APP8/node_modules/.skillsmith-deps-lock" ] && echo yes || echo no)"

# =========================================================================
# Scenario 9: ownership-token unit test — sources check-container-deps-fresh-inner.sh
# directly (SKILLSMITH_LOCK_TEST_SOURCE=1 skips its main flow, leaving
# acquire()/release()/try_reclaim() defined) and calls release() with a
# STALE token against a lock a DIFFERENT token has since legitimately
# re-acquired. No docker/npm/subshells involved — this is a pure unit test
# of the exact property the PID+nonce token exists to guarantee: release()
# must only ever remove a lock whose owner file still names ITS OWN token.
# =========================================================================
APP9="$TMP_ROOT/app9"
rm -rf "$APP9"
mkdir -p "$APP9/node_modules"
(
  cd "$APP9" || exit 1
  # shellcheck disable=SC2034  # read by the sourced INNER file, which shellcheck can't statically follow (dynamic path)
  SKILLSMITH_LOCK_TEST_SOURCE=1
  # shellcheck source=/dev/null
  . "$INNER"

  mkdir -p node_modules/.skillsmith-deps-lock
  # A DIFFERENT holder's token — simulates "someone else has since
  # legitimately reclaimed and re-acquired this lock" (MY_TOKEN, from this
  # sourced instance, was never the one that wrote it).
  echo "999999:someone-elses-nonce" > node_modules/.skillsmith-deps-lock/owner

  release   # must be a no-op: MY_TOKEN != the file's content

  if [ -f node_modules/.skillsmith-deps-lock/owner ] && \
     [ "$(cat node_modules/.skillsmith-deps-lock/owner)" = "999999:someone-elses-nonce" ]; then
    echo PASS
  else
    echo FAIL
  fi
) > "$TMP_ROOT/s9-result.txt" 2>&1
S9_RESULT=$(tail -1 "$TMP_ROOT/s9-result.txt")
assert_eq "S9: release() never removes a lock it does not own (ownership-token check)" "PASS" "$S9_RESULT"

# Sanity check the SAME unit-test seam correctly removes a lock it DOES own —
# proves S9 above is testing the real guard, not a seam that always no-ops.
APP9B="$TMP_ROOT/app9b"
rm -rf "$APP9B"
mkdir -p "$APP9B/node_modules"
(
  cd "$APP9B" || exit 1
  # shellcheck disable=SC2034  # read by the sourced INNER file, which shellcheck can't statically follow (dynamic path)
  SKILLSMITH_LOCK_TEST_SOURCE=1
  # shellcheck source=/dev/null
  . "$INNER"

  mkdir -p node_modules/.skillsmith-deps-lock
  printf "%s\n" "$MY_TOKEN" > node_modules/.skillsmith-deps-lock/owner

  release

  if [ ! -e node_modules/.skillsmith-deps-lock ]; then
    echo PASS
  else
    echo FAIL
  fi
) > "$TMP_ROOT/s9b-result.txt" 2>&1
S9B_RESULT=$(tail -1 "$TMP_ROOT/s9b-result.txt")
assert_eq "S9b: release() DOES remove a lock it owns (seam sanity check)" "PASS" "$S9B_RESULT"

echo ""
echo "======================================"
echo "Results: $pass passed, $fail failed"
echo "======================================"
[ "$fail" -eq 0 ]
