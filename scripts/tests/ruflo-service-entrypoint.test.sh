#!/usr/bin/env bash
# shellcheck disable=SC2016  # every single-quoted 'if [ "$ACTUAL_DIGEST" != ...'
# string below (mutate_prefix_compare's exact-line match/replacement text and
# its own sanity-check grep) is deliberately NOT expanded -- it matches and
# emits shell SOURCE TEXT verbatim, not a value to interpolate.
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
# Read this before trusting Arms 2-4 as full coverage of a privilege limit:
# they hold ONLY under whatever non-root host user runs this test suite --
# `chmod 500` denies a NON-owning process, but the real `ruflo` service
# container runs this entrypoint as root (ADR-170 SS3), and root can write
# through a 500-mode directory it owns regardless. These three arms test
# the writability PROBE's own write-and-remove mechanics (a `mkdir -p`
# success proving nothing about writing into an EXISTING read-only
# directory, ADR-170 SS4) -- they are not, and do not claim to be, coverage
# of what happens when the real uid IS root; that privilege-limit class is
# the scripts/ruflo-launch-guard.mjs per-spawn probe's own Linux arms, owned
# by a parallel A1.4 lane, not this entrypoint's test suite.
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

# ---- fake sleep: records the call and, by default, exits immediately (the
# real backgrounded `sleep infinity` would hang this test forever for every
# arm that doesn't care about the hold itself). H-2's SIGTERM arm (8) is the
# one exception: it sets FAKE_SLEEP_BLOCK so this fake genuinely blocks (via
# the REAL system `sleep`, captured below before FAKE_BIN_DIR shadows it),
# which is what lets that arm observe the entrypoint actually holding before
# it sends SIGTERM -- an already-exited fake proves nothing about the trap.
# A fixed 100 real seconds regardless of the "infinity" argument: BSD `sleep`
# (macOS, this repo's default host) does not accept "infinity" as GNU's does.
REAL_SLEEP="$(command -v sleep)"
cat > "$FAKE_BIN_DIR/sleep" << FAKE_SLEEP
#!/usr/bin/env bash
echo "sleep \$*" >> "\$FAKE_SLEEP_CALL_LOG"
if [ -n "\${FAKE_SLEEP_BLOCK:-}" ]; then
    exec "$REAL_SLEEP" 100
fi
exit 0
FAKE_SLEEP
chmod +x "$FAKE_BIN_DIR/sleep"

# A real-shaped sha256 (64 lowercase hex): the entrypoint validates the expected
# digest's shape before it validates the seed, so a short fixture never reaches the probes.
DIGEST="deadbeefcafe0000deadbeefcafe0000deadbeefcafe0000deadbeefcafe0000"
# PR-16 (cross-family gate on PR #2931): two digests that share DIGEST's
# first 60 hex chars but differ in the last 4, and vice versa -- pinning that
# the entrypoint's `[ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]` compares the
# FULL 64 chars, not a truncated prefix or suffix (Arms 8 and 9 below).
SHARED_PREFIX_DIFF_SUFFIX="${DIGEST%????}beef"
DIFF_PREFIX_SHARED_SUFFIX="beef${DIGEST#????}"

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

# run_script_at <script-path> <out-log> -- like run_script(), but against an
# arbitrary script (the red-arm mutant below) and an arbitrary output file,
# so the mutant run never clobbers $SCRATCH_ROOT/out.log that fail_case()
# reads for every other arm.
run_script_at() {
    set +e
    PATH="$FAKE_BIN_DIR:$PATH" "$1" >"$2" 2>&1
    echo $?
    set -e
}

fail_case() {
    echo "FAIL ($1): $2" >&2
    cat "$SCRATCH_ROOT/out.log" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
}

sleep_was_called() { [[ -s "$FAKE_SLEEP_CALL_LOG" ]]; }

