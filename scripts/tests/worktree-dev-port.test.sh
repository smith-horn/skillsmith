#!/usr/bin/env bash
# SMI-4298: Unit + integration tests for the worktree DEV_PORT port-collision
# fix added to scripts/_lib.sh (resolve_worktree_dev_port,
# export_worktree_dev_port), wired into scripts/worktree-docker.sh's
# cmd_start and scripts/create-worktree.sh's print_worktree_next_steps.
#
# Root cause: Docker Compose CONCATENATES `ports:` lists across `-f` files
# rather than replacing them, so the base docker-compose.yml's
# `${DEV_PORT:-3001}:3001` survives into every worktree's merged config
# ALONGSIDE that worktree's own bucketed `<port>:3001` entry from the
# SMI-5661 generator. Every worktree therefore also silently claims host
# port 3001. The fix exports DEV_PORT to the worktree's own already-assigned
# port before `docker compose up`, so Compose dedupes the two now-identical
# entries into exactly one.
#
# Uses REAL `git worktree add` fixtures (like worktree-port-collision.test.sh
# and worktree-docker-resolve.test.sh) rather than faking git plumbing, since
# cmd_generate / get_worktree_name genuinely shell out to git.
#
# Covers:
#   A. resolve_worktree_dev_port unit (sources the real _lib.sh directly).
#   B. export_worktree_dev_port unit (DEV_PORT export + NOTE/stream behavior).
#   C. worktree-docker.sh `start` integration, docker shimmed via a PATH
#      binary that logs its argv and DEV_PORT env — the bash analogue of
#      repair-worktrees-docker-guard.test.ts's writeDockerShim.
#   D. create-worktree.sh's print_worktree_next_steps guidance text (AC-9),
#      covered by sourcing the script — its BASH_SOURCE guard permits this,
#      same precedent as create-worktree-ready-probe.test.ts.
#   E. Docker-gated (skipped, not failed, when no daemon is reachable): a
#      real `docker compose --profile dev config` run against a fixture that
#      copies the REAL docker-compose.yml, automating the AC-3 manual
#      verification (every test above stubs `docker`, so none of them
#      exercise real Compose config merging).
# No `-e`: several assertions deliberately provoke a non-zero return
# (resolve_worktree_dev_port's not-found path) and inspect it directly,
# matching worktree-port-collision.test.sh's own rationale.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=../_lib.sh
source "$SCRIPT_DIR/_lib.sh"
WORKTREE_DOCKER="$SCRIPT_DIR/worktree-docker.sh"
CREATE_WORKTREE="$SCRIPT_DIR/create-worktree.sh"
REAL_DOCKER_COMPOSE_YML="$SCRIPT_DIR/../docker-compose.yml"
REAL_DOCKERFILE="$SCRIPT_DIR/../Dockerfile"

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

# Global accumulator of every temp dir created below, removed by a single
# EXIT trap (mirrors worktree-port-collision.test.sh).
ALL_TMP_DIRS=""
trap 'rm -rf $ALL_TMP_DIRS' EXIT

# new_tmp_dir -> a plain throwaway directory (no git), tracked for cleanup,
# echoes its canonicalized path.
new_tmp_dir() {
  local dir
  dir=$(mktemp -d)
  dir=$(cd "$dir" && pwd -P)
  ALL_TMP_DIRS="$ALL_TMP_DIRS $dir"
  printf '%s' "$dir"
}

# new_fixture_repo -> a throwaway git repo with one commit, tracked for
# cleanup, echoes its path. Canonicalized eagerly (macOS mktemp -d returns a
# /var/... symlink to /private/var/...) so `git worktree`/`git rev-parse`
# comparisons never trip over the difference.
new_fixture_repo() {
  local root
  root=$(mktemp -d)
  root=$(cd "$root" && pwd -P)
  ALL_TMP_DIRS="$ALL_TMP_DIRS $root"
  git -C "$root" init -q -b main
  git -C "$root" config user.email test@example.com
  git -C "$root" config user.name "Test"
  git -C "$root" config commit.gpgsign false
  : > "$root/README.md"
  git -C "$root" add README.md
  git -C "$root" commit -qm init >/dev/null
  printf '%s' "$root"
}

