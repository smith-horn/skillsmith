#!/usr/bin/env bash
# scripts/tests/ruflo-service-up.test.sh -- fake-binary smoke tests for
# scripts/ruflo-service-up.sh (ADR-170 SS5/SS8's creation procedure),
# following the fake-binary shape of scripts/tests/needle-dispatch.test.sh:
# a `docker` stub on PATH records argv (into FAKE_DOCKER_CALL_LOG) and
# returns scripted results driven by a small file-backed FAKE_STATE_DIR and
# env-var switches, so the full script runs deterministically without a
# real Docker daemon. HOME is overridden to a scratch directory so
# scripts/ruflo-service-up.sh's own `$HOME/.skillsmith/ruflo-store.json`
# resolves under test control.
#
# Usage: ./scripts/tests/ruflo-service-up.test.sh
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
SCRIPT_UNDER_TEST="$REPO_ROOT/scripts/ruflo-service-up.sh"
VOLUME_NAME="skillsmith-ruflo-data"
LABEL_KEY="app.skillsmith.ruflo.instance"

FAIL_COUNT=0
SCRATCH_ROOT="$(mktemp -d)"
FAKE_BIN_DIR="$SCRATCH_ROOT/bin"
mkdir -p "$FAKE_BIN_DIR"

trap 'rm -rf "$SCRATCH_ROOT"' EXIT

# ---- fake docker: records every call, answers volume inspect/create and
# `compose ... run|up` deterministically from FAKE_STATE_DIR + env
# switches. ----
cat > "$FAKE_BIN_DIR/docker" << 'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >> "$FAKE_DOCKER_CALL_LOG"

sub1="${1:-}"
sub2="${2:-}"

if [[ "$sub1 $sub2" == "volume inspect" ]]; then
    [[ -f "$FAKE_STATE_DIR/volume-exists" ]] && exit 0 || exit 1
elif [[ "$sub1 $sub2" == "volume create" ]]; then
    if [[ "${FAKE_VOLUME_CREATE_FAIL:-0}" == "1" ]]; then
        echo "fake docker: forced 'volume create' failure" >&2
        exit 1
    fi
    label=""
    shift 2
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --label) shift; label="$1" ;;
        esac
        shift
    done
    echo "$label" > "$FAKE_STATE_DIR/volume-label"
    touch "$FAKE_STATE_DIR/volume-exists"
    exit 0
elif [[ "$sub1" == "compose" ]]; then
    if [[ "$*" == *" run "* ]]; then
        touch "$FAKE_STATE_DIR/init-ran"
        exit 0
    elif [[ "$*" == *" up "* ]]; then
        touch "$FAKE_STATE_DIR/up-ran"
        exit 0
    fi
    exit 0
elif [[ "$sub1" == "inspect" ]]; then
    echo "  (fake mount fact)"
    exit 0
fi
exit 0
FAKE_DOCKER
chmod +x "$FAKE_BIN_DIR/docker"

