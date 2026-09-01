#!/usr/bin/env bash
# SMI-6334: regression test for the worktree hookspath bug -- a linked
# worktree's `git push`/`git commit` executes the MAIN checkout's copy of
# the hook body (and every script that hook resolves via `$(dirname "$0")`)
# instead of its own, because `core.hooksPath` is repo-shared state and an
# ABSOLUTE value always resolves to the tree it was written from.
#
# Reproduces the bug hermetically (no git-crypt/varlock needed): a bare
# remote + a main checkout + one linked worktree, each with its own
# distinguishable `.husky/pre-push`/`.husky/pre-commit`/`scripts/probe.sh`,
# and the REAL `.husky/_/` dispatch tree copied verbatim from this repo (not
# a paraphrase of it) so the test tracks the shipped `.husky/_/h` dispatcher
# exactly.
#
# Modeled on scripts/tests/create-worktree-hooks.test.sh: same
# assert_eq-style harness, throwaway-repo-in-tmpdir approach.
#
# Assertions (see docs/internal/implementation/smi-6334-worktree-hookspath-fix.md
# Wave 1 Step 1 for the full table + the GPT-5.6-Sol plan-review correction):
#   1. hooksPath absolute -> push from worktree -> MAIN hook runs (documents
#      the bug). Direct config set (baseline case, not exercising the fix).
#   2. hooksPath relative (via ensure_hooks_path_relative()) -> push from
#      worktree -> WORKTREE hook runs.
#   3. hooksPath relative -> push from MAIN -> MAIN hook runs (no
#      regression). Direct config set (baseline case).
#   4. hooksPath relative (via ensure_hooks_path_relative()) -> push from a
#      NESTED SUBDIRECTORY of the worktree -> WORKTREE hook runs.
#   5. hooksPath relative (via ensure_hooks_path_relative()) -> `git commit`
#      from the worktree -> WORKTREE pre-commit runs.
#   6. hooksPath relative (via ensure_hooks_path_relative()) -> the worktree
#      edits ONLY its own `.husky/pre-push` body -> the edit runs (the exact
#      SMI-6260 repro; this is what distinguishes the fix from option (b) in
#      the plan doc -- rewriting hook bodies to resolve siblings via
#      `git rev-parse --show-toplevel` fixes script resolution but NOT
#      hook-body selection itself).
#
# Per the GPT-5.6-Sol plan review (2026-09-01): assertions 2, 4, 5, and 6 --
# every assertion that requires the relative-hooksPath state -- MUST reach
# that state by calling ensure_hooks_path_relative() (Wave 1 Step 2), not by
# hand-setting core.hooksPath directly. A test that sets the destination
# config value itself would keep passing even if the shipped helper were
# missing, broken, or never wired into create-worktree.sh/repair-worktrees.sh
# -- it would prove nothing about the actual fix. Only assertions 1 and 3
# (baseline/no-regression cases) set config directly.

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

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*)
      echo "PASS $name"
      pass=$((pass + 1))
      ;;
    *)
      echo "FAIL $name: expected to find '$needle' in output"
      echo "--- output ---"
      echo "$haystack"
      echo "--------------"
      fail=$((fail + 1))
      ;;
  esac
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*)
      echo "FAIL $name: did NOT expect to find '$needle' in output"
      echo "--- output ---"
      echo "$haystack"
      echo "--------------"
      fail=$((fail + 1))
      ;;
    *)
      echo "PASS $name"
      pass=$((pass + 1))
      ;;
  esac
}

# Calls the real ensure_hooks_path_relative() when it exists (post Wave 1
# Step 2); before Step 2 lands the function is undefined, and this wrapper
# converts that into a clean non-zero return instead of letting bash's
# "command not found" abort the whole script under `set -e` -- which would
# stop the test after assertion 2 and hide whether 4/5/6 also fail as
# expected. Once Step 2 lands, `declare -F` finds the real function and this
# is a transparent passthrough.
call_ensure_hooks_path_relative() {
  if declare -F ensure_hooks_path_relative >/dev/null 2>&1; then
    ensure_hooks_path_relative "$1"
  else
    echo "  (ensure_hooks_path_relative is not yet defined -- expected before Wave 1 Step 2 lands)" >&2
    return 127
  fi
}