# add_worktree <repo_root> <name> -> `git worktree add` on a new branch named
# <name> at <repo_root>/.worktrees/<name>, echoes the path.
add_worktree() {
  local root="$1" name="$2" path
  path="$root/.worktrees/$name"
  git -C "$root" worktree add -q -b "$name" "$path" HEAD >/dev/null 2>&1
  printf '%s' "$path"
}

# Docker shim: PATH-shadows `docker`, logging every invocation's argv AND its
# DEV_PORT env to DOCKER_SHIM_LOG, then exits 0 without touching a real
# daemon. Bash analogue of repair-worktrees-docker-guard.test.ts's
# writeDockerShim.
write_docker_shim() {
  local bin_dir="$1"
  cat > "$bin_dir/docker" << 'SHIM'
#!/bin/sh
echo "DEV_PORT=${DEV_PORT:-} ARGS=$*" >> "$DOCKER_SHIM_LOG"
exit 0
SHIM
  chmod +x "$bin_dir/docker"
}

# =========================================================================
# Group A: resolve_worktree_dev_port unit (real _lib.sh, no git needed)
# =========================================================================

# A1: dev: block has "3891:3001" -> stdout is exactly 3891, rc 0.
DIR_A1=$(new_tmp_dir)
cat > "$DIR_A1/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: fixture-dev-1
    ports:
      - "3890:3000"   # Main app
      - "3891:3001"   # MCP server
  test:
    container_name: fixture-test-1
    ports:
      - "3892:3000"      # Test app
EOF
RC_A1=0
OUT_A1=$(resolve_worktree_dev_port "$DIR_A1/docker-compose.override.yml") || RC_A1=$?
assert_eq "groupA1: dev-block 3891:3001 resolves to 3891" "3891" "$OUT_A1"
assert_eq "groupA1: rc 0 on success" "0" "$RC_A1"

# A2: override file does not exist -> rc 1, stdout empty.
DIR_A2=$(new_tmp_dir)
RC_A2=0
OUT_A2=$(resolve_worktree_dev_port "$DIR_A2/docker-compose.override.yml") || RC_A2=$?
assert_eq "groupA2: missing file returns rc 1" "1" "$RC_A2"
assert_eq "groupA2: missing file -> empty stdout" "" "$OUT_A2"

# A3: dev: block has only a :3000 mapping (no :3001 anywhere) -> rc 1, empty.
DIR_A3=$(new_tmp_dir)
cat > "$DIR_A3/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: fixture-dev-1
    ports:
      - "3890:3000"   # Main app
  test:
    container_name: fixture-test-1
    ports:
      - "3892:3000"      # Test app
EOF
RC_A3=0
OUT_A3=$(resolve_worktree_dev_port "$DIR_A3/docker-compose.override.yml") || RC_A3=$?
assert_eq "groupA3: no :3001 mapping anywhere returns rc 1" "1" "$RC_A3"
assert_eq "groupA3: no :3001 mapping -> empty stdout" "" "$OUT_A3"

# A4: dev: block has "3891:3001" AND a later test: block has "9999:3001" ->
# stdout is 3891 -- proves dev-block scoping, not first-match-in-file luck.
DIR_A4=$(new_tmp_dir)
cat > "$DIR_A4/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: fixture-dev-1
    ports:
      - "3890:3000"   # Main app
      - "3891:3001"   # MCP server
  test:
    container_name: fixture-test-1
    ports:
      - "9999:3001"      # Deliberately shaped like a dev mcp port
