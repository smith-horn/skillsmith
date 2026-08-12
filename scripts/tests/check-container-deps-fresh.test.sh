#!/usr/bin/env bash
# SMI-6006 — scripts/lib/check-container-deps-fresh.sh tests.
#
# Runs the REAL guard script from its real location (not a copy), so its
# `hook-docker-detect.sh` sourcing and its own lock/self-heal logic are
# exercised as written. Two things are faked, both via PATH shims:
#
#   - `docker`: `ps` reports a fake "skillsmith-dev-1" as running; `exec`
#     strictly validates the production invocation shape (`-w /app`, zero or
#     more `-e KEY=VALUE`, the container name, then `sh
#     scripts/lib/check-container-deps-fresh-inner.sh`) and, once validated,
#     actually runs that file with cwd set to a plain (non-git) FAKE_APP_DIR
#     standing in for the container's /app — so the real lock/self-heal
#     script (mkdir, kill -0, npm install, the real
#     check-node-modules-fresh.sh) runs against REAL files with REAL POSIX
#     semantics, not scripted pass/fail responses. Strict validation means a
#     future accidental change to the production invocation shape fails this
#     test loudly instead of silently passing through a permissive parser.
#     Scenario 9 (ownership-token) sources check-container-deps-fresh-inner.sh
#     directly instead, for a true unit test of release()'s ownership check.
#   - `npm`: `install` logs a line to NPM_CALL_LOG (so every scenario can
#     assert exactly how many times it was really called), sleeps
#     $FAKE_NPM_DELAY, then exits 0, or exits 1 if $FAKE_NPM_FAIL=1.
#
# hook-docker-detect.sh's own IS_WORKTREE/USE_DOCKER detection is NOT faked
# — it runs for real against small real git repos/worktrees this file
# creates, mirroring create-worktree-hooks.test.sh's Scenario 11 approach.
# That means this file only needs to cover check-container-deps-fresh.sh's
# OWN new logic (lock, self-heal, worktree gate); hook-docker-detect.sh's
# own detection correctness is already covered by create-worktree-hooks.test.sh.
#
# Run: bash scripts/tests/check-container-deps-fresh.test.sh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
GUARD="$REPO_ROOT/scripts/lib/check-container-deps-fresh.sh"
INNER="$REPO_ROOT/scripts/lib/check-container-deps-fresh-inner.sh"
REAL_FRESH_CHECK="$REPO_ROOT/scripts/lib/check-node-modules-fresh.sh"

if [ ! -x "$GUARD" ]; then
  echo "FAIL: $GUARD is not executable"
  exit 1
fi
if [ ! -x "$INNER" ]; then
  echo "FAIL: $INNER is not executable"
  exit 1
fi

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

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

NPM_CALL_LOG="$TMP_ROOT/npm-calls.log"
: > "$NPM_CALL_LOG"
npm_call_count() { wc -l < "$NPM_CALL_LOG" | tr -d ' '; }

# --- fake docker + npm on PATH -----------------------------------------
FAKE_BIN="$TMP_ROOT/fake-bin"
mkdir -p "$FAKE_BIN"

cat > "$FAKE_BIN/docker" <<'DOCKER_EOF'
#!/usr/bin/env bash
set -eu
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  ps)
    echo "skillsmith-dev-1"
    exit 0
    ;;
  exec)
    shift
    # Strictly validate the production shape:
    #   -w /app [-e KEY=VALUE ...] <container> sh scripts/lib/check-container-deps-fresh-inner.sh
    # Any deviation is a test FAILURE (exit 2), not a silent skip — this test
    # exists partly to catch an accidental future change to how the guard
    # invokes docker, not just to exercise the lock logic.
    [ "${1:-}" = "-w" ] || { echo "fake docker: expected -w first, got '${1:-}'" >&2; exit 2; }
    shift 2
    while [ "${1:-}" = "-e" ]; do
      export "${2?fake docker: -e with no value}"
      shift 2
    done
    container="${1:-}"
    [ -n "$container" ] || { echo "fake docker: missing container name" >&2; exit 2; }
    shift
    [ "${1:-}" = "sh" ] || { echo "fake docker: expected 'sh', got '${1:-}'" >&2; exit 2; }
    script_path="${2:-}"
    [ "$script_path" = "scripts/lib/check-container-deps-fresh-inner.sh" ] || {
      echo "fake docker: expected the inner-script path, got '$script_path'" >&2
      exit 2
    }
    [ "$#" -eq 2 ] || { echo "fake docker: unexpected trailing args: $*" >&2; exit 2; }
    cd "$FAKE_APP_DIR"
    sh "$script_path"
    exit $?
    ;;
  inspect)
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
DOCKER_EOF
chmod +x "$FAKE_BIN/docker"

