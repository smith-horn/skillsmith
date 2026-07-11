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
# SMI-5650 (Wave 1) additions — name-derived (package.json "name", not dir
# basename) create-or-repair of hoisted workspace aliases into a writable
# tmpfs scope dir:
#   7. Name-derived alias creation where the package.json "name" DIFFERS
#      from the directory basename (dir `foo-pkg`, name `@skillsmith/foo`)
#      — proves the script reads package.json, not dir basename.
#   8. Name-derived alias creation for the @smith-horn scope (dir name
#      happens to match the package name here, but a different scope).
#   9. CREATES a MISSING link in an initially-EMPTY writable fixture scope
#      dir — not just repairs an existing wrong one. This is the
#      create-vs-repair-only distinction that is the whole point of the
#      SMI-5650 change (old code only repaired, gated on -L already true).
#  10. Unscoped package names (no "@") are skipped — no link attempted.
#  11. A package with no package.json at all is skipped without error.
#  12. Idempotent second run on already-correct state reports
#      repaired_count 0 / "already correct" for the alias link too.
#  13. A missing/non-writable fixture scope dir fires the actionable
#      "run scripts/repair-worktrees.sh" warning and the script still
#      exits 0.
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
# repointed at the real in-fixture package dir. SMI-5650: the alias name
# is now derived from the package's own package.json "name" field, so the
# fixture package needs one.
# -----------------------------------------------------------------------
setup_fixture
cat > "$SANDBOX/dotworktrees/name/packages/core/package.json" <<'EOF'
{
  "name": "@skillsmith/core",
  "version": "0.0.0"
}
EOF
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

# -----------------------------------------------------------------------
# Test 7 (SMI-5650): name-derived alias creation where the package.json
# "name" field DIFFERS from the directory basename — proves the script
# reads package.json's own "name", not `basename "$pkg_dir"`. Dir is
# `foo-pkg`; package.json name is `@skillsmith/foo`. The correct symlink
# target is still keyed on the DIR basename (packages/<dir>), since that's
# where the real content lives; only the ALIAS NAME under the scope dir is
# name-derived.
# -----------------------------------------------------------------------
setup_fixture
mkdir -p "$SANDBOX/dotworktrees/name/packages/foo-pkg"
cat > "$SANDBOX/dotworktrees/name/packages/foo-pkg/package.json" <<'EOF'
{
  "name": "@skillsmith/foo",
  "version": "0.0.0"
}
EOF

bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /tmp/repair-out-7.log 2>&1
FOO_ALIAS_RESOLVED=$(readlink -f "$SANDBOX/hoisted/@skillsmith/foo")
assert_eq "test7: alias name derived from package.json (not dir basename 'foo-pkg')" "$SANDBOX/dotworktrees/name/packages/foo-pkg" "$FOO_ALIAS_RESOLVED"
if [ -e "$SANDBOX/hoisted/@skillsmith/foo-pkg" ]; then
  echo "FAIL test7: no alias should be created under the dir-basename name 'foo-pkg'"
  fail=$((fail + 1))
else
  echo "PASS test7: no alias created under the dir-basename name 'foo-pkg'"
  pass=$((pass + 1))
fi

# -----------------------------------------------------------------------
# Test 8 (SMI-5650): name-derived alias creation for the @smith-horn scope
# — the pre-existing gap this change closes (old code only ever looked at
# @skillsmith/$pkg, hardcoded to one scope).
# -----------------------------------------------------------------------
setup_fixture
mkdir -p "$SANDBOX/dotworktrees/name/packages/enterprise"
cat > "$SANDBOX/dotworktrees/name/packages/enterprise/package.json" <<'EOF'
{
  "name": "@smith-horn/enterprise",
  "version": "0.0.0"
}
EOF
mkdir -p "$SANDBOX/hoisted/@smith-horn"

bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /tmp/repair-out-8.log 2>&1
ENTERPRISE_ALIAS_RESOLVED=$(readlink -f "$SANDBOX/hoisted/@smith-horn/enterprise")
assert_eq "test8: @smith-horn/enterprise alias created (pre-existing scope gap closed)" "$SANDBOX/dotworktrees/name/packages/enterprise" "$ENTERPRISE_ALIAS_RESOLVED"