EOF
RC_A4=0
OUT_A4=$(resolve_worktree_dev_port "$DIR_A4/docker-compose.override.yml") || RC_A4=$?
assert_eq "groupA4: dev-block scoping picks 3891, not the test block's 9999" "3891" "$OUT_A4"
assert_eq "groupA4: rc 0" "0" "$RC_A4"

# A5: :3001 present ONLY in the test: block -> rc 1 (AC-4: never hand back a
# non-dev port).
DIR_A5=$(new_tmp_dir)
cat > "$DIR_A5/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: fixture-dev-1
    ports:
      - "3890:3000"   # Main app
  test:
    container_name: fixture-test-1
    ports:
      - "9999:3001"      # Only :3001 mapping in the whole file
EOF
RC_A5=0
OUT_A5=$(resolve_worktree_dev_port "$DIR_A5/docker-compose.override.yml") || RC_A5=$?
assert_eq "groupA5: :3001 only in test block refuses to hand it back (AC-4)" "1" "$RC_A5"
assert_eq "groupA5: refusal produces no stdout" "" "$OUT_A5"

# =========================================================================
# Group B: export_worktree_dev_port unit
# =========================================================================

# B1: worktree dir with a 3891:3001 override -> DEV_PORT is 3891 after the
# call; rc 0. Run as a DIRECT call (not $(...)) so `export` persists into
# this shell; redirect combined output to a file instead.
DIR_B1=$(new_tmp_dir)
cat > "$DIR_B1/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: fixture-dev-1
    ports:
      - "3890:3000"   # Main app
      - "3891:3001"   # MCP server
EOF
unset DEV_PORT
OUT_FILE_B1=$(mktemp)
ALL_TMP_DIRS="$ALL_TMP_DIRS $OUT_FILE_B1"
RC_B1=0
export_worktree_dev_port "$DIR_B1" > "$OUT_FILE_B1" 2>&1 || RC_B1=$?
assert_eq "groupB1: DEV_PORT is exported to 3891" "3891" "${DEV_PORT:-}"
assert_eq "groupB1: rc 0" "0" "$RC_B1"

# B2: worktree dir with NO override file -> DEV_PORT stays unset; rc 0;
# combined output is empty (silent no-op -- AC-6).
DIR_B2=$(new_tmp_dir)
unset DEV_PORT
OUT_FILE_B2=$(mktemp)
ALL_TMP_DIRS="$ALL_TMP_DIRS $OUT_FILE_B2"
RC_B2=0
export_worktree_dev_port "$DIR_B2" > "$OUT_FILE_B2" 2>&1 || RC_B2=$?
assert_eq "groupB2: DEV_PORT stays unset (no override file)" "" "${DEV_PORT:-}"
assert_eq "groupB2: rc 0" "0" "$RC_B2"
assert_eq "groupB2: combined output is empty (AC-6 silent no-op)" "" "$(cat "$OUT_FILE_B2")"

# B3: override present, no dev :3001 mapping -> DEV_PORT stays unset; rc 0;
# combined output carries the NOTE and SMI-4298 (AC-5).
DIR_B3=$(new_tmp_dir)
cat > "$DIR_B3/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: fixture-dev-1
    ports:
      - "3890:3000"   # Main app
EOF
unset DEV_PORT
OUT_FILE_B3=$(mktemp)
ALL_TMP_DIRS="$ALL_TMP_DIRS $OUT_FILE_B3"
RC_B3=0
export_worktree_dev_port "$DIR_B3" > "$OUT_FILE_B3" 2>&1 || RC_B3=$?
assert_eq "groupB3: DEV_PORT stays unset (fallback path)" "" "${DEV_PORT:-}"
assert_eq "groupB3: rc 0" "0" "$RC_B3"
assert_contains "groupB3: fallback message carries NOTE:" "NOTE:" "$(cat "$OUT_FILE_B3")"
assert_contains "groupB3: fallback message carries SMI-4298" "SMI-4298" "$(cat "$OUT_FILE_B3")"

