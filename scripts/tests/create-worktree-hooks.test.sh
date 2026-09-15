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

# SMI-5596: portable inode lookup. BSD stat (macOS) uses `-f FORMAT` for a
# format string (`stat -f '%i' file` -> bare inode number); GNU stat (Linux,
# CI) uses `-f` for FILESYSTEM status instead — its own format-string flag is
# `-c`. Naively trying `stat -f '%i' file 2>/dev/null || stat -c '%i' file`
# does NOT fall through on Linux: GNU `stat -f` still exits 0, it just prints
# the multi-line filesystem-status block instead of the inode, so the `||`
# never fires. Validate the BSD-style output is a bare integer before
# accepting it; anything else (including GNU's verbose fs-status dump) falls
# through to the GNU-correct `-c '%i'` form.
get_inode() {
  local path="$1" out
  if out=$(stat -f '%i' "$path" 2>/dev/null) && [[ "$out" =~ ^[0-9]+$ ]]; then
    echo "$out"
  else
    stat -c '%i' "$path"
  fi
}

# -----------------------------------------------------------------------
# Fixture: throwaway repo with a fake node_modules/.bin/lint-staged.
# -----------------------------------------------------------------------
TMPROOT=$(mktemp -d)
# One EXIT trap for every temp root this file creates. A later
# `trap '…' EXIT` replaces the earlier handler rather than adding to it, so
# per-scenario traps leaked every root but the last (SMI-6568 gate F1).
# Scenarios that make a new top-level temp dir add it here, not a new trap.
cleanup_tmp_roots() {
  rm -rf "$TMPROOT" ${SCN11_ROOT:+"$SCN11_ROOT"} ${SCN13_ROOT:+"$SCN13_ROOT"} ${SCN13_SHIM:+"$SCN13_SHIM"}
}
trap cleanup_tmp_roots EXIT

FAKE_MAIN="$TMPROOT/main"
mkdir -p "$FAKE_MAIN/node_modules/.bin"
# Canonicalize FAKE_MAIN to avoid macOS /var → /private/var mismatch:
# `git worktree list` returns /private/var/... but $TMPROOT is /var/...,
# breaking the repo-root prefix check in compute_relative_target.
FAKE_MAIN=$(cd "$FAKE_MAIN" && pwd -P)
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
# SMI-4654: worktree must live under repo root for the dynamic depth
# computation. Conventional layout puts wt under $FAKE_MAIN/.worktrees/.
FAKE_WT1="$FAKE_MAIN/.worktrees/wt1"
mkdir -p "$FAKE_WT1"
link_worktree_node_modules "$FAKE_WT1" "$FAKE_MAIN" >/dev/null
assert_true "link_worktree_node_modules: creates symlink (.worktrees/ layout)" \
  "[ -L '$FAKE_WT1/node_modules' ]"
# SMI-4381: relative target. SMI-4654: depth=2 for .worktrees/<name>/ layout.
assert_eq "link_worktree_node_modules: symlink target (.worktrees/ layout)" \
  "../../node_modules" "$(readlink "$FAKE_WT1/node_modules")"
# Verify symlink resolves to a real directory containing the fake lint-staged.
assert_true "link_worktree_node_modules: .worktrees/ symlink resolves" \
  "[ -x '$FAKE_WT1/node_modules/.bin/lint-staged' ]"

# -----------------------------------------------------------------------
# Scenario 4: _lib.sh — link_worktree_node_modules idempotent
# -----------------------------------------------------------------------
link_worktree_node_modules "$FAKE_WT1" "$FAKE_MAIN" >/dev/null
assert_true "link_worktree_node_modules: idempotent repeat" \
  "[ -L '$FAKE_WT1/node_modules' ] && [ '$(readlink "$FAKE_WT1/node_modules")' = '../../node_modules' ]"

# -----------------------------------------------------------------------
# Scenario 4b (SMI-5596): link_worktree_node_modules idempotent no-op — a
# second call with an already-correct symlink does NOT unlink+recreate it
# (inode preserved). This is the fix for the P-5 cross-invocation residual
# risk: a concurrent sibling create-worktree.sh's Step 7 sweep re-visiting
# an already-settled worktree must be a true no-op, not a fresh
# delete+create event that would re-trigger the Docker Desktop macOS
# file-sharing propagation delay the Step 8 readiness probe bounds.
# -----------------------------------------------------------------------
INODE_BEFORE=$(get_inode "$FAKE_WT1/node_modules")
link_worktree_node_modules "$FAKE_WT1" "$FAKE_MAIN" >/dev/null
INODE_AFTER=$(get_inode "$FAKE_WT1/node_modules")
assert_eq "link_worktree_node_modules: idempotent no-op preserves symlink inode" \
  "$INODE_BEFORE" "$INODE_AFTER"

# -----------------------------------------------------------------------
# Scenario 4c (SMI-5596): link_worktree_node_modules still corrects a STALE
# symlink (wrong target) — the idempotent no-op above must not become a
# blanket skip.
# -----------------------------------------------------------------------
ln -sfn "/tmp/some-wrong-target" "$FAKE_WT1/node_modules"
link_worktree_node_modules "$FAKE_WT1" "$FAKE_MAIN" >/dev/null
assert_eq "link_worktree_node_modules: stale symlink still corrected" \
  "../../node_modules" "$(readlink "$FAKE_WT1/node_modules")"

# -----------------------------------------------------------------------
# Scenario 5: _lib.sh — link_worktree_node_modules skips a real, NON-EMPTY
# directory (SMI-5689: an EMPTY pre-existing dir is now reclaimed instead —
# see scripts/tests/reclaim-node-modules.test.sh for that coverage; this
# fixture must contain real content so it still exercises the skip path).
# -----------------------------------------------------------------------
FAKE_WT2="$FAKE_MAIN/.worktrees/wt2"
mkdir -p "$FAKE_WT2/node_modules"
touch "$FAKE_WT2/node_modules/some-real-file"
set +e
link_worktree_node_modules "$FAKE_WT2" "$FAKE_MAIN" >/dev/null 2>&1; rc=$?
set -e
assert_eq "link_worktree_node_modules: skips real node_modules dir" "1" "$rc"
assert_true "link_worktree_node_modules: did not clobber real dir" \
  "[ -d '$FAKE_WT2/node_modules' ] && [ ! -L '$FAKE_WT2/node_modules' ]"

# -----------------------------------------------------------------------
# Scenario 5b (SMI-4654): nested layout — link_worktree_node_modules with
# worktree directly under repo root produces depth=1 symlink that resolves.
# -----------------------------------------------------------------------
FAKE_WT_NESTED="$FAKE_MAIN/wt-nested"
mkdir -p "$FAKE_WT_NESTED"
link_worktree_node_modules "$FAKE_WT_NESTED" "$FAKE_MAIN" >/dev/null
assert_true "link_worktree_node_modules: creates symlink (nested layout)" \
  "[ -L '$FAKE_WT_NESTED/node_modules' ]"
assert_eq "link_worktree_node_modules: symlink target (nested layout)" \
  "../node_modules" "$(readlink "$FAKE_WT_NESTED/node_modules")"
assert_true "link_worktree_node_modules: nested symlink resolves" \
  "[ -x '$FAKE_WT_NESTED/node_modules/.bin/lint-staged' ]"

# -----------------------------------------------------------------------
# Scenario 5c (SMI-4654): worktree outside repo_root → return 1, no link
# -----------------------------------------------------------------------
FAKE_WT_OUTSIDE="$TMPROOT/wt-outside"
mkdir -p "$FAKE_WT_OUTSIDE"
set +e
link_worktree_node_modules "$FAKE_WT_OUTSIDE" "$FAKE_MAIN" >/dev/null 2>&1; rc=$?
set -e
assert_eq "link_worktree_node_modules: rejects worktree outside repo_root" "1" "$rc"
assert_true "link_worktree_node_modules: outside-repo wt has no symlink" \
  "[ ! -e '$FAKE_WT_OUTSIDE/node_modules' ]"

