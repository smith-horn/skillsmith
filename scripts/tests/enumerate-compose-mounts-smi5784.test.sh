#!/usr/bin/env bash
# SMI-5784: per-package native-module volume/mount enumeration. Sibling to
# scripts/tests/enumerate-compose-mounts-smi5650.test.sh (reuses its exact
# fixture-builder conventions — make_repo/make_pkg_json — plus a new
# make_pkg_native_module() builder for a workspace-local, non-hoisted
# native-module copy under packages/<pkg>/node_modules/<module>).
#
# Context (see docs/internal/implementation/
# smi-5784-native-seed-per-package-volumes.md): the SMI-5650 mechanism only
# covers ROOT node_modules/<module> — packages/core/node_modules/better-sqlite3
# (pinned independently of root, SMI-4484 — a structural, permanent
# divergence, not incidental drift) never got a writable overlay at all.
# scripts/_lib.sh's enumerate_native_module_volumes() and
# enumerate_compose_node_modules_mounts() both grew a SECOND, per-package
# pass that mirrors the existing root-only loop shape, one iteration per
# packages/<pkg>/ directory.
#
# Cases (plan doc § 5):
#   1. Correct per-package volume naming and mount emission.
#   2. Skipped when the per-package module dir is missing.
#   3. Skipped when the per-package module dir is a symlink (same
#      crash-prevention guard as the root loop; sibling real module as
#      control case).
#   4. Mount-order convention check — the package's own `:ro` line
#      textually precedes its native-seed override line (documents the
#      authoring convention; NOT a substitute for a real container-create
#      test, per the plan doc's softened mount-order claim).
#   5. Two packages, each with a divergent copy of the SAME module, get
#      DISTINCT volume names (proves no collision).
#   6. The exact real repro shape confirmed on disk today: root-absent for
#      this module + per-package-present still emits correctly.
#   7. Explicit NO-DIVERGENCE case: zero packages/*/node_modules/<module>
#      directories present must produce byte-for-byte unchanged
#      volume/mount output vs. today's root-only behavior (proves the
#      common case is a clean no-op).
#   8. Empty/partial per-package module directory cases — an empty dir
#      (mid-`npm install` state) and a dir with only package.json (no build
#      artifact) — both evaluated explicitly since the real-directory guard
#      (`[[ -d ... ]]`) does not distinguish empty from populated.
#   9. enumerate_native_module_volumes() per-package declaration: naming,
#      skip-on-missing, skip-on-symlink.

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

assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "FAIL $name: '$needle' should NOT be in output"
    fail=$((fail + 1))
  else
    echo "PASS $name"
    pass=$((pass + 1))
  fi
}

# -----------------------------------------------------------------------
# Fixture builders (mirrors enumerate-compose-mounts-smi5650.test.sh's —
# kept local since shell tests have no import mechanism to share them
# cleanly across files).
# -----------------------------------------------------------------------
make_repo() {
  local root="$1"
  shift
  mkdir -p "$root/packages"
  for pkg in "$@"; do
    mkdir -p "$root/packages/$pkg/node_modules"
  done
}

make_pkg_json() {
  local root="$1" pkg="$2" name="$3"
  cat > "$root/packages/$pkg/package.json" <<EOF
{ "name": "$name", "version": "0.0.0" }
EOF
}

# Workspace-local, non-hoisted native-module copy under a package's own
# node_modules. Populated with a package.json so it reads as a "real"
# installed module (mirrors the real repro shape:
# packages/core/node_modules/better-sqlite3/package.json).
make_pkg_native_module() {
  local root="$1" pkg="$2" module="$3"
  mkdir -p "$root/packages/$pkg/node_modules/$module"
  echo '{ "name": "'"$module"'", "version": "0.0.0" }' \
    > "$root/packages/$pkg/node_modules/$module/package.json"
}

