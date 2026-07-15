#!/usr/bin/env bash
# SMI-5689: Unit tests for reclaim_empty_node_modules_dir and its two call
# sites, link_worktree_node_modules() and repair_worktrees_node_modules().
#
# Covers:
#   1. Pre-existing EMPTY node_modules dir at a worktree path is reclaimed
#      (rmdir + symlink created) by link_worktree_node_modules().
#   2. Pre-existing NON-EMPTY node_modules dir is left untouched (regression
#      guard for the one case the original code already protected).
#   3. Both cases 1-2 exercised through repair_worktrees_node_modules() (the
#      ./scripts/repair-worktrees.sh code path), which enumerates worktrees
#      itself via `git worktree list --porcelain` and so needs a real git
#      repo + `git worktree add` fixture.
#   4. An empty directory whose rmdir fails (parent dir write-permission
#      removed, simulating an active container mount) is left untouched —
#      no nested node_modules/node_modules symlink is created (regression
#      guard for the BSD `ln -sfn`-against-existing-dir nesting hazard
#      found during plan-review).

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../_lib.sh
source "$SCRIPT_DIR/_lib.sh"

fail=0
pass=0

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

# -----------------------------------------------------------------------
# Root-user guard for Case 4 (permission-based rmdir failure is a no-op
# under root, which bypasses DAC permission checks entirely).
# -----------------------------------------------------------------------
IS_ROOT=0
[ "$(id -u)" = "0" ] && IS_ROOT=1

TMPROOT=$(mktemp -d)
# Canonicalize (cd ... && pwd -P) to avoid macOS /var -> /private/var mismatch:
# `git worktree list --porcelain` reports the canonicalized path, so a raw
# mktemp path would fail compute_relative_target's string-prefix check.
GITROOT=$(cd "$(mktemp -d)" && pwd -P)
PERMROOT=$(mktemp -d)
cleanup() {
  chmod -R u+w "$PERMROOT" 2>/dev/null || true
  rm -rf "$TMPROOT" "$GITROOT" "$PERMROOT"
}
trap cleanup EXIT

# =========================================================================
# Case 1 + 2: link_worktree_node_modules() (create-time path)
# =========================================================================
mkdir -p "$TMPROOT/node_modules"
mkdir -p "$TMPROOT/.worktrees/wt-empty/node_modules"
mkdir -p "$TMPROOT/.worktrees/wt-nonempty/node_modules"
touch "$TMPROOT/.worktrees/wt-nonempty/node_modules/some-real-file"

# Case 1: empty pre-existing dir is reclaimed and symlinked.
rc=0
link_worktree_node_modules "$TMPROOT/.worktrees/wt-empty" "$TMPROOT" || rc=$?
assert_eq "case1: link_worktree_node_modules reclaims empty dir (rc=0)" 0 "$rc"
assert_eq "case1: node_modules is now a symlink" "yes" "$([ -L "$TMPROOT/.worktrees/wt-empty/node_modules" ] && echo yes || echo no)"
assert_eq "case1: symlink resolves to repo root's node_modules" "../../node_modules" "$(readlink "$TMPROOT/.worktrees/wt-empty/node_modules")"

# Case 2: non-empty pre-existing dir is preserved (regression guard).
rc=0
link_worktree_node_modules "$TMPROOT/.worktrees/wt-nonempty" "$TMPROOT" || rc=$?
assert_eq "case2: link_worktree_node_modules preserves non-empty dir (rc=1)" 1 "$rc"
assert_eq "case2: node_modules is still a real directory" "yes" "$([ -d "$TMPROOT/.worktrees/wt-nonempty/node_modules" ] && [ ! -L "$TMPROOT/.worktrees/wt-nonempty/node_modules" ] && echo yes || echo no)"
assert_eq "case2: marker file untouched" "yes" "$([ -f "$TMPROOT/.worktrees/wt-nonempty/node_modules/some-real-file" ] && echo yes || echo no)"

# =========================================================================
# Case 3: repair_worktrees_node_modules() (repair-time path, i.e. the
# ./scripts/repair-worktrees.sh code path) — needs a real git worktree
# fixture, since this function enumerates worktrees itself via
# `git worktree list --porcelain` rather than taking a path directly.
# =========================================================================
git init -q "$GITROOT"
git -C "$GITROOT" config user.email "test@example.com"
git -C "$GITROOT" config user.name "Test"
touch "$GITROOT/README.md"
git -C "$GITROOT" add README.md
git -C "$GITROOT" commit -q -m "init"
mkdir -p "$GITROOT/node_modules"

git -C "$GITROOT" worktree add -q "$GITROOT/.worktrees/wt-repair-empty" -b repair-empty-branch >/dev/null
git -C "$GITROOT" worktree add -q "$GITROOT/.worktrees/wt-repair-nonempty" -b repair-nonempty-branch >/dev/null

mkdir -p "$GITROOT/.worktrees/wt-repair-empty/node_modules"
mkdir -p "$GITROOT/.worktrees/wt-repair-nonempty/node_modules"
touch "$GITROOT/.worktrees/wt-repair-nonempty/node_modules/some-real-file"

repair_worktrees_node_modules "$GITROOT" >/dev/null

assert_eq "case3: repair reclaims empty dir at repair-time (now a symlink)" "yes" "$([ -L "$GITROOT/.worktrees/wt-repair-empty/node_modules" ] && echo yes || echo no)"
assert_eq "case3: repair symlink resolves correctly" "../../node_modules" "$(readlink "$GITROOT/.worktrees/wt-repair-empty/node_modules")"
assert_eq "case3: repair preserves non-empty dir (regression guard)" "yes" "$([ -d "$GITROOT/.worktrees/wt-repair-nonempty/node_modules" ] && [ ! -L "$GITROOT/.worktrees/wt-repair-nonempty/node_modules" ] && echo yes || echo no)"
assert_eq "case3: repair leaves non-empty dir's marker file untouched" "yes" "$([ -f "$GITROOT/.worktrees/wt-repair-nonempty/node_modules/some-real-file" ] && echo yes || echo no)"

# =========================================================================
# Case 4: empty directory where rmdir fails (parent write-permission
# removed, simulating an active container mount reference). Asserts the
# distinct "empty but unremovable" status and that NO nested
# node_modules/node_modules symlink is ever created (the BSD `ln -sfn`
# nesting hazard this guard exists to prevent).
# =========================================================================
if [ "$IS_ROOT" = "1" ]; then
  echo "SKIP case4: running as root, permission-based rmdir failure is not simulable (root bypasses DAC checks)"
else
  mkdir -p "$PERMROOT/node_modules"
  chmod 555 "$PERMROOT"

  rc=0
  reclaim_empty_node_modules_dir "$PERMROOT/node_modules" || rc=$?
  assert_eq "case4: reclaim_empty_node_modules_dir returns 2 (empty-but-unremovable)" 2 "$rc"

  chmod u+w "$PERMROOT"
  assert_eq "case4: directory was not removed" "yes" "$([ -d "$PERMROOT/node_modules" ] && echo yes || echo no)"
  assert_eq "case4: no nested node_modules/node_modules symlink created" "" "$(find "$PERMROOT/node_modules" -mindepth 1 -maxdepth 1 2>/dev/null)"
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