# -----------------------------------------------------------------------
# Scenario 6: _lib.sh — repair_worktrees_node_modules backfills missing, skips present
# -----------------------------------------------------------------------
(
  cd "$FAKE_MAIN"
  # SMI-4654: place worktrees under repo root (.worktrees/ convention).
  git worktree add -q -b wt-a "$FAKE_MAIN/.worktrees/wt-a" main
  git worktree add -q -b wt-b "$FAKE_MAIN/.worktrees/wt-b" main
  # wt-a has no node_modules; wt-b already has a symlink
  ln -sfn "$FAKE_MAIN/node_modules" "$FAKE_MAIN/.worktrees/wt-b/node_modules"
) >/dev/null 2>&1
repair_worktrees_node_modules "$FAKE_MAIN" >/dev/null 2>&1
assert_true "repair_worktrees: backfilled missing symlink on wt-a" \
  "[ -L '$FAKE_MAIN/.worktrees/wt-a/node_modules' ]"
# SMI-4381: target is relative. SMI-4654: depth dynamically computed (still 2 here).
assert_eq "repair_worktrees: wt-a symlink target (.worktrees/ layout, depth=2)" \
  "../../node_modules" "$(readlink "$FAKE_MAIN/.worktrees/wt-a/node_modules")"
assert_true "repair_worktrees: skipped existing symlink on wt-b" \
  "[ -L '$FAKE_MAIN/.worktrees/wt-b/node_modules' ]"
# After refresh, wt-b's symlink should be the relative form (idempotent rewrite).
assert_eq "repair_worktrees: wt-b symlink refreshed to relative form" \
  "../../node_modules" "$(readlink "$FAKE_MAIN/.worktrees/wt-b/node_modules")"

# -----------------------------------------------------------------------
# Scenario 6b-idem (SMI-5596): a second repair_worktrees_node_modules sweep
# is a true no-op on an already-correct symlink (inode preserved) — the
# P-5 cross-invocation fix: a sibling worktree's Step 7 sweep re-visiting
# wt-a here must not gratuitously re-trigger propagation.
# -----------------------------------------------------------------------
WTA_INODE_BEFORE=$(get_inode "$FAKE_MAIN/.worktrees/wt-a/node_modules")
repair_worktrees_node_modules "$FAKE_MAIN" >/dev/null 2>&1
WTA_INODE_AFTER=$(get_inode "$FAKE_MAIN/.worktrees/wt-a/node_modules")
assert_eq "repair_worktrees: redundant sweep preserves already-correct symlink inode" \
  "$WTA_INODE_BEFORE" "$WTA_INODE_AFTER"

# -----------------------------------------------------------------------
# Scenario 6b (SMI-4654): repair_worktrees on a nested worktree produces depth=1.
# -----------------------------------------------------------------------
(
  cd "$FAKE_MAIN"
  git worktree add -q -b wt-nested-repair "$FAKE_MAIN/wt-nested-repair" main
) >/dev/null 2>&1
repair_worktrees_node_modules "$FAKE_MAIN" >/dev/null 2>&1
assert_true "repair_worktrees: backfilled symlink on nested layout" \
  "[ -L '$FAKE_MAIN/wt-nested-repair/node_modules' ]"
assert_eq "repair_worktrees: nested wt symlink target (depth=1)" \
  "../node_modules" "$(readlink "$FAKE_MAIN/wt-nested-repair/node_modules")"
# Verify the symlink actually resolves — this is the regression guard for the
# original SMI-4654 bug where nested worktrees got depth=2 symlinks pointing
# outside the repo and silently breaking pre-commit typecheck.
assert_true "repair_worktrees: nested symlink resolves to real node_modules" \
  "[ -x '$FAKE_MAIN/wt-nested-repair/node_modules/.bin/lint-staged' ]"

# -----------------------------------------------------------------------
# Scenario 6c (SMI-4654): per-package symlink on .worktrees/ layout — depth=4.
# -----------------------------------------------------------------------
mkdir -p "$FAKE_MAIN/packages/foo/node_modules"
mkdir -p "$FAKE_MAIN/.worktrees/wt-pkg/packages/foo"
link_worktree_package_node_modules "$FAKE_MAIN/.worktrees/wt-pkg" "$FAKE_MAIN" >/dev/null
assert_true "link_worktree_package: creates per-pkg symlink (.worktrees/ layout)" \
  "[ -L '$FAKE_MAIN/.worktrees/wt-pkg/packages/foo/node_modules' ]"
assert_eq "link_worktree_package: per-pkg target (.worktrees/ layout, depth=4)" \
  "../../../../packages/foo/node_modules" \
  "$(readlink "$FAKE_MAIN/.worktrees/wt-pkg/packages/foo/node_modules")"

# -----------------------------------------------------------------------
# Scenario 6d (SMI-4654): per-package symlink on nested layout — depth=3.
# This is the core regression-guard for the bug. Pre-fix this would have
# emitted depth=4, dangling outside the repo and surfacing zod3-vs-4 in pre-commit.
# -----------------------------------------------------------------------
mkdir -p "$FAKE_MAIN/wt-pkg-nested/packages/foo"
link_worktree_package_node_modules "$FAKE_MAIN/wt-pkg-nested" "$FAKE_MAIN" >/dev/null
assert_true "link_worktree_package: creates per-pkg symlink (nested layout)" \
  "[ -L '$FAKE_MAIN/wt-pkg-nested/packages/foo/node_modules' ]"
assert_eq "link_worktree_package: per-pkg target (nested layout, depth=3)" \
  "../../../packages/foo/node_modules" \
  "$(readlink "$FAKE_MAIN/wt-pkg-nested/packages/foo/node_modules")"
# Verify resolution — regression guard for the original bug.
assert_true "link_worktree_package: nested per-pkg symlink resolves" \
  "[ -d '$FAKE_MAIN/wt-pkg-nested/packages/foo/node_modules' ]"

# -----------------------------------------------------------------------
# Scenario 6d-idem (SMI-5596): link_worktree_package_node_modules idempotent
# no-op (inode preserved on a redundant call) + still corrects a stale
# per-package symlink.
# -----------------------------------------------------------------------
PKG_LINK="$FAKE_MAIN/wt-pkg-nested/packages/foo/node_modules"
PKG_INODE_BEFORE=$(get_inode "$PKG_LINK")
link_worktree_package_node_modules "$FAKE_MAIN/wt-pkg-nested" "$FAKE_MAIN" >/dev/null
PKG_INODE_AFTER=$(get_inode "$PKG_LINK")
assert_eq "link_worktree_package: idempotent no-op preserves symlink inode" \
  "$PKG_INODE_BEFORE" "$PKG_INODE_AFTER"

ln -sfn "/tmp/some-wrong-target" "$PKG_LINK"
link_worktree_package_node_modules "$FAKE_MAIN/wt-pkg-nested" "$FAKE_MAIN" >/dev/null
assert_eq "link_worktree_package: stale per-pkg symlink still corrected" \
  "../../../packages/foo/node_modules" "$(readlink "$PKG_LINK")"

# -----------------------------------------------------------------------
# Scenario 6e (SMI-4654): direct unit tests for compute_relative_target.
# -----------------------------------------------------------------------
assert_eq "compute_relative_target: nested wt root (depth=1)" \
  "../node_modules" \
  "$(compute_relative_target /tmp/repo/wt /tmp/repo/node_modules /tmp/repo)"

assert_eq "compute_relative_target: nested wt per-pkg (depth=3)" \
  "../../../packages/foo/node_modules" \
  "$(compute_relative_target /tmp/repo/wt/packages/foo /tmp/repo/packages/foo/node_modules /tmp/repo)"

assert_eq "compute_relative_target: .worktrees/ wt root (depth=2)" \
  "../../node_modules" \
  "$(compute_relative_target /tmp/repo/.worktrees/wt /tmp/repo/node_modules /tmp/repo)"

assert_eq "compute_relative_target: .worktrees/ wt per-pkg (depth=4)" \
  "../../../../packages/foo/node_modules" \
  "$(compute_relative_target /tmp/repo/.worktrees/wt/packages/foo /tmp/repo/packages/foo/node_modules /tmp/repo)"

# Trailing-slash repo_root normalization.
assert_eq "compute_relative_target: trailing-slash repo_root normalizes" \
  "../node_modules" \
  "$(compute_relative_target /tmp/repo/wt /tmp/repo/node_modules /tmp/repo/)"

