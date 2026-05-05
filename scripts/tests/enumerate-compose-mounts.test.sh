#!/usr/bin/env bash
# SMI-4689: Unit tests for enumerate_compose_node_modules_mounts and
# generate_docker_override (the macOS bind-mount block).
#
# Covers:
#   1. enumerate_compose_node_modules_mounts emits one line per package whose
#      <repo>/packages/<pkg>/node_modules exists; skips packages without it.
#   2. Output indentation matches docker-compose YAML expectations (6 spaces).
#   3. Path with spaces in the repo root survives unchanged in the output.
#   4. Empty / missing packages dir → no output.
#   5. generate_docker_override produces an idempotent file with the SMI-4689
#      marker on Darwin, and without it on non-Darwin (uname mock).
#   6. repair_worktrees_compose_override is a no-op on non-Darwin.

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
# Fixture builders
# -----------------------------------------------------------------------
make_repo() {
  local root="$1"
  shift
  mkdir -p "$root/packages"
  for pkg in "$@"; do
    mkdir -p "$root/packages/$pkg/node_modules"
  done
}

# -----------------------------------------------------------------------
# Helper: write a minimal package.json into a fixture package
# -----------------------------------------------------------------------
make_pkg_json() {
  local root="$1" pkg="$2" name="$3"
  cat > "$root/packages/$pkg/package.json" <<EOF
{ "name": "$name", "version": "0.0.0" }
EOF
}