# -----------------------------------------------------------------------
# Test 1: correct per-package volume naming + mount emission for a single
# diverging module in a single package.
# -----------------------------------------------------------------------
ROOT1=$(mktemp -d)
make_repo "$ROOT1" core
make_pkg_json "$ROOT1" core "@skillsmith/core"
make_pkg_native_module "$ROOT1" core better-sqlite3
OUT1=$(enumerate_compose_node_modules_mounts "$ROOT1")
assert_contains "test1: per-package better-sqlite3 volume-reference line emitted" \
  "      - native-seed-core-better-sqlite3:/app/packages/core/node_modules/better-sqlite3" "$OUT1"
VOL1=$(enumerate_native_module_volumes "$ROOT1")
BLOCK1=$(printf '%s\n' "$VOL1" | grep -A1 -F "  native-seed-core-better-sqlite3:")
assert_eq "test1: per-package volume declaration is driver: local, no driver_opts" \
  "  native-seed-core-better-sqlite3:
    driver: local" "$BLOCK1"
rm -rf "$ROOT1"

# -----------------------------------------------------------------------
# Test 2: skipped when the per-package module dir is simply missing (no
# divergence for this specific module in this package).
# -----------------------------------------------------------------------
ROOT2=$(mktemp -d)
make_repo "$ROOT2" core
make_pkg_json "$ROOT2" core "@skillsmith/core"
OUT2=$(enumerate_compose_node_modules_mounts "$ROOT2")
assert_not_contains "test2: no per-package volume-reference when module dir missing" \
  "native-seed-core-better-sqlite3:" "$OUT2"
VOL2=$(enumerate_native_module_volumes "$ROOT2")
assert_not_contains "test2: no per-package volume declared when module dir missing" \
  "native-seed-core-better-sqlite3:" "$VOL2"
rm -rf "$ROOT2"

# -----------------------------------------------------------------------
# Test 3 (crash-prevention guard, plan §1.4 origin, applied per-package):
# skipped when the per-package module dir is a SYMLINK. A sibling
# real-directory module (hnswlib-node) in the SAME package must still emit
# normally (control case), proving the guard is per-entry, not a global
# bail-out.
# -----------------------------------------------------------------------
ROOT3=$(mktemp -d)
make_repo "$ROOT3" core
make_pkg_json "$ROOT3" core "@skillsmith/core"
mkdir -p "$ROOT3/elsewhere-better-sqlite3"
ln -sfn "$ROOT3/elsewhere-better-sqlite3" "$ROOT3/packages/core/node_modules/better-sqlite3"
make_pkg_native_module "$ROOT3" core hnswlib-node
OUT3=$(enumerate_compose_node_modules_mounts "$ROOT3")
assert_not_contains "test3: no per-package volume-reference when module dir is a symlink" \
  "native-seed-core-better-sqlite3:" "$OUT3"
assert_contains "test3: sibling real per-package module still emitted (control case)" \
  "native-seed-core-hnswlib-node:/app/packages/core/node_modules/hnswlib-node" "$OUT3"
VOL3=$(enumerate_native_module_volumes "$ROOT3")
assert_not_contains "test3: no per-package volume declared when module dir is a symlink" \
  "native-seed-core-better-sqlite3:" "$VOL3"
rm -rf "$ROOT3"

# -----------------------------------------------------------------------
# Test 4 (mount-order authoring convention, softened per plan §1 — NOT a
# substitute for a real container-create test): the package's own `:ro`
# node_modules line must textually precede its native-seed override line.
# -----------------------------------------------------------------------
ROOT4=$(mktemp -d)
make_repo "$ROOT4" core
make_pkg_json "$ROOT4" core "@skillsmith/core"
make_pkg_native_module "$ROOT4" core better-sqlite3
OUT4=$(enumerate_compose_node_modules_mounts "$ROOT4")
RO_LINE4=$(printf '%s\n' "$OUT4" | grep -n -F "      - $ROOT4/packages/core/node_modules:/app/packages/core/node_modules:ro" | head -1 | cut -d: -f1) || true
NATIVE_LINE4=$(printf '%s\n' "$OUT4" | grep -n -F "native-seed-core-better-sqlite3:/app/packages/core/node_modules/better-sqlite3" | head -1 | cut -d: -f1) || true
if [ -n "$RO_LINE4" ] && [ -n "$NATIVE_LINE4" ] && [ "$RO_LINE4" -lt "$NATIVE_LINE4" ]; then
  echo "PASS test4: package :ro mount (line $RO_LINE4) precedes native-seed override (line $NATIVE_LINE4)"
  pass=$((pass + 1))