# Outside-repo error contract: returns 1, exact stderr message.
set +e
out=$(compute_relative_target /other/wt /tmp/repo/node_modules /tmp/repo 2>&1 >/dev/null); rc=$?
set -e
assert_eq "compute_relative_target: outside-repo returns 1" "1" "$rc"
case "$out" in
  *"is not under repo root '/tmp/repo'"*)
    echo "PASS compute_relative_target: outside-repo error mentions repo root"
    pass=$((pass + 1))
    ;;
  *)
    echo "FAIL compute_relative_target: outside-repo error mentions repo root: out='$out'"
    fail=$((fail + 1))
    ;;
esac

# Space-in-path: variable expansions must be quoted.
assert_eq "compute_relative_target: space in repo_root" \
  "../node_modules" \
  "$(compute_relative_target "/tmp/test repo/wt" "/tmp/test repo/node_modules" "/tmp/test repo")"

# Multi-level nesting (defensive — depth=3 from 2 slashes in `a/b/wt`).
assert_eq "compute_relative_target: multi-level nesting (depth=3)" \
  "../../../node_modules" \
  "$(compute_relative_target /tmp/repo/a/b/wt /tmp/repo/node_modules /tmp/repo)"

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
assert_eq "worktree detection: worktree returns 1" "1" "$(detect_worktree "$FAKE_MAIN/.worktrees/wt-a")"

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
# Scenario 9: (removed in SMI-4686 — folded into Scenario 9b's consumer
# loops, which now also assert .husky/pre-commit sources the shared helper.)
# -----------------------------------------------------------------------

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
# Scenario 9b (SMI-4681 + SMI-4686): structural guards for hook chain
# Prevents accidental deletion of:
#   - the shared helper at scripts/lib/hook-docker-detect.sh
#   - source lines in .husky/pre-commit, .husky/pre-push,
#     scripts/pre-push-{check,coverage-check}.sh
# Also asserts each consumer has at most ONE local USE_DOCKER= assignment
# (the graceful-degradation else branch); the helper is the canonical setter.
# SMI-4686 added .husky/pre-commit to both loops; before, it had its own
# inline copy of the detection logic.
# -----------------------------------------------------------------------
HELPER="$REPO_ROOT/scripts/lib/hook-docker-detect.sh"

if [ -r "$HELPER" ] && \
   grep -q 'compute_container_wd' "$HELPER" && \
   grep -q 'IS_WORKTREE' "$HELPER" && \
   grep -q 'Darwin' "$HELPER" && \
   grep -q 'SMI-4681' "$HELPER" && \
   grep -q '_HOOK_DETECT_LOADED' "$HELPER"; then
  echo "PASS hook-docker-detect.sh: helper present with required markers"
  pass=$((pass + 1))
else
  echo "FAIL hook-docker-detect.sh: helper missing or markers stripped"
  fail=$((fail + 1))
fi

# Each consumer sources the helper.
for consumer in \
  ".husky/pre-commit" \
  ".husky/pre-push" \
  "scripts/pre-push-check.sh" \
  "scripts/pre-push-coverage-check.sh"; do
  if grep -q 'hook-docker-detect.sh' "$REPO_ROOT/$consumer"; then
    echo "PASS $consumer: sources hook-docker-detect.sh"
    pass=$((pass + 1))
  else
    echo "FAIL $consumer: missing source of hook-docker-detect.sh"
    fail=$((fail + 1))
  fi
done

# Each consumer has at most ONE local USE_DOCKER= assignment (graceful
# degradation else branch). The helper is the canonical setter; duplicate
# assignments are the kind of drift this PR is meant to prevent.
for consumer in \
  ".husky/pre-commit" \
  ".husky/pre-push" \
  "scripts/pre-push-check.sh" \
  "scripts/pre-push-coverage-check.sh"; do
  count=$(grep -c '^[[:space:]]*USE_DOCKER=' "$REPO_ROOT/$consumer" || true)
  if [ "$count" -le 1 ]; then
    echo "PASS $consumer: at most one local USE_DOCKER= assignment ($count)"
    pass=$((pass + 1))
  else
    echo "FAIL $consumer: $count local USE_DOCKER= assignments (expected ≤1)"
    fail=$((fail + 1))
  fi
done

# -----------------------------------------------------------------------
# Scenario 11 (SMI-4681): hook-docker-detect.sh unit test in subshell.
# Sources helper from a fake repo with controlled (uname, git rev-parse) shims.
# Asserts USE_DOCKER / NEEDS_FALLBACK / FELL_BACK / CONTAINER_WD across
# the four matrix cells: {Darwin, Linux} × {main-repo, in-tree-worktree}.
# -----------------------------------------------------------------------
# Build a minimal fake repo with a worktree.
SCN11_ROOT=$(mktemp -d)  # removed by cleanup_tmp_roots (EXIT trap above)
SCN11_MAIN="$SCN11_ROOT/main"
mkdir -p "$SCN11_MAIN"
SCN11_MAIN=$(cd "$SCN11_MAIN" && pwd -P)
(
  cd "$SCN11_MAIN"
  git init -q -b main
  git config user.email "test@skillsmith.local"
  git config user.name "Test"
  echo "ok" > README.md
  git add README.md
  git -c core.hooksPath=/dev/null commit -q -m "initial" >/dev/null 2>&1
  git worktree add -q -b scn11-wt "$SCN11_MAIN/.worktrees/wt"
) >/dev/null 2>&1
mkdir -p "$SCN11_MAIN/.worktrees/wt/node_modules" # native-binding preflight

# Helper for matrix cells: shim `uname` via PATH, force docker-absent, then
# source helper from the test fixture's cwd. Output the relevant vars.
# Optional $3 is extra env var assignments (e.g. "SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1")
# injected into the sourcing subshell — SMI-5570/SMI-5074's default is now to
# hard-fail (exit 1, no vars printed) rather than silently fall back when an
# in-tree worktree's own container can't be reached, so cells exercising the
# fallback-and-report-state path need to opt out explicitly, same as a real
# caller would via `SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1 git push`.
run_helper_with_uname() {
  uname_value="$1"
  cwd="$2"
  extra_env="${3:-}"
  shim_dir=$(mktemp -d)
  cat > "$shim_dir/uname" <<UNAMEEOF
#!/bin/sh
echo "$uname_value"
UNAMEEOF
  chmod +x "$shim_dir/uname"
  # Disable docker by overriding `command -v docker` with a non-zero stub.
  cat > "$shim_dir/docker" <<DOCKEREOF
#!/bin/sh
exit 1
DOCKEREOF
  chmod +x "$shim_dir/docker"
  # Capture the subshell's own exit status explicitly and `return` it —
  # `rm -rf` as the trailing statement would otherwise always exit 0,
  # masking a hard-fail (exit 1) from hook-docker-detect.sh regardless of
  # what actually happened (only surfaced once a caller started checking
  # this function's exit status, not just its stdout — SMI-5570/SMI-5074).
  # shellcheck disable=SC2086 # intentional word-splitting: $extra_env is
  # either empty (no extra args to env) or a single "VAR=value" token; quoting
  # it would pass an empty-string argument to env instead of omitting it.
  ( cd "$cwd" && env $extra_env PATH="$shim_dir:$PATH" sh -c "
      . '$REPO_ROOT/scripts/lib/hook-docker-detect.sh' >/dev/null 2>&1
      printf 'IS_WORKTREE=%s NEEDS_FALLBACK=%s FELL_BACK=%s USE_DOCKER=%s CONTAINER_WD=%s\n' \
        \"\$IS_WORKTREE\" \"\$NEEDS_FALLBACK\" \"\$FELL_BACK\" \"\$USE_DOCKER\" \"\$CONTAINER_WD\"
    " 2>/dev/null )
  helper_exit=$?
  rm -rf "$shim_dir"
  return "$helper_exit"
}

# Cell 1: Darwin + main repo → no fallback (main checkout is unaffected by
# SMI-5570/SMI-5074's worktree-routing changes).
out=$(run_helper_with_uname "Darwin" "$SCN11_MAIN")
case "$out" in
  *"IS_WORKTREE=0"*"NEEDS_FALLBACK=0"*"USE_DOCKER=0"*"CONTAINER_WD=/app"*)
    echo "PASS Scenario 11 cell 1: Darwin + main repo → no fallback (Docker absent → host)"
    pass=$((pass + 1))
    ;;
  *)
    echo "FAIL Scenario 11 cell 1: Darwin + main repo: $out"
    fail=$((fail + 1))
    ;;