# B4: DEV_PORT=3001 pre-exported, override maps 3891:3001 -> DEV_PORT is
# 3891 after the call, documenting the deliberate overwrite (edge case 4).
DIR_B4=$(new_tmp_dir)
cat > "$DIR_B4/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: fixture-dev-1
    ports:
      - "3890:3000"   # Main app
      - "3891:3001"   # MCP server
EOF
export DEV_PORT=3001
OUT_FILE_B4=$(mktemp)
ALL_TMP_DIRS="$ALL_TMP_DIRS $OUT_FILE_B4"
export_worktree_dev_port "$DIR_B4" > "$OUT_FILE_B4" 2>&1
assert_eq "groupB4: a stale pre-exported DEV_PORT is overwritten to 3891" "3891" "${DEV_PORT:-}"
unset DEV_PORT

# =========================================================================
# Group C: worktree-docker.sh `start` integration (real script, shimmed
# docker)
# =========================================================================
ROOT_C=$(new_fixture_repo)
BIN_C=$(new_tmp_dir)
write_docker_shim "$BIN_C"
DOCKER_SHIM_LOG_C=$(mktemp)
ALL_TMP_DIRS="$ALL_TMP_DIRS $DOCKER_SHIM_LOG_C"
export SKILLSMITH_WORKTREE_PORT_SKIP_HOST_CHECK=1

# C1: override mapping host 3891 -> container 3001; run `start`. The shim
# log's `up -d` line must carry DEV_PORT=3891 (AC-1).
WT_C1=$(add_worktree "$ROOT_C" "wt-c1")
printf 'services: {}\n' > "$WT_C1/docker-compose.yml"
cat > "$WT_C1/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: wt-c1-dev-1
    ports:
      - "3890:3000"   # Main app
      - "3891:3001"   # MCP server
  test:
    container_name: wt-c1-test-1
    ports:
      - "3892:3000"      # Test app
EOF
: > "$DOCKER_SHIM_LOG_C"
DOCKER_SHIM_LOG="$DOCKER_SHIM_LOG_C" PATH="$BIN_C:$PATH" \
  bash "$WORKTREE_DOCKER" start "$WT_C1" > /dev/null 2>&1
assert_contains "groupC1: up -d call carries DEV_PORT=3891 (AC-1)" \
  "DEV_PORT=3891 ARGS=compose --profile dev up -d" "$(cat "$DOCKER_SHIM_LOG_C")"

# C2: override with dev ports but NO :3001 -> up -d runs with DEV_PORT
# unset, and combined script output carries the SMI-4298 NOTE end-to-end
# (AC-5).
WT_C2=$(add_worktree "$ROOT_C" "wt-c2")
printf 'services: {}\n' > "$WT_C2/docker-compose.yml"
cat > "$WT_C2/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: wt-c2-dev-1
    ports:
      - "3890:3000"   # Main app
  test:
    container_name: wt-c2-test-1
    ports:
      - "3892:3000"      # Test app
EOF
: > "$DOCKER_SHIM_LOG_C"
COMBINED_C2=$(DOCKER_SHIM_LOG="$DOCKER_SHIM_LOG_C" PATH="$BIN_C:$PATH" \
  bash "$WORKTREE_DOCKER" start "$WT_C2" 2>&1)
assert_contains "groupC2: up -d call has DEV_PORT unset (fallback)" \
  "DEV_PORT= ARGS=compose --profile dev up -d" "$(cat "$DOCKER_SHIM_LOG_C")"
assert_contains "groupC2: script output carries SMI-4298 end-to-end (AC-5)" \
  "SMI-4298" "$COMBINED_C2"

