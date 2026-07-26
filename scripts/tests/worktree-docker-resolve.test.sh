#!/usr/bin/env bash
# SMI-5570/SMI-5074: Unit tests for worktree-docker.sh's `resolve` subcommand
# and its shared resolve_container_name() helper.
#
# SMI-5836: also covers refuse_if_main_checkout()/is_main_checkout() (now in
# _lib.sh) via `start`/`generate` against the same $SUPER main-checkout
# fixture -- this file already builds exactly the fixture the guard needs
# (a real main checkout plus a real linked worktree), so tests 6-7 extend it
# rather than adding a new file.
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
#   6. `start` against the MAIN checkout hard-refuses (SMI-5836, AC-1/AC-3):
#      non-zero exit, message names "MAIN checkout" and "SMI-5836", no
#      override file written, and `docker` is never invoked at all.
#   7. `generate` against the MAIN checkout behaves identically (AC-2/AC-3),
#      independently of `start`.

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

# SMI-5836: needed for the free-text main-checkout refusal message below --
# assert_eq alone can only test "message equals X", not "message contains X".
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
# Docker shim (SMI-5836): PATH-shadows `docker`, appending its argv to
# DOCKER_SHIM_LOG. Tests 6-7 assert this log stays EMPTY -- the
# main-checkout refusal must fire before docker is invoked AT ALL (AC-3),
# not merely before `up -d`.
# -----------------------------------------------------------------------
DOCKER_SHIM_BIN="$SANDBOX/shim-bin"
mkdir -p "$DOCKER_SHIM_BIN"
cat > "$DOCKER_SHIM_BIN/docker" << 'SHIM'
#!/bin/sh
echo "$*" >> "$DOCKER_SHIM_LOG"
exit 0
SHIM
chmod +x "$DOCKER_SHIM_BIN/docker"
DOCKER_SHIM_LOG="$SANDBOX/docker-shim.log"

# Stub docker-compose.yml in $SUPER so the refusal below cannot be
# attributed to the missing-file precondition (worktree-docker.sh's
# `No docker-compose.yml found` check) rather than the main-checkout guard.
printf 'services: {}\n' > "$SUPER/docker-compose.yml"

# -----------------------------------------------------------------------
# Test 6 (SMI-5836, AC-1/AC-3): `start` against the MAIN checkout
# hard-refuses before any side effect.
# -----------------------------------------------------------------------
: > "$DOCKER_SHIM_LOG"
OUT6=$(DOCKER_SHIM_LOG="$DOCKER_SHIM_LOG" PATH="$DOCKER_SHIM_BIN:$PATH" \
  bash "$WORKTREE_DOCKER" start "$SUPER" 2>&1)
RC6=$?
assert_eq "test6: start against main checkout exits non-zero" "1" "$RC6"
assert_contains "test6: refusal names the MAIN checkout" "MAIN checkout" "$OUT6"
assert_contains "test6: refusal names SMI-5836" "SMI-5836" "$OUT6"
if [ -f "$SUPER/docker-compose.override.yml" ]; then
  echo "FAIL test6: override file was written despite the refusal (AC-3)"
  fail=$((fail + 1))
else
  echo "PASS test6: no override file written (AC-3)"
  pass=$((pass + 1))
fi
assert_eq "test6: docker was never invoked (AC-3)" "" "$(cat "$DOCKER_SHIM_LOG")"

# -----------------------------------------------------------------------
# Test 7 (SMI-5836, AC-2/AC-3): `generate` against the MAIN checkout
# behaves identically, independently of `start`.
# -----------------------------------------------------------------------
: > "$DOCKER_SHIM_LOG"
OUT7=$(DOCKER_SHIM_LOG="$DOCKER_SHIM_LOG" PATH="$DOCKER_SHIM_BIN:$PATH" \
  bash "$WORKTREE_DOCKER" generate "$SUPER" 2>&1)
RC7=$?
assert_eq "test7: generate against main checkout exits non-zero" "1" "$RC7"
assert_contains "test7: refusal names the MAIN checkout" "MAIN checkout" "$OUT7"
assert_contains "test7: refusal names SMI-5836" "SMI-5836" "$OUT7"
if [ -f "$SUPER/docker-compose.override.yml" ]; then
  echo "FAIL test7: override file was written despite the refusal (AC-2/AC-3)"
  fail=$((fail + 1))
else
  echo "PASS test7: no override file written (AC-2/AC-3)"
  pass=$((pass + 1))
fi
assert_eq "test7: docker was never invoked (AC-3)" "" "$(cat "$DOCKER_SHIM_LOG")"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