esac

# Cell 2: Darwin + worktree, own container unreachable, hard-fail disabled →
# fallback (host). SMI-5570/SMI-5074: CONTAINER_WD is now always "/app" (the
# worktree's own container mounts itself there directly — no more nested
# ".worktrees/<name>" path, since that was main's-container-reaching-in,
# which is exactly the routing this change removes).
out=$(run_helper_with_uname "Darwin" "$SCN11_MAIN/.worktrees/wt" "SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1")
case "$out" in
  *"IS_WORKTREE=1"*"NEEDS_FALLBACK=1"*"FELL_BACK=1"*"USE_DOCKER=0"*"CONTAINER_WD=/app"*)
    echo "PASS Scenario 11 cell 2: Darwin + worktree (hard-fail disabled) → host fallback"
    pass=$((pass + 1))
    ;;
  *)
    echo "FAIL Scenario 11 cell 2: Darwin + worktree: $out"
    fail=$((fail + 1))
    ;;
esac

# Cell 2b: Darwin + worktree, own container unreachable, NO opt-out → hard-fail
# (exit 1, no state vars printed). This is the new SMI-5570/SMI-5074 default —
# a worktree's pre-push no longer silently substitutes main's shared
# container's state; it fails loudly with worktree-docker.sh's remediation
# unless the push is docs-only or the guard is explicitly disabled.
if out=$(run_helper_with_uname "Darwin" "$SCN11_MAIN/.worktrees/wt"); then
  echo "FAIL Scenario 11 cell 2b: Darwin + worktree (no opt-out) should have hard-failed, got: $out"
  fail=$((fail + 1))
else
  echo "PASS Scenario 11 cell 2b: Darwin + worktree (no opt-out) → hard-fails"
  pass=$((pass + 1))
fi

# Cell 3: Linux + main repo → no fallback.
out=$(run_helper_with_uname "Linux" "$SCN11_MAIN")
case "$out" in
  *"IS_WORKTREE=0"*"NEEDS_FALLBACK=0"*"FELL_BACK=0"*"CONTAINER_WD=/app"*)
    echo "PASS Scenario 11 cell 3: Linux + main repo → in-container path computed"
    pass=$((pass + 1))
    ;;
  *)
    echo "FAIL Scenario 11 cell 3: Linux + main repo: $out"
    fail=$((fail + 1))
    ;;
esac

# Cell 4: Linux + worktree, own container unreachable, hard-fail disabled →
# fallback (host). SMI-5570/SMI-5074: the worktree-routing fix is universal
# (Docker's mount(2)-follows-symlinks root cause is not macOS-specific), so
# Linux now behaves identically to Darwin here, not "no fallback" as before.
out=$(run_helper_with_uname "Linux" "$SCN11_MAIN/.worktrees/wt" "SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1")
case "$out" in
  *"IS_WORKTREE=1"*"NEEDS_FALLBACK=1"*"FELL_BACK=1"*"USE_DOCKER=0"*"CONTAINER_WD=/app"*)
    echo "PASS Scenario 11 cell 4: Linux + worktree (hard-fail disabled) → host fallback"
    pass=$((pass + 1))
    ;;
  *)
    echo "FAIL Scenario 11 cell 4: Linux + worktree: $out"
    fail=$((fail + 1))
    ;;
esac

# Cell 4b: Linux + worktree, own container unreachable, NO opt-out → hard-fail.
# Same universal behavior as cell 2b — no more OS-specific carve-out.
if out=$(run_helper_with_uname "Linux" "$SCN11_MAIN/.worktrees/wt"); then
  echo "FAIL Scenario 11 cell 4b: Linux + worktree (no opt-out) should have hard-failed, got: $out"
  fail=$((fail + 1))
else
  echo "PASS Scenario 11 cell 4b: Linux + worktree (no opt-out) → hard-fails"
  pass=$((pass + 1))
fi

# -----------------------------------------------------------------------
# Scenario 12 (SMI-4681): off-tree worktree returns empty CONTAINER_WD,
# triggers NEEDS_FALLBACK=1 regardless of platform.
# -----------------------------------------------------------------------
SCN12_OFFTREE="$SCN11_ROOT/offtree-wt"
mkdir -p "$SCN12_OFFTREE"
(
  cd "$SCN11_MAIN"
  git worktree add -q -b scn12-offtree "$SCN12_OFFTREE"
) >/dev/null 2>&1

out=$(run_helper_with_uname "Linux" "$SCN12_OFFTREE")
case "$out" in
  *"IS_WORKTREE=1"*"NEEDS_FALLBACK=1"*"FELL_BACK=1"*"USE_DOCKER=0"*"CONTAINER_WD="*)
    # Note: CONTAINER_WD= (empty value at end) is correct for off-tree.
    if echo "$out" | grep -q 'CONTAINER_WD=$'; then
      echo "PASS Scenario 12: off-tree worktree → empty CONTAINER_WD + NEEDS_FALLBACK=1"
      pass=$((pass + 1))
    else
      echo "FAIL Scenario 12: off-tree CONTAINER_WD not empty: $out"
      fail=$((fail + 1))
    fi
    ;;
  *)
    echo "FAIL Scenario 12: off-tree worktree: $out"
    fail=$((fail + 1))
    ;;
esac

# -----------------------------------------------------------------------
# Scenario 13 (SMI-6568): pre-commit's docs-only carve-out must classify
# the STAGED set, not the committed range. Library cases source the REAL
# scripts/lib/hook-docker-detect.sh once per shell (sh, dash, bash);
# launcher cases exercise real `git commit` invocations (pathspec/-a/
# --allow-empty/--amend), once under bash — those forms only manifest
# through git's own temporary-index machinery, which a manual `git add`/
# `git rm` cannot reproduce. Design:
# docs/internal/implementation/smi-6568-precommit-docs-only-staged-set.md.
#
# Scope note: the plan's Caller-pairs bullet names S1/S3/S2c as producing
# an IDENTICAL outcome triple (already measured 72-of-72 cells, 0
# divergence, in the plan's own prototype fixture, per that doc's state
# table). This harness exercises one representative state from that family
# (S1) plus S2 (the genuinely different, bug-fix-relevant state) rather
# than re-deriving all three — keeps the fixture small per the host's
# memory-pressure constraint without losing coverage of a NEW invariant.
# -----------------------------------------------------------------------
SCN13_PASS_FAIL_BEFORE_S13=$((pass + fail))
SCN13_ROOT=$(mktemp -d)  # removed by cleanup_tmp_roots (EXIT trap above)
SCN13_ORIGIN="$SCN13_ROOT/origin.git"
git init -q --bare "$SCN13_ORIGIN" >/dev/null 2>&1

SCN13_MAIN="$SCN13_ROOT/main"
mkdir -p "$SCN13_MAIN"
SCN13_MAIN=$(cd "$SCN13_MAIN" && pwd -P)
(
  cd "$SCN13_MAIN"
  git init -q -b main
  git config user.email "test@skillsmith.local"
  git config user.name "Test"
  git remote add origin "$SCN13_ORIGIN"
  mkdir -p docs scripts
  echo "ok" > README.md
  # git never tracks an empty directory — commit a placeholder so every
  # worktree checked out from main has a REAL docs/ directory on disk.
  touch docs/.gitkeep
  printf '#!/bin/sh\necho hi\n' > scripts/tracked.sh
  printf '#!/bin/sh\n' > scripts/a.sh
  printf '#!/bin/sh\n' > scripts/b.sh
  git add README.md docs/.gitkeep scripts/tracked.sh scripts/a.sh scripts/b.sh
  git -c core.hooksPath=/dev/null commit -q -m "initial"
  git push -q origin main
) >/dev/null 2>&1