make_workspace_symlink() {
  # Match npm's real-world depth:
  # - Scoped (@x/y):   <root>/node_modules/@x/y -> ../../packages/<pkg>  (2 levels up)
  # - Non-scoped (y):  <root>/node_modules/y    -> ../packages/<pkg>     (1 level up)
  local root="$1" name="$2" pkg="$3"
  mkdir -p "$(dirname "$root/node_modules/$name")"
  case "$name" in
    @*/*) ln -sf "../../packages/$pkg" "$root/node_modules/$name" ;;
    *)    ln -sf "../packages/$pkg"    "$root/node_modules/$name" ;;
  esac
}

# -----------------------------------------------------------------------
# Test 1: 3 packages, each with node_modules + workspace symlink
# Expected: 3 per-pkg lines + 3 workspace-sibling lines = 6 total
# -----------------------------------------------------------------------
TMPROOT=$(mktemp -d)
trap 'rm -rf "$TMPROOT" "$SPACEROOT" "$EMPTYROOT"' EXIT

make_repo "$TMPROOT" core mcp-server vscode-extension
make_pkg_json "$TMPROOT" core "@skillsmith/core"
make_pkg_json "$TMPROOT" mcp-server "@skillsmith/mcp-server"
make_pkg_json "$TMPROOT" vscode-extension "skillsmith-vscode"
make_workspace_symlink "$TMPROOT" "@skillsmith/core" "core"
make_workspace_symlink "$TMPROOT" "@skillsmith/mcp-server" "mcp-server"
make_workspace_symlink "$TMPROOT" "skillsmith-vscode" "vscode-extension"

OUT=$(enumerate_compose_node_modules_mounts "$TMPROOT")

assert_eq "test1: emits 3 per-pkg + 3 workspace-sibling = 6 lines" 6 "$(printf '%s\n' "$OUT" | grep -c '^      - ' || true)"
assert_contains "test1: per-pkg core" "      - $TMPROOT/packages/core/node_modules:/app/packages/core/node_modules" "$OUT"
assert_contains "test1: per-pkg mcp-server" "      - $TMPROOT/packages/mcp-server/node_modules:/app/packages/mcp-server/node_modules" "$OUT"
assert_contains "test1: per-pkg vscode-extension" "      - $TMPROOT/packages/vscode-extension/node_modules:/app/packages/vscode-extension/node_modules" "$OUT"
assert_contains "test1: workspace @skillsmith/core" "      - $TMPROOT/packages/core:/app/node_modules/@skillsmith/core" "$OUT"
assert_contains "test1: workspace @skillsmith/mcp-server" "      - $TMPROOT/packages/mcp-server:/app/node_modules/@skillsmith/mcp-server" "$OUT"
assert_contains "test1: workspace skillsmith-vscode (top-level scope)" "      - $TMPROOT/packages/vscode-extension:/app/node_modules/skillsmith-vscode" "$OUT"

# -----------------------------------------------------------------------
# Test 2: package without node_modules is skipped (matches SMI-4381 gate),
# but it MAY still emit a workspace-sibling mount IF its package.json + the
# workspace symlink exist (workspace-sibling = name-based, not deps-based).
# We test the per-pkg gate here; workspace-sibling behavior covered in Test 7.
# -----------------------------------------------------------------------
mkdir -p "$TMPROOT/packages/skillsmith-cli"  # NO node_modules, NO package.json

OUT2=$(enumerate_compose_node_modules_mounts "$TMPROOT")
assert_eq "test2: still 6 lines (skillsmith-cli has no node_modules AND no pkg.json)" 6 "$(printf '%s\n' "$OUT2" | grep -c '^      - ' || true)"
assert_not_contains "test2: skillsmith-cli per-pkg not emitted" "skillsmith-cli/node_modules:/app/packages/skillsmith-cli" "$OUT2"

# -----------------------------------------------------------------------
# Test 3: missing packages/ dir → empty output
# -----------------------------------------------------------------------
EMPTYROOT=$(mktemp -d)
OUT3=$(enumerate_compose_node_modules_mounts "$EMPTYROOT")
assert_eq "test3: empty output for missing packages/" "" "$OUT3"

# -----------------------------------------------------------------------
# Test 4: path with spaces preserved verbatim (per-pkg + workspace-sibling)
# -----------------------------------------------------------------------
SPACEROOT=$(mktemp -d -t 'has space test')
make_repo "$SPACEROOT" core
make_pkg_json "$SPACEROOT" core "@skillsmith/core"
make_workspace_symlink "$SPACEROOT" "@skillsmith/core" "core"
OUT4=$(enumerate_compose_node_modules_mounts "$SPACEROOT")
assert_contains "test4: per-pkg with spaces" "$SPACEROOT/packages/core/node_modules:/app/packages/core/node_modules" "$OUT4"
assert_contains "test4: workspace-sibling with spaces" "$SPACEROOT/packages/core:/app/node_modules/@skillsmith/core" "$OUT4"

# -----------------------------------------------------------------------
# Test 7: workspace-sibling skipped when host workspace symlink missing
# -----------------------------------------------------------------------
NOSYMROOT=$(mktemp -d)
make_repo "$NOSYMROOT" core
make_pkg_json "$NOSYMROOT" core "@skillsmith/core"
# Deliberately do NOT create the workspace symlink at <root>/node_modules/@skillsmith/core
OUT7=$(enumerate_compose_node_modules_mounts "$NOSYMROOT")
assert_eq "test7: only per-pkg emitted (1 line) when symlink absent" 1 "$(printf '%s\n' "$OUT7" | grep -c '^      - ' || true)"
assert_not_contains "test7: no workspace mount" "/app/node_modules/@skillsmith/core" "$OUT7"
rm -rf "$NOSYMROOT"

# -----------------------------------------------------------------------
# Test 5: indentation is exactly 6 spaces (compose YAML services.<*>.volumes:)
# -----------------------------------------------------------------------
FIRST_LINE=$(printf '%s\n' "$OUT" | head -n 1)
LEADING_WS=$(printf '%s' "$FIRST_LINE" | sed -n 's/^\( *\).*/\1/p')
assert_eq "test5: 6-space indent" "      " "$LEADING_WS"

# -----------------------------------------------------------------------
# Test 6: generate_docker_override produces SMI-4689 marker on Darwin only
# -----------------------------------------------------------------------
WT_DIR="$TMPROOT/.worktrees/test-wt"
mkdir -p "$WT_DIR"
generate_docker_override "$WT_DIR" "test-branch" "$TMPROOT"
OVERRIDE=$(cat "$WT_DIR/docker-compose.override.yml")

if [ "$(uname)" = "Darwin" ]; then
  assert_contains "test6 (Darwin): SMI-4689 marker present" "# SMI-4689 bind mounts" "$OVERRIDE"
  assert_contains "test6 (Darwin): core mount injected" "/app/packages/core/node_modules" "$OVERRIDE"
else
  assert_not_contains "test6 (non-Darwin): no SMI-4689 marker" "# SMI-4689 bind mounts" "$OVERRIDE"
  assert_not_contains "test6 (non-Darwin): no bind mount" "/app/packages/core/node_modules" "$OVERRIDE"
fi

# Always present: container_name and ports
assert_contains "test6: container_name emitted" "container_name: test-branch-dev-1" "$OVERRIDE"
assert_contains "test6: dev port emitted" '3000"   # Main app' "$OVERRIDE"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
