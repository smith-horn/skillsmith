#!/usr/bin/env bash
# SMI-5570/SMI-5074: Unit tests for scripts/lib/repair-worktree-container-symlinks.sh
#
# Covers:
#   1. A per-package node_modules symlink escaped outside the fixture's
#      "app root" (via a 3-level-up relative target) gets repointed at its
#      actual resolved location.
#   2. A DIFFERENT escape depth (1-level-up) is handled identically — the
#      script reads each symlink's own resolved target rather than assuming
#      one fixed dot-dot count, which is exactly what's needed since real
#      worktree layouts escape by different depths (SMI-4654: 4-up for
#      `.worktrees/<name>/`, 3-up for a nested `<repo>/<name>/`).
#   3. An already-correct symlink (resolves under the app root) is left
#      untouched.
#   4. A hoisted workspace alias symlink (@skillsmith/<pkg>) pointing at the
#      wrong location gets repointed at the real in-fixture package dir.
#   5. A package with no node_modules symlink at all is a no-op, no crash.
#   6. Idempotent: running twice produces the same corrected state.
#
# Uses `cd ... && pwd -P` (not raw mktemp output) for all path comparisons —
# on macOS, mktemp returns a /var/... path that is itself a symlink to
# /private/var/..., and readlink -f fully canonicalizes through it, so a raw
# string comparison against the un-resolved mktemp path would spuriously fail.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPAIR_SCRIPT="$SCRIPT_DIR/lib/repair-worktree-container-symlinks.sh"

fail=0
pass=0

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: '$needle' not in output"
    echo "  Haystack: $haystack"
    fail=$((fail + 1))
  fi
}

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: expected='$expected' actual='$actual'"
    fail=$((fail + 1))
  fi
}

# SANDBOX plays the role of the container's filesystem root. Two distinct
# PACKAGES_DIR nestings are tested, matching SMI-4654's two supported
# worktree layouts exactly:
#   - `.worktrees/<name>/packages/<pkg>/node_modules` (4 named segments
#     between repo_root and node_modules's parent -> 4-up escape)
#   - `<name>/packages/<pkg>/node_modules` (3 segments -> 3-up escape)
# Each test uses its own PACKAGES_DIR (a real worktree only ever has one
# layout at a time), nested exactly deep enough that the escape lands back
# at SANDBOX — mirroring how the real escape clamps at container root.
SANDBOX=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$SANDBOX"' EXIT