# C3: no-drift / read-back check. Fresh worktree with no override; run
# `generate` (real _lib.sh generator) then `start`. The DEV_PORT value the
# shim observed must equal what the generated file itself says -- proving
# the value is READ BACK, never recomputed (AC-2).
WT_C3=$(add_worktree "$ROOT_C" "wt-c3")
cp "$REAL_DOCKER_COMPOSE_YML" "$WT_C3/docker-compose.yml"
: > "$DOCKER_SHIM_LOG_C"
DOCKER_SHIM_LOG="$DOCKER_SHIM_LOG_C" PATH="$BIN_C:$PATH" \
  bash "$WORKTREE_DOCKER" generate "$WT_C3" > /dev/null 2>&1
GENERATED_PORT_C3=$(grep -oE '"[0-9]+:3001"' "$WT_C3/docker-compose.override.yml" \
  | head -1 | tr -d '"' | cut -d: -f1)
: > "$DOCKER_SHIM_LOG_C"
DOCKER_SHIM_LOG="$DOCKER_SHIM_LOG_C" PATH="$BIN_C:$PATH" \
  bash "$WORKTREE_DOCKER" start "$WT_C3" > /dev/null 2>&1
assert_contains "groupC3: start's DEV_PORT equals the generated file's own value (AC-2)" \
  "DEV_PORT=${GENERATED_PORT_C3} ARGS=compose --profile dev up -d" "$(cat "$DOCKER_SHIM_LOG_C")"

# C4: negative control on the harness -- the same shim log must ALSO record
# cmd_status's trailing `docker ps` call, proving the shim really is on PATH
# and intercepting (so C2's empty DEV_PORT is a real observation, not a
# silently-missing invocation).
assert_contains "groupC4: shim also recorded the cmd_status docker ps call" \
  "ARGS=ps -a" "$(cat "$DOCKER_SHIM_LOG_C")"

unset SKILLSMITH_WORKTREE_PORT_SKIP_HOST_CHECK

# =========================================================================
# Group D: create-worktree.sh's print_worktree_next_steps guidance (AC-9)
# =========================================================================
# Sourced in a fresh `bash -c` subprocess (not our own shell) so
# create-worktree.sh's top-level `set -euo pipefail` never leaks into this
# test runner. $0 is deliberately a PLACEHOLDER, not the real script path:
# create-worktree.sh's own BASH_SOURCE guard at its bottom
# (`[[ "${BASH_SOURCE[0]}" == "${0}" ]]`) exists so `source` can pull in its
# functions WITHOUT running `main` -- but that guard trips true (running a
# real worktree-creation main()) if $0 happens to equal the sourced file's
# own path, which is exactly what BASH_SOURCE[0] resolves to while it is
# being sourced. Keeping $0 a distinct placeholder string is what makes
# `source` a pure function-definition import here.
run_print_next_steps() {
  bash -c '
    source "$1"
    print_worktree_next_steps "$2" "$3" "$4"
  ' _test_runner_ "$CREATE_WORKTREE" "$1" "fix/demo" "$2"
}

# D1/D2: worktree dir with a 3891:3001 override.
DIR_D=$(new_tmp_dir)
cat > "$DIR_D/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: fixture-dev-1
    ports:
      - "3890:3000"   # Main app
      - "3891:3001"   # MCP server
EOF
OUT_D=$(run_print_next_steps "$DIR_D" "/repo")
assert_contains "groupD1: guidance carries DEV_PORT=3891 ... up -d (AC-9)" \
  "DEV_PORT=3891 docker compose --profile dev up -d" "$OUT_D"
assert_contains "groupD2: no-prefix worktree-docker.sh start form is offered first" \
  "worktree-docker.sh start" "$OUT_D"

# D3: worktree dir with an override lacking :3001 -> WARNING, the bare `up`
# fallback, and NOT a malformed empty-valued DEV_PORT= (plan-review High #3).
DIR_D3=$(new_tmp_dir)
cat > "$DIR_D3/docker-compose.override.yml" << 'EOF'
services:
  dev:
    container_name: fixture-dev-1
    ports:
      - "3890:3000"   # Main app
