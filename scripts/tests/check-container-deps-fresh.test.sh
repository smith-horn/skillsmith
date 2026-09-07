#!/usr/bin/env bash
# scripts/tests/check-container-deps-fresh.test.sh
# SMI-6006 — scripts/lib/check-container-deps-fresh.sh tests: basic
# dispatcher behavior (Scenarios 1-4) plus SMI-6437's post-self-heal
# native-module verification (the three new scenarios below).
#
# SMI-6437: split from the original single file, which had grown to 464/500
# lines before these new scenarios — the lock-contention cluster (Scenarios
# 5-9: live-lock-wait, dead-lock-reclaim, concurrent-barrier race,
# multi-reclaimer TOCTOU race, ownership-token unit tests) moved to
# scripts/tests/check-container-deps-fresh-lock.test.sh; both files now
# source the shared setup in scripts/tests/_lib/check-container-deps-fresh-fixtures.sh
# (mirrors the scripts/tests/_lib/needle-dispatch-fixtures.sh precedent).
#
# Run: bash scripts/tests/check-container-deps-fresh.test.sh
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
# Scenario 1: fresh container — no npm install call, exits 0
# =========================================================================
MAIN1="$TMP_ROOT/main1"
APP1="$TMP_ROOT/app1"
setup_main_repo "$MAIN1"
setup_fake_app_dir "$APP1" fresh
FAKE_APP_DIR="$APP1"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
rc=$(run_guard "$MAIN1")
assert_eq "S1: fresh container exits 0" "0" "$rc"
assert_eq "S1: npm install NOT called" "0" "$(npm_call_count)"

# =========================================================================
# Scenario 2: stale container — self-heal fires exactly once, sentinel rewritten
# =========================================================================
MAIN2="$TMP_ROOT/main2"
APP2="$TMP_ROOT/app2"
setup_main_repo "$MAIN2"
setup_fake_app_dir "$APP2" stale
FAKE_APP_DIR="$APP2"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
rc=$(run_guard "$MAIN2")
assert_eq "S2: stale container self-heals and exits 0" "0" "$rc"
assert_eq "S2: npm install called exactly once" "1" "$(npm_call_count)"
NEW_HASH=$(cat "$APP2/node_modules/.skillsmith-deps-hash" 2>/dev/null || echo MISSING)
EXPECTED_HASH=$(sha256sum "$APP2/package-lock.json" | cut -d' ' -f1)
assert_eq "S2: sentinel rewritten to match package-lock.json" "$EXPECTED_HASH" "$NEW_HASH"

# =========================================================================
# Scenario 3: worktree container — guard exits 0 immediately, ZERO docker calls
# =========================================================================
MAIN3="$TMP_ROOT/main3"
setup_main_repo "$MAIN3"
setup_worktree "$MAIN3" "wt3"
WT3="$MAIN3/.worktrees/wt3"
APP3="$TMP_ROOT/app3-should-be-untouched"
setup_fake_app_dir "$APP3" stale
FAKE_APP_DIR="$APP3"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
rc=$(run_guard "$WT3")
assert_eq "S3: worktree guard exits 0" "0" "$rc"
LOG=$(cat "$FAKE_DOCKER_LOG")
if [ -n "$LOG" ]; then
  assert_eq "S3: no 'exec' (mutation) docker calls from a worktree" "" "$(printf '%s\n' "$LOG" | grep '^exec' || true)"
else
  assert_eq "S3: no docker calls at all from a worktree" "" "$LOG"
fi
assert_eq "S3: npm install NOT called" "0" "$(npm_call_count)"

# =========================================================================
# Scenario 4: npm install failure — loud failure, non-zero exit, no sentinel
# write, and the lock is released (not left wedged for the next push)
# =========================================================================
MAIN4="$TMP_ROOT/main4"
APP4="$TMP_ROOT/app4"
setup_main_repo "$MAIN4"
setup_fake_app_dir "$APP4" stale
FAKE_APP_DIR="$APP4"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
FAKE_NPM_FAIL=1
rc=$(run_guard "$MAIN4")
FAKE_NPM_FAIL=0
assert_eq "S4: npm install failure exits non-zero" "1" "$rc"
assert_eq "S4: npm install was attempted exactly once" "1" "$(npm_call_count)"
POST_HASH=$(cat "$APP4/node_modules/.skillsmith-deps-hash")
assert_eq "S4: sentinel NOT rewritten after install failure" "0000000000000000000000000000000000000000000000000000000000000000" "$POST_HASH"
assert_eq "S4: lock released after install failure (not wedged)" "no" "$([ -d "$APP4/node_modules/.skillsmith-deps-lock" ] && echo yes || echo no)"