# mutate_prefix_compare <src> <dst> -- writes a scratch copy of the
# entrypoint whose digest comparison examines only the first 60 hex chars of
# each digest instead of the full 64 -- the mutant class PR-16 named. Exact
# line match (not sed/awk regex escaping of `$`/`[`/`]`) so there is no
# escaping to get wrong; the sanity check below confirms the substitution
# actually fired rather than silently no-op'ing if the source line's exact
# text ever drifts.
mutate_prefix_compare() {
    src="$1"
    dst="$2"
    : > "$dst"
    while IFS= read -r line || [ -n "$line" ]; do
        if [ "$line" = 'if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then' ]; then
            {
                printf '%s\n' 'ACTUAL_DIGEST_PREFIX=$(printf '"'"'%s'"'"' "$ACTUAL_DIGEST" | cut -c1-60)'
                printf '%s\n' 'EXPECTED_DIGEST_PREFIX=$(printf '"'"'%s'"'"' "$EXPECTED_DIGEST" | cut -c1-60)'
                printf '%s\n' 'if [ "$ACTUAL_DIGEST_PREFIX" != "$EXPECTED_DIGEST_PREFIX" ]; then'
            } >> "$dst"
        else
            printf '%s\n' "$line" >> "$dst"
        fi
    done < "$src"
    chmod +x "$dst"
}

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

# ---- Arm 8 (PR-16): candidate shares the expected digest's first 60 hex
# chars, differs only in the last 4 -- pins that the comparison is over the
# FULL 64 chars, not a truncated prefix. RUFLO_SEED_EXPECTED_DIGEST stays
# DIGEST (reset_fixture's default); only the fixture's generator output
# (the CANDIDATE/actual digest, per the fake node's `cat "$1"` branch at the
# top of this file) is overwritten to the shared-prefix/differing-suffix value.
reset_fixture
echo "$SHARED_PREFIX_DIFF_SUFFIX" > "$GENERATOR"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "8-digest-shared-prefix" "expected non-zero exit (refusal) for a candidate sharing the expected digest's first 60 hex chars but differing in the last 4, got 0"
elif ! grep -q "digest mismatch" "$SCRATCH_ROOT/out.log"; then
    fail_case "8-digest-shared-prefix" "expected the refusal to say digest mismatch"
elif sleep_was_called; then
    fail_case "8-digest-shared-prefix" "expected the hold command to NEVER be invoked on refusal"
else
    echo "applied=digest-shared-prefix PASS (8-digest-shared-prefix): refused a candidate differing only in the last 4 hex chars (actual=$SHARED_PREFIX_DIFF_SUFFIX expected=$DIGEST)"
fi

# ---- Arm 8-red (PR-16 red-arm confirmation): the SAME shared-prefix/
# differing-suffix fixture from Arm 8, run against a MUTANT copy of the
# entrypoint whose comparison examines only the first 60 hex chars. If Arm 8
# is a real pin on a full 64-char comparison (not merely "some difference
# somewhere"), this mutant must WRONGLY pass (exit 0) the exact case Arm 8
# requires a refusal for -- CLAUDE.md's "a regression test you have not run
# against the unfixed code is unverified", run here as a committed,
# automated part of the suite rather than a one-off manual check so every
# future run keeps proving Arm 8 actually distinguishes the two comparisons.
MUTANT_SCRIPT="$SCRATCH_ROOT/entrypoint-prefix-mutant.sh"
mutate_prefix_compare "$SCRIPT_UNDER_TEST" "$MUTANT_SCRIPT"
if grep -qF 'if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then' "$MUTANT_SCRIPT"; then
    fail_case "8-red-prefix-mutant" "mutate_prefix_compare's exact-line match no longer matches $SCRIPT_UNDER_TEST -- the mutant is a byte-for-byte copy of the real script, so this red arm proves nothing until the match is updated"
else
    reset_fixture
    echo "$SHARED_PREFIX_DIFF_SUFFIX" > "$GENERATOR"
    RED_EXIT="$(run_script_at "$MUTANT_SCRIPT" "$SCRATCH_ROOT/out-red.log")"
    if [[ "$RED_EXIT" -ne 0 ]]; then
        fail_case "8-red-prefix-mutant" "expected the prefix-compare MUTANT to wrongly PASS (exit 0) the shared-prefix/differing-suffix case -- it refused instead (exit $RED_EXIT), which means this fixture no longer distinguishes a prefix-only comparison from a full-string one: $(cat "$SCRATCH_ROOT/out-red.log")"
    else
        echo "applied=red-arm-prefix-mutant PASS (8-red-prefix-mutant): the prefix-compare MUTANT wrongly accepted a digest differing only in the last 4 hex chars (exit 0) -- confirms Arm 8 pins a full 64-char comparison, not a prefix compare"
    fi