setup_fixture() {
  rm -rf "${SANDBOX:?}"/*
  mkdir -p "$SANDBOX/dotworktrees/name/packages/core"
  mkdir -p "$SANDBOX/nestedname/packages/mcp-server"
  mkdir -p "$SANDBOX/escaped-4up/core/node_modules"
  mkdir -p "$SANDBOX/escaped-3up/mcp-server/node_modules"
  mkdir -p "$SANDBOX/hoisted/@skillsmith"
}

# -----------------------------------------------------------------------
# Test 1: a 4-level-up escape, matching SMI-4654's `.worktrees/<name>/`
# layout depth — packages/core/node_modules -> ../../../../escaped-4up/core/node_modules,
# landing at $SANDBOX/escaped-4up/core/node_modules (SANDBOX = container root).
# -----------------------------------------------------------------------
setup_fixture
ln -sfn "../../../../escaped-4up/core/node_modules" "$SANDBOX/dotworktrees/name/packages/core/node_modules"

bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /tmp/repair-out-1.log 2>&1
RESOLVED1=$(readlink -f "$SANDBOX/dotworktrees/name/packages/core/node_modules")
assert_eq "test1 (4-up escape, .worktrees/<name>/ layout): repoints at the real escaped location" "$SANDBOX/escaped-4up/core/node_modules" "$RESOLVED1"
assert_contains "test1: reports a repair" "Repaired" "$(cat /tmp/repair-out-1.log)"

# -----------------------------------------------------------------------
# Test 2: a DIFFERENT escape depth — 3-level-up, matching SMI-4654's nested
# <repo>/<name>/ layout — proves the script reads each symlink's own
# resolved target rather than assuming one fixed dot-dot count.
# -----------------------------------------------------------------------
setup_fixture
ln -sfn "../../../escaped-3up/mcp-server/node_modules" "$SANDBOX/nestedname/packages/mcp-server/node_modules"

bash "$REPAIR_SCRIPT" "$SANDBOX/nestedname/packages" "$SANDBOX/hoisted" > /tmp/repair-out-2.log 2>&1
RESOLVED2=$(readlink -f "$SANDBOX/nestedname/packages/mcp-server/node_modules")
assert_eq "test2 (3-up escape, nested <repo>/<name>/ layout): repoints at the real escaped location" "$SANDBOX/escaped-3up/mcp-server/node_modules" "$RESOLVED2"

# -----------------------------------------------------------------------
# Test 3: already-correct symlink (a direct absolute link to real content)
# — no-op, left untouched.
# -----------------------------------------------------------------------
setup_fixture
mkdir -p "$SANDBOX/dotworktrees/name/packages/real-node-modules-location"
ln -sfn "$SANDBOX/dotworktrees/name/packages/real-node-modules-location" "$SANDBOX/dotworktrees/name/packages/core/node_modules"
BEFORE=$(readlink "$SANDBOX/dotworktrees/name/packages/core/node_modules")

bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /tmp/repair-out-3.log 2>&1
AFTER=$(readlink "$SANDBOX/dotworktrees/name/packages/core/node_modules")
assert_eq "test3: already-correct direct symlink untouched" "$BEFORE" "$AFTER"
assert_contains "test3: reports already-correct, no repair" "already correct" "$(cat /tmp/repair-out-3.log)"

# -----------------------------------------------------------------------
# Test 4: hoisted workspace alias pointing at the wrong location gets
# repointed at the real in-fixture package dir.
# -----------------------------------------------------------------------
setup_fixture
mkdir -p "$SANDBOX/some/wrong/place"
ln -sfn "$SANDBOX/some/wrong/place" "$SANDBOX/hoisted/@skillsmith/core"

bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /tmp/repair-out-4.log 2>&1
HOISTED_RESOLVED=$(readlink -f "$SANDBOX/hoisted/@skillsmith/core")
assert_eq "test4: hoisted alias repointed at the real package dir" "$SANDBOX/dotworktrees/name/packages/core" "$HOISTED_RESOLVED"

# -----------------------------------------------------------------------
# Test 5: package with no node_modules symlink at all — no-op, no crash.
# -----------------------------------------------------------------------
setup_fixture
# core/ exists (from setup_fixture) with no node_modules entry, no hoisted alias.

bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /tmp/repair-out-5.log 2>&1
EXIT5=$?
assert_eq "test5: exits 0 when a package has nothing to repair" "0" "$EXIT5"

# -----------------------------------------------------------------------
# Test 6: idempotent — running twice produces the same corrected state,
# and the second run recognizes it as already-correct rather than
# re-repairing (even though the repaired target sits outside "app").
# -----------------------------------------------------------------------
setup_fixture
ln -sfn "../../../../escaped-4up/core/node_modules" "$SANDBOX/dotworktrees/name/packages/core/node_modules"
bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /dev/null 2>&1
FIRST_RUN=$(readlink -f "$SANDBOX/dotworktrees/name/packages/core/node_modules")
bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /tmp/repair-out-6.log 2>&1
SECOND_RUN=$(readlink -f "$SANDBOX/dotworktrees/name/packages/core/node_modules")
assert_eq "test6: idempotent across two runs" "$FIRST_RUN" "$SECOND_RUN"
assert_contains "test6: second run reports already-correct, not a re-repair" "already correct" "$(cat /tmp/repair-out-6.log)"

rm -f /tmp/repair-out-*.log

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
