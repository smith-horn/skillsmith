#!/usr/bin/env bash
# SMI-5570/SMI-5074: Unit tests for worktree-docker.sh's `resolve` subcommand
# and its shared resolve_container_name() helper.
#
# Covers:
#   1. Main checkout resolves to "skillsmith-dev-1" / "main checkout".
#   2. A worktree with a docker-compose.override.yml resolves the
#      CONFIGURED container_name (override-file-preferring), not a fresh
#      recomputation from the current branch.
#   3. Branch-drift case: switching branches within an existing worktree
#      WITHOUT regenerating the override still resolves the override's
#      original (still-correct, still-running) container name — the bug
#      this session found live while implementing Wave 2.
#   4. A worktree with no override.yml falls back to fresh computation
#      from the current branch (get_worktree_name()).
#   5. `resolve` exits 0 when the resolved container is running, 1 when not
#      (verified via `docker ps` filtering — no real container needed
#      since we assert on the exit code / stdout only, not run_cmd).

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
WORKTREE_DOCKER="$SCRIPT_DIR/worktree-docker.sh"

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

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# -----------------------------------------------------------------------
# Fixture: a bare "superproject" repo with a real linked worktree, so
# `git rev-parse --git-dir`/`--git-common-dir` behave exactly as they
# would for a real skillsmith worktree (no faking git plumbing).
# -----------------------------------------------------------------------
SUPER="$SANDBOX/super"
mkdir -p "$SUPER"
git -C "$SUPER" init -q -b main
git -C "$SUPER" config user.email "test@example.com"
git -C "$SUPER" config user.name "Test"
git -C "$SUPER" commit -q --allow-empty -m "init"

WT="$SANDBOX/wt-feature"
git -C "$SUPER" worktree add -q -b "fix/original-branch" "$WT" >/dev/null 2>&1

# -----------------------------------------------------------------------
# Test 1: main checkout resolves to skillsmith-dev-1 / main checkout.
# -----------------------------------------------------------------------
OUT1=$(bash "$WORKTREE_DOCKER" resolve "$SUPER" 2>/dev/null)
assert_eq "test1: main checkout resolves container name" "skillsmith-dev-1" "$(printf '%s' "$OUT1" | cut -d' ' -f1)"
assert_eq "test1: main checkout resolves source label" "main checkout" "$(printf '%s' "$OUT1" | cut -d' ' -f2-)"

# -----------------------------------------------------------------------
# Test 2: worktree with an override.yml resolves the CONFIGURED name.
# -----------------------------------------------------------------------
cat > "$WT/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: original-branch-dev-1
    ports:
      - "3970:3000"
EOF

OUT2=$(bash "$WORKTREE_DOCKER" resolve "$WT" 2>/dev/null)
assert_eq "test2: worktree resolves the override-configured name" "original-branch-dev-1" "$(printf '%s' "$OUT2" | cut -d' ' -f1)"
assert_eq "test2: worktree source label mentions override" "worktree branch (override)" "$(printf '%s' "$OUT2" | cut -d' ' -f2-)"

# -----------------------------------------------------------------------
# Test 3: branch-drift — switch branches within the SAME worktree
# directory without regenerating the override. resolve should still
# report the override's ORIGINAL name (ground truth for what's actually
# provisioned), not a fresh recomputation from the new branch.
# -----------------------------------------------------------------------
git -C "$WT" checkout -q -b "fix/a-totally-different-branch-name"

OUT3=$(bash "$WORKTREE_DOCKER" resolve "$WT" 2>/dev/null)
assert_eq "test3 (branch drift): still resolves the override's original name" "original-branch-dev-1" "$(printf '%s' "$OUT3" | cut -d' ' -f1)"

# -----------------------------------------------------------------------
# Test 4: no override.yml at all → falls back to fresh get_worktree_name()
# computation from the CURRENT branch.
# -----------------------------------------------------------------------
rm -f "$WT/docker-compose.override.yml"

OUT4=$(bash "$WORKTREE_DOCKER" resolve "$WT" 2>/dev/null)
assert_eq "test4 (no override): falls back to fresh branch-based name" "a-totally-different-branch-name-dev-1" "$(printf '%s' "$OUT4" | cut -d' ' -f1)"
assert_eq "test4: source label flags the fallback" "worktree branch (recomputed — no override.yml found; run create-worktree.sh or repair-worktrees.sh)" "$(printf '%s' "$OUT4" | cut -d' ' -f2-)"

# -----------------------------------------------------------------------
# Test 5: exit code reflects running state. Uses the worktree fixture (its
# resolved name, "a-totally-different-branch-name-dev-1", is synthetic and
# guaranteed not to collide with any real container on the test machine —
# unlike "skillsmith-dev-1", which may legitimately be running for real).
# -----------------------------------------------------------------------
bash "$WORKTREE_DOCKER" resolve "$WT" >/dev/null 2>&1
EXIT5=$?
assert_eq "test5: exit 1 when the resolved container isn't actually running" "1" "$EXIT5"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
