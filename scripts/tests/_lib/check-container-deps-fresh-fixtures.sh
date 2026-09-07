#!/usr/bin/env bash
# scripts/tests/_lib/check-container-deps-fresh-fixtures.sh
#
# Shared fixture setup for the check-container-deps-fresh.sh (SMI-6006) test
# files. Split out of the original check-container-deps-fresh.test.sh
# (SMI-6437) to keep both consumer files under this repo's 500-line-per-file
# limit — mirrors the scripts/tests/_lib/needle-dispatch-fixtures.sh
# precedent exactly (same source pattern, same split rationale).
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
#   - `npm`: `install` logs a line to NPM_CALL_LOG (so every scenario can
#     assert exactly how many times it was really called), sleeps
#     $FAKE_NPM_DELAY, then exits 0, or exits 1 if $FAKE_NPM_FAIL=1.
#
# hook-docker-detect.sh's own IS_WORKTREE/USE_DOCKER detection is NOT faked
# — it runs for real against small real git repos/worktrees this file
# creates, mirroring create-worktree-hooks.test.sh's Scenario 11 approach.
#
# SMI-6437: `run_guard()`'s env-forwarding list also carries
# SKILLSMITH_NATIVE_CHECK_TEST through to the real guard script, so a
# consumer test can deterministically force check-native-modules.sh's own
# real (not faked) test seam — no separate native-module fake is needed.
#
# Consumers: scripts/tests/check-container-deps-fresh.test.sh (Scenarios
# 1-4 plus the SMI-6437 native-probe scenarios) and
# scripts/tests/check-container-deps-fresh-lock.test.sh (Scenarios 5-9,
# the lock-contention cluster).

SCRIPT_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
GUARD="$REPO_ROOT/scripts/lib/check-container-deps-fresh.sh"
INNER="$REPO_ROOT/scripts/lib/check-container-deps-fresh-inner.sh"
REAL_FRESH_CHECK="$REPO_ROOT/scripts/lib/check-node-modules-fresh.sh"
# SMI-6437: the real, committed sibling script GUARD resolves at its own new
# call sites. A dedicated scenario temporarily renames this exact file (via
# absolute path, restored by an EXIT trap) to test the "probe script itself
# is missing" branch — never referenced via a relative path anywhere that
# scenario touches it, precisely to avoid a cwd-change silently breaking
# the restore (confirmed painfully while writing that scenario).
NATIVE_LIB="$REPO_ROOT/scripts/lib/check-native-modules.sh"

if [ ! -x "$GUARD" ]; then
  echo "FAIL: $GUARD is not executable"
  exit 1
fi
if [ ! -x "$INNER" ]; then
  echo "FAIL: $INNER is not executable"
  exit 1
fi
if [ ! -x "$NATIVE_LIB" ]; then
  echo "FAIL: $NATIVE_LIB is not executable"
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
#
# SMI-6437: SKILLSMITH_NATIVE_CHECK_TEST is forwarded here so a consumer
# scenario can deterministically force check-native-modules.sh's own real
# test seam (ok|fail) without touching Docker at all — that script's seam
# short-circuits before any USE_DOCKER/hook-docker-detect.sh involvement.
# Defaults to "ok" (not unset/empty): a bare `${VAR:+NAME=value}` expansion
# is NOT recognized by bash as a variable-assignment prefix (that
# recognition is parse-time-only, for literal `NAME=value` syntax — the
# *result* of a runtime parameter expansion is just executed as a command,
# which fails with "command not found" the moment the variable is
# non-empty; caught empirically while writing this file's own scenarios).
# Defaulting to "ok" also keeps every pre-existing scenario below (S1-S9,
# none of which care about native-module health) deterministic against the
# two new SMI-6437 probe call sites in check-container-deps-fresh.sh,
# rather than letting them fall through to a REAL (non-test-seam) probe
# attempt that would hit this file's own strict fake-docker exec-shape
# validation and spuriously fail.
GUARD_LAST_OUTPUT="$TMP_ROOT/guard-last-output.txt"
run_guard() {
  local cwd="$1"
  ( cd "$cwd" && FAKE_DOCKER_LOG="$FAKE_DOCKER_LOG" FAKE_APP_DIR="$FAKE_APP_DIR" \
      FAKE_NPM_FAIL="${FAKE_NPM_FAIL:-0}" FAKE_NPM_DELAY="${FAKE_NPM_DELAY:-0}" \
      SKILLSMITH_LOCK_MAX_TRIES="${SKILLSMITH_LOCK_MAX_TRIES:-45}" \
      SKILLSMITH_LOCK_SLEEP_SECS="${SKILLSMITH_LOCK_SLEEP_SECS:-2}" \
      SKILLSMITH_NATIVE_CHECK_TEST="${SKILLSMITH_NATIVE_CHECK_TEST:-ok}" \
      "$GUARD" </dev/null >"$GUARD_LAST_OUTPUT" 2>&1 )
  echo $?
}