# docker shim: `command -v docker` succeeds (so detection reaches the
# worktree-own-container-down branch); actually invoking it always exits 1
# (container/daemon unreachable) — same technique as Scenario 11's
# run_helper_with_uname.
SCN13_SHIM=$(mktemp -d)  # removed by cleanup_tmp_roots (EXIT trap above)
cat > "$SCN13_SHIM/docker" <<'DOCKEREOF'
#!/bin/sh
exit 1
DOCKEREOF
chmod +x "$SCN13_SHIM/docker"
# node shim: default success (skips the D4 rollup/esbuild repair probe
# entirely); SCN13_NODE_FAIL=1 flips it to fail, to deliberately trigger
# that probe for the D4 marker cases below.
cat > "$SCN13_SHIM/node" <<'NODEEOF'
#!/bin/sh
[ "${SCN13_NODE_FAIL:-0}" = "1" ] && exit 1
exit 0
NODEEOF
chmod +x "$SCN13_SHIM/node"
# git shim: delegates to the REAL git for everything, EXCEPT when
# SCN13_GIT_DIFF_PARTIAL_FAIL=1 and the invocation is `git diff --cached
# ...`, in which case it reproduces the plan's own measured shell
# primitive directly — `if x=$(printf partial; exit 1)` leaves partial
# stdout in x on failure — rather than hunting for a REAL index
# corruption that happens to behave this way (the plan's own F1 table
# found none for the corruption shapes it tried). Used by exactly one
# case below (mutation-detection for the else-branch's explicit clear).
SCN13_REAL_GIT=$(command -v git)
cat > "$SCN13_SHIM/git" <<GITEOF
#!/bin/sh
if [ "\${SCN13_GIT_DIFF_PARTIAL_FAIL:-0}" = "1" ] && [ "\$1" = "diff" ]; then
  case "\$*" in
    *--cached*)
      printf 'scripts/partial-garbage.sh\n'
      exit 1
      ;;
  esac
fi
exec "$SCN13_REAL_GIT" "\$@"
GITEOF
chmod +x "$SCN13_SHIM/git"

# scn13_new_wt <name> — creates an in-tree worktree off main, no upstream
# tracking (git worktree add -b never sets one). node_modules is
# pre-created so the D4 block's earlier "host node_modules missing" check
# never fires — irrelevant to what these cases test.
scn13_new_wt() {
  _wt="$SCN13_MAIN/.worktrees/$1"
  ( cd "$SCN13_MAIN" && git worktree add -q -b "scn13-$1" "$_wt" main ) >/dev/null 2>&1
  mkdir -p "$_wt/node_modules"
  printf '%s' "$_wt"
}

# scn13_run <shell> <caller|""> <cwd> [VAR=val ...] — sources the REAL
# repo lib in a fresh <shell> process from <cwd>, with HOOK_DETECT_CALLER
# set to <caller> (unset if ""), PATH shimmed, extra VAR=val pairs
# exported first. Prints classification state to stdout — only reached on
# a fallback/no-op outcome, since a hard-fail `exit 1` inside the sourced
# lib terminates the shell before the trailing printf runs (mirrors
# Scenario 11's run_helper_with_uname). stderr goes to SCN13_STDERR
# (truncated fresh each call) for the text-assertion cases.
SCN13_STDERR="$SCN13_ROOT/stderr.out"
scn13_run() {
  _sh="$1"; _caller="$2"; _cwd="$3"; shift 3
  : > "$SCN13_STDERR"
  (
    cd "$_cwd" || exit 99
    if [ -n "$_caller" ]; then
      HOOK_DETECT_CALLER="$_caller"
      export HOOK_DETECT_CALLER
    else
      unset HOOK_DETECT_CALLER 2>/dev/null || true
    fi
    for _kv in "$@"; do
      export "${_kv?}"
    done
    HOOK_DETECT_LIB="${SCN13_LIB_OVERRIDE:-$REPO_ROOT/scripts/lib/hook-docker-detect.sh}"
    export HOOK_DETECT_LIB
    PATH="$SCN13_SHIM:$PATH"
    export PATH
    "$_sh" -c '
      . "$HOOK_DETECT_LIB"
      _changed_empty=0
      [ -z "${_HOOK_CHANGED_FILES:-}" ] && _changed_empty=1
      printf "NEEDS_FALLBACK=%s USE_DOCKER=%s STAGED_EMPTY=%s DOCS_ONLY=%s CHANGED_EMPTY=%s\n" \
        "$NEEDS_FALLBACK" "$USE_DOCKER" "${_HOOK_STAGED_EMPTY:-}" "${_HOOK_DOCS_ONLY:-}" "$_changed_empty"
    '
  ) 2>"$SCN13_STDERR"
}

# scn13_expect <shell> <name> <FB|HF> <caller|""> <cwd> [VAR=val ...]
# Increments the per-shell SCN13_SHELL_EXEC counter as a side effect.
scn13_expect() {
  _shell="$1"; _name="$2"; _expect="$3"; shift 3
  SCN13_SHELL_EXEC=$((SCN13_SHELL_EXEC + 1))
  if out=$(scn13_run "$_shell" "$@"); then
    if [ "$_expect" = "FB" ]; then
      echo "PASS Scenario 13 [$_shell]: $_name -> FB"
      pass=$((pass + 1))
    else
      echo "FAIL Scenario 13 [$_shell]: $_name expected HF but got FB ($out)"
      fail=$((fail + 1))
    fi
  else
    if [ "$_expect" = "HF" ]; then
      echo "PASS Scenario 13 [$_shell]: $_name -> HF"
      pass=$((pass + 1))
    else
      echo "FAIL Scenario 13 [$_shell]: $_name expected FB but got HF"
      fail=$((fail + 1))
    fi
  fi
}

# scn13_pair_guard <name> <expect1> <expect2> — B-2: assert each pair's
# expectations differ BEFORE running the pair's cases.
scn13_pair_guard() {
  SCN13_SHELL_EXEC=$((SCN13_SHELL_EXEC + 1))
  if [ "$2" != "$3" ]; then
    echo "PASS Scenario 13 pair-guard: $1 (expectations differ: $2 vs $3)"
    pass=$((pass + 1))
  else
    echo "FAIL Scenario 13 pair-guard: $1 (expectations must differ, both '$2')"
    fail=$((fail + 1))
  fi
}

# --- Shared, read-only fixture state (built once, reused across shells) ---

# S1: no upstream, no commits beyond the shared initial commit — docs/empty
# family (S1/S3/S2c in the plan's state table all share this outcome
# triple; S1 is this harness's representative).
SCN13_WT_S1=$(scn13_new_wt s1)

# S2: no upstream, 1 docs commit already made (committed range = docs),
# THEN a code file staged on top (staged set = code) — the fix-relevant
# state where pre-commit and pre-push must now disagree.
SCN13_WT_S2=$(scn13_new_wt s2)
(
  cd "$SCN13_WT_S2"
  echo "s2 docs" > docs/s2.md
  git add docs/s2.md
  git -c core.hooksPath=/dev/null commit -q -m "s2 docs commit"
  echo "echo s2" >> scripts/tracked.sh
  git add scripts/tracked.sh
) >/dev/null 2>&1

# D4: 1 docs commit (pre-push committed range) + a second docs file staged
# on top (pre-commit staged set) — both callers reach the docs-only
# fallback path from this one state. Carries its own
# repair-host-native-deps.sh stub so the D4 gate's marker-touch is
# observable.
SCN13_WT_D4=$(scn13_new_wt d4)
mkdir -p "$SCN13_WT_D4/scripts"
SCN13_D4_MARKER_PC="$SCN13_ROOT/d4-marker-pre-commit"
SCN13_D4_MARKER_PP="$SCN13_ROOT/d4-marker-pre-push"
cat > "$SCN13_WT_D4/scripts/repair-host-native-deps.sh" <<'REPAIREOF'
#!/bin/sh
touch "$SCN13_D4_MARKER"
exit 0
REPAIREOF
chmod +x "$SCN13_WT_D4/scripts/repair-host-native-deps.sh"
(
  cd "$SCN13_WT_D4"
  echo "d4 docs" > docs/d4.md
  git add docs/d4.md
  git -c core.hooksPath=/dev/null commit -q -m "d4 docs commit"
  echo "d4 more docs" > docs/d4b.md
  git add docs/d4b.md
) >/dev/null 2>&1

# nodop: a throwaway COPY of the real lib with no sibling
# docs-only-patterns.sh (never the real repo's own copy — that file stays
# untouched). Read via SCN13_LIB_OVERRIDE.
SCN13_NODOP_DIR="$SCN13_ROOT/nodop"
mkdir -p "$SCN13_NODOP_DIR"
cp "$REPO_ROOT/scripts/lib/hook-docker-detect.sh" "$SCN13_NODOP_DIR/hook-docker-detect.sh"

