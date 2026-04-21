#!/usr/bin/env bash
# SMI-4377: Unit + structural tests for worktree hook infrastructure.
#
# Covers:
#   1. _lib.sh helpers  — assert_host_node_modules, link_worktree_node_modules,
#                         repair_worktrees_node_modules (unit tests with a
#                         throwaway git repo in a tmpdir; no git-crypt needed)
#   2. .husky/pre-commit — IS_WORKTREE detection via --git-dir vs --git-common-dir
#   3. .husky/_/          — committed dispatch files present and non-trivial
#   4. Structural guards — regex checks on .husky/pre-commit for the worktree
#                          fallback block + grep lint-staged.config.js for
#                          check-file-length wiring (catches accidental
#                          deletion of the Change 6 fallback and the 500-line
#                          gate respectively)
#
# End-to-end hook validation (Phase 0 gitleaks, Phase 2 typecheck false-green
# canary, Phase 3 file-length rejection, branch-integrity smudge recovery)
# requires git-crypt + varlock + a decrypted worktree. Those run via the
# manual verification section of the SMI-4377 PR description; gating them in
# CI requires the 4-week reliability window (plan-review finding #10).

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

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

assert_true() {
  local name="$1" cmd="$2"
  if eval "$cmd"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: '$cmd' was false"
    fail=$((fail + 1))
  fi
}

# -----------------------------------------------------------------------
# Fixture: throwaway repo with a fake node_modules/.bin/lint-staged.
# -----------------------------------------------------------------------
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

FAKE_MAIN="$TMPROOT/main"
mkdir -p "$FAKE_MAIN/node_modules/.bin"
touch "$FAKE_MAIN/node_modules/.bin/lint-staged"
chmod +x "$FAKE_MAIN/node_modules/.bin/lint-staged"

(
  cd "$FAKE_MAIN"
  git init -q -b main
  git config user.email "test@skillsmith.local"
  git config user.name "Test"
  echo "ok" > README.md
  git add README.md
  git -c core.hooksPath=/dev/null commit -q -m "initial"
) >/dev/null 2>&1

# -----------------------------------------------------------------------
# Scenario 1: _lib.sh — assert_host_node_modules passes when lint-staged exists
# -----------------------------------------------------------------------
set +e
( assert_host_node_modules "$FAKE_MAIN" >/dev/null 2>&1 ); rc=$?
set -e
assert_eq "assert_host_node_modules: passes with lint-staged present" "0" "$rc"

# -----------------------------------------------------------------------
# Scenario 2: _lib.sh — assert_host_node_modules fails when lint-staged missing
# -----------------------------------------------------------------------
FAKE_EMPTY="$TMPROOT/empty"
mkdir -p "$FAKE_EMPTY"
set +e
( assert_host_node_modules "$FAKE_EMPTY" >/dev/null 2>&1 ); rc=$?
set -e
assert_eq "assert_host_node_modules: fails when lint-staged missing" "1" "$rc"

# -----------------------------------------------------------------------
# Scenario 3: _lib.sh — link_worktree_node_modules creates symlink
# -----------------------------------------------------------------------
FAKE_WT1="$TMPROOT/wt1"
mkdir -p "$FAKE_WT1"
link_worktree_node_modules "$FAKE_WT1" "$FAKE_MAIN" >/dev/null
assert_true "link_worktree_node_modules: creates symlink" \
  "[ -L '$FAKE_WT1/node_modules' ]"
assert_eq "link_worktree_node_modules: symlink target" \
  "$FAKE_MAIN/node_modules" "$(readlink "$FAKE_WT1/node_modules")"

# -----------------------------------------------------------------------
# Scenario 4: _lib.sh — link_worktree_node_modules idempotent
# -----------------------------------------------------------------------
link_worktree_node_modules "$FAKE_WT1" "$FAKE_MAIN" >/dev/null
assert_true "link_worktree_node_modules: idempotent repeat" \
  "[ -L '$FAKE_WT1/node_modules' ] && [ '$(readlink "$FAKE_WT1/node_modules")' = '$FAKE_MAIN/node_modules' ]"

# -----------------------------------------------------------------------
# Scenario 5: _lib.sh — link_worktree_node_modules skips real directory
# -----------------------------------------------------------------------
FAKE_WT2="$TMPROOT/wt2"
mkdir -p "$FAKE_WT2/node_modules"
set +e
link_worktree_node_modules "$FAKE_WT2" "$FAKE_MAIN" >/dev/null 2>&1; rc=$?
set -e
assert_eq "link_worktree_node_modules: skips real node_modules dir" "1" "$rc"
assert_true "link_worktree_node_modules: did not clobber real dir" \
  "[ -d '$FAKE_WT2/node_modules' ] && [ ! -L '$FAKE_WT2/node_modules' ]"

