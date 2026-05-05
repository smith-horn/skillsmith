#!/usr/bin/env bash
#
# SMI-4738: smoke tests for scripts/regen-worktree-overrides.sh
#
# Tests the postinstall shim end-to-end against the live repo:
#
#   1. Idempotency — back-to-back invocation does not rewrite an override
#      whose content is already current (cmp -s match).
#   2. Drift detection — staging a fake `packages/<n>/` with a node_modules
#      dir AND a workspace symlink causes the next invocation to write a
#      new override containing the fake's mount lines. Removing the fake
#      causes the subsequent invocation to write again, removing the lines.
#
# Skips cleanly on non-Darwin (the shim itself short-circuits there) and
# when no qualifying worktree (must have BOTH docker-compose.yml AND
# docker-compose.override.yml) is present.
#
# Side effects: stages `packages/skillsmith-fake-smoke/` under the main
# repo root and a workspace symlink at `node_modules/@skillsmith/fake-smoke`.
# Both are removed in a `trap` cleanup, so failures don't leave debris.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "")"
SHIM="$SCRIPT_DIR/regen-worktree-overrides.sh"

# shellcheck source=../_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Resolve to main repo root if invoked from a worktree.
MAIN_GIT_DIR="$(get_main_git_dir "$REPO_ROOT")"
if [[ -n "$MAIN_GIT_DIR" ]] && [[ "$MAIN_GIT_DIR" != "$REPO_ROOT/.git" ]]; then
    REPO_ROOT="$(dirname "$MAIN_GIT_DIR")"
fi

fail=0
pass=0
skipped=0

assert_eq() {
    local name="$1" expected="$2" actual="$3"
    if [[ "$expected" = "$actual" ]]; then
        echo "PASS $name"
        pass=$((pass + 1))
    else
        echo "FAIL $name: expected='$expected' actual='$actual'"
        fail=$((fail + 1))
    fi
}

assert_contains_file() {
    local name="$1" needle="$2" file="$3"
    if grep -qF "$needle" "$file" 2>/dev/null; then
        echo "PASS $name"
        pass=$((pass + 1))
    else
        echo "FAIL $name: '$needle' not in $file"
        fail=$((fail + 1))
    fi
}

assert_not_contains_file() {
    local name="$1" needle="$2" file="$3"
    if grep -qF "$needle" "$file" 2>/dev/null; then
        echo "FAIL $name: '$needle' should NOT be in $file"
        fail=$((fail + 1))
    else
        echo "PASS $name"
        pass=$((pass + 1))
    fi
}

# -----------------------------------------------------------------------
# Platform / fixture gate
# -----------------------------------------------------------------------
if [[ "$(uname)" != "Darwin" ]]; then
    echo "SKIP: macOS-only (postinstall shim is a no-op on $(uname))"
    exit 0
fi

if [[ -z "$REPO_ROOT" ]] || [[ ! -d "$REPO_ROOT" ]]; then
    echo "SKIP: could not resolve main repo root"
    exit 0
fi

# Pick the first worktree that has BOTH compose.yml AND an existing override.
# Iterate via a temp file so we don't lose state across the loop.
TARGET_WT=""
while IFS= read -r wt_path; do
    [[ -z "$wt_path" ]] && continue
    [[ "$wt_path" == "$REPO_ROOT" ]] && continue
    [[ ! -d "$wt_path" ]] && continue
    [[ -f "$wt_path/docker-compose.yml" ]] || continue
    [[ -f "$wt_path/docker-compose.override.yml" ]] || continue
    TARGET_WT="$wt_path"
    break
done < <(git -C "$REPO_ROOT" worktree list --porcelain | awk '/^worktree / { print $2 }')

if [[ -z "$TARGET_WT" ]]; then
    echo "SKIP: no worktree with both docker-compose.yml AND docker-compose.override.yml"
    exit 0
fi

echo "Using target worktree: $TARGET_WT"

# -----------------------------------------------------------------------
# Cleanup trap — must come BEFORE any staging, so a failure mid-test
# still removes fake artifacts.
# -----------------------------------------------------------------------
FAKE_PKG_DIR="$REPO_ROOT/packages/skillsmith-fake-smoke"
FAKE_SYMLINK="$REPO_ROOT/node_modules/@skillsmith/fake-smoke"

cleanup() {
    rm -rf "$FAKE_PKG_DIR"
    rm -f "$FAKE_SYMLINK"
    # If any tmp override file was left behind by an aborted shim run, sweep it.
    find "$TARGET_WT" -maxdepth 1 -name '.docker-compose.override.yml.*' -type f -delete 2>/dev/null || true
}
trap cleanup EXIT

# Pre-flight: make sure the fake doesn't already exist (e.g. left over
# from a prior aborted run before this script's trap was installed).
cleanup

# -----------------------------------------------------------------------
# Test 1: idempotency — first run brings override current; second run
# is a byte-equal no-op (cmp -s).
# -----------------------------------------------------------------------
# Prime: run once to make the override "current" against today's package set.
bash "$SHIM" >/dev/null 2>&1 || true

OVERRIDE="$TARGET_WT/docker-compose.override.yml"
HASH_BEFORE="$(shasum -a 256 "$OVERRIDE" | awk '{print $1}')"

# Re-run within the same wall-clock second as the prime would normally
# differ on the `Generated:` timestamp; sleep 1s to make that difference
# observable IF content-compare were broken. (If cmp -s works, hashes match.)
sleep 1
bash "$SHIM" >/dev/null 2>&1 || true

HASH_AFTER="$(shasum -a 256 "$OVERRIDE" | awk '{print $1}')"
assert_eq "test1: idempotent re-run preserves override content" "$HASH_BEFORE" "$HASH_AFTER"

# -----------------------------------------------------------------------
# Test 2: drift detection — staging a new fake package + workspace
# symlink causes the next shim invocation to write new mount lines.
# -----------------------------------------------------------------------
mkdir -p "$FAKE_PKG_DIR/node_modules"
cat > "$FAKE_PKG_DIR/package.json" <<'EOF'
{ "name": "@skillsmith/fake-smoke", "version": "0.0.0", "private": true }
EOF
mkdir -p "$REPO_ROOT/node_modules/@skillsmith"
ln -sfn "../../packages/skillsmith-fake-smoke" "$FAKE_SYMLINK"

bash "$SHIM" >/dev/null 2>&1 || true

assert_contains_file "test2: per-pkg fake mount emitted" \
    "/packages/skillsmith-fake-smoke/node_modules:/app/packages/skillsmith-fake-smoke/node_modules" \
    "$OVERRIDE"
assert_contains_file "test2: workspace-sibling fake mount emitted" \
    ":/app/node_modules/@skillsmith/fake-smoke" \
    "$OVERRIDE"

# -----------------------------------------------------------------------
# Test 3: drift detection (removal) — removing the fake causes the next
# invocation to remove the mount lines from the override.
# -----------------------------------------------------------------------
rm -rf "$FAKE_PKG_DIR"
rm -f "$FAKE_SYMLINK"

bash "$SHIM" >/dev/null 2>&1 || true

assert_not_contains_file "test3: per-pkg fake mount removed after cleanup" \
    "/packages/skillsmith-fake-smoke/node_modules" \
    "$OVERRIDE"
assert_not_contains_file "test3: workspace-sibling fake mount removed after cleanup" \
    "/app/node_modules/@skillsmith/fake-smoke" \
    "$OVERRIDE"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed, $skipped skipped ====="
[[ "$fail" -eq 0 ]] || exit 1
exit 0