else
  echo "FAIL test4: package :ro mount (line $RO_LINE4) does not precede native-seed override (line $NATIVE_LINE4)"
  fail=$((fail + 1))
fi
rm -rf "$ROOT4"

# -----------------------------------------------------------------------
# Test 5: two packages, each with a divergent copy of the SAME module, get
# DISTINCT volume names (proves no collision between packages).
# -----------------------------------------------------------------------
ROOT5=$(mktemp -d)
make_repo "$ROOT5" core doc-retrieval-mcp
make_pkg_json "$ROOT5" core "@skillsmith/core"
make_pkg_json "$ROOT5" doc-retrieval-mcp "@skillsmith/doc-retrieval-mcp"
make_pkg_native_module "$ROOT5" core better-sqlite3
make_pkg_native_module "$ROOT5" doc-retrieval-mcp better-sqlite3
OUT5=$(enumerate_compose_node_modules_mounts "$ROOT5")
assert_contains "test5: core's better-sqlite3 volume-reference is distinct" \
  "native-seed-core-better-sqlite3:/app/packages/core/node_modules/better-sqlite3" "$OUT5"
assert_contains "test5: doc-retrieval-mcp's better-sqlite3 volume-reference is distinct" \
  "native-seed-doc-retrieval-mcp-better-sqlite3:/app/packages/doc-retrieval-mcp/node_modules/better-sqlite3" "$OUT5"
assert_eq "test5: exactly 2 native-seed volume-reference lines (one per package)" \
  2 "$(printf '%s\n' "$OUT5" | grep -c '^      - native-seed-' || true)"
VOL5=$(enumerate_native_module_volumes "$ROOT5")
assert_contains "test5: core's volume declared distinctly" "  native-seed-core-better-sqlite3:" "$VOL5"
assert_contains "test5: doc-retrieval-mcp's volume declared distinctly" "  native-seed-doc-retrieval-mcp-better-sqlite3:" "$VOL5"
rm -rf "$ROOT5"

# -----------------------------------------------------------------------
# Test 6: the exact real repro shape confirmed on disk today (see plan doc
# Context) — root does NOT have this module diverging, but the package
# DOES. Per-package emission must not depend on root also diverging (the
# two loops are independent).
# -----------------------------------------------------------------------
ROOT6=$(mktemp -d)
make_repo "$ROOT6" core
make_pkg_json "$ROOT6" core "@skillsmith/core"
mkdir -p "$ROOT6/node_modules"   # root node_modules exists, but no better-sqlite3 subdir
make_pkg_native_module "$ROOT6" core better-sqlite3
OUT6=$(enumerate_compose_node_modules_mounts "$ROOT6")
assert_not_contains "test6: no ROOT better-sqlite3 volume-reference (root doesn't diverge)" \
  "native-seed-better-sqlite3:/app/node_modules/better-sqlite3" "$OUT6"
assert_contains "test6: per-package better-sqlite3 volume-reference still emitted" \
  "native-seed-core-better-sqlite3:/app/packages/core/node_modules/better-sqlite3" "$OUT6"
rm -rf "$ROOT6"

# -----------------------------------------------------------------------
# Test 7 (explicit no-divergence case, plan §5): zero
# packages/*/node_modules/<module> directories present must produce
# byte-for-byte UNCHANGED volume/mount output vs. today's root-only
# behavior — proves the common case (no per-package divergence) is a clean
# no-op. Compares against a root-only fixture built with the SAME repo
# shape but no per-package native-module dirs at all.
# -----------------------------------------------------------------------
ROOT7A=$(mktemp -d)
make_repo "$ROOT7A" core
make_pkg_json "$ROOT7A" core "@skillsmith/core"
mkdir -p "$ROOT7A/node_modules/better-sqlite3"
OUT7A=$(enumerate_compose_node_modules_mounts "$ROOT7A")
VOL7A=$(enumerate_native_module_volumes "$ROOT7A")

