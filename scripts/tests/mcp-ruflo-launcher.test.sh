#!/usr/bin/env bash
# scripts/tests/mcp-ruflo-launcher.test.sh — smoke tests for
# scripts/mcp-ruflo-launcher.sh (SMI-6744 A1.4, ADR-170), fake-binary shape
# of scripts/tests/needle-dispatch.test.sh: a `docker` stub that records
# every invocation's argv and returns scripted output per subcommand, plus
# a silent `npx` canary (the launcher never invokes npx — "no npx fallback
# by design" — so it must stay untouched across every arm, not only the
# disabled one).
#
# Arms: container down, container-id resolution failure (TOCTOU), service-
# command mismatch (Entrypoint half, Cmd half, and an inspect-failure
# branch), a WorkingDir mismatch (governance review finding H-3), pin
# mismatch (plus a stderr-noisy-but-correct pass and a missing-sentinel
# refusal, governance review finding M-9), each authority-quad leg (a/b/d;
# c is covered by the pin/version-style text-gated branch the same way),
# the per-spawn guard refusing, healthy, and disabled.
#
# Red (mutation) arms mutate a SCRATCH COPY of the launcher, never the
# tracked file (governance review finding M-10 — a SIGKILL mid-run must
# never leave a neutered security check in a tracked file): the mutant
# lives at scripts/.mcp-ruflo-launcher.mutant.$$.sh, directly under
# scripts/, because the launcher derives REPO_ROOT and GUARD_SCRIPT from
# BASH_SOURCE (mcp-ruflo-launcher.sh:76,86) and a mutant elsewhere would
# resolve GUARD_SCRIPT to the wrong path. The tracked launcher's md5 is
# captured at suite start and re-checked at suite end — a check the suite
# never touches it, structurally true regardless of whether cleanup runs
# (a SIGKILL prevents the trap-based mutant cleanup too, but the tracked
# file itself was never written).
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
SERVICE_CWD="/srv/ruflo"
# The container ID the docker stub returns for `docker inspect -f '{{.Id}}'`
# by default (governance review finding L-17/TOCTOU) — a fixed 64-hex
# constant distinct from $CONTAINER_NAME, so an assertion that the final
# exec's argv carries this ID (not the name) actually distinguishes the
# TOCTOU fix from a launcher that never adopted it.
FAKE_CONTAINER_ID="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

md5_of() { md5 -q "$1" 2>/dev/null || md5sum "$1" | awk '{print $1}'; }

# Captured before any arm runs — re-checked at suite end (M-10).
LAUNCHER_MD5_BEFORE="$(md5_of "$LAUNCHER")"

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
      *"{{.Id}}"*)
        printf '%s' "${FAKE_CID-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef}"
        exit "${FAKE_CID_STATUS:-0}"
        ;;
      *"json .Config.Entrypoint"*)
        printf '%s' "${FAKE_INSPECT_PATH-[\"/bin/sh\",\"/opt/ruflo-service-entrypoint.sh\"]}"
        exit "${FAKE_INSPECT_STATUS:-0}"
        ;;
      *"json .Config.Cmd"*)
        printf '%s' "${FAKE_INSPECT_ARGS-$DEFAULT_ARGS_JSON}"
        exit "${FAKE_INSPECT_STATUS:-0}"
        ;;
      *".Config.WorkingDir"*)
        printf '%s' "${FAKE_WORKDIR-/srv/ruflo}"
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
      # plain version-check branch below. The version-probe branch ALSO
      # contains "require(" (it wraps the same require() call in a sentinel
      # string concatenation) so it still matches this same pattern.
      *"RUFLO_DB_PRESENT"*)
        printf '%s' "${FAKE_DB_PROBE-RUFLO_DB_PRESENT}"
        exit "${FAKE_DB_PROBE_STATUS:-0}"
        ;;
      *"better-sqlite3"*)
        printf '%s' "${FAKE_STORE_GENERATION-gen-123}"
        exit "${FAKE_GENERATION_STATUS:-0}"
        ;;
      *"require("*)
        if [ -n "${FAKE_VERSION_STDERR-}" ]; then
          printf '%s\n' "$FAKE_VERSION_STDERR" >&2
        fi
        if [ "${FAKE_VERSION_NO_SENTINEL:-0}" = "1" ]; then
          printf '%s' "${FAKE_SERVED_VERSION-3.42.4}"
        else
          printf 'RUFLO_VER=%s' "${FAKE_SERVED_VERSION-3.42.4}"
        fi
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