# Index-corruption fixtures, built once from S1's real (intact) index —
# the test never corrupts the fixture's live index; these are separate
# files pointed to via GIT_INDEX_FILE.
SCN13_S1_GITDIR=$(cd "$SCN13_WT_S1" && git rev-parse --git-dir)
case "$SCN13_S1_GITDIR" in
  /*) : ;;
  *) SCN13_S1_GITDIR="$SCN13_WT_S1/$SCN13_S1_GITDIR" ;;
esac
SCN13_S1_REAL_INDEX="$SCN13_S1_GITDIR/index"
printf 'garbage not an index' > "$SCN13_ROOT/index-garbage"
cp "$SCN13_S1_REAL_INDEX" "$SCN13_ROOT/index-valid-copy"
cp "$SCN13_S1_REAL_INDEX" "$SCN13_ROOT/index-truncated"
: > "$SCN13_ROOT/index-truncated"
cp "$SCN13_S1_REAL_INDEX" "$SCN13_ROOT/index-unreadable"
chmod 000 "$SCN13_ROOT/index-unreadable"

# Fixed per-shell case+pair-guard count (CALLER 7, F1-EMPTY 3, F1-INDEX 4,
# F1-CLEAR 1, F1-NODOP 3, F1-UNREADABLE 1, SHAPES 5, D4 3, LEAK 3,
# R2-F1 6 = 36).
SCN13_EXPECTED_PER_SHELL=36

for SCN13_SH in sh dash bash; do
  SCN13_SHELL_EXEC=0
  if ! command -v "$SCN13_SH" >/dev/null 2>&1; then
    echo "FAIL Scenario 13: $SCN13_SH not found"
    fail=$((fail + 1))
    continue
  fi

  # --- Group CALLER (S1 + S2 families) ---
  # S1 starts clean (nothing staged): stage docs, check, unstage, stage
  # code, check.
  ( cd "$SCN13_WT_S1" && echo "s1 docs" > docs/s1.md && git add docs/s1.md ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "S1 pre-commit docs staged" FB pre-commit "$SCN13_WT_S1"
  ( cd "$SCN13_WT_S1" && git reset -q -- docs/s1.md && rm -f docs/s1.md ) >/dev/null 2>&1
  ( cd "$SCN13_WT_S1" && echo "echo s1" >> scripts/tracked.sh && git add scripts/tracked.sh ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "S1 pre-commit code staged" HF pre-commit "$SCN13_WT_S1"
  ( cd "$SCN13_WT_S1" && git reset -q -- scripts/tracked.sh && git checkout -q -- scripts/tracked.sh ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "S1 pre-push (no commits, no upstream)" HF pre-push "$SCN13_WT_S1"
  scn13_pair_guard "caller-S1 docs-vs-code" FB HF

  scn13_expect "$SCN13_SH" "S2 pre-commit code staged (committed=docs)" HF pre-commit "$SCN13_WT_S2"
  scn13_expect "$SCN13_SH" "S2 pre-push (committed=docs)" FB pre-push "$SCN13_WT_S2"
  scn13_pair_guard "caller-S2 pre-commit-vs-pre-push" HF FB

  # --- Group F1-EMPTY (fresh worktree, this shell only) ---
  SCN13_WT_F1=$(scn13_new_wt "f1-$SCN13_SH")
  scn13_expect "$SCN13_SH" "F1 nothing staged" FB pre-commit "$SCN13_WT_F1"
  ( cd "$SCN13_WT_F1" && echo "echo f1" >> scripts/tracked.sh && git add scripts/tracked.sh ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "F1 code staged (same state)" HF pre-commit "$SCN13_WT_F1"
  scn13_pair_guard "F1-nothing-vs-code" FB HF

  # --- Group F1-INDEX (GIT_INDEX_FILE triple, from S1's real index) ---
  scn13_expect "$SCN13_SH" "F1 GIT_INDEX_FILE valid copy, nothing staged" FB pre-commit "$SCN13_WT_S1" "GIT_INDEX_FILE=$SCN13_ROOT/index-valid-copy"
  scn13_expect "$SCN13_SH" "F1 GIT_INDEX_FILE garbage bytes" HF pre-commit "$SCN13_WT_S1" "GIT_INDEX_FILE=$SCN13_ROOT/index-garbage"
  scn13_expect "$SCN13_SH" "F1 GIT_INDEX_FILE 0-byte-truncated" HF pre-commit "$SCN13_WT_S1" "GIT_INDEX_FILE=$SCN13_ROOT/index-truncated"
  scn13_pair_guard "F1-index-valid-vs-garbage" FB HF

  # --- Group F1-CLEAR: regression guard for the else branch's explicit
  # `_HOOK_CHANGED_FILES=""` clear on a failed diff. Not observable via
  # FB/HF alone (_HOOK_DOCS_ONLY=0 forces the same branch either way), so
  # SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1 forces the fallback
  # path regardless of DOCS_ONLY, making the printed CHANGED_EMPTY field
  # observable. SCN13_GIT_DIFF_PARTIAL_FAIL=1 reproduces the plan's own
  # measured shell primitive (`if x=$(printf partial; exit 1)` leaves
  # partial stdout in x on failure) directly via the git shim, since no
  # real index corruption the plan tried produces partial stdout on a
  # nonzero exit.
  SCN13_SHELL_EXEC=$((SCN13_SHELL_EXEC + 1))
  SCN13_F1CLEAR_OUT=$(scn13_run "$SCN13_SH" pre-commit "$SCN13_WT_S1" "SCN13_GIT_DIFF_PARTIAL_FAIL=1" "SKILLSMITH_WORKTREE_PREPUSH_HARDFAIL_DISABLE=1")
  case "$SCN13_F1CLEAR_OUT" in
    *"CHANGED_EMPTY=1"*)
      echo "PASS Scenario 13 [$SCN13_SH]: failed git diff clears _HOOK_CHANGED_FILES (no partial-stdout leak)"
      pass=$((pass + 1))
      ;;
    *)
      echo "FAIL Scenario 13 [$SCN13_SH]: failed git diff left _HOOK_CHANGED_FILES non-empty ($SCN13_F1CLEAR_OUT)"
      fail=$((fail + 1))
      ;;
  esac

  # --- Group F1-NODOP ---
  scn13_expect "$SCN13_SH" "nothing staged, lib present" FB pre-commit "$SCN13_WT_S1" "GIT_INDEX_FILE=$SCN13_ROOT/index-valid-copy"
  SCN13_LIB_OVERRIDE="$SCN13_NODOP_DIR/hook-docker-detect.sh"
  scn13_expect "$SCN13_SH" "nothing staged, docs-only-patterns.sh sibling absent (nodop)" HF pre-commit "$SCN13_WT_S1" "GIT_INDEX_FILE=$SCN13_ROOT/index-valid-copy"
  unset SCN13_LIB_OVERRIDE
  scn13_pair_guard "F1-nodop" FB HF

  # --- Group F1-UNREADABLE ---
  if [ "$(id -u)" = "0" ]; then
    echo "SKIP Scenario 13 [$SCN13_SH]: chmod-000 index case vacuous (running as root — root can read a 000-mode file)"
    pass=$((pass + 1))
    SCN13_SHELL_EXEC=$((SCN13_SHELL_EXEC + 1))
  else
    scn13_expect "$SCN13_SH" "F1 GIT_INDEX_FILE chmod 000 (unreadable)" HF pre-commit "$SCN13_WT_S1" "GIT_INDEX_FILE=$SCN13_ROOT/index-unreadable"
  fi

  # --- Group SHAPES (fresh worktree, this shell only) ---
  SCN13_WT_SHAPES=$(scn13_new_wt "shapes-$SCN13_SH")
  ( cd "$SCN13_WT_SHAPES" && git mv scripts/b.sh docs/b.sh ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "rename tracked script into docs/ (--no-renames catches it)" HF pre-commit "$SCN13_WT_SHAPES"
  ( cd "$SCN13_WT_SHAPES" && git reset -q; git checkout -q -- scripts/b.sh 2>/dev/null; rm -f docs/b.sh; true ) >/dev/null 2>&1
  ( cd "$SCN13_WT_SHAPES" && git rm -q scripts/a.sh ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "deletion of tracked script" HF pre-commit "$SCN13_WT_SHAPES"
  ( cd "$SCN13_WT_SHAPES" && git reset -q -- scripts/a.sh && git checkout -q -- scripts/a.sh ) >/dev/null 2>&1
  SCN13_FAKE_SHA=$(head -c 40 /dev/zero | tr '\0' '1')
  ( cd "$SCN13_WT_SHAPES" && git update-index --add --cacheinfo "160000,$SCN13_FAKE_SHA,vendor/thing" ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "staged gitlink (--ignore-submodules=none catches it)" HF pre-commit "$SCN13_WT_SHAPES"
  ( cd "$SCN13_WT_SHAPES" && git reset -q -- vendor/thing ) >/dev/null 2>&1
  ( cd "$SCN13_WT_SHAPES" && echo "plain docs" > docs/plain.md && git add docs/plain.md ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "plain docs-only (baseline)" FB pre-commit "$SCN13_WT_SHAPES"
  scn13_pair_guard "shapes-vs-plain-docs" HF FB

  # --- Group D4 (shared, read-only) ---
  rm -f "$SCN13_D4_MARKER_PC" "$SCN13_D4_MARKER_PP"
  scn13_run "$SCN13_SH" pre-commit "$SCN13_WT_D4" "SCN13_NODE_FAIL=1" "SCN13_D4_MARKER=$SCN13_D4_MARKER_PC" >/dev/null
  SCN13_SHELL_EXEC=$((SCN13_SHELL_EXEC + 1))
  if [ ! -e "$SCN13_D4_MARKER_PC" ]; then
    echo "PASS Scenario 13 [$SCN13_SH]: D4 pre-commit never runs the host native repair (marker absent)"
    pass=$((pass + 1))
  else
    echo "FAIL Scenario 13 [$SCN13_SH]: D4 pre-commit ran the host native repair (marker present, should be absent)"
    fail=$((fail + 1))
  fi
  scn13_run "$SCN13_SH" pre-push "$SCN13_WT_D4" "SCN13_NODE_FAIL=1" "SCN13_D4_MARKER=$SCN13_D4_MARKER_PP" >/dev/null
  SCN13_SHELL_EXEC=$((SCN13_SHELL_EXEC + 1))
  if [ -e "$SCN13_D4_MARKER_PP" ]; then
    echo "PASS Scenario 13 [$SCN13_SH]: D4 pre-push still runs the host native repair (marker present)"
    pass=$((pass + 1))
  else
    echo "FAIL Scenario 13 [$SCN13_SH]: D4 pre-push did not run the host native repair (marker absent, should be present)"
    fail=$((fail + 1))
  fi
  scn13_pair_guard "D4-marker-pre-commit-vs-pre-push" ABSENT PRESENT

  # --- Group LEAK (reuse S2, read-only) ---
  # .husky/pre-commit's own HOOK_DETECT_CALLER=pre-commit assignment is
  # deliberately UNEXPORTED (D3) — it must not leak to a genuinely
  # separate child process. Simulate that here: set it without export,
  # then exec a fresh child shell that sources the lib. An unpinned child
  # must see it as unset and default to pre-push semantics (committed
  # range = docs, so FB) — [MEASURED equivalent: "not-in-env+pinned
  # unset"].
  SCN13_SHELL_EXEC=$((SCN13_SHELL_EXEC + 1))
  if out=$(
    cd "$SCN13_WT_S2" || exit 99
    HOOK_DETECT_CALLER=pre-commit
    HOOK_DETECT_LIB="$REPO_ROOT/scripts/lib/hook-docker-detect.sh"
    export HOOK_DETECT_LIB
    PATH="$SCN13_SHIM:$PATH"
    export PATH
    "$SCN13_SH" -c '. "$HOOK_DETECT_LIB"; printf "NEEDS_FALLBACK=%s\n" "$NEEDS_FALLBACK"'
  ); then
    echo "PASS Scenario 13 [$SCN13_SH]: unexported pre-commit caller does not leak to a child -> FB (pre-push default)"
    pass=$((pass + 1))
  else
    echo "FAIL Scenario 13 [$SCN13_SH]: unexported pre-commit caller unexpectedly leaked to the child (hard-failed)"
    fail=$((fail + 1))
  fi
  # Contrast: a HYPOTHETICALLY exported pre-commit caller (the mistake D3's
  # "unexported" choice guards against) WOULD leak to an unpinned child —
  # [MEASURED equivalent: "leaked+unpinned child sees pre-commit"].
  scn13_expect "$SCN13_SH" "hypothetically-exported pre-commit caller leaks to an unpinned child" HF pre-commit "$SCN13_WT_S2"
  scn13_pair_guard "leak-unexported-vs-exported" FB HF

  # --- Group R2-F1 (fresh worktree, this shell only) ---
  SCN13_WT_R2F1=$(scn13_new_wt "r2f1-$SCN13_SH")
  ( cd "$SCN13_WT_R2F1" && echo "r2f1 docs" > docs/r2f1.md && git add docs/r2f1.md ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "R2-F1 docs staged, SKILLSMITH_PRE_PUSH_DOCKER=1" HF pre-commit "$SCN13_WT_R2F1" "SKILLSMITH_PRE_PUSH_DOCKER=1"
  scn13_expect "$SCN13_SH" "R2-F1 docs staged, without the var" FB pre-commit "$SCN13_WT_R2F1"
  scn13_pair_guard "R2-F1-docs" HF FB
  ( cd "$SCN13_WT_R2F1" && git reset -q -- docs/r2f1.md && rm -f docs/r2f1.md ) >/dev/null 2>&1
  scn13_expect "$SCN13_SH" "R2-F1 nothing staged, SKILLSMITH_PRE_PUSH_DOCKER=1" HF pre-commit "$SCN13_WT_R2F1" "SKILLSMITH_PRE_PUSH_DOCKER=1"
  scn13_expect "$SCN13_SH" "R2-F1 nothing staged, without the var" FB pre-commit "$SCN13_WT_R2F1"
  scn13_pair_guard "R2-F1-empty" HF FB

  if [ "$SCN13_SHELL_EXEC" -eq "$SCN13_EXPECTED_PER_SHELL" ]; then
    echo "Scenario 13 [$SCN13_SH]: executed $SCN13_SHELL_EXEC of $SCN13_EXPECTED_PER_SHELL"
  else
    echo "FAIL Scenario 13 [$SCN13_SH]: executed $SCN13_SHELL_EXEC of $SCN13_EXPECTED_PER_SHELL (mismatch)"
    fail=$((fail + 1))
  fi
done

# -----------------------------------------------------------------------
# Scenario 13 structural guards (Scenario 9b-style, static/grep — not
# per-shell): the caller contract must be set BEFORE the lib is sourced in
# each hook.
# -----------------------------------------------------------------------
if awk '/HOOK_DETECT_CALLER=pre-commit/{f=NR} /\. "\$HOOK_DETECT_LIB"/{s=NR} END{exit !(f && s && f < s)}' "$REPO_ROOT/.husky/pre-commit"; then
  echo "PASS Scenario 13: .husky/pre-commit sets HOOK_DETECT_CALLER before sourcing the lib"
  pass=$((pass + 1))
else
  echo "FAIL Scenario 13: .husky/pre-commit does not set HOOK_DETECT_CALLER before sourcing the lib"
  fail=$((fail + 1))
fi

if awk '/export HOOK_DETECT_CALLER=pre-push/{f=NR} /sh "\$CONTAINER_DEPS_LIB"/{s=NR} END{exit !(f && s && f < s)}' "$REPO_ROOT/.husky/pre-push"; then
  echo "PASS Scenario 13: .husky/pre-push pins HOOK_DETECT_CALLER before its first child sourcer"
  pass=$((pass + 1))
else
  echo "FAIL Scenario 13: .husky/pre-push does not pin HOOK_DETECT_CALLER before its first child sourcer"
  fail=$((fail + 1))
fi

# -----------------------------------------------------------------------
# Scenario 13 launcher cases (bash only): real `git commit` invocations,
# since pathspec/-a/--allow-empty/--amend semantics only manifest through
# git's own temporary-index machinery (GIT_INDEX_FILE pointed at a
# next-index-<pid>.lock / index.lock git creates itself), which a manual
# `git add`/`git rm` on the real index cannot reproduce.
# -----------------------------------------------------------------------
SCN13_LAUNCH_HOOKS="$SCN13_ROOT/launch-hooks"
mkdir -p "$SCN13_LAUNCH_HOOKS"
cat > "$SCN13_LAUNCH_HOOKS/pre-commit" <<LAUNCHEOF
#!/bin/sh
PATH="$SCN13_SHIM:\$PATH"
export PATH
HOOK_DETECT_CALLER=pre-commit
HOOK_DETECT_LIB="$REPO_ROOT/scripts/lib/hook-docker-detect.sh"
. "\$HOOK_DETECT_LIB"
exit 0
LAUNCHEOF
chmod +x "$SCN13_LAUNCH_HOOKS/pre-commit"

SCN13_WT_LAUNCH=$(scn13_new_wt launch)
( cd "$SCN13_WT_LAUNCH" && git config core.hooksPath "$SCN13_LAUNCH_HOOKS" ) >/dev/null 2>&1

# L1: pathspec restricts the commit's own temp index to docs/x.md even
# though scripts/tracked.sh is ALSO staged — --cached honours
# GIT_INDEX_FILE, which git points at that temp index for the hook's
# duration.
(
  cd "$SCN13_WT_LAUNCH"
  echo "l1 docs" > docs/x.md
  git add docs/x.md scripts/tracked.sh 2>/dev/null
  echo "l1 code" >> scripts/tracked.sh
  git add docs/x.md scripts/tracked.sh
) >/dev/null 2>&1
if ( cd "$SCN13_WT_LAUNCH" && git commit -q -m "L1 pathspec" -- docs/x.md ) >/dev/null 2>"$SCN13_STDERR"; then
  echo "PASS Scenario 13 [bash launcher]: pathspec -- docs/x.md with code also staged -> commit succeeds (FB)"
  pass=$((pass + 1))
else
  echo "FAIL Scenario 13 [bash launcher]: pathspec -- docs/x.md with code also staged should have succeeded"
  fail=$((fail + 1))
fi
( cd "$SCN13_WT_LAUNCH" && git reset -q -- scripts/tracked.sh && git checkout -q -- scripts/tracked.sh ) >/dev/null 2>&1

# L2: `-a` auto-stages the tracked code modification into a temp index —
# HF (commit must fail).
( cd "$SCN13_WT_LAUNCH" && echo "l2 code" >> scripts/tracked.sh ) >/dev/null 2>&1
if ( cd "$SCN13_WT_LAUNCH" && git commit -q -a -m "L2 -a code" ) >/dev/null 2>"$SCN13_STDERR"; then
  echo "FAIL Scenario 13 [bash launcher]: git commit -a with tracked code should have hard-failed"
  fail=$((fail + 1))
else
  echo "PASS Scenario 13 [bash launcher]: git commit -a with tracked code -> hard-fails (HF)"
  pass=$((pass + 1))
fi
( cd "$SCN13_WT_LAUNCH" && git reset -q -- scripts/tracked.sh; git checkout -q -- scripts/tracked.sh; true ) >/dev/null 2>&1

# L3: --allow-empty -> nothing staged -> FB, commit created.
if ( cd "$SCN13_WT_LAUNCH" && git commit -q --allow-empty -m "L3 empty" ) >/dev/null 2>"$SCN13_STDERR"; then
  echo "PASS Scenario 13 [bash launcher]: git commit --allow-empty -> succeeds (FB)"
  pass=$((pass + 1))
else
  echo "FAIL Scenario 13 [bash launcher]: git commit --allow-empty should have succeeded"
  fail=$((fail + 1))
fi

# L4: message-only --amend -> index still equals the commit being amended
# -> empty diff -> FB. Amends a NON-empty commit (git refuses to amend an
# already-empty commit into another empty one without its own
# --allow-empty, an unrelated git restriction, not what's under test here)
# made fresh with nothing else staged.
( cd "$SCN13_WT_LAUNCH" && echo "l4 docs" > docs/amend-target.md && git add docs/amend-target.md && git commit -q -m "L4 amend target" ) >/dev/null 2>&1
if ( cd "$SCN13_WT_LAUNCH" && git commit -q --amend -m "L4 amend target (message only)" ) >/dev/null 2>"$SCN13_STDERR"; then
  echo "PASS Scenario 13 [bash launcher]: message-only --amend -> succeeds (FB)"
  pass=$((pass + 1))
else
  echo "FAIL Scenario 13 [bash launcher]: message-only --amend should have succeeded"
  fail=$((fail + 1))
fi

# L5: plain code commit -> HF; stderr text check (F4: no un-runnable
# "<same arguments>" placeholder, 0 "git push" mentions).
( cd "$SCN13_WT_LAUNCH" && echo "l5 code" >> scripts/tracked.sh && git add scripts/tracked.sh ) >/dev/null 2>&1
if ( cd "$SCN13_WT_LAUNCH" && git commit -q -m "L5 code" ) >/dev/null 2>"$SCN13_STDERR"; then
  echo "FAIL Scenario 13 [bash launcher]: plain code commit should have hard-failed"
  fail=$((fail + 1))
else
  echo "PASS Scenario 13 [bash launcher]: plain code commit -> hard-fails (HF)"
  pass=$((pass + 1))
fi
SCN13_L5_TEXT=$(cat "$SCN13_STDERR")
case "$SCN13_L5_TEXT" in
  *"re-run your original git commit command prefixed with SKILLSMITH_PRE_PUSH_HOST=1"*)
    if printf '%s' "$SCN13_L5_TEXT" | grep -q 'git push'; then
      echo "FAIL Scenario 13 [bash launcher]: pre-commit HF stderr unexpectedly mentions 'git push'"
      fail=$((fail + 1))
    else
      echo "PASS Scenario 13 [bash launcher]: pre-commit HF stderr has escape-hatch text and 0 'git push' mentions"
      pass=$((pass + 1))
    fi
    ;;
  *)
    echo "FAIL Scenario 13 [bash launcher]: pre-commit HF stderr missing escape-hatch text: $SCN13_L5_TEXT"
    fail=$((fail + 1))
    ;;
esac

# L6: pre-push HF stderr contains the unchanged SKILLSMITH_PRE_PUSH_HOST=1
# git push escape hatch (library-level check — no real `git push` needed,
# since no pathspec/-a/--amend semantics are under test here).
scn13_run bash pre-push "$SCN13_WT_S1" >/dev/null || true
SCN13_L6_TEXT=$(cat "$SCN13_STDERR")
case "$SCN13_L6_TEXT" in
  *"SKILLSMITH_PRE_PUSH_HOST=1 git push"*)
    echo "PASS Scenario 13 [bash launcher]: pre-push HF stderr contains 'SKILLSMITH_PRE_PUSH_HOST=1 git push'"
    pass=$((pass + 1))
    ;;
  *)
    echo "FAIL Scenario 13 [bash launcher]: pre-push HF stderr missing the unchanged escape hatch: $SCN13_L6_TEXT"
    fail=$((fail + 1))
    ;;
esac

# -----------------------------------------------------------------------
# Scenario 13 B-3: pinned total against SMI6568_EXPECTED_CASES (set by
# validate-hooks.yml, D8) — fails loudly on drift instead of silently
# accepting a shrunk or padded case count.
# -----------------------------------------------------------------------
SCN13_TOTAL_AFTER=$((pass + fail))
SCN13_TOTAL_EXECUTED=$((SCN13_TOTAL_AFTER - SCN13_PASS_FAIL_BEFORE_S13))
if [ -n "${SMI6568_EXPECTED_CASES:-}" ]; then
  if [ "$SCN13_TOTAL_EXECUTED" -eq "$SMI6568_EXPECTED_CASES" ]; then
    echo "PASS Scenario 13: total executed ($SCN13_TOTAL_EXECUTED) matches SMI6568_EXPECTED_CASES"
    pass=$((pass + 1))
  else
    echo "FAIL Scenario 13: total executed ($SCN13_TOTAL_EXECUTED) != SMI6568_EXPECTED_CASES ($SMI6568_EXPECTED_CASES)"
    fail=$((fail + 1))
  fi
else
  echo "Scenario 13: SMI6568_EXPECTED_CASES not set — executed $SCN13_TOTAL_EXECUTED cases+checks (local run)"
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