fi

# ---- Arm 9 (PR-16): candidate differs from the expected digest only in the
# FIRST 4 hex chars, shares the last 60 -- the symmetric case to Arm 8.
reset_fixture
echo "$DIFF_PREFIX_SHARED_SUFFIX" > "$GENERATOR"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "9-digest-diff-prefix" "expected non-zero exit (refusal) for a candidate differing from the expected digest only in the first 4 hex chars, got 0"
elif ! grep -q "digest mismatch" "$SCRATCH_ROOT/out.log"; then
    fail_case "9-digest-diff-prefix" "expected the refusal to say digest mismatch"
elif sleep_was_called; then
    fail_case "9-digest-diff-prefix" "expected the hold command to NEVER be invoked on refusal"
else
    echo "applied=digest-diff-prefix PASS (9-digest-diff-prefix): refused a candidate differing only in the first 4 hex chars (actual=$DIFF_PREFIX_SHARED_SUFFIX expected=$DIGEST)"
fi

# ---- Arm 10 (H-2): the hold responds to SIGTERM by exiting 0 within 2s.
# FAKE_SLEEP_BLOCK makes the fake `sleep` genuinely block (real system
# sleep, see above) so the entrypoint is actually parked in `wait $!` when
# the signal arrives -- an instantly-exiting fake would prove nothing about
# the trap. Started in the background (not via run_script(), which blocks
# until exit) so this arm can send SIGTERM while the entrypoint still holds.
reset_fixture
export FAKE_SLEEP_BLOCK=1
PATH="$FAKE_BIN_DIR:$PATH" "$SCRIPT_UNDER_TEST" >"$SCRATCH_ROOT/out-10.log" 2>&1 &
ENTRYPOINT_PID=$!
sleep 0.5
if ! kill -0 "$ENTRYPOINT_PID" 2>/dev/null; then
    fail_case "10-sigterm" "entrypoint exited before reaching the hold: $(cat "$SCRATCH_ROOT/out-10.log")"
else
    # Watchdog: forces the test to fail fast (not hang) if the trap never
    # fires, by SIGKILLing past the 2s budget -- `wait` below then observes
    # a non-zero (signalled) exit status rather than the required 0.
    ( sleep 2; kill -0 "$ENTRYPOINT_PID" 2>/dev/null && kill -KILL "$ENTRYPOINT_PID" 2>/dev/null ) &
    WATCHDOG_PID=$!
    START_S="$(date +%s)"
    kill -TERM "$ENTRYPOINT_PID"
    set +e
    wait "$ENTRYPOINT_PID"
    SIGTERM_EXIT=$?
    set -e
    END_S="$(date +%s)"
    kill "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
    ELAPSED=$((END_S - START_S))
    if [[ "$SIGTERM_EXIT" -ne 0 ]]; then
        fail_case "10-sigterm" "expected exit 0 within 2s of SIGTERM, got exit $SIGTERM_EXIT after ${ELAPSED}s (0 usually means the watchdog SIGKILLed it): $(cat "$SCRATCH_ROOT/out-10.log")"
    elif [[ "$ELAPSED" -gt 1 ]]; then
        fail_case "10-sigterm" "expected the trap to fire near-instantly (well under the 2s watchdog budget), took ${ELAPSED}s"
    else
        echo "applied=sigterm-exit0 PASS (10-sigterm): entrypoint exited 0 in ${ELAPSED}s of SIGTERM (budget 2s)"
    fi
fi
unset FAKE_SLEEP_BLOCK

echo ""
if [[ "$FAIL_COUNT" -eq 0 ]]; then
    echo "SUMMARY: 11/11 arms passed"
    exit 0
else
    echo "SUMMARY: $FAIL_COUNT/11 arms FAILED"
    exit 1
fi