# -----------------------------------------------------------------------
# Scenario 6: _lib.sh — repair_worktrees_node_modules backfills missing, skips present
# -----------------------------------------------------------------------
(
  cd "$FAKE_MAIN"
  git worktree add -q -b wt-a "$TMPROOT/wt-a" main
  git worktree add -q -b wt-b "$TMPROOT/wt-b" main
  # wt-a has no node_modules; wt-b already has a symlink
  ln -sfn "$FAKE_MAIN/node_modules" "$TMPROOT/wt-b/node_modules"
) >/dev/null 2>&1
repair_worktrees_node_modules "$FAKE_MAIN" >/dev/null 2>&1
assert_true "repair_worktrees: backfilled missing symlink on wt-a" \
  "[ -L '$TMPROOT/wt-a/node_modules' ]"
assert_eq "repair_worktrees: wt-a symlink target" \
  "$FAKE_MAIN/node_modules" "$(readlink "$TMPROOT/wt-a/node_modules")"
assert_true "repair_worktrees: skipped existing symlink on wt-b" \
  "[ -L '$TMPROOT/wt-b/node_modules' ]"

# -----------------------------------------------------------------------
# Scenario 7: .husky/pre-commit worktree detection (mirrors IS_WORKTREE logic)
# -----------------------------------------------------------------------
detect_worktree() {
  local dir="$1"
  if [ "$(git -C "$dir" rev-parse --git-dir)" != "$(git -C "$dir" rev-parse --git-common-dir)" ]; then
    echo 1
  else
    echo 0
  fi
}
assert_eq "worktree detection: main repo returns 0" "0" "$(detect_worktree "$FAKE_MAIN")"
assert_eq "worktree detection: worktree returns 1" "1" "$(detect_worktree "$TMPROOT/wt-a")"

# -----------------------------------------------------------------------
# Scenario 8: .husky/_/ dispatch files committed (Layer 1 fix)
# -----------------------------------------------------------------------
HUSKY_TRACKED=$(git -C "$REPO_ROOT" ls-files '.husky/_' | wc -l | tr -d ' ')
assert_true ".husky/_/ tracked dispatch files (>=10)" \
  "[ '$HUSKY_TRACKED' -ge 10 ]"
assert_true ".husky/_/h exists and non-empty" \
  "[ -s '$REPO_ROOT/.husky/_/h' ]"
assert_true ".husky/_/pre-commit stub exists" \
  "[ -f '$REPO_ROOT/.husky/_/pre-commit' ]"

# -----------------------------------------------------------------------
# Scenario 9: structural guard — .husky/pre-commit contains Change 6 fallback
# Prevents accidental deletion of the Docker worktree fallback. If this
# guard fails, typecheck from worktrees will regress to false-green.
# -----------------------------------------------------------------------
if grep -q 'IS_WORKTREE=1' "$REPO_ROOT/.husky/pre-commit" && \
   grep -q 'USE_DOCKER=0' "$REPO_ROOT/.husky/pre-commit" && \
   grep -q 'SMI-4377' "$REPO_ROOT/.husky/pre-commit"; then
  echo "PASS pre-commit: Change 6 worktree-fallback block present"
  pass=$((pass + 1))
else
  echo "FAIL pre-commit: Change 6 worktree-fallback block missing or altered"
  fail=$((fail + 1))
fi

# -----------------------------------------------------------------------
# Scenario 10: structural guard — lint-staged.config.js wires check-file-length
# The 500-line cap is the canary that tripped in SMI-4374; verify the gate
# is still wired so SMI-4376's refactor can rely on it.
# -----------------------------------------------------------------------
if grep -q 'check-file-length.mjs' "$REPO_ROOT/lint-staged.config.js"; then
  echo "PASS lint-staged: check-file-length.mjs still wired"
  pass=$((pass + 1))
else
  echo "FAIL lint-staged: check-file-length.mjs wiring missing"
  fail=$((fail + 1))
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
total=$((pass + fail))
echo ""
if [ $fail -eq 0 ]; then
  echo "All tests passed ($pass/$total)"
  exit 0
else
  echo "FAILURES: $fail failed, $pass passed ($total total)"
  exit 1
fi
