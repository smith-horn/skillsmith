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
trap 'rm -rf "$TMPROOT"' EXIT

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
SCN11_ROOT=$(mktemp -d)
trap 'rm -rf "$SCN11_ROOT"' EXIT
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
