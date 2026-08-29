#!/usr/bin/env bash
# SMI-6192: static assertions on docker-compose.yml's website-vercel-output
# named volume -- no live Docker required, pure text/YAML checks against the
# committed file.
#
# This is a *static* file edit (routing packages/website/.vercel through a
# named volume instead of the plain .:/app bind mount, to work around a
# Docker Desktop virtiofs write-coherency bug -- see docs/internal/
# implementation/smi-6192-website-vercel-output-eacces.md), not generated
# output, so unlike the sibling scripts/tests/enumerate-compose-mounts.test.sh
# (which sources _lib.sh and calls a generation function), this test reads
# docker-compose.yml directly and asserts on its content.
#
# Covers:
#   1. Top-level `volumes:` section declares `website-vercel-output` with the
#      `app.skillsmith.owned` label, and no explicit `driver:` key (matching
#      the base-file convention every sibling named volume already follows).
#   2. `dev.volumes` mounts it at /app/packages/website/.vercel.
#   3. `test.volumes` mounts it at /app/packages/website/.vercel.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "FAIL: $COMPOSE_FILE not found"
  exit 1
fi

fail=0
pass=0

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "PASS $name"
    pass=$((pass + 1))
  else
    echo "FAIL $name: '$needle' not in output"
    fail=$((fail + 1))
  fi
}

assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "FAIL $name: '$needle' should NOT be in output"
    fail=$((fail + 1))
  else
    echo "PASS $name"
    pass=$((pass + 1))
  fi
}

COMPOSE_CONTENT=$(cat "$COMPOSE_FILE")

# -----------------------------------------------------------------------
# Top-level `volumes:` section: website-vercel-output declared with the
# app.skillsmith.owned label, no explicit `driver:` key.
# -----------------------------------------------------------------------
assert_contains "top-level volumes: declares website-vercel-output" \
  "website-vercel-output:" "$COMPOSE_CONTENT"

# Grab the matched declaration line plus its `labels:`/owned-label lines
# (it's the last entry in the top-level volumes: section, so this also
# covers EOF gracefully).
TOP_LEVEL_BLOCK=$(grep -A3 "^  website-vercel-output:" "$COMPOSE_FILE" || true)

assert_contains "website-vercel-output has labels: key" \
  "labels:" "$TOP_LEVEL_BLOCK"
assert_contains "website-vercel-output carries app.skillsmith.owned: 'true'" \
  "app.skillsmith.owned: 'true'" "$TOP_LEVEL_BLOCK"
assert_not_contains "website-vercel-output has no explicit driver: key" \
  "driver:" "$TOP_LEVEL_BLOCK"

# -----------------------------------------------------------------------
# dev.volumes and test.volumes both mount the volume at the expected path.
# -----------------------------------------------------------------------
DEV_BLOCK=$(awk '/^  dev:/{flag=1} /^  test:/{flag=0} flag' "$COMPOSE_FILE")
TEST_BLOCK=$(awk '/^  test:/{flag=1} /^volumes:/{flag=0} flag' "$COMPOSE_FILE")

assert_contains "dev.volumes mounts website-vercel-output at /app/packages/website/.vercel" \
  "- website-vercel-output:/app/packages/website/.vercel" "$DEV_BLOCK"
assert_contains "test.volumes mounts website-vercel-output at /app/packages/website/.vercel" \
  "- website-vercel-output:/app/packages/website/.vercel" "$TEST_BLOCK"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