# -----------------------------------------------------------------------
# Fixture: bare remote + main checkout + one linked worktree, each with a
# distinguishable .husky/pre-push, .husky/pre-commit, and scripts/probe.sh,
# and the REAL .husky/_/ dispatch tree copied verbatim from this repo.
# -----------------------------------------------------------------------
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT"' EXIT

BARE="$TMPROOT/origin.git"
git init -q --bare "$BARE" >/dev/null 2>&1

MAIN="$TMPROOT/main"
mkdir -p "$MAIN"
# Canonicalize to avoid macOS /var -> /private/var mismatch (same rationale
# as create-worktree-hooks.test.sh's FAKE_MAIN normalization).
MAIN=$(cd "$MAIN" && pwd -P)

(
  cd "$MAIN"
  git init -q -b main
  git config user.email "test@skillsmith.local"
  git config user.name "Test"
  git remote add origin "$BARE"
) >/dev/null 2>&1

# install_hook_set <dir> <marker> -- lays down a full, self-contained hook
# layer in <dir>: the REAL .husky/_/ dispatch tree copied verbatim from
# REPO_ROOT (h + every per-hook stub, e.g. .husky/_/pre-push sourcing h),
# plus distinguishable .husky/pre-push, .husky/pre-commit, and
# scripts/probe.sh bodies that each echo <marker>. Neither hook body needs
# +x -- .husky/_/h invokes them via `sh -e "$s"`, not exec.
install_hook_set() {
  local dir="$1" marker="$2"
  mkdir -p "$dir/.husky" "$dir/scripts"
  rm -rf "$dir/.husky/_"
  cp -R "$REPO_ROOT/.husky/_" "$dir/.husky/_"

  cat > "$dir/.husky/pre-push" <<HOOK
#!/usr/bin/env sh
echo "HOOK-FILE-IS: $marker"
PROBE_SCRIPT="\$(dirname "\$0")/../scripts/probe.sh"
[ -r "\$PROBE_SCRIPT" ] && sh "\$PROBE_SCRIPT"
exit 0
HOOK

  cat > "$dir/.husky/pre-commit" <<HOOK
#!/usr/bin/env sh
echo "HOOK-FILE-IS: $marker"
exit 0
HOOK

  cat > "$dir/scripts/probe.sh" <<HOOK
#!/usr/bin/env sh
echo "PROBE: $marker"
HOOK
}

# commit_all <dir> <msg> -- stages+commits everything in <dir>, with
# core.hooksPath forced to /dev/null so this bootstrap commit never invokes
# whatever hook layer is currently installed (avoids noise/interference
# ahead of the assertions, which each control hooksPath explicitly).
commit_all() {
  local dir="$1" msg="$2"
  ( cd "$dir" && git add -A && git -c core.hooksPath=/dev/null commit -q -m "$msg" )
}

# Bootstrap MAIN: initial commit, then MAIN's own hook set (marker MAIN),
# both pushed with hooks disabled.
echo "ok" > "$MAIN/README.md"
commit_all "$MAIN" "initial"
( cd "$MAIN" && git -c core.hooksPath=/dev/null push -q origin main ) >/dev/null 2>&1

install_hook_set "$MAIN" "MAIN"
commit_all "$MAIN" "add MAIN hook set"
( cd "$MAIN" && git -c core.hooksPath=/dev/null push -q origin main ) >/dev/null 2>&1

# Create the linked worktree, then give it its OWN hook set (marker
# WORKTREE) -- mirrors a real worktree branch that has edited .husky/* and
# scripts/* and committed the change.
( cd "$MAIN" && git worktree add -q -b wt-branch "$MAIN/.worktrees/wt" main ) >/dev/null 2>&1
WT="$MAIN/.worktrees/wt"
WT=$(cd "$WT" && pwd -P)

install_hook_set "$WT" "WORKTREE"
commit_all "$WT" "worktree: own hook set"
( cd "$WT" && git -c core.hooksPath=/dev/null push -q origin wt-branch ) >/dev/null 2>&1

# -----------------------------------------------------------------------
# Assertion 1: hooksPath ABSOLUTE -> push from worktree -> MAIN hook runs
# (documents the pre-fix bug). Direct config set -- baseline case, not
# exercising ensure_hooks_path_relative().
# -----------------------------------------------------------------------
git -C "$MAIN" config core.hooksPath "$MAIN/.husky/_"

echo "a1" >> "$WT/README.md"
commit_all "$WT" "a1 change"
OUT1=$( (cd "$WT" && git push origin wt-branch 2>&1) || true )

