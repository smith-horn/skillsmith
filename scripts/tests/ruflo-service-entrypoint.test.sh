#!/usr/bin/env bash
# scripts/tests/ruflo-service-entrypoint.test.sh -- fake-binary smoke tests
# for scripts/ruflo-service-entrypoint.sh (ADR-170 SS4/SS6's container
# entrypoint), following the fake-binary shape of scripts/tests/
# needle-dispatch.test.sh: `node` and `sleep` stubs on PATH record argv and
# return scripted results, so the full entrypoint logic runs
# deterministically against a real (scratch) filesystem without a real
# Docker container, a real Node.js manifest generator, or the real seed
# tree. The entrypoint's own RUFLO_SERVICE_CWD/RUFLO_MANIFEST_GENERATOR/
# RUFLO_MANIFEST_RECORD/RUFLO_SEED_ROOT env overrides point it at this
# fixture instead of /srv/ruflo and /opt/ruflo-*.
#
# Real chmod-based read-only directories are used for the three
# writability-probe arms -- this deliberately exercises the entrypoint's
# actual filesystem calls (write + remove), not a mocked writability
# signal, per this repo's "a mount flag is an inference; a successful write
# ... demonstrates that operation succeeds" rule.
#
# Usage: ./scripts/tests/ruflo-service-entrypoint.test.sh
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
SCRIPT_UNDER_TEST="$REPO_ROOT/scripts/ruflo-service-entrypoint.sh"

FAIL_COUNT=0
SCRATCH_ROOT="$(mktemp -d)"
FAKE_BIN_DIR="$SCRATCH_ROOT/bin"
mkdir -p "$FAKE_BIN_DIR"
FAKE_NODE_VERSION_OUTPUT="9.9.9-fake"
export FAKE_NODE_VERSION_OUTPUT

trap 'chmod -R u+w "$SCRATCH_ROOT" 2>/dev/null || true; rm -rf "$SCRATCH_ROOT"' EXIT

# ---- fake node: three call shapes the entrypoint uses.
#   node -p "require(...).version"            -> canned version string
#   node -e "<JS>" <manifest-record> <field>   -> naive JSON field grep
#   node <generator-script> <seed-root>        -> cats the fixture script's
#                                                  own content as "the digest"
cat > "$FAKE_BIN_DIR/node" << 'FAKE_NODE'
#!/usr/bin/env bash
set -euo pipefail
echo "node $*" >> "$FAKE_NODE_CALL_LOG"

case "${1:-}" in
    -p)
        echo "$FAKE_NODE_VERSION_OUTPUT"
        exit 0
        ;;
    -e)
        record="${3:-}"
        field="${4:-}"
        val="$(grep -o "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$record" 2>/dev/null | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"
        printf '%s' "$val"
        exit 0
        ;;
    *)
        cat "$1"
        exit 0
        ;;
esac
FAKE_NODE
chmod +x "$FAKE_BIN_DIR/node"

# ---- fake sleep: records the call and exits immediately (the real
# `exec sleep infinity` would hang this test forever). ----
cat > "$FAKE_BIN_DIR/sleep" << 'FAKE_SLEEP'
#!/usr/bin/env bash
echo "sleep $*" >> "$FAKE_SLEEP_CALL_LOG"
exit 0
FAKE_SLEEP
chmod +x "$FAKE_BIN_DIR/sleep"

# A real-shaped sha256 (64 lowercase hex): the entrypoint validates the expected
# digest's shape before it validates the seed, so a short fixture never reaches the probes.
DIGEST="deadbeefcafe0000deadbeefcafe0000deadbeefcafe0000deadbeefcafe0000"

reset_fixture() {
    FIX="$(mktemp -d)"
    CWD="$FIX/srv-ruflo"
    mkdir -p "$CWD"
    GENERATOR="$FIX/generate-manifest.mjs"
    echo "$DIGEST" > "$GENERATOR"
    FAKE_NODE_CALL_LOG="$(mktemp)"
    FAKE_SLEEP_CALL_LOG="$(mktemp)"
    export FAKE_NODE_CALL_LOG FAKE_SLEEP_CALL_LOG
    export RUFLO_SERVICE_CWD="$CWD"
    export RUFLO_MANIFEST_GENERATOR="$GENERATOR"
    export RUFLO_SEED_EXPECTED_DIGEST="$DIGEST"
    export RUFLO_SEED_ROOT="$FIX/seed"
    mkdir -p "$RUFLO_SEED_ROOT"
}

run_script() {
    set +e
    PATH="$FAKE_BIN_DIR:$PATH" "$SCRIPT_UNDER_TEST" >"$SCRATCH_ROOT/out.log" 2>&1
    echo $?
    set -e
}

fail_case() {
    echo "FAIL ($1): $2" >&2
    cat "$SCRATCH_ROOT/out.log" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
}

sleep_was_called() { [[ -s "$FAKE_SLEEP_CALL_LOG" ]]; }

# ---- Arm 1: healthy ----
reset_fixture
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "1-healthy" "expected exit 0, got $EXIT_CODE"
elif [[ ! -d "$CWD/.claude-flow" || ! -d "$CWD/.claude-flow/policy" || ! -d "$CWD/.swarm" ]]; then
    fail_case "1-healthy" "expected .claude-flow, .claude-flow/policy and .swarm to have been created"
