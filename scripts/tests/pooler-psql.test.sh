#!/usr/bin/env bash
# Unit tests for scripts/pooler-psql.sh.
#
# Stubs `docker` so no real container is needed. Verifies:
#   1. Script exits non-zero and prints a useful message when required env
#      vars are absent.
#   2. Correct PG env vars are forwarded to docker exec (host, port, user,
#      database, password).
#   3. Extra psql flags passed as positional args are forwarded unchanged.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
TARGET="$SCRIPT_DIR/pooler-psql.sh"

if [ ! -x "$TARGET" ]; then
  echo "FAIL: $TARGET not found or not executable"
  exit 1
fi

fail=0

assert_pass() {
  local name="$1" result="$2"
  if [ "$result" = "0" ]; then
    echo "PASS $name"
  else
    echo "FAIL $name: expected exit 0, got $result"
    fail=1
  fi
}

assert_fail() {
  local name="$1" result="$2"
  if [ "$result" != "0" ]; then
    echo "PASS $name"
  else
    echo "FAIL $name: expected non-zero exit, got 0"
    fail=1
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    echo "PASS $name"
  else
    echo "FAIL $name: expected to contain '$needle' in: $haystack"
    fail=1
  fi
}

# ---------------------------------------------------------------------------
# Build a docker shim that simulates the container running.
# `docker inspect ... --format ...` returns "true"; `docker exec` records args.
# ---------------------------------------------------------------------------
make_docker_shim() {
  local tmpdir="$1"
  cat > "$tmpdir/docker" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  inspect)
    echo "true"
    ;;
  exec)
    printf '%s\n' "$@" > "$(dirname "$0")/docker_call"
    ;;
  *)
    printf '%s\n' "$@" > "$(dirname "$0")/docker_call"
    ;;
esac
SHIM
  chmod +x "$tmpdir/docker"
}

# ---------------------------------------------------------------------------
# Build a docker shim that simulates the container NOT running.
# ---------------------------------------------------------------------------
make_docker_shim_down() {
  local tmpdir="$1"
  cat > "$tmpdir/docker" <<'SHIM'
#!/usr/bin/env bash
case "$1" in
  inspect)
    echo "false"
    ;;
  *)
    echo "error: container not running" >&2
    exit 1
    ;;
esac
SHIM
  chmod +x "$tmpdir/docker"
}

run_script() {
  local tmpdir="$1"
  shift
  PATH="$tmpdir:$PATH" bash "$TARGET" "$@" 2>&1
}

# ---------------------------------------------------------------------------
# Case 1: Missing SUPABASE_PROJECT_REF → non-zero exit + helpful message
# ---------------------------------------------------------------------------
case1_dir=$(mktemp -d)
make_docker_shim "$case1_dir"
case1_tmpout="$case1_dir/out"
env -i HOME="$HOME" PATH="$case1_dir:/usr/local/bin:/usr/bin:/bin" \
  SUPABASE_DB_PASSWORD="s3cr3t" \
  bash "$TARGET" -c 'SELECT 1' >"$case1_tmpout" 2>&1 && case1_rc=0 || case1_rc=$?
case1_out=$(cat "$case1_tmpout")
assert_fail "missing_project_ref_exits_nonzero" "$case1_rc"
assert_contains "missing_project_ref_message" "$case1_out" "SUPABASE_PROJECT_REF"
rm -rf "$case1_dir"

# ---------------------------------------------------------------------------
# Case 2: Missing SUPABASE_DB_PASSWORD → non-zero exit + helpful message
# ---------------------------------------------------------------------------
case2_dir=$(mktemp -d)
make_docker_shim "$case2_dir"
case2_tmpout="$case2_dir/out"
env -i HOME="$HOME" PATH="$case2_dir:/usr/local/bin:/usr/bin:/bin" \
  SUPABASE_PROJECT_REF="vrcnzpmndtroqxxoqkzy" \
  bash "$TARGET" -c 'SELECT 1' >"$case2_tmpout" 2>&1 && case2_rc=0 || case2_rc=$?
case2_out=$(cat "$case2_tmpout")
assert_fail "missing_db_password_exits_nonzero" "$case2_rc"
assert_contains "missing_db_password_message" "$case2_out" "SUPABASE_DB_PASSWORD"
rm -rf "$case2_dir"

# ---------------------------------------------------------------------------
# Case 3: Both env vars set → docker exec receives correct PG env vars
# ---------------------------------------------------------------------------
case3_dir=$(mktemp -d)
make_docker_shim "$case3_dir"
(
  export SUPABASE_PROJECT_REF="testref123"
  export SUPABASE_DB_PASSWORD="p@ss!w0rd"
  PATH="$case3_dir:$PATH" bash "$TARGET" -c 'SELECT 1' >/dev/null 2>&1 || true
)
docker_args=$(cat "$case3_dir/docker_call" 2>/dev/null || echo "")

assert_contains "pg_host_passed"     "$docker_args" "PGHOST=aws-1-us-east-1.pooler.supabase.com"
assert_contains "pg_port_passed"     "$docker_args" "PGPORT=6543"
assert_contains "pg_user_passed"     "$docker_args" "PGUSER=postgres.testref123"
assert_contains "pg_password_passed" "$docker_args" "PGPASSWORD=p@ss!w0rd"
assert_contains "pg_database_passed" "$docker_args" "PGDATABASE=postgres"
assert_contains "container_name"     "$docker_args" "skillsmith-dev-1"
rm -rf "$case3_dir"

# ---------------------------------------------------------------------------
# Case 4: Positional args forwarded to psql after container name
# ---------------------------------------------------------------------------
case4_dir=$(mktemp -d)
make_docker_shim "$case4_dir"
(
  export SUPABASE_PROJECT_REF="testref123"
  export SUPABASE_DB_PASSWORD="hunter2"
  PATH="$case4_dir:$PATH" bash "$TARGET" -c 'SELECT 42' >/dev/null 2>&1 || true
)
docker_args4=$(cat "$case4_dir/docker_call" 2>/dev/null || echo "")
assert_contains "psql_flag_passthrough"  "$docker_args4" "-c"
assert_contains "psql_query_passthrough" "$docker_args4" "SELECT 42"
rm -rf "$case4_dir"

# ---------------------------------------------------------------------------
# Case 5: Container not running → non-zero exit + helpful docker compose message
# ---------------------------------------------------------------------------
case5_dir=$(mktemp -d)
make_docker_shim_down "$case5_dir"
case5_tmpout="$case5_dir/out"
env -i HOME="$HOME" PATH="$case5_dir:/usr/local/bin:/usr/bin:/bin" \
  SUPABASE_PROJECT_REF="vrcnzpmndtroqxxoqkzy" \
  SUPABASE_DB_PASSWORD="s3cr3t" \
  bash "$TARGET" -c 'SELECT 1' >"$case5_tmpout" 2>&1 && case5_rc=0 || case5_rc=$?
case5_out=$(cat "$case5_tmpout")
assert_fail    "container_down_exits_nonzero" "$case5_rc"
assert_contains "container_down_message"      "$case5_out" "skillsmith-dev-1"
assert_contains "container_down_hint"         "$case5_out" "docker compose"
rm -rf "$case5_dir"

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [ "$fail" -eq 0 ]; then
  echo "All tests passed."
  exit 0
else
  echo "Some tests FAILED."
  exit 1
fi