# =========================================================================
# Scenario 10 (SMI-6437): self-heal succeeds, but native bindings are
# broken — must now be a HARD FAILURE, not the old "self-healed" success.
# This is the regression test proving the fix actually changes behavior.
# =========================================================================
MAIN10="$TMP_ROOT/main10"
APP10="$TMP_ROOT/app10"
setup_main_repo "$MAIN10"
setup_fake_app_dir "$APP10" stale
FAKE_APP_DIR="$APP10"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
SKILLSMITH_NATIVE_CHECK_TEST=fail
rc=$(run_guard "$MAIN10")
unset SKILLSMITH_NATIVE_CHECK_TEST
assert_eq "S10: self-heal succeeds but broken native bindings -> hard failure" "1" "$rc"
assert_eq "S10: npm install still called exactly once" "1" "$(npm_call_count)"
assert_eq "S10: output mentions the SMI-6437 native-binding failure" "yes" "$(grep -q "native module bindings are still broken" "$GUARD_LAST_OUTPUT" && echo yes || echo no)"

# =========================================================================
# Scenario 11 (SMI-6437): self-heal succeeds AND native bindings are
# healthy — success must be preserved (proves the fix doesn't break the
# good path).
# =========================================================================
MAIN11="$TMP_ROOT/main11"
APP11="$TMP_ROOT/app11"
setup_main_repo "$MAIN11"
setup_fake_app_dir "$APP11" stale
FAKE_APP_DIR="$APP11"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
SKILLSMITH_NATIVE_CHECK_TEST=ok
rc=$(run_guard "$MAIN11")
unset SKILLSMITH_NATIVE_CHECK_TEST
assert_eq "S11: self-heal succeeds and native bindings healthy -> exit 0" "0" "$rc"
assert_eq "S11: output still shows the existing self-healed message" "yes" "$(grep -q "Self-healed" "$GUARD_LAST_OUTPUT" && echo yes || echo no)"

# =========================================================================
# Scenario 12 (SMI-6437): npm install fails AND native bindings are ALSO
# broken — the existing npm-failure message must additionally mention the
# native-binding remediation text.
# =========================================================================
MAIN12="$TMP_ROOT/main12"
APP12="$TMP_ROOT/app12"
setup_main_repo "$MAIN12"
setup_fake_app_dir "$APP12" stale
FAKE_APP_DIR="$APP12"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
FAKE_NPM_FAIL=1
SKILLSMITH_NATIVE_CHECK_TEST=fail
rc=$(run_guard "$MAIN12")
FAKE_NPM_FAIL=0
unset SKILLSMITH_NATIVE_CHECK_TEST
assert_eq "S12: npm install failure still exits non-zero" "1" "$rc"
assert_eq "S12: output additionally mentions native bindings ALSO broken" "yes" "$(grep -q "ALSO currently broken" "$GUARD_LAST_OUTPUT" && echo yes || echo no)"
assert_eq "S12: output still names the restart remedy" "yes" "$(grep -q "docker compose --profile dev restart dev" "$GUARD_LAST_OUTPUT" && echo yes || echo no)"

# =========================================================================
# Scenario 13 (SMI-6437, pr-reviewer finding): self-heal succeeds, but the
# native-probe script ITSELF is missing/unreadable — must be a hard failure
# too, not a silent fail-open pass. Temporarily renames the REAL,
# committed NATIVE_LIB via its absolute path (never a relative one — a
# cwd change elsewhere in this scenario must never break the restore).
# Deliberately does NOT use `trap ... EXIT` for the restore: this file
# already has one EXIT trap (the fixtures file's TMP_ROOT cleanup, sourced
# above) — a SECOND `trap ... EXIT` here would silently REPLACE it, and
# `trap - EXIT` afterward clears the slot rather than restoring what was
# there before, permanently losing that cleanup for the rest of the run.
# The one command between the two `mv` calls (`run_guard`) is already
# proven safe under this file's `set -euo pipefail` — its last action is
# always a successful `echo $?`, exactly like every other scenario's
# `rc=$(run_guard ...)` call above — so a plain sequential restore is
# sufficient without needing trap-based protection.
# =========================================================================
MAIN13="$TMP_ROOT/main13"
APP13="$TMP_ROOT/app13"
setup_main_repo "$MAIN13"
setup_fake_app_dir "$APP13" stale
FAKE_APP_DIR="$APP13"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
mv "$NATIVE_LIB" "$NATIVE_LIB.s13-bak"
rc=$(run_guard "$MAIN13")
mv "$NATIVE_LIB.s13-bak" "$NATIVE_LIB"
assert_eq "S13: self-heal succeeds but native-probe script is missing -> hard failure" "1" "$rc"
assert_eq "S13: output names the missing-probe reason" "yes" "$(grep -q "could not be verified" "$GUARD_LAST_OUTPUT" && echo yes || echo no)"
assert_eq "S13: real NATIVE_LIB restored" "yes" "$([ -x "$NATIVE_LIB" ] && echo yes || echo no)"

echo ""
echo "======================================"
echo "Results: $pass passed, $fail failed"
echo "======================================"
[ "$fail" -eq 0 ]