assert_contains "Assertion 1: absolute hooksPath, push from worktree -> MAIN hook body runs" \
  "$OUT1" "HOOK-FILE-IS: MAIN"
assert_contains "Assertion 1: absolute hooksPath, push from worktree -> MAIN probe.sh runs" \
  "$OUT1" "PROBE: MAIN"
assert_not_contains "Assertion 1: absolute hooksPath, push from worktree -> WORKTREE hook does NOT run" \
  "$OUT1" "HOOK-FILE-IS: WORKTREE"

# -----------------------------------------------------------------------
# Assertion 2: hooksPath RELATIVE (via ensure_hooks_path_relative()) -> push
# from worktree -> WORKTREE hook runs.
#
# core.hooksPath is re-corrupted to ABSOLUTE immediately before the helper
# call (same wrong value assertion 1 used) so this assertion's downstream
# checks are genuinely gated on THIS call to ensure_hooks_path_relative()
# succeeding -- not on residual relative state left over from a later
# assertion's direct config set. Without this re-corruption, assertion 3's
# baseline direct-set of core.hooksPath would leak forward and make
# assertions 4/5/6 "pass" even with a missing/broken helper, exactly the gap
# the GPT-5.6-Sol plan review flagged.
# -----------------------------------------------------------------------
git -C "$MAIN" config core.hooksPath "$MAIN/.husky/_"

set +e
call_ensure_hooks_path_relative "$WT" >/dev/null 2>&1
ehpr_rc2=$?
set -e
assert_eq "Assertion 2: ensure_hooks_path_relative() succeeds" "0" "$ehpr_rc2"
assert_eq "Assertion 2: core.hooksPath is now the relative literal '.husky/_'" \
  ".husky/_" "$(git -C "$MAIN" config --get core.hooksPath 2>/dev/null || echo '')"

echo "a2" >> "$WT/README.md"
commit_all "$WT" "a2 change"
OUT2=$( (cd "$WT" && git push origin wt-branch 2>&1) || true )

assert_contains "Assertion 2: relative hooksPath, push from worktree -> WORKTREE hook body runs" \
  "$OUT2" "HOOK-FILE-IS: WORKTREE"
assert_contains "Assertion 2: relative hooksPath, push from worktree -> WORKTREE probe.sh runs" \
  "$OUT2" "PROBE: WORKTREE"
assert_not_contains "Assertion 2: relative hooksPath, push from worktree -> MAIN hook does NOT run" \
  "$OUT2" "HOOK-FILE-IS: MAIN"

# -----------------------------------------------------------------------
# Assertion 3: hooksPath RELATIVE -> push from MAIN -> MAIN hook runs (no
# regression). Direct config set -- baseline/no-regression case, not
# exercising ensure_hooks_path_relative(). (Already relative from assertion
# 2, but re-set directly here so this assertion stays order-independent.)
# -----------------------------------------------------------------------
git -C "$MAIN" config core.hooksPath ".husky/_"

echo "a3" >> "$MAIN/README.md"
commit_all "$MAIN" "a3 change"
OUT3=$( (cd "$MAIN" && git push origin main 2>&1) || true )

assert_contains "Assertion 3: relative hooksPath, push from MAIN -> MAIN hook body runs" \
  "$OUT3" "HOOK-FILE-IS: MAIN"
assert_contains "Assertion 3: relative hooksPath, push from MAIN -> MAIN probe.sh runs" \
  "$OUT3" "PROBE: MAIN"
assert_not_contains "Assertion 3: relative hooksPath, push from MAIN -> WORKTREE hook does NOT run" \
  "$OUT3" "HOOK-FILE-IS: WORKTREE"

# -----------------------------------------------------------------------
# Assertion 4: hooksPath RELATIVE (via ensure_hooks_path_relative()) -> push
# from a NESTED SUBDIRECTORY of the worktree -> WORKTREE hook runs. Git
# normalizes cwd to the worktree's toplevel before running any hook, so this
# must behave identically to a push from the worktree root (assertion 2).
#
# Re-corrupted to ABSOLUTE first -- see assertion 2's comment for why.
# -----------------------------------------------------------------------
git -C "$MAIN" config core.hooksPath "$MAIN/.husky/_"

set +e
call_ensure_hooks_path_relative "$WT" >/dev/null 2>&1
ehpr_rc4=$?
set -e
assert_eq "Assertion 4: ensure_hooks_path_relative() succeeds" "0" "$ehpr_rc4"