EOF
OUT_D3=$(run_print_next_steps "$DIR_D3" "/repo")
assert_contains "groupD3: WARNING (SMI-4298) shown when no dev :3001 mapping exists" \
  "WARNING (SMI-4298)" "$OUT_D3"
assert_contains "groupD3: bare up -d fallback still printed" \
  "docker compose --profile dev up -d" "$OUT_D3"
assert_not_contains "groupD3: no malformed empty DEV_PORT= prefix" \
  "DEV_PORT=" "$OUT_D3"

# =========================================================================
# Group E: plan-review Medium #5 -- Docker-gated real Compose integration
# for AC-3. Every test above stubs `docker`; none of them exercise real
# Compose config merging. Skipped (not failed) when Docker is unavailable.
# =========================================================================
if ! command -v docker > /dev/null 2>&1 || ! docker info > /dev/null 2>&1; then
  echo "SKIP: docker unavailable (Group E)"
else
  ROOT_E=$(new_fixture_repo)
  cp "$REAL_DOCKER_COMPOSE_YML" "$ROOT_E/docker-compose.yml"
  if [ -f "$REAL_DOCKERFILE" ]; then
    cp "$REAL_DOCKERFILE" "$ROOT_E/Dockerfile"
  else
    printf 'FROM scratch\n' > "$ROOT_E/Dockerfile"
  fi
  git -C "$ROOT_E" add docker-compose.yml Dockerfile
  git -C "$ROOT_E" commit -qm "add real compose files" > /dev/null

  WT_E=$(add_worktree "$ROOT_E" "wt-e")
  export SKILLSMITH_WORKTREE_PORT_SKIP_HOST_CHECK=1
  generate_docker_override "$WT_E" "wt-e" "$ROOT_E" > /dev/null 2>/dev/null
  unset SKILLSMITH_WORKTREE_PORT_SKIP_HOST_CHECK
  PORT_E=$(resolve_worktree_dev_port "$WT_E/docker-compose.override.yml")

  # E1: pre-fix negative control -- DEV_PORT unset. Reproduces the
  # collision: MORE THAN ONE port mapping targets container port 3001 (the
  # base file's stray default AND the worktree's own bucketed mcp port).
  unset DEV_PORT
  TARGET_3001_COUNT_E1=$(cd "$WT_E" && docker compose --profile dev config 2>/dev/null \
    | grep -c 'target: 3001')
  if [ "$TARGET_3001_COUNT_E1" -gt 1 ]; then
    echo "PASS groupE1: DEV_PORT unset reproduces the pre-fix double-publish of container port 3001 (count=$TARGET_3001_COUNT_E1)"
    pass=$((pass + 1))
  else
    echo "FAIL groupE1: expected more than one target:3001 entry with DEV_PORT unset, got $TARGET_3001_COUNT_E1"
    fail=$((fail + 1))
  fi

  # E2: post-fix -- DEV_PORT=<resolved> collapses to exactly ONE entry
  # targeting container port 3001, published at the override's own bucketed
  # port (the literal AC-3 assertion).
  TARGET_3001_COUNT_E2=$(cd "$WT_E" && DEV_PORT="$PORT_E" docker compose --profile dev config 2>/dev/null \
    | grep -c 'target: 3001')
  assert_eq "groupE2: DEV_PORT=<resolved> dedupes to exactly one target:3001 entry (AC-3)" \
    "1" "$TARGET_3001_COUNT_E2"
  PUBLISHED_E2=$(cd "$WT_E" && DEV_PORT="$PORT_E" docker compose --profile dev config 2>/dev/null \
    | grep -A2 'target: 3001' | grep 'published:')
  assert_contains "groupE2: the single entry publishes the override's own port ($PORT_E)" \
    "\"$PORT_E\"" "$PUBLISHED_E2"
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "===== Results: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ] || exit 1