elif find "$CWD" -name '.ruflo-entrypoint-probe.*' 2>/dev/null | grep -q .; then
    fail_case "1-healthy" "expected every probe file to have been removed, found: $(find "$CWD" -name '.ruflo-entrypoint-probe.*')"
elif ! grep -q "@claude-flow/cli@$FAKE_NODE_VERSION_OUTPUT" "$SCRATCH_ROOT/out.log"; then
    fail_case "1-healthy" "expected the served version line naming $FAKE_NODE_VERSION_OUTPUT"
elif ! sleep_was_called; then
    fail_case "1-healthy" "expected the hold command (sleep infinity) to have been invoked"
else
    echo "applied=healthy PASS (1-healthy): dirs created, probes cleaned up, version printed, hold invoked"
fi

# ---- Arm 2: read-only .claude-flow/policy ----
reset_fixture
mkdir -p "$CWD/.claude-flow" "$CWD/.swarm"
mkdir -p "$CWD/.claude-flow/policy"
chmod 500 "$CWD/.claude-flow/policy"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "2-policy-readonly" "expected non-zero exit (refusal), got 0"
elif ! grep -q "$CWD/.claude-flow/policy" "$SCRATCH_ROOT/out.log"; then
    fail_case "2-policy-readonly" "expected the refusal to name $CWD/.claude-flow/policy"
elif sleep_was_called; then
    fail_case "2-policy-readonly" "expected the hold command to NEVER be invoked on refusal"
else
    echo "applied=policy-readonly PASS (2-policy-readonly): refused naming the path, hold never called"
fi
chmod 700 "$CWD/.claude-flow/policy"

# ---- Arm 3: read-only .swarm ----
reset_fixture
mkdir -p "$CWD/.claude-flow/policy"
mkdir -p "$CWD/.swarm"
chmod 500 "$CWD/.swarm"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "3-swarm-readonly" "expected non-zero exit (refusal), got 0"
elif ! grep -q "$CWD/.swarm" "$SCRATCH_ROOT/out.log"; then
    fail_case "3-swarm-readonly" "expected the refusal to name $CWD/.swarm"
elif sleep_was_called; then
    fail_case "3-swarm-readonly" "expected the hold command to NEVER be invoked on refusal"
else
    echo "applied=swarm-readonly PASS (3-swarm-readonly): refused naming the path, hold never called"
fi
chmod 700 "$CWD/.swarm"

# ---- Arm 4: read-only cwd root ----
reset_fixture
chmod 500 "$CWD"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "4-cwd-readonly" "expected non-zero exit (refusal), got 0"
elif ! grep -q "$CWD" "$SCRATCH_ROOT/out.log"; then
    fail_case "4-cwd-readonly" "expected the refusal to name $CWD"
elif sleep_was_called; then
    fail_case "4-cwd-readonly" "expected the hold command to NEVER be invoked on refusal"
else
    echo "applied=cwd-readonly PASS (4-cwd-readonly): refused naming the path, hold never called"
fi
chmod 700 "$CWD"

# ---- Arm 5: missing manifest inputs ----
reset_fixture
export RUFLO_MANIFEST_GENERATOR="$FIX/does-not-exist-generator.mjs"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "5-missing-manifest" "expected non-zero exit (refusal), got 0"
elif ! grep -q "$FIX/does-not-exist-generator.mjs" "$SCRATCH_ROOT/out.log"; then
    fail_case "5-missing-manifest" "expected the refusal to name the missing generator path"
elif sleep_was_called; then
    fail_case "5-missing-manifest" "expected the hold command to NEVER be invoked on refusal"
else
    echo "applied=missing-manifest PASS (5-missing-manifest): refused naming the missing path"
fi

# ---- Arm 6: expected digest not supplied (a bare docker compose up) ----
reset_fixture
unset RUFLO_SEED_EXPECTED_DIGEST
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "6-digest-unset" "expected non-zero exit (refusal), got 0"
elif ! grep -q "RUFLO_SEED_EXPECTED_DIGEST" "$SCRATCH_ROOT/out.log"; then
    fail_case "6-digest-unset" "expected the refusal to name RUFLO_SEED_EXPECTED_DIGEST"
elif sleep_was_called; then
    fail_case "6-digest-unset" "expected the hold command to NEVER be invoked on refusal"
else
    echo "applied=digest-unset PASS (6-digest-unset): refused naming the variable, hold never called"
fi

# ---- Arm 7: candidate digest differs from the expected one ----
reset_fixture
RUFLO_SEED_EXPECTED_DIGEST="$(printf 'f%.0s' $(seq 1 64))"
export RUFLO_SEED_EXPECTED_DIGEST
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "7-digest-mismatch" "expected non-zero exit (refusal), got 0"
elif ! grep -q "digest mismatch" "$SCRATCH_ROOT/out.log"; then
    fail_case "7-digest-mismatch" "expected the refusal to say digest mismatch"
elif ! grep -q "expected=ffff" "$SCRATCH_ROOT/out.log"; then
    fail_case "7-digest-mismatch" "expected the refusal to print the expected digest"
elif sleep_was_called; then
    fail_case "7-digest-mismatch" "expected the hold command to NEVER be invoked on refusal"
else
    echo "applied=digest-mismatch PASS (7-digest-mismatch): refused naming both digests, hold never called"
fi

echo ""
if [[ "$FAIL_COUNT" -eq 0 ]]; then
    echo "SUMMARY: 7/7 arms passed"
    exit 0
else
    echo "SUMMARY: $FAIL_COUNT/7 arms FAILED"
    exit 1
fi