mkdir -p "$WT/nested/sub"
echo "a4" >> "$WT/README.md"
commit_all "$WT" "a4 change"
OUT4=$( (cd "$WT/nested/sub" && git push origin wt-branch 2>&1) || true )

assert_contains "Assertion 4: relative hooksPath, push from nested worktree subdir -> WORKTREE hook body runs" \
  "$OUT4" "HOOK-FILE-IS: WORKTREE"
assert_contains "Assertion 4: relative hooksPath, push from nested worktree subdir -> WORKTREE probe.sh runs" \
  "$OUT4" "PROBE: WORKTREE"
assert_not_contains "Assertion 4: relative hooksPath, push from nested worktree subdir -> MAIN hook does NOT run" \
  "$OUT4" "HOOK-FILE-IS: MAIN"

# -----------------------------------------------------------------------
# Assertion 5: hooksPath RELATIVE (via ensure_hooks_path_relative()) ->
# `git commit` from the worktree -> WORKTREE pre-commit hook runs.
#
# Re-corrupted to ABSOLUTE first -- see assertion 2's comment for why.
# -----------------------------------------------------------------------
git -C "$MAIN" config core.hooksPath "$MAIN/.husky/_"

set +e
call_ensure_hooks_path_relative "$WT" >/dev/null 2>&1
ehpr_rc5=$?
set -e
assert_eq "Assertion 5: ensure_hooks_path_relative() succeeds" "0" "$ehpr_rc5"

echo "a5" >> "$WT/README.md"
OUT5=$( (cd "$WT" && git add -A && git commit -q -m "a5 change" 2>&1) || true )

assert_contains "Assertion 5: relative hooksPath, git commit from worktree -> WORKTREE pre-commit runs" \
  "$OUT5" "HOOK-FILE-IS: WORKTREE"
assert_not_contains "Assertion 5: relative hooksPath, git commit from worktree -> MAIN pre-commit does NOT run" \
  "$OUT5" "HOOK-FILE-IS: MAIN"

# -----------------------------------------------------------------------
# Assertion 6 (the SMI-6260 repro): hooksPath RELATIVE (via
# ensure_hooks_path_relative()) -> the worktree edits ONLY its own
# .husky/pre-push body (scripts/probe.sh and .husky/pre-commit untouched) ->
# the edit runs on push. This is what distinguishes the fix from option (b)
# in the plan doc (rewriting `$(dirname "$0")/../` references to resolve via
# `git rev-parse --show-toplevel`) -- that option fixes SCRIPT resolution
# but the worktree's own edited HOOK BODY still never runs, because hook
# body selection happens one level up, at core.hooksPath resolution, before
# any script-resolution logic inside the hook ever executes.
#
# Re-corrupted to ABSOLUTE first -- see assertion 2's comment for why.
# -----------------------------------------------------------------------
git -C "$MAIN" config core.hooksPath "$MAIN/.husky/_"

set +e
call_ensure_hooks_path_relative "$WT" >/dev/null 2>&1
ehpr_rc6=$?
set -e
assert_eq "Assertion 6: ensure_hooks_path_relative() succeeds" "0" "$ehpr_rc6"

cat > "$WT/.husky/pre-push" <<'HOOK'
#!/usr/bin/env sh
echo "HOOK-FILE-IS: WORKTREE"
echo "PRE-PUSH-EDIT-MARKER: SMI-6260-REPRO"
PROBE_SCRIPT="$(dirname "$0")/../scripts/probe.sh"
[ -r "$PROBE_SCRIPT" ] && sh "$PROBE_SCRIPT"
exit 0
HOOK

( cd "$WT" && git add .husky/pre-push && git -c core.hooksPath=/dev/null commit -q -m "a6: edit only .husky/pre-push" ) >/dev/null 2>&1
OUT6=$( (cd "$WT" && git push origin wt-branch 2>&1) || true )

assert_contains "Assertion 6: worktree's own live .husky/pre-push edit RUNS on push (SMI-6260 repro)" \
  "$OUT6" "PRE-PUSH-EDIT-MARKER: SMI-6260-REPRO"
assert_not_contains "Assertion 6: worktree's own live .husky/pre-push edit -> MAIN hook does NOT run" \
  "$OUT6" "HOOK-FILE-IS: MAIN"

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
