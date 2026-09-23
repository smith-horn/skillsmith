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
    # H-5: a `-f <format>` flag (check_existing_volume()'s label read) is a
    # DIFFERENT call from the plain existence probe (volume_exists()) below
    # it -- detect it and answer with the label content instead of a bare
    # exit code.
    fmt=""
    shift 2
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -f) shift; fmt="${1:-}" ;;
        esac
        shift
    done
    if [[ -n "$fmt" ]]; then
        [[ -f "$FAKE_STATE_DIR/volume-exists" ]] || exit 1
        cat "$FAKE_STATE_DIR/volume-label" 2>/dev/null || true
        exit 0
    fi
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
        if [[ "$*" == *"RUFLO_PROBE_DB_PATH="* ]]; then
            # H-6: probe_generation()'s per-file read-only probe. Distinguish
            # WHICH file by the presence of "agentdb-memory.db" in the argv
            # (the -e RUFLO_PROBE_DB_PATH=<path> value) -- check the MORE
            # SPECIFIC substring first, since "memory.db" is itself a
            # substring of "agentdb-memory.db" (same ordering discipline as
            # scripts/tests/mcp-ruflo-launcher.test.sh's own docker stub).
            if [[ "$*" == *"agentdb-memory.db"* ]]; then
                gen="${FAKE_AGENTDB_GENERATION-}"
            else
                gen="${FAKE_MEMORY_GENERATION-}"
            fi
            if [[ -n "$gen" ]]; then
                echo "RUFLO_GEN=$gen"
            else
                echo "RUFLO_GEN_ABSENT"
            fi
            exit 0
        fi
        # --entrypoint node without RUFLO_PROBE_DB_PATH: init_store()'s
        # one-off store_generation WRITE run, once per file (H-6). Record a
        # per-file marker (from RUFLO_STORE_DB_FILENAME=<name>) plus the
        # shared init-ran marker the existing arms already check.
        if [[ "${FAKE_INIT_STORE_ROW_MISMATCH:-0}" == "1" ]]; then
            # M-6: simulates the node script's own SELECT-back finding an
            # EXISTING row for a DIFFERENT generation and exiting 1.
            echo "store_generation rows: [\"some-other-generation\"] (expected exactly one row equal to the requested generation)" >&2
            exit 1
        fi
        if [[ "$*" == *"RUFLO_STORE_DB_FILENAME=agentdb-memory.db"* ]]; then
            touch "$FAKE_STATE_DIR/init-ran-agentdb-memory.db"
        elif [[ "$*" == *"RUFLO_STORE_DB_FILENAME=memory.db"* ]]; then
            touch "$FAKE_STATE_DIR/init-ran-memory.db"
        fi
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
    unset FAKE_INIT_STORE_ROW_MISMATCH || true
    unset FAKE_MEMORY_GENERATION || true
    unset FAKE_AGENTDB_GENERATION || true
}