ROOT7B=$(mktemp -d)
make_repo "$ROOT7B" core
make_pkg_json "$ROOT7B" core "@skillsmith/core"
mkdir -p "$ROOT7B/node_modules/better-sqlite3"
OUT7B=$(enumerate_compose_node_modules_mounts "$ROOT7B")
VOL7B=$(enumerate_native_module_volumes "$ROOT7B")

# Normalize the two independent tmpdir paths out of both outputs before
# comparing, so the comparison is about SHAPE, not the incidental tmpdir name.
NORM7A=$(printf '%s\n' "$OUT7A" | sed "s#$ROOT7A#ROOT#g")
NORM7B=$(printf '%s\n' "$OUT7B" | sed "s#$ROOT7B#ROOT#g")
assert_eq "test7: identical repo shapes with zero per-package divergence produce byte-for-byte identical mount output" \
  "$NORM7A" "$NORM7B"
NORMVOL7A=$(printf '%s\n' "$VOL7A" | sed "s#$ROOT7A#ROOT#g")
NORMVOL7B=$(printf '%s\n' "$VOL7B" | sed "s#$ROOT7B#ROOT#g")
assert_eq "test7: identical repo shapes with zero per-package divergence produce byte-for-byte identical volume output" \
  "$NORMVOL7A" "$NORMVOL7B"
assert_eq "test7: zero native-seed volume-reference lines for per-package (no divergence)" \
  0 "$(printf '%s\n' "$OUT7A" | grep -c '^      - native-seed-core-\|^      - native-seed-doc-retrieval-mcp-' || true)"
rm -rf "$ROOT7A" "$ROOT7B"

# -----------------------------------------------------------------------
# Test 8 (empty/partial per-package module directory cases): the
# real-directory guard (`[[ -d ... ]]`) does not distinguish empty from
# populated — both must still emit the overlay (Docker's own copy-up +
# self-heal handle populating it; the mount enumeration's job is only to
# decide WHETHER an overlay is needed, not whether it's healthy).
# -----------------------------------------------------------------------
ROOT8=$(mktemp -d)
make_repo "$ROOT8" core doc-retrieval-mcp
make_pkg_json "$ROOT8" core "@skillsmith/core"
make_pkg_json "$ROOT8" doc-retrieval-mcp "@skillsmith/doc-retrieval-mcp"
# (a) Completely empty dir — simulates mid-`npm install` state.
mkdir -p "$ROOT8/packages/core/node_modules/better-sqlite3"
# (b) package.json present but no build artifact (e.g. no build/Release/*.node).
mkdir -p "$ROOT8/packages/doc-retrieval-mcp/node_modules/better-sqlite3"
echo '{ "name": "better-sqlite3" }' > "$ROOT8/packages/doc-retrieval-mcp/node_modules/better-sqlite3/package.json"
OUT8=$(enumerate_compose_node_modules_mounts "$ROOT8")
assert_contains "test8: empty per-package module dir still gets a volume-reference line" \
  "native-seed-core-better-sqlite3:/app/packages/core/node_modules/better-sqlite3" "$OUT8"
assert_contains "test8: package.json-only (no build artifact) per-package module dir still gets a volume-reference line" \
  "native-seed-doc-retrieval-mcp-better-sqlite3:/app/packages/doc-retrieval-mcp/node_modules/better-sqlite3" "$OUT8"
VOL8=$(enumerate_native_module_volumes "$ROOT8")
assert_contains "test8: empty per-package module dir still gets a volume declaration" \
  "  native-seed-core-better-sqlite3:" "$VOL8"
assert_contains "test8: package.json-only per-package module dir still gets a volume declaration" \
  "  native-seed-doc-retrieval-mcp-better-sqlite3:" "$VOL8"
rm -rf "$ROOT8"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