cat > "$FAKE_BIN/npm" <<EOF
#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = "install" ]; then
  echo "call" >> "$NPM_CALL_LOG"
  sleep "\${FAKE_NPM_DELAY:-0}"
  if [ "\${FAKE_NPM_FAIL:-0}" = "1" ]; then
    echo "npm ERR! simulated failure" >&2
    exit 1
  fi
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_BIN/npm"

export PATH="$FAKE_BIN:$PATH"

# --- helper: a fresh FAKE_APP_DIR (stands in for the container's /app) --
setup_fake_app_dir() {
  local dir="$1" hash_state="$2"   # hash_state: fresh|stale|missing
  rm -rf "$dir"
  mkdir -p "$dir/scripts/lib" "$dir/node_modules"
  cp "$REAL_FRESH_CHECK" "$dir/scripts/lib/check-node-modules-fresh.sh"
  cp "$INNER" "$dir/scripts/lib/check-container-deps-fresh-inner.sh"
  echo '{"name":"fake"}' > "$dir/package-lock.json"
  local real_hash
  real_hash=$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1)
  case "$hash_state" in
    fresh)   printf '%s\n' "$real_hash" > "$dir/node_modules/.skillsmith-deps-hash" ;;
    stale)   printf '%s\n' "0000000000000000000000000000000000000000000000000000000000000000" > "$dir/node_modules/.skillsmith-deps-hash" ;;
    missing) ;;
  esac
}

# --- helper: a plain (non-worktree) real git repo, main-checkout-shaped -
setup_main_repo() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  ( cd "$dir" && git init -q && git config user.email t@t.com && git config user.name t \
    && touch f && git add f && git commit -q -m init )
}

# --- helper: an in-tree worktree of that repo --------------------------
# Must be a SUBDIRECTORY of main_dir (mirrors this repo's own .worktrees/<name>
# convention) — hook-docker-detect.sh's compute_container_wd() only resolves
# CONTAINER_WD="/app" when the worktree's toplevel is main_dir itself or
# starts with "main_dir/"; a sibling directory is the (different, also-real)
# OFF-TREE worktree case and takes a different code path entirely.
setup_worktree() {
  local main_dir="$1" wt_name="$2"
  ( cd "$main_dir" && git worktree add -q -b "wt-branch-$$-$wt_name" ".worktrees/$wt_name" >/dev/null 2>&1 )
}