# H-5/M-6 shared fixture: an existing, labelled volume whose label and
# authority-file instanceNonce agree (so authority quad (a)/(b) both pass),
# leaving only the store-presence probe (d) and the generation row (c) to
# vary per arm below.
setup_labelled_volume() {
    local nonce="$1" generation="$2"
    mkdir -p "$FAKE_STATE_DIR" && touch "$FAKE_STATE_DIR/volume-exists"
    echo "$nonce" > "$FAKE_STATE_DIR/volume-label"
    mkdir -p "$HOME/.skillsmith"
    printf '{"instanceNonce":"%s","generationUuid":"%s","createdAt":"2020-01-01T00:00:00Z"}\n' "$nonce" "$generation" > "$HOME/.skillsmith/ruflo-store.json"
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
elif [[ ! -f "$FAKE_STATE_DIR/init-ran-memory.db" ]] || [[ ! -f "$FAKE_STATE_DIR/init-ran-agentdb-memory.db" ]]; then
    fail_case "1-fresh" "expected TWO init calls, one per store file (memory.db and agentdb-memory.db) -- SMI-6744 A1.4 defect fix"
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

# ---- Arm 5 (H-5): existing volume, label MISMATCHES the authority file's
# instanceNonce -- must die naming the ADR-170 SS5 manual-resolution text,
# without ever probing the store or running init. ----
reset_fixture
setup_labelled_volume "actual-nonce-on-volume" "gen-5"
# Authority file names a DIFFERENT nonce than the volume actually carries.
printf '{"instanceNonce":"%s","generationUuid":"%s","createdAt":"2020-01-01T00:00:00Z"}\n' "expected-nonce-from-authority-file" "gen-5" > "$HOME/.skillsmith/ruflo-store.json"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "5-label-mismatch" "expected non-zero exit (refusal), got 0"
elif ! grep -q "$HOME/.skillsmith/ruflo-store.json" "$SCRATCH_ROOT/out.log"; then
    fail_case "5-label-mismatch" "expected the refusal message to name the authority file path"
elif ! grep -qi "wrong-generation hazard" "$SCRATCH_ROOT/out.log"; then
    fail_case "5-label-mismatch" "expected the refusal message to name the wrong-generation hazard (ADR-170 SS5 (b))"
elif [[ -f "$FAKE_STATE_DIR/init-ran" ]]; then
    fail_case "5-label-mismatch" "expected NO store-init run on a label mismatch"
else
    echo "applied=refuse-label-mismatch PASS (5-label-mismatch): refused naming the file and the wrong-generation hazard, no init"
fi

# ---- Arm 6 (H-5): existing volume, label matches, but NEITHER store file
# has a store_generation marker (the partial-creation hole) -- must re-run
# init_store with the authority file's own generationUuid for BOTH files,
# then still bring the service up. ----
reset_fixture
setup_labelled_volume "matching-nonce" "gen-6-from-authority-file"
# Deliberately no FAKE_MEMORY_GENERATION/FAKE_AGENTDB_GENERATION -- both
# probes answer ABSENT.
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "6-missing-store-reinit" "expected exit 0, got $EXIT_CODE"
elif grep -q "volume create" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "6-missing-store-reinit" "expected NO 'volume create' call (the volume already exists), log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif [[ ! -f "$FAKE_STATE_DIR/init-ran-memory.db" ]] || [[ ! -f "$FAKE_STATE_DIR/init-ran-agentdb-memory.db" ]]; then
    fail_case "6-missing-store-reinit" "expected init_store() to re-run against BOTH store files on a labelled-but-empty volume"
elif ! grep -q "RUFLO_GENERATION_UUID=gen-6-from-authority-file" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "6-missing-store-reinit" "expected init_store() to run with the authority file's own generationUuid, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif [[ ! -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "6-missing-store-reinit" "expected docker compose ... up -d ruflo to have executed after re-init"
else
    echo "applied=reinit-missing-store PASS (6-missing-store-reinit): label matched, both stores absent, init_store re-ran for both with the authority file's generation, up ran"
fi

# ---- Arm 7 (M-6): existing volume, label matches, store absent, but the
# one-off init run itself reports a pre-existing DIFFERENT generation row --
# the shell caller (init_store()) must propagate that failure as a non-zero
# exit rather than treating "docker compose run" completing as success. ----
reset_fixture
setup_labelled_volume "matching-nonce-7" "gen-7-requested"
export FAKE_INIT_STORE_ROW_MISMATCH=1
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "7-row-mismatch-propagates" "expected non-zero exit (M-6 propagation), got 0"
elif ! grep -q "one-off store_generation init run for .swarm/memory.db failed" "$SCRATCH_ROOT/out.log"; then
    fail_case "7-row-mismatch-propagates" "expected the init_store() failure message to be surfaced by name"
elif [[ -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "7-row-mismatch-propagates" "expected docker compose ... up -d ruflo NOT to run after a propagated init failure"
else
    echo "applied=row-mismatch-propagates PASS (7-row-mismatch-propagates): a pre-existing different generation row's exit 1 propagated through the shell caller as a non-zero exit, no up"
fi
unset FAKE_INIT_STORE_ROW_MISMATCH

# ---- Arm 8 (SMI-6744 A1.4 two-store defect): existing volume, label
# matches, memory.db ALREADY carries the marker at the authority file's own
# generation, but agentdb-memory.db has none -- the live-volume state this
# fix targets. Must repair ONLY agentdb-memory.db (memory.db already correct,
# no need to re-init it), log it as a same-generation repair (not a
# wrong-generation refusal), then bring the service up. ----
reset_fixture
setup_labelled_volume "matching-nonce-8" "gen-8-authority"
export FAKE_MEMORY_GENERATION="gen-8-authority"
# FAKE_AGENTDB_GENERATION deliberately unset -- probe answers ABSENT.
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "8-agentdb-repair" "expected exit 0, got $EXIT_CODE"
elif grep -q "volume create" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "8-agentdb-repair" "expected NO 'volume create' call, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif [[ -f "$FAKE_STATE_DIR/init-ran-memory.db" ]]; then
    fail_case "8-agentdb-repair" "expected NO re-init of memory.db (it already carries the correct marker)"
elif [[ ! -f "$FAKE_STATE_DIR/init-ran-agentdb-memory.db" ]]; then
    fail_case "8-agentdb-repair" "expected init_store() to repair agentdb-memory.db"
elif ! grep -q "RUFLO_GENERATION_UUID=gen-8-authority" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "8-agentdb-repair" "expected the repair to use memory.db's own (== authority file's) generation, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif ! grep -qi "same-generation repair\|NOT a wrong-generation hazard" "$SCRATCH_ROOT/out.log"; then
    fail_case "8-agentdb-repair" "expected the log to distinguish this from a wrong-generation refusal"
elif [[ ! -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "8-agentdb-repair" "expected docker compose ... up -d ruflo to have executed after the repair"
else
    echo "applied=same-generation-repair PASS (8-agentdb-repair): memory.db already correct, agentdb-memory.db repaired with the same generation, logged as a repair (not a refusal), up ran"
fi
unset FAKE_MEMORY_GENERATION

# ---- Arm 9 (SMI-6744 A1.4 two-store defect): existing volume, label
# matches, but memory.db and agentdb-memory.db carry DIFFERENT
# store_generation rows -- a forked/copied store. Must refuse naming BOTH
# files, with NO init and NO up. ----
reset_fixture
setup_labelled_volume "matching-nonce-9" "gen-9-authority"
export FAKE_MEMORY_GENERATION="gen-9-authority"
export FAKE_AGENTDB_GENERATION="gen-9-DIFFERENT"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "9-two-stores-disagree" "expected non-zero exit (refusal), got 0"
elif ! grep -q "memory.db" "$SCRATCH_ROOT/out.log" || ! grep -q "agentdb-memory.db" "$SCRATCH_ROOT/out.log"; then
    fail_case "9-two-stores-disagree" "expected the refusal message to name BOTH memory.db and agentdb-memory.db"
elif ! grep -qi "DIFFERENT generations" "$SCRATCH_ROOT/out.log"; then
    fail_case "9-two-stores-disagree" "expected the refusal message to name the generation disagreement"
elif [[ -f "$FAKE_STATE_DIR/init-ran" ]]; then
    fail_case "9-two-stores-disagree" "expected NO init run when the two stores disagree"
elif [[ -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "9-two-stores-disagree" "expected docker compose ... up -d ruflo NOT to run on a store disagreement"
else
    echo "applied=refuse-two-stores-disagree PASS (9-two-stores-disagree): refused naming both files and the generation disagreement, no init, no up"
fi
unset FAKE_MEMORY_GENERATION FAKE_AGENTDB_GENERATION

echo ""
if [[ "$FAIL_COUNT" -eq 0 ]]; then
    echo "SUMMARY: 9/9 arms passed"
    exit 0
else
    echo "SUMMARY: $FAIL_COUNT/9 arms FAILED"
    exit 1
fi