# run <name> [launcher-path] — invokes the given launcher (default: the
# real, tracked one) with the current FAKE_* env and the stub PATH/HOME;
# writes stdout+stderr to /tmp/mcp-ruflo-launcher-test-<name>.out and
# echoes the exit code.
run() {
  local name="$1"
  local launcher_path="${2:-$LAUNCHER}"
  local out="/tmp/mcp-ruflo-launcher-test-${name}.out"
  : >"$DOCKER_LOG"
  : >"$NPX_LOG"
  set +e
  DOCKER_LOG="$DOCKER_LOG" NPX_LOG="$NPX_LOG" DEFAULT_ARGS_JSON="$DEFAULT_ARGS_JSON" \
    PATH="$TEST_PATH" HOME="$TEST_HOME" "$launcher_path" >"$out" 2>&1
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

# ---- arm: container-id resolution failure (TOCTOU) -------------------------
export FAKE_CID_STATUS="1"
rc="$(run cid-resolve-failure)"
out="/tmp/mcp-ruflo-launcher-test-cid-resolve-failure.out"
if [ "$rc" -eq 1 ] && grep -q "could not resolve the container id" "$out"; then
  pass cid-resolve-failure "refuses when the container-id resolution inspect fails"
else
  fail cid-resolve-failure "expected exit 1 naming a container-id resolution failure (got rc=$rc)"
fi
unset FAKE_CID_STATUS

# ---- arm: service-command mismatch — Cmd half ------------------------------
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

# ---- arm: service-command mismatch — Entrypoint half (L-18) ----------------
export FAKE_INSPECT_PATH='["/bin/sh","-c","evil"]'
rc="$(run entrypoint-mismatch)"
out="/tmp/mcp-ruflo-launcher-test-entrypoint-mismatch.out"
if [ "$rc" -eq 1 ] \
  && grep -q "does not match the ADR-170" "$out" \
  && grep -qF 'entrypoint ["/bin/sh","-c","evil"]' "$out"; then
  pass entrypoint-mismatch "refuses when the running container's Entrypoint differs from the ADR-170 § 1 literal"
else
  fail entrypoint-mismatch "expected exit 1 naming an Entrypoint mismatch (got rc=$rc)"
fi
unset FAKE_INSPECT_PATH

# ---- arm: service-command inspect failure (L-18) ---------------------------
export FAKE_INSPECT_STATUS="1"
rc="$(run inspect-status-failure)"
out="/tmp/mcp-ruflo-launcher-test-inspect-status-failure.out"
if [ "$rc" -eq 1 ] && grep -q "docker inspect failed" "$out"; then
  pass inspect-status-failure "refuses when the command-authentication inspect calls fail"
else
  fail inspect-status-failure "expected exit 1 naming a docker inspect failure (got rc=$rc)"
fi
unset FAKE_INSPECT_STATUS

# ---- arm: WorkingDir mismatch (governance review finding H-3) -------------
export FAKE_WORKDIR="/wrong/dir"
rc="$(run workdir-mismatch)"
out="/tmp/mcp-ruflo-launcher-test-workdir-mismatch.out"
if [ "$rc" -eq 1 ] \
  && grep -q "configured working directory does not match ADR-170 § 4" "$out" \
  && grep -qF "expected: workdir $SERVICE_CWD" "$out" \
  && grep -qF "actual:   workdir /wrong/dir" "$out"; then
  pass workdir-mismatch "refuses naming ADR-170 § 4 with expected/actual workdir"
else
  fail workdir-mismatch "expected exit 1 naming a WorkingDir mismatch (got rc=$rc)"
fi
unset FAKE_WORKDIR

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

# ---- arm: version probe with noisy-but-harmless stderr still passes (M-9) --
export FAKE_VERSION_STDERR="(node:1) ExperimentalWarning: something noisy on stderr"
rc="$(run version-stderr-noise-passes)"
out="/tmp/mcp-ruflo-launcher-test-version-stderr-noise-passes.out"
if [ "$rc" -eq 0 ] && grep -q "serving @claude-flow/cli@3.42.4" "$out"; then
  pass version-stderr-noise-passes "a correct container with noisy Node stderr on the version probe still passes"
else
  fail version-stderr-noise-passes "expected exit 0 despite stderr noise on the version probe (got rc=$rc)"
fi
unset FAKE_VERSION_STDERR

# ---- arm: version probe sentinel absent → refusal (M-9) --------------------
export FAKE_VERSION_NO_SENTINEL="1"
rc="$(run version-sentinel-absent)"
out="/tmp/mcp-ruflo-launcher-test-version-sentinel-absent.out"
if [ "$rc" -eq 1 ] && grep -q "no RUFLO_VER= sentinel" "$out"; then
  pass version-sentinel-absent "refuses when the version probe carries no RUFLO_VER= sentinel"
else
  fail version-sentinel-absent "expected exit 1 naming a missing sentinel (got rc=$rc)"
fi
unset FAKE_VERSION_NO_SENTINEL

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
# L-20: the nonce is shown truncated (first 12 chars + "..."), not in full,
# and H-5 part 3: quad (b)'s remediation is the SAME manual-resolution text
# as quad (c) ("not auto-repaired"), not $REMEDIATION_START_SERVICE's
# ruflo-service-up.sh (which cannot repair a label mismatch).
if [ "$rc" -eq 1 ] \
  && grep -q "authority quad b" "$out" \
  && grep -qF "some-other-n..." "$out" \
  && ! grep -qF "some-other-nonce" "$out" \
  && grep -q "not auto-repaired; see ADR-170 § 5" "$out" \
  && ! grep -q "ruflo-service-up.sh" "$out"; then
  pass quad-b "refuses naming authority quad b, truncated nonce, manual-resolution remediation"
else
  fail quad-b "expected exit 1 naming authority quad b with a truncated nonce and manual-resolution text (got rc=$rc)"
fi
unset FAKE_VOLUME_LABEL

# ---- arm: authority quad (c) — store_generation mismatch -------------------
export FAKE_STORE_GENERATION="some-other-generation"
rc="$(run quad-c)"
out="/tmp/mcp-ruflo-launcher-test-quad-c.out"
# L-20: the generation is shown truncated (first 12 chars + "..."), not in full.
if [ "$rc" -eq 1 ] \
  && grep -q "authority quad c" "$out" \
  && grep -qF "some-other-g..." "$out" \
  && ! grep -qF "some-other-generation" "$out"; then
  pass quad-c "refuses naming authority quad c with a truncated generation"
else
  fail quad-c "expected exit 1 naming authority quad c with a truncated generation (got rc=$rc)"
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
# "exec"/"node"/the container id individually.
last_call_start="$(grep -n "^--- CALL ---$" "$DOCKER_LOG" | tail -1 | cut -d: -f1)"
last_call="$(tail -n +"$((last_call_start + 1))" "$DOCKER_LOG")"
if [ "$rc" -eq 0 ] \
  && grep -qF "serving @claude-flow/cli@3.42.4 from $EXPECTED_MAIN_CHECKOUT via $CONTAINER_NAME" "$out" \
  && printf '%s\n' "$last_call" | grep -q "^exec$" \
  && printf '%s\n' "$last_call" | grep -q "^-i$" \
  && printf '%s\n' "$last_call" | grep -q "^-w$" \
  && printf '%s\n' "$last_call" | grep -q "^$SERVICE_CWD$" \
  && printf '%s\n' "$last_call" | grep -q "^$FAKE_CONTAINER_ID$" \
  && ! printf '%s\n' "$last_call" | grep -q "^$CONTAINER_NAME$" \
  && printf '%s\n' "$last_call" | grep -q "^node$" \
  && printf '%s\n' "$last_call" | grep -q "^$CLI_PATH$" \
  && printf '%s\n' "$last_call" | grep -q "^mcp$" \
  && printf '%s\n' "$last_call" | grep -q "^start$" \
  && printf '%s\n' "$last_call" | grep -q "CLAUDE_FLOW_MEMORY_BACKEND=sqlite" \
  && printf '%s\n' "$last_call" | grep -q "CLAUDE_FLOW_LOG_LEVEL=info" \
  && grep -q "real-exec-reached" "$out"; then
  pass healthy "the final docker call's argv contains exec/-i/-w/cwd/container-id (not name)/node/cli path/mcp/start/env, success line printed first, exec reached"
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

# ---- red arms: mutate a SCRATCH COPY, run, never touch the tracked file ----
# (governance review finding M-10). `applied=` goes to stderr so stdout
# carries ONLY the arm's exit code for the caller to capture directly.
MUTANT="$REPO_ROOT/scripts/.mcp-ruflo-launcher.mutant.$$.sh"
cleanup_mutant() { rm -f "$MUTANT" "$MUTANT.tmp"; }
trap cleanup_mutant EXIT

mutate_run() {
  local label="$1" sed_expr="$2" applied="$3"
  echo "applied=$applied" >&2
  cp "$LAUNCHER" "$MUTANT"
  chmod +x "$MUTANT"
  sed -i.tmp "$sed_expr" "$MUTANT"
  rm -f "$MUTANT.tmp"
  run "$label" "$MUTANT"
}

# red arm 1: delete the disable branch (SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1
# must be set for this mutation to have anything to disable).
export SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1
red_rc="$(mutate_run red-disable-branch \
  's/if \[ "\${SKILLSMITH_RUFLO_LAUNCHER_DISABLE:-}" = "1" \]; then/if false; then/' \
  "delete the disable branch (flip its condition to false)")"
unset SKILLSMITH_RUFLO_LAUNCHER_DISABLE
if [ "$red_rc" != "1" ]; then
  pass red-disable-branch "mutated launcher no longer refuses when disabled (rc=$red_rc, expected != 1)"
else
  fail red-disable-branch "mutation had no effect: still exited 1 with the disable branch neutered"
fi

# red arm 2: delete the container-id resolution failure check (TOCTOU).
export FAKE_CID_STATUS="1"
red_rc="$(mutate_run red-cid-check \
  's/if \[ "\$cid_status" -ne 0 \] || \[ -z "\$cid" \]; then/if false; then/' \
  "delete the container-id resolution failure check (flip its condition to false)")"
unset FAKE_CID_STATUS
if [ "$red_rc" != "1" ]; then
  pass red-cid-check "mutated launcher no longer refuses when container-id resolution fails (rc=$red_rc, expected != 1)"
else
  fail red-cid-check "mutation had no effect: still exited 1 with the cid-resolution check neutered"
fi

# red arm 3: delete the WorkingDir authentication (governance review H-3).
export FAKE_WORKDIR="/wrong/dir"
red_rc="$(mutate_run red-workdir-check \
  's/if \[ "\$actual_workdir" != "\$SERVICE_CWD" \]; then/if false; then/' \
  "delete the WorkingDir authentication (flip its condition to false)")"
unset FAKE_WORKDIR
if [ "$red_rc" != "1" ]; then
  pass red-workdir-check "mutated launcher no longer refuses on a WorkingDir mismatch (rc=$red_rc, expected != 1)"
else
  fail red-workdir-check "mutation had no effect: still exited 1 with the WorkingDir check neutered"
fi

# red arm 4: delete the sentinel-absent refusal (governance review M-9).
export FAKE_VERSION_NO_SENTINEL="1"
red_rc="$(mutate_run red-version-sentinel-check \
  's/if \[ "\$sentinel_found" != "1" \]; then/if false; then/' \
  "delete the sentinel-absent refusal (flip its condition to false)")"
unset FAKE_VERSION_NO_SENTINEL
if [ "$red_rc" != "1" ]; then
  pass red-version-sentinel-check "mutated launcher silently accepts a sentinel-less version probe (rc=$red_rc, expected != 1)"
else
  fail red-version-sentinel-check "mutation had no effect: still exited 1 with the sentinel check neutered"
fi

# red arm 5: revert the sentinel-gated comparison to the PRE-FIX whole-
# string compare — proves M-9's fix is necessary by showing a noisy-but-
# correct container is now WRONGLY refused once the fix is reverted.
export FAKE_VERSION_STDERR="(node:1) ExperimentalWarning: something noisy on stderr"
red_rc="$(mutate_run red-version-stderr-mutation \
  's/if \[ "\$served_version" != "\$RUFLO_CLI_PIN" \]; then/if [ "$version_probe_out" != "$RUFLO_CLI_PIN" ]; then/' \
  "revert the sentinel-gated comparison to the pre-fix whole-string compare")"
unset FAKE_VERSION_STDERR
if [ "$red_rc" = "1" ]; then
  pass red-version-stderr-mutation "reverting to a whole-string compare falsely refuses a noisy-but-correct container (rc=$red_rc, expected 1)"
else
  fail red-version-stderr-mutation "expected the reverted comparison to falsely refuse a noisy-but-correct container (rc=$red_rc, expected 1)"
fi

# red arm 6: delete authority quad check (b)
export FAKE_VOLUME_LABEL="some-other-nonce"
red_rc="$(mutate_run red-quad-b \
  's/if \[ "\$volume_label" != "\$expected_nonce" \]; then/if false; then/' \
  "delete authority quad check (b) (flip its condition to false)")"
unset FAKE_VOLUME_LABEL
if [ "$red_rc" != "1" ]; then
  pass red-quad-b "mutated launcher no longer refuses on a volume-label mismatch (rc=$red_rc, expected != 1)"
else
  fail red-quad-b "mutation had no effect: still exited 1 on a quad-b mismatch"
fi

rm -rf "$STUB_DIR" "$TEST_HOME"

# ---- the tracked launcher must be byte-identical to its value at suite ----
# ---- start (governance review finding M-10) --------------------------------
LAUNCHER_MD5_AFTER="$(md5_of "$LAUNCHER")"
if [ "$LAUNCHER_MD5_AFTER" != "$LAUNCHER_MD5_BEFORE" ]; then
  echo "FAIL (tracked-launcher-untouched): the tracked launcher's md5 changed during the suite (before=$LAUNCHER_MD5_BEFORE after=$LAUNCHER_MD5_AFTER)" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo "PASS (tracked-launcher-untouched): tracked launcher md5 unchanged throughout the suite ($LAUNCHER_MD5_AFTER)" >&2
fi

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAILED: $FAIL_COUNT case(s) failed" >&2
  exit 1
fi

echo "PASS: all mcp-ruflo-launcher.test.sh cases passed"