reset_fixture() {
    FAKE_STATE_DIR="$(mktemp -d)"
    FAKE_DOCKER_CALL_LOG="$(mktemp)"
    HOME="$(mktemp -d)"
    RUFLO_SEED_EXPECTED_DIGEST_FILE="$HOME/SEED-MANIFEST.sha256"
    printf '%s\n' "$(printf 'a%.0s' $(seq 1 64))" > "$RUFLO_SEED_EXPECTED_DIGEST_FILE"
    export FAKE_STATE_DIR FAKE_DOCKER_CALL_LOG HOME RUFLO_SEED_EXPECTED_DIGEST_FILE
    unset FAKE_VOLUME_CREATE_FAIL || true
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

# ---- Arm 1: fresh (volume absent, no authority file) ----
reset_fixture
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "1-fresh" "expected exit 0, got $EXIT_CODE"
elif ! grep -q "volume create --label $LABEL_KEY=.* $VOLUME_NAME" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "1-fresh" "expected a 'volume create --label $LABEL_KEY=... $VOLUME_NAME' call, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif [[ ! -f "$FAKE_STATE_DIR/init-ran" ]]; then
    fail_case "1-fresh" "expected the one-off store-init run (docker compose ... run ...) to have executed"
elif [[ ! -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "1-fresh" "expected docker compose ... up -d ruflo to have executed"
elif [[ ! -f "$HOME/.skillsmith/ruflo-store.json" ]]; then
    fail_case "1-fresh" "expected authority file to exist at \$HOME/.skillsmith/ruflo-store.json"
else
    MODE="$(stat -f '%Lp' "$HOME/.skillsmith/ruflo-store.json" 2>/dev/null || stat -c '%a' "$HOME/.skillsmith/ruflo-store.json")"
    if [[ "$MODE" != "600" ]]; then
        fail_case "1-fresh" "expected authority file mode 600, got $MODE"
    elif ! grep -q '"instanceNonce"' "$HOME/.skillsmith/ruflo-store.json" || \
         ! grep -q '"generationUuid"' "$HOME/.skillsmith/ruflo-store.json" || \
         ! grep -q '"createdAt"' "$HOME/.skillsmith/ruflo-store.json"; then
        fail_case "1-fresh" "authority file missing one of instanceNonce/generationUuid/createdAt: $(cat "$HOME/.skillsmith/ruflo-store.json")"
    else
        echo "applied=fresh-create PASS (1-fresh): volume created with nonce label, store initialised, up ran, authority file 0600 with all three fields"
    fi
fi

# ---- Arm 2: existing volume ----
reset_fixture
mkdir -p "$FAKE_STATE_DIR" && touch "$FAKE_STATE_DIR/volume-exists"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "2-existing" "expected exit 0, got $EXIT_CODE"
elif grep -q "volume create" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "2-existing" "expected NO 'volume create' call, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif [[ -f "$FAKE_STATE_DIR/init-ran" ]]; then
    fail_case "2-existing" "expected NO store-init run against an already-existing volume"
elif [[ ! -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "2-existing" "expected docker compose ... up -d ruflo to have executed"
else
    echo "applied=existing-volume PASS (2-existing): no create, no init, up ran"
fi

# ---- Arm 3: authority file present but volume absent (wrong-generation
# hazard) ----
reset_fixture
mkdir -p "$HOME/.skillsmith"
echo '{"instanceNonce":"stale","generationUuid":"stale","createdAt":"2020-01-01T00:00:00Z"}' > "$HOME/.skillsmith/ruflo-store.json"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "3-wrong-generation" "expected non-zero exit (refusal), got 0"
elif ! grep -q "$HOME/.skillsmith/ruflo-store.json" "$SCRATCH_ROOT/out.log"; then
    fail_case "3-wrong-generation" "expected the refusal message to name the authority file path"
elif ! grep -qi "wrong.generation" "$SCRATCH_ROOT/out.log"; then
    fail_case "3-wrong-generation" "expected the refusal message to name the wrong-generation hazard"
elif grep -q "volume create" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "3-wrong-generation" "expected NO 'volume create' call on refusal, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
else
    echo "applied=refuse-wrong-generation PASS (3-wrong-generation): refused naming the file and the wrong-generation hazard, no create"
fi

# ---- Arm 4: docker fails at volume create ----
reset_fixture
export FAKE_VOLUME_CREATE_FAIL=1
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "4-create-fails" "expected non-zero exit, got 0"
elif ! grep -q "docker volume create" "$SCRATCH_ROOT/out.log"; then
    fail_case "4-create-fails" "expected the failure message to name the 'docker volume create' command"
elif [[ -f "$HOME/.skillsmith/ruflo-store.json" ]]; then
    fail_case "4-create-fails" "expected NO authority file to be left behind by a failed create (would orphan into a permanent wrong-generation refusal)"
else
    echo "applied=docker-volume-create-fail PASS (4-create-fails): non-zero exit naming the command, no orphaned authority file"
fi
unset FAKE_VOLUME_CREATE_FAIL

echo ""
if [[ "$FAIL_COUNT" -eq 0 ]]; then
    echo "SUMMARY: 4/4 arms passed"
    exit 0
else
    echo "SUMMARY: $FAIL_COUNT/4 arms FAILED"
    exit 1
fi