# -----------------------------------------------------------------------
# Test 9 (SMI-5650, the whole point of the change): CREATES a MISSING link
# in an initially-EMPTY writable scope dir — not just repairs an existing
# wrong one (that's test4/test8's shape). Old code's `[ -L "$hoisted_link" ]`
# gate made it repair-only; it could never populate an empty tmpfs overlay.
# -----------------------------------------------------------------------
setup_fixture
cat > "$SANDBOX/dotworktrees/name/packages/core/package.json" <<'EOF'
{
  "name": "@skillsmith/core",
  "version": "0.0.0"
}
EOF
# $SANDBOX/hoisted/@skillsmith exists (setup_fixture) but is EMPTY —
# no pre-existing @skillsmith/core entry of ANY kind (not even a broken one).
if [ -e "$SANDBOX/hoisted/@skillsmith/core" ]; then
  echo "FAIL test9 precondition: fixture must start with no @skillsmith/core entry"
  fail=$((fail + 1))
fi

bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /tmp/repair-out-9.log 2>&1
CREATED_RESOLVED=$(readlink -f "$SANDBOX/hoisted/@skillsmith/core")
assert_eq "test9: link CREATED from scratch in an empty scope dir" "$SANDBOX/dotworktrees/name/packages/core" "$CREATED_RESOLVED"
assert_contains "test9: reports a repair/create" "Repaired" "$(cat /tmp/repair-out-9.log)"

# -----------------------------------------------------------------------
# Test 10 (SMI-5650): unscoped package names (no "@") are skipped — no
# link attempted anywhere under the hoisted dir.
# -----------------------------------------------------------------------
setup_fixture
mkdir -p "$SANDBOX/dotworktrees/name/packages/cli-pkg"
cat > "$SANDBOX/dotworktrees/name/packages/cli-pkg/package.json" <<'EOF'
{
  "name": "skillsmith-cli",
  "version": "0.0.0"
}
EOF
BEFORE_HOISTED_LISTING=$(find "$SANDBOX/hoisted" -mindepth 1 2>/dev/null | sort)

EXIT10_LOG=$(mktemp)
bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > "$EXIT10_LOG" 2>&1
EXIT10=$?
AFTER_HOISTED_LISTING=$(find "$SANDBOX/hoisted" -mindepth 1 2>/dev/null | sort)
assert_eq "test10: unscoped name leaves hoisted dir listing unchanged" "$BEFORE_HOISTED_LISTING" "$AFTER_HOISTED_LISTING"
assert_eq "test10: exits 0 for an unscoped package name" "0" "$EXIT10"
rm -f "$EXIT10_LOG"

# -----------------------------------------------------------------------
# Test 11 (SMI-5650): a package with no package.json at all is skipped
# without error (no crash, no alias attempted).
# -----------------------------------------------------------------------
setup_fixture
mkdir -p "$SANDBOX/dotworktrees/name/packages/no-json-pkg"
# Deliberately no package.json written.

EXIT11_LOG=$(mktemp)
bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > "$EXIT11_LOG" 2>&1
EXIT11=$?
assert_eq "test11: exits 0 when a package has no package.json" "0" "$EXIT11"
if [ -e "$SANDBOX/hoisted/@skillsmith/no-json-pkg" ]; then
  echo "FAIL test11: no alias should be attempted for a package with no package.json"
  fail=$((fail + 1))
else
  echo "PASS test11: no alias attempted for a package with no package.json"
  pass=$((pass + 1))
fi
rm -f "$EXIT11_LOG"

