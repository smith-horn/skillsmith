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

# S-2 (SMI-6744 A1.8 retro): resolve the REAL git binary here, AFTER the
# cleanup trap above is already registered (F-3, SMI-6744 A1.8 retro round
# 2: the original capture ran BEFORE the trap existed -- an early,
# unexpected `command -v git` failure under `set -e` would then abort with
# nothing armed to clean up $SCRATCH_ROOT). `|| true` so a missing git
# surfaces as the 17-setup FAIL below (REAL_GIT empty -> `git init` fails
# with a clear "No such file or directory") rather than aborting this whole
# suite silently here. In THIS file, PATH is never globally prefixed with
# FAKE_BIN_DIR -- run_script() below only prepends it to the environment of
# the ONE command it invokes (`PATH="$FAKE_BIN_DIR:$PATH"
# "$SCRIPT_UNDER_TEST"`), which does not leak into this shell's own PATH --
# so a bare `git` anywhere else in this file, including Arm 17's real-git
# gate test, already resolves to the real binary regardless. REAL_GIT is
# still captured explicitly here (rather than relying on that fact staying
# true) so Arm 17 keeps working even if this file's PATH handling changes.
REAL_GIT="$(command -v git || true)"

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
    elif [[ "$*" == *" config "* ]]; then
        # H-3(c): check_foreign_project()'s own project-name resolution
        # (docker compose ... config --format json | jq -r .name).
        printf '{"name":"%s"}\n' "${FAKE_THIS_PROJECT:-test-fixture-project}"
        exit 0
    fi
    exit 0
elif [[ "$sub1" == "inspect" ]]; then
    # F-5 (SMI-6846 governance retro, Low): a VOLUME named skillsmith-ruflo-1
    # exists but no CONTAINER does -- a bare `docker inspect NAME` succeeds
    # on it (Docker inspects across object types by default), but
    # `--type container` does not. probe_container_owner()'s own inspect
    # call pins `--type container` (measured live, comment further down in
    # this file), so this checked BEFORE FAKE_INSPECT_FAIL: an arm can force
    # this same-name-volume shape regardless of the other fixture state.
    if [[ "${FAKE_SAMENAME_VOLUME:-0}" == "1" ]]; then
        if [[ "$*" == *"--type container"* ]]; then
            echo "Error response from daemon: No such container: skillsmith-ruflo-1" >&2
            exit 1
        fi
        printf '{"Name":"skillsmith-ruflo-1","Driver":"local"}\n'
        exit 0
    fi
    # SMI-6744 A1.8 gate round-1 fix (PR #2937, class 1): FAKE_INSPECT_FAIL
    # simulates the real docker-inspect failure modes measured on this host
    # (Docker client 29.7.2) for probe_container_owner() -- checked BEFORE
    # the existing FAKE_CONTAINER_PROJECT branch below so an arm can force
    # any of these regardless of the fixture's "container present" state.
    case "${FAKE_INSPECT_FAIL:-}" in
        nosuch)
            echo "Error response from daemon: No such container: skillsmith-ruflo-1" >&2
            exit 1
            ;;
        nosuch-object)
            echo "Error: No such object: skillsmith-ruflo-1" >&2
            exit 1
            ;;
        daemon)
            echo "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory" >&2
            exit 1
            ;;
        flag)
            echo "unknown flag: --type" >&2
            exit 125
            ;;
        workdir)
            # F-1 (SMI-6846 governance): fails ONLY the working_dir call so
            # an arm can force the project probe to succeed (exists=1,
            # owner readable) while the SEPARATE working_dir read fails --
            # falls through otherwise so the normal FAKE_CONTAINER_PROJECT
            # branches below still answer the project-label call.
            if [[ "$*" == *"project.working_dir"* ]]; then
                echo "failed to connect to the docker API at unix:///var/run/docker.sock" >&2
                exit 1
            fi
            ;;
    esac
    # H-3(c): default is NO container (the pre-H-3(c) behavior every
    # existing arm below already assumes) -- only "exists" when a dedicated
    # arm sets FAKE_CONTAINER_PROJECT. Answer the MORE SPECIFIC
    # ".project.working_dir" query before the plain ".project" one, since
    # the latter is a substring of the former's label key.
    if [[ -z "${FAKE_CONTAINER_PROJECT:-}" ]]; then
        echo "Error: No such object: skillsmith-ruflo-1" >&2
        exit 1
    fi
    if [[ "$*" == *"com.docker.compose.project.working_dir"* ]]; then
        printf '%s' "${FAKE_CONTAINER_WORKDIR:-}"
        exit 0
    elif [[ "$*" == *"com.docker.compose.project"* ]]; then
        # Arm 15c: the container EXISTS (FAKE_CONTAINER_PROJECT set) but its
        # project label reads back empty -- a hand-started or non-Compose
        # container, or a failed inspect.
        if [[ "${FAKE_CONTAINER_LABEL_EMPTY:-}" == "1" ]]; then
            printf ''
        elif [[ "${FAKE_CONTAINER_LABEL_NOVALUE:-}" == "1" ]]; then
            # Arm 15d (F-7, SMI-6744 A1.8 retro round 2): Docker's own
            # template engine prints the literal string "<no value>" (not an
            # empty string) when a --format references a map key that does
            # not exist -- measured live. check_foreign_project()'s empty
            # check must treat this the same as a genuinely empty read.
            printf '<no value>'
        else
            printf '%s' "${FAKE_CONTAINER_PROJECT:-}"
        fi
        exit 0
    else
        echo "  (fake mount fact)"
        exit 0
    fi
fi
exit 0
FAKE_DOCKER
chmod +x "$FAKE_BIN_DIR/docker"

# ---- fake git: answers ONLY the two `rev-parse` calls
# check_not_linked_worktree() (scripts/ruflo-service-up.helpers.sh, H-3(b))
# makes -- `-C <dir> rev-parse --git-dir` and `-C <dir> rev-parse
# --git-common-dir` -- from FAKE_GIT_DIR/FAKE_GIT_COMMON_DIR, so the
# worktree-vs-not decision is driven by the fixture, never by this test
# file's OWN real git state (this file itself may be running inside a real
# linked worktree). FAKE_GIT_NOT_A_REPO simulates "not inside a git
# repository" (git's own real exit code and stderr shape). ----
cat > "$FAKE_BIN_DIR/git" << 'FAKE_GIT'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-C" ]]; then
    shift 2
fi
if [[ "${FAKE_GIT_NOT_A_REPO:-0}" == "1" ]]; then
    echo "fatal: not a git repository (or any of the parent directories): .git" >&2
    exit 128
fi
case "${1:-} ${2:-}" in
    "rev-parse --git-dir")
        printf '%s\n' "${FAKE_GIT_DIR:-.git}"
        exit 0
        ;;
    "rev-parse --git-common-dir")
        printf '%s\n' "${FAKE_GIT_COMMON_DIR:-.git}"
        exit 0
        ;;
