#!/usr/bin/env bash
# scripts/tests/mcp-ruflo-launcher.test.sh — smoke tests for
# scripts/mcp-ruflo-launcher.sh (SMI-6744 A1.4, ADR-170), fake-binary shape
# of scripts/tests/needle-dispatch.test.sh: a `docker` stub that records
# every invocation's argv and returns scripted output per subcommand, plus
# a silent `npx` canary (the launcher never invokes npx — "no npx fallback
# by design" — so it must stay untouched across every arm, not only the
# disabled one).
#
# Arms: container down, service-command mismatch, pin mismatch, each
# authority-quad leg (a/b/d; c is covered by the pin/version-style
# text-gated branch the same way), the per-spawn guard refusing, healthy,
# and disabled. Three red (mutation) arms restore the real launcher file
# afterward and verify the restore by md5.
#
# Usage: ./scripts/tests/mcp-ruflo-launcher.test.sh

# shellcheck disable=SC2016  # the red-arm sed patterns below are single-quoted on purpose: they match literal $VAR text in the launcher
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
LAUNCHER="$REPO_ROOT/scripts/mcp-ruflo-launcher.sh"
# The launcher resolves MAIN_CHECKOUT via git-common-dir (ADR-170 § 7), which
# from a WORKTREE checkout (this test tree may well be one) resolves to the
# separate main checkout, not $REPO_ROOT — recompute the same way rather
# than assume they're equal (a real, once-observed failure here: the
# healthy-arm success line named the main checkout, not this worktree).
EXPECTED_MAIN_CHECKOUT="$REPO_ROOT"
_gcd_probe="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || echo '')"
if [ -n "$_gcd_probe" ]; then
  case "$_gcd_probe" in
    /*) _abs_gcd_probe="$_gcd_probe" ;;
    *) _abs_gcd_probe="$REPO_ROOT/$_gcd_probe" ;;
  esac
  _resolved_probe="$(cd "$_abs_gcd_probe/.." 2>/dev/null && pwd || echo '')"
  [ -n "$_resolved_probe" ] && EXPECTED_MAIN_CHECKOUT="$_resolved_probe"
fi

FAIL_COUNT=0
CONTAINER_NAME="skillsmith-ruflo-1"
CLI_PATH="/opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js"
DEFAULT_ARGS_JSON="[\"node\",\"$CLI_PATH\",\"mcp\",\"start\"]"

md5_of() { md5 -q "$1" 2>/dev/null || md5sum "$1" | awk '{print $1}'; }

# ---- stub bin dir: docker (scripted) + npx (silent canary) ----------------
STUB_DIR="$(mktemp -d)"
DOCKER_LOG="$STUB_DIR/.docker-argv.log"
NPX_LOG="$STUB_DIR/.npx-argv.log"
: >"$DOCKER_LOG"
: >"$NPX_LOG"

cat >"$STUB_DIR/npx" <<'NPXSTUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$NPX_LOG"
exit 0
NPXSTUB
chmod +x "$STUB_DIR/npx"

cat >"$STUB_DIR/docker" <<'DOCKERSTUB'
#!/usr/bin/env bash
{
  echo "--- CALL ---"
  printf '%s\n' "$@"
} >>"$DOCKER_LOG"

cmd="${1:-}"
case "$cmd" in
  ps)
    printf '%s' "${FAKE_DOCKER_PS_OUTPUT-cid123}"
    exit 0
    ;;
  volume)
    if [ "${2:-}" = "inspect" ]; then
      printf '%s' "${FAKE_VOLUME_LABEL-nonce-abc}"
      exit "${FAKE_VOLUME_INSPECT_STATUS:-0}"
    fi
    exit 9
    ;;
  inspect)
    joined="$*"
    case "$joined" in
      *"json .Config.Entrypoint"*)
        printf '%s' "${FAKE_INSPECT_PATH-[\"/bin/sh\",\"/opt/ruflo-service-entrypoint.sh\"]}"
        exit "${FAKE_INSPECT_STATUS:-0}"
        ;;
      *"json .Config.Cmd"*)
        printf '%s' "${FAKE_INSPECT_ARGS-$DEFAULT_ARGS_JSON}"
        exit "${FAKE_INSPECT_STATUS:-0}"
        ;;
      *"range .Mounts"*)
        printf '%s' "${FAKE_MOUNT_INFO-volume skillsmith-ruflo-data}"
        exit "${FAKE_MOUNT_STATUS:-0}"
        ;;
      *)
        echo "UNKNOWN docker inspect: $joined" >&2
        exit 9
        ;;
    esac
    ;;
  exec)
    joined="$*"
    case "$joined" in
      # NOTE: the store_generation script (better-sqlite3 fallback branch)
      # ALSO contains the substring "require(" — its more specific pattern
      # ("better-sqlite3") must be checked FIRST, or it falls through to the
      # plain version-check branch below.
      *"RUFLO_DB_PRESENT"*)
        printf '%s' "${FAKE_DB_PROBE-RUFLO_DB_PRESENT}"
        exit "${FAKE_DB_PROBE_STATUS:-0}"
        ;;
      *"better-sqlite3"*)
        printf '%s' "${FAKE_STORE_GENERATION-gen-123}"
        exit "${FAKE_GENERATION_STATUS:-0}"
        ;;
      *"require("*)
        printf '%s' "${FAKE_SERVED_VERSION-3.42.4}"
        exit "${FAKE_VERSION_STATUS:-0}"
        ;;
      *"RUFLO_GUARD_CLI_PATH"*)
        printf '%s' "${FAKE_GUARD_OUTPUT-}" >&2
        exit "${FAKE_GUARD_EXIT:-0}"
        ;;
      *"CLAUDE_FLOW_MEMORY_BACKEND"*)
        echo "DOCKER_STUB: real-exec-reached"
        exit 0
        ;;
      *)
        echo "UNKNOWN docker exec: $joined" >&2
        exit 9
        ;;
    esac
    ;;
  *)
    echo "UNKNOWN docker command: $joined" >&2
    exit 9
    ;;
esac
DOCKERSTUB
chmod +x "$STUB_DIR/docker"
# DEFAULT_ARGS_JSON is resolved by the docker stub itself, at run time, from
# its own inherited environment (exported by run(), below) — no sed
# literal-substitution into the heredoc-written script.

TEST_HOME="$(mktemp -d)"
mkdir -p "$TEST_HOME/.skillsmith"
cat >"$TEST_HOME/.skillsmith/ruflo-store.json" <<JSON
{"instanceNonce":"nonce-abc","generationUuid":"gen-123","createdAt":"2026-09-23T00:00:00Z"}
JSON

TEST_PATH="$STUB_DIR:$PATH"

# run <name...> — invokes the real launcher with the current FAKE_* env and
# the stub PATH/HOME; writes stdout+stderr to /tmp/mcp-ruflo-launcher-test-<name>.out
# and echoes the exit code.
run() {
  local name="$1"
  local out="/tmp/mcp-ruflo-launcher-test-${name}.out"
  : >"$DOCKER_LOG"
  : >"$NPX_LOG"
  set +e
  DOCKER_LOG="$DOCKER_LOG" NPX_LOG="$NPX_LOG" DEFAULT_ARGS_JSON="$DEFAULT_ARGS_JSON" \
    PATH="$TEST_PATH" HOME="$TEST_HOME" "$LAUNCHER" >"$out" 2>&1
  local rc=$?
  set -e
  echo "$rc"
}

pass() { echo "PASS ($1): $2"; }
fail() {
  echo "FAIL ($1): $2" >&2
  cat "/tmp/mcp-ruflo-launcher-test-$1.out" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

# ---- arm: container down ---------------------------------------------------
export FAKE_DOCKER_PS_OUTPUT=""
rc="$(run container-down)"
out="/tmp/mcp-ruflo-launcher-test-container-down.out"
call_count="$(grep -c "^--- CALL ---$" "$DOCKER_LOG" || true)"
exec_count="$(grep -c "^exec$" "$DOCKER_LOG" || true)"
if [ "$rc" -eq 1 ] \
  && grep -q "cannot start: $CONTAINER_NAME container is not running" "$out" \
  && grep -q "ruflo-service-up.sh" "$out" \
  && [ "$call_count" -eq 1 ] \
  && [ "$exec_count" -eq 0 ]; then
  pass container-down "exits 1, names the container, exactly one docker call (ps), no exec"
else
  fail container-down "expected exit 1, remediation naming ruflo-service-up.sh, no exec (got rc=$rc)"
fi
unset FAKE_DOCKER_PS_OUTPUT

# ---- arm: service-command (Path/Args) mismatch -----------------------------
export FAKE_INSPECT_ARGS='["node","-e","evil"]'
rc="$(run path-args-mismatch)"
out="/tmp/mcp-ruflo-launcher-test-path-args-mismatch.out"
if [ "$rc" -eq 1 ] \
  && grep -q "does not match the ADR-170" "$out" \
  && grep -qF "cmd $DEFAULT_ARGS_JSON" "$out" \
  && grep -qF 'cmd ["node","-e","evil"]' "$out"; then
  pass path-args-mismatch "refuses, prints both expected and actual"
else
  fail path-args-mismatch "expected exit 1 naming both expected and actual command (got rc=$rc)"
fi
unset FAKE_INSPECT_ARGS

# ---- arm: RUFLO_CLI_PIN vs served version mismatch -------------------------
export FAKE_SERVED_VERSION="9.9.9"
rc="$(run version-mismatch)"
out="/tmp/mcp-ruflo-launcher-test-version-mismatch.out"
if [ "$rc" -eq 1 ] && grep -q "pinned:  3.42.4" "$out" && grep -q "served:  9.9.9" "$out"; then
  pass version-mismatch "refuses, prints both version strings, no exec"
else
  fail version-mismatch "expected exit 1 naming both pinned and served versions (got rc=$rc)"
fi
unset FAKE_SERVED_VERSION

# ---- arm: authority quad (a) — wrong mount type/name -----------------------
export FAKE_MOUNT_INFO="bind /somewhere/else"
rc="$(run quad-a)"
out="/tmp/mcp-ruflo-launcher-test-quad-a.out"
if [ "$rc" -eq 1 ] && grep -q "authority quad a" "$out"; then
  pass quad-a "refuses naming authority quad a"
else
  fail quad-a "expected exit 1 naming authority quad a (got rc=$rc)"
fi
unset FAKE_MOUNT_INFO

# ---- arm: authority quad (b) — wrong volume-instance label -----------------
export FAKE_VOLUME_LABEL="some-other-nonce"
rc="$(run quad-b)"
out="/tmp/mcp-ruflo-launcher-test-quad-b.out"
if [ "$rc" -eq 1 ] && grep -q "authority quad b" "$out"; then
  pass quad-b "refuses naming authority quad b"
else
  fail quad-b "expected exit 1 naming authority quad b (got rc=$rc)"
fi
unset FAKE_VOLUME_LABEL

# ---- arm: authority quad (c) — store_generation mismatch -------------------
export FAKE_STORE_GENERATION="some-other-generation"
rc="$(run quad-c)"
out="/tmp/mcp-ruflo-launcher-test-quad-c.out"
if [ "$rc" -eq 1 ] && grep -q "authority quad c" "$out"; then
  pass quad-c "refuses naming authority quad c"
else
  fail quad-c "expected exit 1 naming authority quad c (got rc=$rc)"
fi
unset FAKE_STORE_GENERATION

# ---- arm: authority quad (d) — empty volume, no database -------------------
export FAKE_DB_PROBE="RUFLO_DB_ABSENT"
rc="$(run quad-d)"
out="/tmp/mcp-ruflo-launcher-test-quad-d.out"
if [ "$rc" -eq 1 ] && grep -q "authority quad d" "$out" && grep -q "ruflo-service-up.sh" "$out"; then
  pass quad-d "refuses naming authority quad d and ruflo-service-up.sh"
else
  fail quad-d "expected exit 1 naming authority quad d (got rc=$rc)"
fi
unset FAKE_DB_PROBE

# ---- arm: per-spawn guard refuses ------------------------------------------
export FAKE_GUARD_EXIT="5"
export FAKE_GUARD_OUTPUT="[ruflo] guard: state.lock held by a live server"
rc="$(run guard-refuses)"
out="/tmp/mcp-ruflo-launcher-test-guard-refuses.out"
if [ "$rc" -eq 1 ] \
  && grep -q "the per-spawn guard refused" "$out" \
  && grep -q "state.lock held by a live server" "$out" \
  && ! grep -q "real-exec-reached" "$out"; then
  pass guard-refuses "no exec, the guard's message is forwarded"
else
  fail guard-refuses "expected exit 1, guard message forwarded, no exec (got rc=$rc)"
fi
unset FAKE_GUARD_EXIT FAKE_GUARD_OUTPUT

# ---- arm: healthy ------------------------------------------------------------
rc="$(run healthy)"
out="/tmp/mcp-ruflo-launcher-test-healthy.out"
# Scope the assertion to the LAST recorded call (the final real exec), not
# just "somewhere in the whole log" — several earlier calls also contain
# "exec"/"node"/the container name individually.
last_call_start="$(grep -n "^--- CALL ---$" "$DOCKER_LOG" | tail -1 | cut -d: -f1)"
last_call="$(tail -n +"$((last_call_start + 1))" "$DOCKER_LOG")"
if [ "$rc" -eq 0 ] \
  && grep -qF "serving @claude-flow/cli@3.42.4 from $EXPECTED_MAIN_CHECKOUT via $CONTAINER_NAME" "$out" \
  && printf '%s\n' "$last_call" | grep -q "^exec$" \
  && printf '%s\n' "$last_call" | grep -q "^-i$" \
  && printf '%s\n' "$last_call" | grep -q "^$CONTAINER_NAME$" \
  && printf '%s\n' "$last_call" | grep -q "^node$" \
  && printf '%s\n' "$last_call" | grep -q "^$CLI_PATH$" \
  && printf '%s\n' "$last_call" | grep -q "CLAUDE_FLOW_MEMORY_BACKEND=sqlite" \
  && printf '%s\n' "$last_call" | grep -q "CLAUDE_FLOW_LOG_LEVEL=info" \
  && grep -q "real-exec-reached" "$out"; then
  pass healthy "the final docker call's argv contains exec/-i/service/node/cli path/env, success line printed first, exec reached"
else
  fail healthy "expected a healthy run with the success line and the final exec argv/env (got rc=$rc)"
fi

# ---- arm: disabled -----------------------------------------------------------
export SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1
rc="$(run disabled)"
out="/tmp/mcp-ruflo-launcher-test-disabled.out"
if [ "$rc" -eq 1 ] \
  && grep -qF "[ruflo] MCP server cannot start: disabled by SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1 (no npx fallback by design, SMI-6744 Wave 4)." "$out" \
  && grep -qF "[ruflo] Run these commands, then reconnect via /mcp:" "$out" \
  && grep -qF "unset SKILLSMITH_RUFLO_LAUNCHER_DISABLE" "$out" \
  && grep -qF "[ruflo] (See .claude/development/claude-flow-guide.md > Launcher)" "$out" \
  && [ ! -s "$DOCKER_LOG" ] \
  && [ ! -s "$NPX_LOG" ]; then
  pass disabled "exits 1 with all three lines, both stubs silent"
else
  fail disabled "expected exit 1 with the three-part disabled message and zero docker/npx calls (got rc=$rc)"
fi
unset SKILLSMITH_RUFLO_LAUNCHER_DISABLE

# ---- red arms: mutate the real launcher file, run, restore, verify by md5 --
# `applied=` and the restore verdict go to stderr so stdout carries ONLY the
# arm's exit code for the caller's `tail -1`; a restore failure is an
# infrastructure problem with this test (reported and counted) and does not
# suppress reporting the arm's own observed exit code.
mutate_run_restore() {
  local label="$1" sed_expr="$2" applied="$3"
  echo "applied=$applied" >&2
  local before after
  before="$(md5_of "$LAUNCHER")"
  cp "$LAUNCHER" "$LAUNCHER.bak.$$"
  trap 'mv -f "$LAUNCHER.bak.$$" "$LAUNCHER" 2>/dev/null || true' EXIT
  sed -i.tmp "$sed_expr" "$LAUNCHER"
  rm -f "$LAUNCHER.tmp"
  local rc
  rc="$(run "$label")"
  mv -f "$LAUNCHER.bak.$$" "$LAUNCHER"
  trap - EXIT
  after="$(md5_of "$LAUNCHER")"
  if [ "$after" != "$before" ]; then
    echo "FAIL ($label): launcher was not correctly restored after mutation" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
  else
    echo "PASS ($label): launcher file restored to its original content (md5 $after)" >&2
  fi
  echo "$rc"
}

# red arm 1: delete the disable branch (SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1
# must be set for this mutation to have anything to disable).
export SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1
red_rc="$(mutate_run_restore red-disable-branch \
  's/if \[ "\${SKILLSMITH_RUFLO_LAUNCHER_DISABLE:-}" = "1" \]; then/if false; then/' \
  "delete the disable branch (flip its condition to false)" | tail -1)"
unset SKILLSMITH_RUFLO_LAUNCHER_DISABLE
if [ "$red_rc" != "1" ]; then
  pass red-disable-branch "mutated launcher no longer refuses when disabled (rc=$red_rc, expected != 1)"
else
  fail red-disable-branch "mutation had no effect: still exited 1 with the disable branch neutered"
fi

# red arm 2: delete the version comparison
export FAKE_SERVED_VERSION="9.9.9"
red_rc="$(mutate_run_restore red-version-check \
  's/if \[ "\$served_version" != "\$RUFLO_CLI_PIN" \]; then/if false; then/' \
  "delete the RUFLO_CLI_PIN vs served-version comparison (flip its condition to false)" | tail -1)"
unset FAKE_SERVED_VERSION
if [ "$red_rc" != "1" ]; then
  pass red-version-check "mutated launcher no longer refuses on a version mismatch (rc=$red_rc, expected != 1)"
else
  fail red-version-check "mutation had no effect: still exited 1 on a pin/version mismatch"
fi

# red arm 3: delete authority quad check (b)
export FAKE_VOLUME_LABEL="some-other-nonce"
red_rc="$(mutate_run_restore red-quad-b \
  's/if \[ "\$volume_label" != "\$expected_nonce" \]; then/if false; then/' \
  "delete authority quad check (b) (flip its condition to false)" | tail -1)"
unset FAKE_VOLUME_LABEL
if [ "$red_rc" != "1" ]; then
  pass red-quad-b "mutated launcher no longer refuses on a volume-label mismatch (rc=$red_rc, expected != 1)"
else
  fail red-quad-b "mutation had no effect: still exited 1 on a quad-b mismatch"
fi

rm -rf "$STUB_DIR" "$TEST_HOME"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAILED: $FAIL_COUNT case(s) failed" >&2
  exit 1
fi

echo "PASS: all mcp-ruflo-launcher.test.sh cases passed"