# -----------------------------------------------------------------------
# Test 12 (SMI-5650): idempotent second run on already-correct alias-link
# state reports repaired_count 0 / "already correct" — same convention as
# test6's per-package-symlink idempotency, now covering the alias-creation
# path too.
# -----------------------------------------------------------------------
setup_fixture
cat > "$SANDBOX/dotworktrees/name/packages/core/package.json" <<'EOF'
{
  "name": "@skillsmith/core",
  "version": "0.0.0"
}
EOF
bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /dev/null 2>&1
FIRST_ALIAS=$(readlink -f "$SANDBOX/hoisted/@skillsmith/core")
bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > /tmp/repair-out-12.log 2>&1
SECOND_ALIAS=$(readlink -f "$SANDBOX/hoisted/@skillsmith/core")
assert_eq "test12: alias link idempotent across two runs" "$FIRST_ALIAS" "$SECOND_ALIAS"
assert_contains "test12: second run reports already-correct, not a re-repair" "already correct" "$(cat /tmp/repair-out-12.log)"

# -----------------------------------------------------------------------
# Test 13 (SMI-5650): actionable warning + exit-0 fail-soft behavior when
# the fixture scope dir is MISSING or NOT WRITABLE — the two edge cases
# plan §5 Edge Case 1 describes as "stale override, not a cosmetic
# warning". Both must reference the scripts/repair-worktrees.sh
# remediation the CLAUDE.md troubleshooting row now points at.
# -----------------------------------------------------------------------
setup_fixture
mkdir -p "$SANDBOX/dotworktrees/name/packages/missing-scope-pkg"
cat > "$SANDBOX/dotworktrees/name/packages/missing-scope-pkg/package.json" <<'EOF'
{
  "name": "@missing-scope/foo",
  "version": "0.0.0"
}
EOF
# Deliberately do NOT create $SANDBOX/hoisted/@missing-scope.

EXIT13A_LOG=$(mktemp)
bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > "$EXIT13A_LOG" 2>&1
EXIT13A=$?
assert_eq "test13a: exits 0 when the scope dir is missing" "0" "$EXIT13A"
assert_contains "test13a: actionable warning names scripts/repair-worktrees.sh" "run scripts/repair-worktrees.sh" "$(cat "$EXIT13A_LOG")"
assert_contains "test13a: warning names the missing scope + package" "missing/read-only" "$(cat "$EXIT13A_LOG")"
rm -f "$EXIT13A_LOG"

# chmod-based write denial is not exercisable as root (root bypasses file-mode
# write checks entirely) — and this repo's dev container's `dev` Docker build
# target intentionally has NO `USER` directive (only the separate `prod`
# target sets `USER nodejs`; see Dockerfile), so a bash test invoked inside
# it legitimately runs as uid 0. Guard rather than produce a flaky/host-
# dependent result: this sub-case is validated whenever the runner is
# non-root (macOS host, a GitHub Actions runner, or a future non-root dev
# image) and skipped with an explicit message otherwise — test13a above
# (the "missing" sub-case) already covers the else-branch's message and
# exit code root-invariantly.
if [ "$(id -u)" = "0" ]; then
  echo "SKIP test13b: running as root (uid 0) — chmod-based write-permission denial is not exercisable (root bypasses file-mode write checks); see comment above"
else
  setup_fixture
  mkdir -p "$SANDBOX/dotworktrees/name/packages/readonly-scope-pkg"
  cat > "$SANDBOX/dotworktrees/name/packages/readonly-scope-pkg/package.json" <<'EOF'
{
  "name": "@skillsmith/readonly-scope-pkg",
  "version": "0.0.0"
}
EOF
  chmod 555 "$SANDBOX/hoisted/@skillsmith"

  EXIT13B_LOG=$(mktemp)
  bash "$REPAIR_SCRIPT" "$SANDBOX/dotworktrees/name/packages" "$SANDBOX/hoisted" > "$EXIT13B_LOG" 2>&1
  EXIT13B=$?
  chmod 755 "$SANDBOX/hoisted/@skillsmith"   # restore before rm -rf in the next setup_fixture/trap
  assert_eq "test13b: exits 0 when the scope dir is read-only" "0" "$EXIT13B"
  assert_contains "test13b: actionable warning names scripts/repair-worktrees.sh" "run scripts/repair-worktrees.sh" "$(cat "$EXIT13B_LOG")"
  assert_contains "test13b: warning names the read-only scope + package" "missing/read-only" "$(cat "$EXIT13B_LOG")"
  rm -f "$EXIT13B_LOG"
fi

rm -f /tmp/repair-out-*.log

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