esac
echo "fake git: unexpected invocation: $*" >&2
exit 1
FAKE_GIT
chmod +x "$FAKE_BIN_DIR/git"

reset_fixture() {
    FAKE_STATE_DIR="$(mktemp -d)"
    FAKE_DOCKER_CALL_LOG="$(mktemp)"
    HOME="$(mktemp -d)"
    RUFLO_SEED_EXPECTED_DIGEST_FILE="$HOME/SEED-MANIFEST.sha256"
    printf '%s\n' "$(printf 'a%.0s' $(seq 1 64))" > "$RUFLO_SEED_EXPECTED_DIGEST_FILE"
    export FAKE_STATE_DIR FAKE_DOCKER_CALL_LOG HOME RUFLO_SEED_EXPECTED_DIGEST_FILE
    # H-3(b): every EXISTING arm below is exercising volume/store logic, not
    # the linked-worktree gate -- skip it unconditionally here so their
    # pass/fail never depends on whether THIS test file itself happens to be
    # running inside a real linked worktree. The two dedicated H-3(b) arms
    # near the end unset this to exercise the gate itself, via the fake git
    # stub above (never this test's own real git state).
    export RUFLO_UP_SKIP_WORKTREE_GATE=1
    unset FAKE_GIT_DIR FAKE_GIT_COMMON_DIR FAKE_GIT_NOT_A_REPO || true
    unset FAKE_CONTAINER_PROJECT FAKE_CONTAINER_WORKDIR FAKE_THIS_PROJECT || true
    unset FAKE_INSPECT_FAIL || true
    unset FAKE_SAMENAME_VOLUME || true
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

# SMI-5596 / SMI-6744: BSD stat (macOS) uses `-f FORMAT`; GNU stat (Linux, CI)
# uses `-c FORMAT` and `-f` means FILESYSTEM status. A naive
# `stat -f … || stat -c …` chain does not fall through cleanly on Linux --
# GNU prints the fs-status block to stdout and the `||` output is appended to
# it. Probe for GNU explicitly instead. Same shape as
# scripts/tests/create-worktree-hooks.test.sh's get_inode().
stat_mode() {
    if stat --version >/dev/null 2>&1; then
        stat -c '%a' "$1"
    else
        stat -f '%Lp' "$1"
    fi
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
    MODE="$(stat_mode "$HOME/.skillsmith/ruflo-store.json")"
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

# ---- Arm 10 (M-10): existing volume, label matches, BOTH stores already at
# the authority file's own generation -- the genuine steady state (the
# reconcile_store_pair (E,E) cell). Must be a pure no-op except for `up`: no
# volume create, no init for either file, logged as "both at generation",
# and the service brought up. ----
reset_fixture
setup_labelled_volume "matching-nonce-10" "gen-10-authority"
export FAKE_MEMORY_GENERATION="gen-10-authority"
export FAKE_AGENTDB_GENERATION="gen-10-authority"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "10-steady-state" "expected exit 0, got $EXIT_CODE"
elif grep -q "volume create" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "10-steady-state" "expected NO 'volume create' call, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif [[ -f "$FAKE_STATE_DIR/init-ran-memory.db" ]] || [[ -f "$FAKE_STATE_DIR/init-ran-agentdb-memory.db" ]]; then
    fail_case "10-steady-state" "expected NO init of either store file (both already at the expected generation)"
elif ! grep -qi "both at generation" "$SCRATCH_ROOT/out.log"; then
    fail_case "10-steady-state" "expected the log to say both stores are at generation, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif [[ ! -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "10-steady-state" "expected docker compose ... up -d ruflo to have executed"
else
    echo "applied=steady-state PASS (10-steady-state): both stores at the authority file's generation, no create, no init, up ran"
fi
unset FAKE_MEMORY_GENERATION FAKE_AGENTDB_GENERATION

# ---- Arm 11 (M-8): existing volume, label matches, agentdb-memory.db
# ALREADY carries the marker at the authority file's own generation, but
# memory.db has none -- the mirror of Arm 8 (the pre-A1.4 shape where
# memory.db was recreated by the sql.js writer). Must repair ONLY memory.db
# (agentdb-memory.db already correct, no need to re-init it), log it as a
# same-generation repair (not a wrong-generation refusal), then bring the
# service up. ----
reset_fixture
setup_labelled_volume "matching-nonce-11" "gen-11-authority"
export FAKE_AGENTDB_GENERATION="gen-11-authority"
# FAKE_MEMORY_GENERATION deliberately unset -- probe answers ABSENT.
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "11-memory-repair" "expected exit 0, got $EXIT_CODE"
elif grep -q "volume create" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "11-memory-repair" "expected NO 'volume create' call, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif [[ -f "$FAKE_STATE_DIR/init-ran-agentdb-memory.db" ]]; then
    fail_case "11-memory-repair" "expected NO re-init of agentdb-memory.db (it already carries the correct marker)"
elif [[ ! -f "$FAKE_STATE_DIR/init-ran-memory.db" ]]; then
    fail_case "11-memory-repair" "expected init_store() to repair memory.db"
elif ! grep -q "RUFLO_GENERATION_UUID=gen-11-authority" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "11-memory-repair" "expected the repair to use agentdb-memory.db's own (== authority file's) generation, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif ! grep -qi "same-generation repair\|NOT a wrong-generation hazard\|mirror of the pre-A1.4 shape" "$SCRATCH_ROOT/out.log"; then
    fail_case "11-memory-repair" "expected the log to distinguish this from a wrong-generation refusal, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif [[ ! -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "11-memory-repair" "expected docker compose ... up -d ruflo to have executed after the repair"
else
    echo "applied=memory-db-repair PASS (11-memory-repair): agentdb-memory.db already correct, memory.db repaired with the same generation, logged as a repair (not a refusal), up ran"
fi
unset FAKE_AGENTDB_GENERATION

# ---- Arm 12 (M-9): existing volume, label matches, BOTH stores carry the
# SAME generation as each other, but that generation is NOT the authority
# file's expected one -- the two stores agree with each other; it is the
# authority file that has moved. Must refuse WITHOUT the "DIFFERENT
# generations" text (the two stores do not disagree with each other), naming
# the authority file as the thing that moved instead. ----
reset_fixture
setup_labelled_volume "matching-nonce-12" "gen-12-authority-expected"
export FAKE_MEMORY_GENERATION="gen-12-stale-agreed"
export FAKE_AGENTDB_GENERATION="gen-12-stale-agreed"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "12-both-stale-agree" "expected non-zero exit (refusal), got 0"
elif grep -qi "DIFFERENT generations" "$SCRATCH_ROOT/out.log"; then
    fail_case "12-both-stale-agree" "expected the refusal NOT to use the 'DIFFERENT generations' text -- the two stores agree with EACH OTHER, only the authority file disagrees, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qi "authority file" "$SCRATCH_ROOT/out.log" || ! grep -qi "moved" "$SCRATCH_ROOT/out.log"; then
    fail_case "12-both-stale-agree" "expected the refusal to name the authority file as the thing that moved, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif [[ -f "$FAKE_STATE_DIR/init-ran" ]]; then
    fail_case "12-both-stale-agree" "expected NO init run when both stores agree but disagree with the authority file"
elif [[ -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "12-both-stale-agree" "expected docker compose ... up -d ruflo NOT to run on this refusal"
else
    echo "applied=refuse-both-stale-agree PASS (12-both-stale-agree): refused naming the authority file as having moved, no 'DIFFERENT generations' text, no init, no up"
fi
unset FAKE_MEMORY_GENERATION FAKE_AGENTDB_GENERATION

# ---- Arm 13 (H-3(b)): a LINKED-worktree-shaped checkout is refused before
# any docker call, naming the exact remediation `cd` command. Driven
# entirely by the fake git stub above -- never this test file's own real
# git state (which may itself be a linked worktree). ----
reset_fixture
unset RUFLO_UP_SKIP_WORKTREE_GATE
export FAKE_GIT_DIR="/fake/main-checkout/.git/worktrees/some-worktree"
export FAKE_GIT_COMMON_DIR="/fake/main-checkout/.git"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "13-worktree-refused" "expected non-zero exit (refusal), got 0, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF "LINKED git worktree" "$SCRATCH_ROOT/out.log"; then
    fail_case "13-worktree-refused" "expected the refusal to name the LINKED-worktree condition, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF '( cd "/fake/main-checkout" && ./scripts/ruflo-service-up.sh )' "$SCRATCH_ROOT/out.log"; then
    fail_case "13-worktree-refused" "expected the exact remediation cd command naming the main checkout, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif [[ -s "$FAKE_DOCKER_CALL_LOG" ]]; then
    fail_case "13-worktree-refused" "expected ZERO docker calls before this refusal, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
else
    echo "applied=worktree-gate-refuse PASS (13-worktree-refused): refused before any docker call, named the linked-worktree condition and the exact remediation cd command"
fi
unset FAKE_GIT_DIR FAKE_GIT_COMMON_DIR

# ---- Arm 14 (H-3(b)): a NON-worktree checkout (git-dir == git-common-dir,
# the plain-clone/main-checkout shape) passes the gate and proceeds through
# the normal fresh-creation flow end to end. ----
reset_fixture
unset RUFLO_UP_SKIP_WORKTREE_GATE
export FAKE_GIT_DIR="/fake/plain-checkout/.git"
export FAKE_GIT_COMMON_DIR="/fake/plain-checkout/.git"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "14-non-worktree-passes" "expected exit 0 (gate must not refuse a non-worktree checkout), got $EXIT_CODE, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif grep -qF "LINKED git worktree" "$SCRATCH_ROOT/out.log"; then
    fail_case "14-non-worktree-passes" "expected NO linked-worktree refusal text, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif [[ ! -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "14-non-worktree-passes" "expected the normal fresh-creation flow to complete (docker compose ... up -d ruflo), log:\n$(cat "$SCRATCH_ROOT/out.log")"
else
    echo "applied=worktree-gate-pass PASS (14-non-worktree-passes): git-dir == git-common-dir passed the gate, ordinary fresh-creation flow completed"
fi
unset FAKE_GIT_DIR FAKE_GIT_COMMON_DIR

# ---- Arm 15 (H-3(c)): an existing skillsmith-ruflo-1 container that
# belongs to a DIFFERENT Compose project is refused before any
# volume/store bookkeeping runs, naming the foreign project, its
# working_dir, and the exact remediation for both the
# checkout-still-exists and checkout-gone sub-cases. ----
reset_fixture
export FAKE_THIS_PROJECT="this-checkout-project"
export FAKE_CONTAINER_PROJECT="foreign-checkout-project"
export FAKE_CONTAINER_WORKDIR="$FAKE_STATE_DIR"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "15a-foreign-project-exists" "expected non-zero exit (refusal), got 0, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF "foreign-checkout-project" "$SCRATCH_ROOT/out.log" || ! grep -qF "$FAKE_STATE_DIR" "$SCRATCH_ROOT/out.log"; then
    fail_case "15a-foreign-project-exists" "expected the refusal to name the foreign project and its working_dir, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF "docker compose --profile ruflo down ruflo" "$SCRATCH_ROOT/out.log"; then
    fail_case "15a-foreign-project-exists" "expected the checkout-still-exists remediation (docker compose --profile ruflo down ruflo, scoped to the ruflo service, from ITS OWN project -- L-A), log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif grep -qF "volume create" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "15a-foreign-project-exists" "expected NO volume/store bookkeeping before this refusal, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
else
    echo "applied=foreign-project-refuse-exists PASS (15a-foreign-project-exists): refused naming the foreign project and its (still-existing) working_dir, with the docker compose down remediation"
fi

reset_fixture
export FAKE_THIS_PROJECT="this-checkout-project"
export FAKE_CONTAINER_PROJECT="foreign-checkout-project"
export FAKE_CONTAINER_WORKDIR="/fake/long-gone-worktree"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "15b-foreign-project-gone" "expected non-zero exit (refusal), got 0, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF "docker stop skillsmith-ruflo-1 && docker rm skillsmith-ruflo-1" "$SCRATCH_ROOT/out.log"; then
    fail_case "15b-foreign-project-gone" "expected the checkout-gone remediation (stop then rm, never rm -f a running container), log:\n$(cat "$SCRATCH_ROOT/out.log")"
else
    echo "applied=foreign-project-refuse-gone PASS (15b-foreign-project-gone): refused with the stop-then-rm remediation when the foreign checkout's working_dir no longer exists"
fi
unset FAKE_THIS_PROJECT FAKE_CONTAINER_PROJECT FAKE_CONTAINER_WORKDIR

# ---- 15c: the container exists but its project label reads back EMPTY --
# must be refused (fail closed), never treated as "no foreign project"
# (cross-family gate round 1 on PR #2934, Medium: PR-16 named the mutation
# "label read returns empty" and arms 15a/15b did not kill it).
reset_fixture
export FAKE_THIS_PROJECT="this-checkout-project"
export FAKE_CONTAINER_PROJECT="exists-but-unlabelled"
export FAKE_CONTAINER_LABEL_EMPTY=1
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "15c-foreign-project-label-empty" "expected non-zero exit (refusal), got 0, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF "project label could not be read" "$SCRATCH_ROOT/out.log"; then
    fail_case "15c-foreign-project-label-empty" "expected the refusal to say the label could not be read, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif grep -qE "volume (create|inspect)" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "15c-foreign-project-label-empty" "expected NO volume/store bookkeeping before this refusal, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
else
    echo "applied=foreign-project-refuse-unlabelled PASS (15c-foreign-project-label-empty): refused when the existing container's project label read back empty, before any bookkeeping"
fi
unset FAKE_THIS_PROJECT FAKE_CONTAINER_PROJECT FAKE_CONTAINER_LABEL_EMPTY

# ---- 15d (F-7, SMI-6744 A1.8 retro round 2): the container exists but its
# project label reads back the literal Docker template string "<no value>"
# (not an empty string) -- must be refused the SAME way as an empty read
# (15c above), never treated as "no foreign project". Docker's own --format
# engine prints this literal for a missing map key (measured live); a bare
# `[[ -z "$container_project" ]]` check does not catch it.
reset_fixture
export FAKE_THIS_PROJECT="this-checkout-project"
export FAKE_CONTAINER_PROJECT="exists-but-novalue"
export FAKE_CONTAINER_LABEL_NOVALUE=1
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "15d-foreign-project-label-novalue" "expected non-zero exit (refusal), got 0, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF "project label could not be read" "$SCRATCH_ROOT/out.log"; then
    fail_case "15d-foreign-project-label-novalue" "expected the refusal to say the label could not be read, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif grep -qE "volume (create|inspect)" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "15d-foreign-project-label-novalue" "expected NO volume/store bookkeeping before this refusal, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
else
    echo "applied=foreign-project-refuse-novalue PASS (15d-foreign-project-label-novalue): refused when the existing container's project label read back the literal '<no value>', before any bookkeeping"
fi
unset FAKE_THIS_PROJECT FAKE_CONTAINER_PROJECT FAKE_CONTAINER_LABEL_NOVALUE

# ---- 15e (SMI-6846, High, PR #2937 post-merge retro): `docker inspect`
# fails for a reason OTHER than a confirmed "No such container" (daemon
# unreachable, a permission error, an older CLI, a context switch) -- must
# be refused (fail closed), never treated as "container absent, no foreign
# project" (the identical fail-open shape the cross-family gate round 1 on
# PR #2937 already closed in probe_container_owner() itself, further down
# in scripts/ruflo-service-up.helpers.sh). Before the SMI-6846 fix,
# check_foreign_project()'s own bare `docker inspect ... || return 0`
# mapped this SAME daemon-unreachable failure to "return 0" and let `up`
# proceed straight into its volume/authority-file bookkeeping.
reset_fixture
export FAKE_INSPECT_FAIL="daemon"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "15e-inspect-fails-unattributable" "expected non-zero exit (refusal), got 0, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF "refusing to assume there is no foreign-project collision" "$SCRATCH_ROOT/out.log"; then
    fail_case "15e-inspect-fails-unattributable" "expected the SMI-6846 refusal text, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF "probe_container_owner: docker inspect of skillsmith-ruflo-1 failed" "$SCRATCH_ROOT/out.log"; then
    fail_case "15e-inspect-fails-unattributable" "expected the probe's own diagnostic line, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif grep -qE "volume (create|inspect)" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "15e-inspect-fails-unattributable" "expected NO volume/store bookkeeping before this refusal, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif [[ -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "15e-inspect-fails-unattributable" "expected NO 'docker compose ... up' before this refusal (up-ran marker should not exist)"
elif [[ -f "$HOME/.skillsmith/ruflo-store.json" ]]; then
    fail_case "15e-inspect-fails-unattributable" "expected NO authority file to be written before this refusal"
else
    echo "applied=foreign-project-refuse-inspect-unattributable PASS (15e-inspect-fails-unattributable): refused when docker inspect failed for a reason other than a confirmed 'No such container', before any bookkeeping"
fi
unset FAKE_INSPECT_FAIL

# ---- 15f (F-1, SMI-6846 governance retro, Medium): the container exists,
# belongs to a DIFFERENT project, but the SEPARATE working_dir read itself
# fails (daemon blip, permission error, or the container replaced between
# the two probe calls) -- the same definite-state-from-an-undetermined-probe
# shape check_foreign_project()'s EXISTENCE probe was fixed for (SMI-6846).
# A failed read must be refused as "could not be read", never silently
# treated as "the working_dir no longer exists" (15b's own genuine-gone
# case). Ordered so the "no bookkeeping" check comes before either text
# check -- it holds under BOTH the old and new code, so it cannot be what
# distinguishes them; the RED run before F-1's code fix landed failed at the
# "must NOT assert gone" check (position 3), never reaching "could NOT be
# read" (position 4), because the pre-fix code's `-d ""` branch dies with
# "no longer exists on this machine" first.
reset_fixture
export FAKE_THIS_PROJECT="this-checkout-project" FAKE_CONTAINER_PROJECT="foreign-checkout-project" FAKE_INSPECT_FAIL="workdir"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -eq 0 ]]; then
    fail_case "15f-workdir-unreadable" "expected non-zero exit (refusal), got 0, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif grep -qE "volume (create|inspect)" "$FAKE_DOCKER_CALL_LOG"; then
    fail_case "15f-workdir-unreadable" "expected NO volume/store bookkeeping before this refusal, log:\n$(cat "$FAKE_DOCKER_CALL_LOG")"
elif grep -qF "no longer exists on this machine" "$SCRATCH_ROOT/out.log"; then
    fail_case "15f-workdir-unreadable" "must NOT assert the working_dir is gone when the read itself failed, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif ! grep -qF "working_dir could NOT be read" "$SCRATCH_ROOT/out.log"; then
    fail_case "15f-workdir-unreadable" "expected the refusal to say the working_dir could NOT be read, log:\n$(cat "$SCRATCH_ROOT/out.log")"
else
    echo "applied=foreign-project-refuse-workdir-unreadable PASS (15f-workdir-unreadable): refused naming that the working_dir could not be read, without asserting it is gone, and before any bookkeeping"
fi
unset FAKE_THIS_PROJECT FAKE_CONTAINER_PROJECT FAKE_INSPECT_FAIL

# ---- 15g (F-6, SMI-6846 governance retro, Low): the guard's own POSITIVE
# path -- an existing skillsmith-ruflo-1 container that belongs to THIS
# SAME checkout's project must proceed straight through to the normal
# fresh-creation flow, never refused. Every other 15* arm exercises a
# refusal; this is the only one exercising the non-refusing branch of the
# `container_project != this_project` guard.
reset_fixture
export FAKE_THIS_PROJECT="same-project" FAKE_CONTAINER_PROJECT="same-project" FAKE_CONTAINER_WORKDIR="$FAKE_STATE_DIR"
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "15g-own-container-proceeds" "expected exit 0 (same project, no foreign-project refusal), got $EXIT_CODE, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif [[ ! -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "15g-own-container-proceeds" "expected the normal fresh-creation flow to complete (docker compose ... up -d ruflo), log:\n$(cat "$SCRATCH_ROOT/out.log")"
else
    echo "applied=own-project-proceeds PASS (15g-own-container-proceeds): a same-project existing container is not refused, ordinary flow completed"
fi
unset FAKE_THIS_PROJECT FAKE_CONTAINER_PROJECT FAKE_CONTAINER_WORKDIR

# ---- 15h (F-5, SMI-6846 governance retro, Low): a VOLUME named
# skillsmith-ruflo-1 exists but no CONTAINER does -- probe_container_owner()
# pins `--type container` at the probe, so this must read as ABSENT (proceed
# with the normal fresh-creation flow), never as an existing container to
# attribute or refuse.
reset_fixture
export FAKE_SAMENAME_VOLUME=1
EXIT_CODE="$(run_script)"
if [[ "$EXIT_CODE" -ne 0 ]]; then
    fail_case "15h-samename-volume-not-container" "expected exit 0 (a same-named volume is not a container collision), got $EXIT_CODE, log:\n$(cat "$SCRATCH_ROOT/out.log")"
elif [[ ! -f "$FAKE_STATE_DIR/up-ran" ]]; then
    fail_case "15h-samename-volume-not-container" "expected the normal fresh-creation flow to complete (docker compose ... up -d ruflo), log:\n$(cat "$SCRATCH_ROOT/out.log")"
else
    echo "applied=samename-volume-proceeds PASS (15h-samename-volume-not-container): a same-named volume (not a container) does not trip the foreign-project guard, ordinary flow completed"
fi
unset FAKE_SAMENAME_VOLUME

# ---- Arm 16 (S-1, SMI-6744 A1.8 retro): federation_restore_disposition()
# (scripts/ruflo-service-up.helpers.sh) is a PURE function -- source the
# helpers directly into THIS shell and call it, no docker/git and no
# run_script() subprocess involved. Covers all four dispositions: absent,
# refuse-unattributable (the S-1 defect: an EMPTY owner used to fall through
# to `docker rm -f` in scripts/ruflo-federation-test.sh's old inline check),
# refuse-third, and proceed (checked against BOTH p1 and p2, since the
# disposition is "owner == p1 OR owner == p2").
# shellcheck source=../ruflo-service-up.helpers.sh
source "$REPO_ROOT/scripts/ruflo-service-up.helpers.sh"

DISPOSITION="$(federation_restore_disposition 0 "" "p1-project" "p2-project")"
if [[ "$DISPOSITION" != "absent" ]]; then
    fail_case "16a-disposition-absent" "expected 'absent' when exists=0 (owner/p1/p2 irrelevant), got '$DISPOSITION'"
else
    echo "applied=disposition-absent PASS (16a-disposition-absent): exists=0 -> absent"
fi

DISPOSITION="$(federation_restore_disposition 1 "" "p1-project" "p2-project")"
if [[ "$DISPOSITION" != "refuse-unattributable" ]]; then
    fail_case "16b-disposition-unattributable" "expected 'refuse-unattributable' when exists=1 and owner is EMPTY (the S-1 fall-through defect), got '$DISPOSITION'"
else
    echo "applied=disposition-unattributable PASS (16b-disposition-unattributable): exists=1, owner='' -> refuse-unattributable"
fi

DISPOSITION="$(federation_restore_disposition 1 "third-project" "p1-project" "p2-project")"
if [[ "$DISPOSITION" != "refuse-third" ]]; then
    fail_case "16c-disposition-third" "expected 'refuse-third' when owner is neither p1 nor p2, got '$DISPOSITION'"
else
    echo "applied=disposition-third PASS (16c-disposition-third): exists=1, owner=third-project -> refuse-third"
fi

DISPOSITION="$(federation_restore_disposition 1 "p1-project" "p1-project" "p2-project")"
if [[ "$DISPOSITION" != "proceed" ]]; then
    fail_case "16d-disposition-proceed-p1" "expected 'proceed' when owner == p1, got '$DISPOSITION'"
else
    echo "applied=disposition-proceed-p1 PASS (16d-disposition-proceed-p1): exists=1, owner==p1 -> proceed"
fi

DISPOSITION="$(federation_restore_disposition 1 "p2-project" "p1-project" "p2-project")"
if [[ "$DISPOSITION" != "proceed" ]]; then
    fail_case "16e-disposition-proceed-p2" "expected 'proceed' when owner == p2, got '$DISPOSITION'"
else
    echo "applied=disposition-proceed-p2 PASS (16e-disposition-proceed-p2): exists=1, owner==p2 -> proceed"
fi

# ---- 16f (F-6, SMI-6744 A1.8 retro round 2): an unrecognized/malformed
# <exists> value (neither the literal "0" nor "1") must fail CLOSED to
# refuse-unattributable, not fall through to the PERMISSIVE "absent" branch
# the original `[[ "$exists" -ne 1 ]]` arithmetic compare produced for "",
# "abc", or "2" (measured live in bash: none of those error the compare,
# they just read as "not 1" and land on "absent").
DISPOSITION="$(federation_restore_disposition "" "some-owner" "p1-project" "p2-project")"
if [[ "$DISPOSITION" != "refuse-unattributable" ]]; then
    fail_case "16f-disposition-unknown-exists" "expected 'refuse-unattributable' when exists is an unrecognized/malformed value (neither '0' nor '1'), got '$DISPOSITION'"
else
    echo "applied=disposition-unknown-exists PASS (16f-disposition-unknown-exists): exists='' (neither 0 nor 1) -> refuse-unattributable, not absent"
fi

# ---- 16g (F-7, SMI-6744 A1.8 retro round 2): owner==\"<no value>\" (Docker's
# own --format template-engine string for a missing map key, distinct from a
# genuinely empty string) must be treated the same as an empty owner.
DISPOSITION="$(federation_restore_disposition 1 "<no value>" "p1-project" "p2-project")"
if [[ "$DISPOSITION" != "refuse-unattributable" ]]; then
    fail_case "16g-disposition-owner-novalue" "expected 'refuse-unattributable' when owner is the literal '<no value>', got '$DISPOSITION'"
else
    echo "applied=disposition-owner-novalue PASS (16g-disposition-owner-novalue): exists=1, owner='<no value>' -> refuse-unattributable"
fi

# ---- Arm 18 (F-2, SMI-6744 A1.8 retro round 2): a decoy executable named
# `log` on PATH must not defeat the log()/die() fallback in
# scripts/ruflo-service-up.helpers.sh. `command -v log` returns 0 for ANY
# `log` on PATH, whether it is a shell function or an external binary
# (macOS ships /usr/bin/log, the unified-logging CLI, confirmed present on
# this host) -- the ORIGINAL predicate silently skipped defining log()
# whenever such a binary existed. The fixed predicate uses `declare -F`,
# which tests only for a shell FUNCTION. Exercised in an ISOLATED bash
# subprocess (never this test file's own already-sourced helpers, which
# were sourced before this arm ever runs) with a decoy `log` executable
# prepended to PATH.
DECOY_LOG_DIR="$SCRATCH_ROOT/decoy-log-bin"
mkdir -p "$DECOY_LOG_DIR"
cat > "$DECOY_LOG_DIR/log" << 'DECOY_LOG'
#!/usr/bin/env bash
exit 64
DECOY_LOG
chmod +x "$DECOY_LOG_DIR/log"
ARM18_OUT="$(PATH="$DECOY_LOG_DIR:$PATH" bash -c '
    set -euo pipefail
    source "'"$REPO_ROOT"'/scripts/ruflo-service-up.helpers.sh"
    declare -F log >/dev/null 2>&1 && echo "log_is_function=yes" || echo "log_is_function=no"
    declare -F die >/dev/null 2>&1 && echo "die_is_function=yes" || echo "die_is_function=no"
')"
if ! grep -q "log_is_function=yes" <<<"$ARM18_OUT" || ! grep -q "die_is_function=yes" <<<"$ARM18_OUT"; then
    fail_case "18-log-fallback-decoy-on-path" "expected BOTH log() and die() to be installed as shell functions even with a decoy 'log' executable on PATH, got:\n$ARM18_OUT"
else
    echo "applied=log-fallback-survives-decoy PASS (18-log-fallback-decoy-on-path): log() and die() both installed as shell functions despite a decoy 'log' executable earlier on PATH"
fi

# ---- Arm 17 (S-2, SMI-6744 A1.8 retro): git_dir_equals_common_dir()
# (sourced above alongside federation_restore_disposition()) exercised
# against the REAL git binary ($REAL_GIT, resolved at the top of this file)
# -- not this file's own fake git stub, which cannot reproduce real git's
# environment-variable resolution behavior. An inherited GIT_DIR in the
# environment previously made `git -C <dir> rev-parse --git-dir` answer for
# the EXPORTED dir instead of resolving from <dir> itself, so the gate
# WRONGLY PASSED (returned 0, "not a linked worktree") on a genuinely linked
# worktree whenever GIT_DIR happened to be set (measured with git 2.50.0).
# Three assertions: the control with no GIT_DIR exported (main -> 0,
# worktree -> 1), then the same worktree check WITH an inherited GIT_DIR
# pointing at the main repo's .git (must still be 1 -- the env -u prefix
# must neutralize it).
#
# F-3 (SMI-6744 A1.8 retro round 2): the fixture below is built under
# $SCRATCH_ROOT/arm17 (cleaned up by this file's own EXIT trap, unlike the
# ORIGINAL shape's dedicated `mktemp -d` that only a manual `rm -rf` at the
# end cleaned -- a leak if anything between creation and that line aborted
# under `set -e`), and its setup is now guarded behind `if !` with combined
# output captured to a log file instead of a bare compound command with both
# streams discarded to /dev/null: the ORIGINAL shape, if `git init`/`commit`/
# `worktree add` ever failed, aborted this ENTIRE test file under `set -e`
# with NO verdict printed for Arm 17 or anything after it, and no diagnostic
# (both streams were discarded). This FAILs loudly instead, naming the setup
# log, and skips 17a/17b/17c (their inputs would be meaningless without a
# working fixture) rather than aborting the suite.
ARM17_ROOT="$SCRATCH_ROOT/arm17"
mkdir -p "$ARM17_ROOT"
MAIN_REPO="$ARM17_ROOT/main"
LINKED_WORKTREE="$ARM17_ROOT/linked"

if ! (
    cd "$ARM17_ROOT" &&
        "$REAL_GIT" init -q main &&
        cd main &&
        "$REAL_GIT" -c user.email=test@example.com -c user.name=test commit -q --allow-empty -m init &&
        "$REAL_GIT" worktree add -q "../linked" -b arm17-linked
) >"$SCRATCH_ROOT/arm17-setup.log" 2>&1; then
    fail_case "17-setup" "failed to build the real-git worktree fixture under $ARM17_ROOT (REAL_GIT='$REAL_GIT') -- 17a/17b/17c skipped, log:\n$(cat "$SCRATCH_ROOT/arm17-setup.log")"
else
    echo "applied=arm17-fixture-built PASS (17-setup): real-git worktree fixture built under $ARM17_ROOT"
    unset GIT_DIR
    git_dir_equals_common_dir "$MAIN_REPO" && ARM17_CONTROL_MAIN=0 || ARM17_CONTROL_MAIN=1
    git_dir_equals_common_dir "$LINKED_WORKTREE" && ARM17_CONTROL_WORKTREE=0 || ARM17_CONTROL_WORKTREE=1
    export GIT_DIR="$MAIN_REPO/.git"
    git_dir_equals_common_dir "$LINKED_WORKTREE" && ARM17_INHERITED_GITDIR=0 || ARM17_INHERITED_GITDIR=1
    unset GIT_DIR

    # F-11 (SMI-6744 A1.8 retro round 2): three INDEPENDENT `if` blocks, not
    # an `elif` chain -- the ORIGINAL elif chain masked the S-2 regression
    # assertion (17c-inherited-gitdir, the actual GIT_DIR-leak fix this arm
    # exists to pin) whenever an EARLIER branch (17a/17b) also failed: only
    # the FIRST failing branch in an elif chain ever prints, so a control
    # regression could silently hide the S-2 regression sitting right behind
    # it. Each of the three now reports its own PASS/FAIL independently.
    if [[ "$ARM17_CONTROL_MAIN" -ne 0 ]]; then
        echo "FAIL (17a-control-main): expected git_dir_equals_common_dir(main) == 0 (pass) with no GIT_DIR exported, got $ARM17_CONTROL_MAIN" >&2
        FAIL_COUNT=$((FAIL_COUNT + 1))
    else
        echo "applied=control-main PASS (17a-control-main): git_dir_equals_common_dir(main) == 0 with no GIT_DIR exported"
    fi

    if [[ "$ARM17_CONTROL_WORKTREE" -ne 1 ]]; then
        echo "FAIL (17b-control-worktree): expected git_dir_equals_common_dir(linked worktree) == 1 (refuse) with no GIT_DIR exported, got $ARM17_CONTROL_WORKTREE" >&2
        FAIL_COUNT=$((FAIL_COUNT + 1))
    else
        echo "applied=control-worktree PASS (17b-control-worktree): git_dir_equals_common_dir(linked worktree) == 1 with no GIT_DIR exported"
    fi

    if [[ "$ARM17_INHERITED_GITDIR" -ne 1 ]]; then
        echo "FAIL (17c-inherited-gitdir): expected git_dir_equals_common_dir(linked worktree) == 1 (refuse) even with an inherited GIT_DIR=<main>/.git -- the env -u prefix must neutralize it, got $ARM17_INHERITED_GITDIR" >&2
        FAIL_COUNT=$((FAIL_COUNT + 1))
    else
        echo "applied=env-u-neutralizes-inherited-gitdir PASS (17c-inherited-gitdir): real git (not the fake stub) -- with an inherited GIT_DIR pointing at main's .git, the linked worktree is still correctly refused (1)"
    fi
fi

# ---- Arms 19a-19e (probe_container_owner(), SMI-6744 A1.8 cross-family gate
# round-1 fix on PR #2937, High, class 1): classify the SAME one-call
# docker-inspect shape federation_restore_checkout_1() drives. Each arm runs
# in its OWN subshell with PATH="$FAKE_BIN_DIR:$PATH" and a fresh
# FAKE_DOCKER_CALL_LOG exported only inside that subshell -- consistent with
# this file's own stated convention (Arm 17's setup comment) that PATH is
# never globally prefixed with FAKE_BIN_DIR here -- so nothing this helper
# exports can leak into a later arm.
run_probe_arm() {
    local inspect_fail="$1" container_project="$2"
    (
        PATH="$FAKE_BIN_DIR:$PATH"
        FAKE_DOCKER_CALL_LOG="$(mktemp "$SCRATCH_ROOT/probe-call-log.XXXXXX")"
        FAKE_INSPECT_FAIL="$inspect_fail"
        FAKE_CONTAINER_PROJECT="$container_project"
        export PATH FAKE_DOCKER_CALL_LOG FAKE_INSPECT_FAIL FAKE_CONTAINER_PROJECT
        # shellcheck source=../ruflo-service-up.helpers.sh
        source "$REPO_ROOT/scripts/ruflo-service-up.helpers.sh"
        EX=""
        OW=""
        probe_container_owner skillsmith-ruflo-1 EX OW
        echo "exists=$EX owner=$OW"
    )
}

PROBE_19A_OUT="$(run_probe_arm nosuch "" 2>"$SCRATCH_ROOT/probe-19a.err")"
if [[ "$PROBE_19A_OUT" != "exists=0 owner=" ]]; then
    fail_case "19a-probe-nosuch" "expected 'exists=0 owner=', got '$PROBE_19A_OUT', stderr:\n$(cat "$SCRATCH_ROOT/probe-19a.err")"
else
    echo "applied=probe-nosuch PASS (19a-probe-nosuch): docker inspect 'No such container' (exit 1) -> exists=0 owner='' (positively established absence)"
fi

PROBE_19B_OUT="$(run_probe_arm nosuch-object "" 2>"$SCRATCH_ROOT/probe-19b.err")"
if [[ "$PROBE_19B_OUT" != "exists=0 owner=" ]]; then
    fail_case "19b-probe-nosuch-object" "expected 'exists=0 owner=', got '$PROBE_19B_OUT', stderr:\n$(cat "$SCRATCH_ROOT/probe-19b.err")"
else
    echo "applied=probe-nosuch-object PASS (19b-probe-nosuch-object): older-CLI 'No such object' wording (exit 1) -> exists=0 owner='' too (case-insensitive, either noun)"
fi

PROBE_19C_OUT="$(run_probe_arm daemon "" 2>"$SCRATCH_ROOT/probe-19c.err")"
PROBE_19C_ERR="$(cat "$SCRATCH_ROOT/probe-19c.err")"
if [[ "$PROBE_19C_OUT" != "exists= owner=" ]]; then
    fail_case "19c-probe-daemon-down" "expected 'exists= owner=' (unknown, not absence), got '$PROBE_19C_OUT', stderr:\n$PROBE_19C_ERR"
elif ! grep -qF "probe_container_owner: docker inspect of skillsmith-ruflo-1 failed" <<<"$PROBE_19C_ERR"; then
    fail_case "19c-probe-daemon-down" "expected a diagnostic line on stderr naming the failed inspect, got:\n$PROBE_19C_ERR"
else
    DISPOSITION_19C="$(federation_restore_disposition "" "" "p1-project" "p2-project")"
    if [[ "$DISPOSITION_19C" != "refuse-unattributable" ]]; then
        fail_case "19c-probe-daemon-down" "expected the composed disposition for exists='' owner='' to be refuse-unattributable, got '$DISPOSITION_19C'"
    else
        echo "applied=probe-daemon-down PASS (19c-probe-daemon-down): daemon-unreachable (exit 1, the SAME exit code as absent) -> exists='' (unknown, NOT absence), a diagnostic on stderr, and the composed disposition is refuse-unattributable -- this is the exact gate finding"
    fi
fi

PROBE_19D_OUT="$(run_probe_arm flag "" 2>"$SCRATCH_ROOT/probe-19d.err")"
if [[ "$PROBE_19D_OUT" != "exists= owner=" ]]; then
    fail_case "19d-probe-unknown-flag" "expected 'exists= owner=' (unknown, not absence), got '$PROBE_19D_OUT', stderr:\n$(cat "$SCRATCH_ROOT/probe-19d.err")"
else
    echo "applied=probe-unknown-flag PASS (19d-probe-unknown-flag): an older CLI rejecting --type (exit 125, 'unknown flag: --type') -> exists='' (unknown, not absence)"
fi

PROBE_19E_OUT="$(run_probe_arm "" "owner-x" 2>"$SCRATCH_ROOT/probe-19e.err")"
if [[ "$PROBE_19E_OUT" != "exists=1 owner=owner-x" ]]; then
    fail_case "19e-probe-control-present" "expected 'exists=1 owner=owner-x' (control), got '$PROBE_19E_OUT', stderr:\n$(cat "$SCRATCH_ROOT/probe-19e.err")"
else
    echo "applied=probe-control-present PASS (19e-probe-control-present): container present with a readable label -> exists=1 owner=owner-x, unaffected by the new classifier"
fi

# ---- Arms 20a-20c (federation_restore_checkout_1(), end to end): drive the
# WHOLE restore path -- probe, disposition, and the rm/up decision -- with a
# fake checkout-1 ruflo-service-up.sh stub standing in for the real one.
ARM20_ROOT="$SCRATCH_ROOT/arm20"
ARM20_CHECKOUT1="$ARM20_ROOT/checkout1"
mkdir -p "$ARM20_CHECKOUT1/scripts"
cat > "$ARM20_CHECKOUT1/scripts/ruflo-service-up.sh" << ARM20_STUB
#!/usr/bin/env bash
touch "$ARM20_ROOT/up-ran"
exit 0
ARM20_STUB
chmod +x "$ARM20_CHECKOUT1/scripts/ruflo-service-up.sh"

run_restore_arm() {
    local inspect_fail="$1" service_touched="$2" call_log="$3"
    (
        PATH="$FAKE_BIN_DIR:$PATH"
        FAKE_DOCKER_CALL_LOG="$call_log"
        FAKE_INSPECT_FAIL="$inspect_fail"
        export PATH FAKE_DOCKER_CALL_LOG FAKE_INSPECT_FAIL
        # shellcheck source=../ruflo-service-up.helpers.sh
        source "$REPO_ROOT/scripts/ruflo-service-up.helpers.sh"
        federation_restore_checkout_1 skillsmith-ruflo-1 p1-project p2-project "$ARM20_CHECKOUT1" "$service_touched"
        echo "rc=$?"
    )
}

# 20a (the gate's own requested arm): inspect fails because the DAEMON is
# unreachable -- must NOT be read as absence. No rm, no re-up, refused on
# stderr.
rm -f "$ARM20_ROOT/up-ran"
ARM20A_LOG="$(mktemp "$SCRATCH_ROOT/arm20a-call-log.XXXXXX")"
ARM20A_OUT="$(run_restore_arm daemon 1 "$ARM20A_LOG" 2>"$SCRATCH_ROOT/arm20a.err")"
if grep -qF "docker rm" "$ARM20A_LOG"; then
    fail_case "20a-restore-daemon-down-no-rm" "expected NO 'docker rm' call when the inspect could not be classified, log:\n$(cat "$ARM20A_LOG")"
elif [[ -e "$ARM20_ROOT/up-ran" ]]; then
    fail_case "20a-restore-daemon-down-no-rm" "expected NO re-up when the disposition refused, but the up-ran marker exists"
elif ! grep -qF "refusing to rm -f" "$SCRATCH_ROOT/arm20a.err"; then
    fail_case "20a-restore-daemon-down-no-rm" "expected 'refusing to rm -f' on stderr, got:\n$(cat "$SCRATCH_ROOT/arm20a.err")"
elif ! grep -q "^rc=0$" <<<"$ARM20A_OUT"; then
    fail_case "20a-restore-daemon-down-no-rm" "expected federation_restore_checkout_1 to return 0, got:\n$ARM20A_OUT"
else
    echo "applied=restore-daemon-down-no-rm PASS (20a-restore-daemon-down-no-rm): a daemon-unreachable inspect (exit 1, the SAME code as absent) is classified as unknown, not absence -- no rm -f, no re-up, refused on stderr (the exact gate finding, PR #2937 round 1 class 1)"
fi

# 20b: known-positive control for the SAME instrument -- a confirmed 'No
# such container' inspect DOES rm -f and re-up, so 20a's own absence
# assertions are not vacuously true.
rm -f "$ARM20_ROOT/up-ran"
ARM20B_LOG="$(mktemp "$SCRATCH_ROOT/arm20b-call-log.XXXXXX")"
ARM20B_OUT="$(run_restore_arm nosuch 1 "$ARM20B_LOG" 2>"$SCRATCH_ROOT/arm20b.err")"
if ! grep -qF "docker rm -f skillsmith-ruflo-1" "$ARM20B_LOG"; then
    fail_case "20b-restore-nosuch-control" "expected a 'docker rm -f skillsmith-ruflo-1' call for a confirmed-absent container, log:\n$(cat "$ARM20B_LOG")"
elif [[ ! -e "$ARM20_ROOT/up-ran" ]]; then
    fail_case "20b-restore-nosuch-control" "expected the re-up stub to run (up-ran marker), but it did not; stderr:\n$(cat "$SCRATCH_ROOT/arm20b.err")"
elif ! grep -q "^rc=0$" <<<"$ARM20B_OUT"; then
    fail_case "20b-restore-nosuch-control" "expected federation_restore_checkout_1 to return 0, got:\n$ARM20B_OUT"
else
    echo "applied=restore-nosuch-control PASS (20b-restore-nosuch-control): known-positive control -- a confirmed 'No such container' inspect (exists=0, absent) DOES rm -f and re-up, proving 20a's absence assertions can see a removal when one actually happens"
fi

# 20c: the never-touched gate returns before ANY probing -- no inspect call,
# no rm, no up, regardless of what the inspect would have returned.
rm -f "$ARM20_ROOT/up-ran"
ARM20C_LOG="$(mktemp "$SCRATCH_ROOT/arm20c-call-log.XXXXXX")"
run_restore_arm daemon 0 "$ARM20C_LOG" >/dev/null 2>"$SCRATCH_ROOT/arm20c.err"
if [[ -s "$ARM20C_LOG" ]]; then
    fail_case "20c-restore-never-touched" "expected ZERO docker calls (inspect/rm/up) when service_touched=0, log:\n$(cat "$ARM20C_LOG")"
elif [[ -e "$ARM20_ROOT/up-ran" ]]; then
    fail_case "20c-restore-never-touched" "expected NO re-up when service_touched=0, but the up-ran marker exists"
else
    echo "applied=restore-never-touched PASS (20c-restore-never-touched): the never-touched gate returns before any probing, rm, or re-up"
fi

# SMI-6744 A1.8 retro round 2 tally: 14 (arms 1-14) + 8 (15a-15h, SMI-6846
# adds 15e; the SMI-6846 governance retro's F-1/F-6/F-5 fixes add
# 15f/15g/15h) + 7 (16a-16g, F-6 adds 16f, F-7 adds 16g) + 1 (17-setup, F-3)
# + 1 (Arm 18, F-2's decoy-log-on-PATH arm) + 3 (17a/17b/17c, F-11 splits the
# former single combined "17" check into three independently-reported
# assertions) + 5 (19a-19e, probe_container_owner() classification arms,
# SMI-6744 A1.8 cross-family gate round-1 fix on PR #2937 class 1) + 3
# (20a-20c, federation_restore_checkout_1() end-to-end arms, same fix) = 42.
# SMI-6846 governance retro F-3 (Medium): verify this arithmetic against the
# actual fail_case/FAIL labels in this file (not just this comment) with a
# reproducible command instead of citing an uncommitted scratchpad artifact
# (a prior version of this comment cited gate-r1-fix/summary-tally.txt,
# which proved 38 for an earlier arm count and cannot be re-run by a later
# reader). The `grep -v '^[[:space:]]*#'` strips comment lines FIRST --
# without it, this very documentation line's own literal text (a quoted
# 'fail_case "[^"]+"' example) self-matches the pattern it is illustrating,
# overcounting by one (measured live: 40 instead of 39):
#   expr $(grep -v '^[[:space:]]*#' "$0" | grep -oE 'fail_case "[^"]+"' | sort -u | wc -l) + \
#        $(grep -v '^[[:space:]]*#' "$0" | grep -oE 'FAIL \([^)$][^)]*\)' | sort -u | wc -l)
# 39 fail_case labels (36 before the SMI-6846 governance round added 15f/15g/15h) + 3
# (17a/17b/17c, which report via a direct FAIL, not fail_case) = 42.
echo ""
if [[ "$FAIL_COUNT" -eq 0 ]]; then
    echo "SUMMARY: 42/42 arms passed"
    exit 0
else
    echo "SUMMARY: $FAIL_COUNT/42 arms FAILED"
    exit 1
fi