# NOTE: callers must set FAKE_DOCKER_LOG (a mktemp path) BEFORE invoking this
# via `rc=$(run_guard ...)` — command substitution forks a subshell, so any
# variable this function assigned would not survive back to the caller.
#
# The guard's own stdout/stderr (colored status text) is redirected to
# GUARD_LAST_OUTPUT (a file, so `cat` after the call recovers it for
# debugging) — never mixed into the captured exit code via `$(run_guard ...)`.
GUARD_LAST_OUTPUT="$TMP_ROOT/guard-last-output.txt"
run_guard() {
  local cwd="$1"
  ( cd "$cwd" && FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" FAKE_APP_DIR="$FAKE_APP_DIR" \
      FAKE_NPM_FAIL="${FAKE_NPM_FAIL:-0}" FAKE_NPM_DELAY="${FAKE_NPM_DELAY:-0}" \
      SKILLSMITH_LOCK_MAX_TRIES="${SKILLSMITH_LOCK_MAX_TRIES:-45}" \
      SKILLSMITH_LOCK_SLEEP_SECS="${SKILLSMITH_LOCK_SLEEP_SECS:-2}" \
      "$GUARD" </dev/null >"$GUARD_LAST_OUTPUT" 2>&1 )
  echo $?
}

# =========================================================================
# Scenario 1: fresh container — no npm install call, exits 0
# =========================================================================
MAIN1="$TMP_ROOT/main1"
APP1="$TMP_ROOT/app1"
setup_main_repo "$MAIN1"
setup_fake_app_dir "$APP1" fresh
FAKE_APP_DIR="$APP1"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
rc=$(run_guard "$MAIN1")
assert_eq "S1: fresh container exits 0" "0" "$rc"
assert_eq "S1: npm install NOT called" "0" "$(npm_call_count)"

# =========================================================================
# Scenario 2: stale container — self-heal fires exactly once, sentinel rewritten
# =========================================================================
MAIN2="$TMP_ROOT/main2"
APP2="$TMP_ROOT/app2"
setup_main_repo "$MAIN2"
setup_fake_app_dir "$APP2" stale
FAKE_APP_DIR="$APP2"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
rc=$(run_guard "$MAIN2")
assert_eq "S2: stale container self-heals and exits 0" "0" "$rc"
assert_eq "S2: npm install called exactly once" "1" "$(npm_call_count)"
NEW_HASH=$(cat "$APP2/node_modules/.skillsmith-deps-hash" 2>/dev/null || echo MISSING)
EXPECTED_HASH=$(sha256sum "$APP2/package-lock.json" | cut -d' ' -f1)
assert_eq "S2: sentinel rewritten to match package-lock.json" "$EXPECTED_HASH" "$NEW_HASH"

# =========================================================================
# Scenario 3: worktree container — guard exits 0 immediately, ZERO docker calls
# =========================================================================
MAIN3="$TMP_ROOT/main3"
setup_main_repo "$MAIN3"
setup_worktree "$MAIN3" "wt3"
WT3="$MAIN3/.worktrees/wt3"
APP3="$TMP_ROOT/app3-should-be-untouched"
setup_fake_app_dir "$APP3" stale
FAKE_APP_DIR="$APP3"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
rc=$(run_guard "$WT3")
assert_eq "S3: worktree guard exits 0" "0" "$rc"
LOG=$(cat "$FAKE_DOCKER_LOG")
if [ -n "$LOG" ]; then
  assert_eq "S3: no 'exec' (mutation) docker calls from a worktree" "" "$(printf '%s\n' "$LOG" | grep '^exec' || true)"
else
  assert_eq "S3: no docker calls at all from a worktree" "" "$LOG"
fi
assert_eq "S3: npm install NOT called" "0" "$(npm_call_count)"

# =========================================================================
# Scenario 4: npm install failure — loud failure, non-zero exit, no sentinel
# write, and the lock is released (not left wedged for the next push)
# =========================================================================
MAIN4="$TMP_ROOT/main4"
APP4="$TMP_ROOT/app4"
setup_main_repo "$MAIN4"
setup_fake_app_dir "$APP4" stale
FAKE_APP_DIR="$APP4"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
FAKE_NPM_FAIL=1
rc=$(run_guard "$MAIN4")
FAKE_NPM_FAIL=0
assert_eq "S4: npm install failure exits non-zero" "1" "$rc"
assert_eq "S4: npm install was attempted exactly once" "1" "$(npm_call_count)"
POST_HASH=$(cat "$APP4/node_modules/.skillsmith-deps-hash")
assert_eq "S4: sentinel NOT rewritten after install failure" "0000000000000000000000000000000000000000000000000000000000000000" "$POST_HASH"
assert_eq "S4: lock released after install failure (not wedged)" "no" "$([ -d "$APP4/node_modules/.skillsmith-deps-lock" ] && echo yes || echo no)"

# =========================================================================
# Scenario 5: lock held by a live PID — waiter fails safely, no npm install
# =========================================================================
MAIN5="$TMP_ROOT/main5"
APP5="$TMP_ROOT/app5"
setup_main_repo "$MAIN5"
setup_fake_app_dir "$APP5" stale
mkdir -p "$APP5/node_modules/.skillsmith-deps-lock"
# A live process to be the "owner" — this test script's own PID is alive
# for the duration of this scenario.
printf '%s:%s\n' "$$" "$(date +%s)" > "$APP5/node_modules/.skillsmith-deps-lock/owner"
FAKE_APP_DIR="$APP5"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
SKILLSMITH_LOCK_MAX_TRIES=2
SKILLSMITH_LOCK_SLEEP_SECS=0
rc=$(run_guard "$MAIN5")
SKILLSMITH_LOCK_MAX_TRIES=45
SKILLSMITH_LOCK_SLEEP_SECS=2
assert_eq "S5: lock held by live PID -> guard fails (not silently proceeding)" "1" "$rc"
assert_eq "S5: npm install NOT called while waiting on a live lock" "0" "$(npm_call_count)"
rm -rf "$APP5/node_modules/.skillsmith-deps-lock"

# =========================================================================
# Scenario 6: lock held by a dead PID — reclaimed, self-heal proceeds
# =========================================================================
MAIN6="$TMP_ROOT/main6"
APP6="$TMP_ROOT/app6"
setup_main_repo "$MAIN6"
setup_fake_app_dir "$APP6" stale
mkdir -p "$APP6/node_modules/.skillsmith-deps-lock"
# A definitely-dead PID (a backgrounded subshell, waited on so it's reaped).
( : ) &
DEAD_PID=$!
wait "$DEAD_PID" 2>/dev/null || true
printf '%s:%s\n' "$DEAD_PID" "$(date +%s)" > "$APP6/node_modules/.skillsmith-deps-lock/owner"
FAKE_APP_DIR="$APP6"
FAKE_DOCKER_LOG=$(mktemp)
: > "$NPM_CALL_LOG"
rc=$(run_guard "$MAIN6")
assert_eq "S6: lock held by dead PID is reclaimed, self-heal proceeds" "0" "$rc"
assert_eq "S6: npm install called exactly once after reclaim" "1" "$(npm_call_count)"
NEW_HASH6=$(cat "$APP6/node_modules/.skillsmith-deps-hash")
EXPECTED_HASH6=$(sha256sum "$APP6/package-lock.json" | cut -d' ' -f1)
assert_eq "S6: sentinel rewritten after reclaim" "$EXPECTED_HASH6" "$NEW_HASH6"

# =========================================================================
# Scenario 7: two truly concurrent invocations against a stale (no existing
# lock) tree, synchronized with a BARRIER rather than a hopeful sleep — B is
# only started once A's own fake npm has recorded that it actually began
# installing, so this deterministically proves the lock (not scheduling
# luck) is what keeps B from also installing. Per review: a sleep-based
# "widen the window" approach could pass even for an unlocked implementation
# if B merely happened to start after A finished.
# =========================================================================
MAIN7A="$TMP_ROOT/main7a"
MAIN7B="$TMP_ROOT/main7b"
APP7="$TMP_ROOT/app7"
setup_main_repo "$MAIN7A"
setup_main_repo "$MAIN7B"
setup_fake_app_dir "$APP7" stale
FAKE_APP_DIR="$APP7"
FAKE_DOCKER_LOG_A=$(mktemp)
FAKE_DOCKER_LOG_B=$(mktemp)
: > "$NPM_CALL_LOG"
FAKE_NPM_DELAY=2   # A stays "inside" the install long enough for B to attempt entry

LOG_A="$TMP_ROOT/s7-a.rc"
LOG_B="$TMP_ROOT/s7-b.rc"
( cd "$MAIN7A" && FAKE_APP_DIR="$APP7" FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG_A" FAKE_NPM_DELAY="$FAKE_NPM_DELAY" "$GUARD" </dev/null; echo $? > "$LOG_A" ) &
PID_A=$!

# Barrier: block here until A's fake npm has actually recorded a call —
# proves B starts DURING A's install, not merely "probably around the same
# time". 10s cap so a genuine regression fails the test instead of hanging.
barrier_tries=0
while [ ! -s "$NPM_CALL_LOG" ] && [ "$barrier_tries" -lt 100 ]; do
  sleep 0.1
  barrier_tries=$((barrier_tries + 1))
done
assert_eq "S7: barrier — A's install actually started before B launches" "yes" "$([ -s "$NPM_CALL_LOG" ] && echo yes || echo no)"

( cd "$MAIN7B" && FAKE_APP_DIR="$APP7" FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG_B" FAKE_NPM_DELAY="$FAKE_NPM_DELAY" "$GUARD" </dev/null; echo $? > "$LOG_B" ) &
PID_B=$!
wait "$PID_A" "$PID_B"
FAKE_NPM_DELAY=0
RC_A=$(cat "$LOG_A"); RC_B=$(cat "$LOG_B")
assert_eq "S7: invocation A exits 0" "0" "$RC_A"
assert_eq "S7: invocation B exits 0" "0" "$RC_B"
assert_eq "S7: npm install called exactly once despite B starting mid-install" "1" "$(npm_call_count)"

# =========================================================================
# Scenario 8: two waiters observe the SAME dead-owner lock and race to
# reclaim it, while a fresh acquirer may slip in between — this is the
# multi-reclaimer TOCTOU this design's RECLAIM_DIR mutex exists to close.
# Deterministic guarantee is weaker than Scenario 7 (no barrier point exists
# mid-mkdir to synchronize on), but two processes launched back-to-back
# against the same pre-seeded dead lock reliably contend for the SAME
# reclaim window in practice — the assertion that matters is that exactly
# ONE self-heal (one npm install) ever results, never zero, never more than
# one, and never a corrupted lock state that hangs both.
# =========================================================================
MAIN8A="$TMP_ROOT/main8a"
MAIN8B="$TMP_ROOT/main8b"
APP8="$TMP_ROOT/app8"
setup_main_repo "$MAIN8A"
setup_main_repo "$MAIN8B"
setup_fake_app_dir "$APP8" stale
mkdir -p "$APP8/node_modules/.skillsmith-deps-lock"
( : ) &
DEAD_PID8=$!
wait "$DEAD_PID8" 2>/dev/null || true
printf '%s:0\n' "$DEAD_PID8" > "$APP8/node_modules/.skillsmith-deps-lock/owner"
FAKE_APP_DIR="$APP8"
: > "$NPM_CALL_LOG"

LOG_8A="$TMP_ROOT/s8-a.rc"
LOG_8B="$TMP_ROOT/s8-b.rc"
( cd "$MAIN8A" && FAKE_APP_DIR="$APP8" FAKE_DOCKER_LOG="$(mktemp)" "$GUARD" </dev/null; echo $? > "$LOG_8A" ) &
PID_8A=$!
( cd "$MAIN8B" && FAKE_APP_DIR="$APP8" FAKE_DOCKER_LOG="$(mktemp)" "$GUARD" </dev/null; echo $? > "$LOG_8B" ) &
PID_8B=$!
wait "$PID_8A" "$PID_8B"
RC_8A=$(cat "$LOG_8A"); RC_8B=$(cat "$LOG_8B")
assert_eq "S8: invocation A exits 0" "0" "$RC_8A"
assert_eq "S8: invocation B exits 0" "0" "$RC_8B"
assert_eq "S8: exactly one self-heal resulted from the dead-lock reclaim race" "1" "$(npm_call_count)"
assert_eq "S8: no lock left behind after both finish" "no" "$([ -d "$APP8/node_modules/.skillsmith-deps-lock" ] && echo yes || echo no)"

# =========================================================================
# Scenario 9: ownership-token unit test — sources check-container-deps-fresh-inner.sh
# directly (SKILLSMITH_LOCK_TEST_SOURCE=1 skips its main flow, leaving
# acquire()/release()/try_reclaim() defined) and calls release() with a
# STALE token against a lock a DIFFERENT token has since legitimately
# re-acquired. No docker/npm/subshells involved — this is a pure unit test
# of the exact property the PID+nonce token exists to guarantee: release()
# must only ever remove a lock whose owner file still names ITS OWN token.
# =========================================================================
APP9="$TMP_ROOT/app9"
rm -rf "$APP9"
mkdir -p "$APP9/node_modules"
(
  cd "$APP9" || exit 1
  # shellcheck disable=SC2034  # read by the sourced INNER file, which shellcheck can't statically follow (dynamic path)
  SKILLSMITH_LOCK_TEST_SOURCE=1
  # shellcheck source=/dev/null
  . "$INNER"

  mkdir -p node_modules/.skillsmith-deps-lock
  # A DIFFERENT holder's token — simulates "someone else has since
  # legitimately reclaimed and re-acquired this lock" (MY_TOKEN, from this
  # sourced instance, was never the one that wrote it).
  echo "999999:someone-elses-nonce" > node_modules/.skillsmith-deps-lock/owner

  release   # must be a no-op: MY_TOKEN != the file's content

  if [ -f node_modules/.skillsmith-deps-lock/owner ] && \
     [ "$(cat node_modules/.skillsmith-deps-lock/owner)" = "999999:someone-elses-nonce" ]; then
    echo PASS
  else
    echo FAIL
  fi
) > "$TMP_ROOT/s9-result.txt" 2>&1
S9_RESULT=$(tail -1 "$TMP_ROOT/s9-result.txt")
assert_eq "S9: release() never removes a lock it does not own (ownership-token check)" "PASS" "$S9_RESULT"

# Sanity check the SAME unit-test seam correctly removes a lock it DOES own —
# proves S9 above is testing the real guard, not a seam that always no-ops.
APP9B="$TMP_ROOT/app9b"
rm -rf "$APP9B"
mkdir -p "$APP9B/node_modules"
(
  cd "$APP9B" || exit 1
  # shellcheck disable=SC2034  # read by the sourced INNER file, which shellcheck can't statically follow (dynamic path)
  SKILLSMITH_LOCK_TEST_SOURCE=1
  # shellcheck source=/dev/null
  . "$INNER"

  mkdir -p node_modules/.skillsmith-deps-lock
  printf "%s\n" "$MY_TOKEN" > node_modules/.skillsmith-deps-lock/owner

  release

  if [ ! -e node_modules/.skillsmith-deps-lock ]; then
    echo PASS
  else
    echo FAIL
  fi
) > "$TMP_ROOT/s9b-result.txt" 2>&1
S9B_RESULT=$(tail -1 "$TMP_ROOT/s9b-result.txt")
assert_eq "S9b: release() DOES remove a lock it owns (seam sanity check)" "PASS" "$S9B_RESULT"

echo ""
echo "======================================"
echo "Results: $pass passed, $fail failed"
echo "======================================"
[ "$fail" -eq 0 ]
