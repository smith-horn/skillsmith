#!/usr/bin/env bash
# SMI-6520 Wave 1 Step 4: tests for verify-worktree-symlinks.sh's dangling-cause
# classification.
#
# Fixture-driven and fully offline: builds a throwaway git repo plus a real
# `git worktree`, plants one symlink of each shape, and runs the REAL script.
# No container, no Docker, no network, and nothing outside the temp dir.
#
# The shapes under test are the ones actually observed on this fleet:
#   alpha  canonical relative literal            -> resolves, not a problem
#   beta   /packages/<pkg>/node_modules          -> container-only resolved form
#          (written by repair-worktree-container-symlinks.sh; 96 of 189 links
#          on the live fleet were in this state when this test was written)
#   gamma  /app/packages/<pkg>/node_modules      -> container-only, /app-rooted.
#          B2(i): an earlier draft would have ACCEPTED this because it is
#          "under /app"; it is still meaningless on the host and must fail.
#   delta  a relative literal pointing nowhere   -> ordinary dangling

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERIFY="$SCRIPT_DIR/verify-worktree-symlinks.sh"

fail_n=0
pass_n=0

assert_contains() {
    local name="$1" needle="$2" haystack="$3"
    case "$haystack" in
        *"$needle"*)
            echo "PASS $name"
            pass_n=$((pass_n + 1))
            ;;
        *)
            echo "FAIL $name: missing '$needle'"
            fail_n=$((fail_n + 1))
            ;;
    esac
}

assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "PASS $name"
        pass_n=$((pass_n + 1))
    else
        echo "FAIL $name: expected='$expected' actual='$actual'"
        fail_n=$((fail_n + 1))
    fi
}

WORK="$(mktemp -d)"
trap 'git -C "$WORK/main" worktree remove --force "$WORK/main/.worktrees/wt" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

MAIN="$WORK/main"
mkdir -p "$MAIN/packages"/{alpha,beta,gamma,delta}
cd "$MAIN" || exit 1
git init -q .
git config user.email t@example.com
git config user.name t
for p in alpha beta gamma delta; do
    mkdir -p "$MAIN/packages/$p/node_modules"
    echo "{}" >"$MAIN/packages/$p/keep.json"
done
git add -A >/dev/null 2>&1
git commit -qm init >/dev/null 2>&1

WT="$MAIN/.worktrees/wt"
git worktree add -q -b wtbranch "$WT" >/dev/null 2>&1 || {
    echo "FAIL setup: git worktree add failed"
    exit 1
}

# Plant one symlink shape per package.
ln -s "../../../../packages/alpha/node_modules" "$WT/packages/alpha/node_modules"
ln -s "/packages/beta/node_modules" "$WT/packages/beta/node_modules"
ln -s "/app/packages/gamma/node_modules" "$WT/packages/gamma/node_modules"
ln -s "../../../../packages/delta/NOPE" "$WT/packages/delta/node_modules"

out="$(cd "$MAIN" && bash "$VERIFY" 2>&1)"
status=$?
# Strip ANSI colour so assertions match plain text.
out="$(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g')"

assert_eq "T-S4-1 exit semantics unchanged (non-zero when problems exist)" "1" "$status"

assert_contains "T-S4-2 beta classified as container-only resolved form" \
    "container-only absolute path (resolved-in-container form)" \
    "$(printf '%s\n' "$out" | grep -A2 'packages/beta/node_modules ->' || true)"

assert_contains "T-S4-3 (B2(i)) gamma /app-rooted literal is FAILED, not accepted" \
    "container-only absolute path (/app-rooted)" \
    "$(printf '%s\n' "$out" | grep -A2 'packages/gamma/node_modules ->' || true)"

assert_contains "T-S4-4 delta classified as an ordinary non-canonical dangling" \
    "relative literal that does not match the canonical form" \
    "$(printf '%s\n' "$out" | grep -A2 'packages/delta/node_modules ->' || true)"

# The canonical literal must be COMPUTED (compute_relative_target), so a
# .worktrees/<name>/packages/<pkg> link gets exactly four ups.
assert_contains "T-S4-5 canonical literal is named and correct for this depth" \
    "canonical literal: ../../../../packages/beta/node_modules" "$out"

assert_contains "T-S4-6 remedy is named" \
    "remedy: ./scripts/repair-worktrees.sh" "$out"

# alpha resolves, so it must NOT be reported as dangling at all.
assert_eq "T-S4-7 canonical, resolving link is not reported" "0" \
    "$(printf '%s\n' "$out" | grep -c 'packages/alpha/node_modules ->' || true)"

# Exactly three problems: beta, gamma, delta.
assert_contains "T-S4-8 problem count is 3, denominator reported" \
    "3 symlink problem(s) found" "$out"

echo
echo "-----------------------------------------------------------"
echo "verify-worktree-symlinks dangling classification: $pass_n passed, $fail_n failed (denominator: $((pass_n + fail_n)))"
[ "$fail_n" -eq 0 ] || exit 1
