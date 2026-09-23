#!/usr/bin/env bash
# scripts/ruflo-service-up.sh -- ADR-170
# (docs/internal/adr/170-ruflo-mcp-server-tree-store-and-topology.md) SS5 /
# SS8 creation procedure for the `ruflo` Compose service's external,
# nonce-labelled, machine-global volume (skillsmith-ruflo-data), plus
# bring-up of the service itself. Run from the main checkout (SS3: the
# `ruflo` profile is started once per MACHINE, never once per worktree --
# never `docker compose --profile ruflo up -d` bare, which skips this
# script's volume-creation and store-init steps on a fresh machine).
#
# Idempotent on the common case: on a volume that already exists, carries a
# matching label, and already has a store, this is exactly
# `docker compose --profile ruflo up -d ruflo` plus a fact printout -- no
# volume create, no store-init run. H-5: an existing volume is no longer
# trusted blindly, though -- see check_existing_volume() below, which is
# what closes shapes 5 and 6 (this script is the named remedy for the
# launcher's authority-quad (b) and (d) refusals, so it must be able to
# actually resolve the states those refusals report, not just repeat them).
#
# Six failure/success shapes (ADR-170 SS5's "store authority" quad, the
# fields this script alone is responsible for minting and recording):
#   1. volume absent, no local authority file  -> fresh creation (mint
#      nonce + generation UUID, write authority file 0600, create the
#      labelled volume, run the one-off store_generation init AGAINST BOTH
#      store files (see "Two stores, one marker" below), then up).
#   2. volume present, label matches, both stores present    -> no create,
#      no init, up (the common case).
#   3. volume absent, authority file PRESENT    -> refuse. Silently
#      recreating here would mint a NEW nonce/generation while the local
#      file still names the OLD one -- exactly the "wrong generation"
#      confusion ADR-170 SS5 (d) exists to make impossible. This is a
#      manual-intervention case; the script never resolves it on its own.
#   4. `docker volume create` itself fails      -> non-zero exit naming
#      the exact command that failed.
#   5. volume present, label DOES NOT match the local authority file's
#      instanceNonce -> refuse (H-5). This is the launcher's authority quad
#      (b) refusal; re-running this script must not loop forever on it.
#   6. volume present, label matches, but one or both stores lack the
#      marker at the expected path -> the partial-creation hole:
#      create_volume() succeeded on an earlier run and then
#      write_authority_file() or init_store() died before completing,
#      leaving a labelled, still-empty volume. Runs init_store() with the
#      authority file's own generationUuid for whichever file(s) lack the
#      marker rather than skipping (H-5). This is the launcher's authority
#      quad (d) refusal. reconcile_store_pair() (below) also covers the
#      narrower "one store already has the marker, the other predates it"
#      shape -- a same-generation repair, not a fresh-creation hole -- and
#      refuses distinctly if the two stores disagree on generation.
#
# Two stores, one marker (SMI-6744 A1.4 defect, measured 2026-09-23):
# ADR-170 SS5 (c) speaks of "the store's store_generation row" singular, but
# the served @claude-flow/cli@3.42.4 keeps TWO SQLite databases under
# .swarm/: sql.js writes memory.db (possibly encrypted at rest under
# CLAUDE_FLOW_ENCRYPT_AT_REST, which this service does not set) and AgentDB
# owns agentdb-memory.db via native better-sqlite3 -- see getAgentDbPath() in
# @claude-flow/cli's memory-bridge.js ("Resolve AgentDB's native
# better-sqlite3 database path (#2786)"). Both files get the marker so
# either one authenticates the same generation; scripts/mcp-ruflo-launcher.sh
# requires BOTH.
#
# bash 3.2-safe (macOS default bash: no associative arrays, no `${v,,}`).
# Lint-clean under `shellcheck -S warning`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
VOLUME_NAME="skillsmith-ruflo-data"
LABEL_KEY="app.skillsmith.ruflo.instance"
AUTHORITY_FILE="$HOME/.skillsmith/ruflo-store.json"
# H-5: the exact paths scripts/mcp-ruflo-launcher.sh's authority-quad (c)/(d)
# checks probe (STORE_DB_PATH/AGENTDB_DB_PATH there) -- read from that script
# rather than guessed, so this script's own store probes agree with the
# launcher's. Two files, not one -- see "Two stores, one marker" above.
SERVICE_CWD="/srv/ruflo"
STORE_DB_PATH="$SERVICE_CWD/.swarm/memory.db"
AGENTDB_DB_PATH="$SERVICE_CWD/.swarm/agentdb-memory.db"
# The expected seed digest lives outside the image (ADR-170 SS7): committed beside the
# lockfile, derived by acceptance from the accepted build, exported into the service's
# environment here so the entrypoint can compare its candidate digest against it.
EXPECTED_DIGEST_FILE="${RUFLO_SEED_EXPECTED_DIGEST_FILE:-$REPO_ROOT/scripts/ruflo-seed/SEED-MANIFEST.sha256}"

log() { echo "[ruflo-up] $*"; }
die() { echo "[ruflo-up] ERROR: $*" >&2; exit 1; }

mint_token() {
    if command -v uuidgen >/dev/null 2>&1; then
        uuidgen
    else
        od -An -tx1 -N16 /dev/urandom | tr -d ' \n'
    fi
}

volume_exists() {
    docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1
}

# One-off store_generation-row init, run ONCE PER FILE (the caller passes
# db_filename="memory.db" or "agentdb-memory.db" -- see "Two stores, one
# marker" above). Runs through --entrypoint node so
# scripts/ruflo-service-entrypoint.sh (which the `ruflo` service's own
# entrypoint: normally is) is bypassed entirely for this call -- that
# script always holds forever and ignores its own "$@" by design, so
# without this override the init run would never execute and would hang
# until the caller's own timeout. This IS the deliberate, narrow exception:
# the up script is the same trusted actor that just created the volume, and
# this is the one supported way anything other than the entrypoint's own
# probes ever touches a freshly-created, still-empty volume.
init_store() {
    local generation="$1" db_filename="$2"
    log "initialising store_generation row (generation=$generation) in .swarm/$db_filename via a one-off run"
    local init_js
    init_js=$(
        cat <<'JS'
const path = require('path');
const fs = require('fs');
const Database = require('/opt/ruflo-seed/node_modules/better-sqlite3');
const dir = path.join(process.cwd(), '.swarm');
fs.mkdirSync(dir, { recursive: true });
const dbPath = path.join(dir, process.env.RUFLO_STORE_DB_FILENAME);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS store_generation (id TEXT PRIMARY KEY)');
const expected = process.env.RUFLO_GENERATION_UUID;
const info = db.prepare('INSERT OR IGNORE INTO store_generation (id) VALUES (?)').run(expected);
// M-6: INSERT OR IGNORE reporting changes===0 as "already present" without
// checking the EXISTING row's id would let a store carrying a DIFFERENT
// generation's row silently pass as "initialised" for this one. Read the
// row back and require exactly one, equal to the generation this call was
// asked to initialise, before declaring success.
const rows = db.prepare('SELECT id FROM store_generation').all();
if (rows.length !== 1 || rows[0].id !== expected) {
  console.error('store_generation rows in ' + process.env.RUFLO_STORE_DB_FILENAME + ': ' + JSON.stringify(rows.map((r) => r.id)) + ' (expected exactly one row equal to ' + expected + ')');
  db.close();
  process.exit(1);
}
db.close();
console.log('store_generation row for ' + expected + ' in ' + process.env.RUFLO_STORE_DB_FILENAME + ': ' + (info.changes === 1 ? 'inserted' : 'already present'));
JS
    )
    # M-6: the shell caller must propagate the node script's failure -- it
    # already does, via this `if ! docker compose ... run ...` -- `docker
    # compose run --rm` exits with the container's own exit status, so the
    # node script's `process.exit(1)` above surfaces here as a non-zero
    # `docker compose run` exit and this branch's `die`, not a false success.
    if ! docker compose -f "$COMPOSE_FILE" --profile ruflo run --rm --no-deps \
        --entrypoint node \
        -e RUFLO_GENERATION_UUID="$generation" \
        -e RUFLO_STORE_DB_FILENAME="$db_filename" \
        ruflo -e "$init_js"; then
        die "one-off store_generation init run for .swarm/$db_filename failed: docker compose -f $COMPOSE_FILE --profile ruflo run --rm --no-deps --entrypoint node ruflo -e '<init script>' (requires /opt/ruflo-seed/node_modules/better-sqlite3 in the image; a non-zero exit here can mean an existing store_generation row for a DIFFERENT generation was found -- ADR-170 SS5 (c), a manual-intervention case, not a retryable one)"
    fi
    log "store_generation row initialised in .swarm/$db_filename"
}

write_authority_file() {
    local nonce="$1" generation="$2"
    local dir tmp_file created_at
    dir="$(dirname "$AUTHORITY_FILE")"
    mkdir -p "$dir"
    if [[ -e "$AUTHORITY_FILE" ]]; then
        die "authority file already exists at $AUTHORITY_FILE -- refusing to overwrite it (this is the wrong-generation case, not creation; remove it deliberately first if a fresh store is genuinely intended)"
    fi
    created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    tmp_file="$(mktemp "$dir/.ruflo-store.json.XXXXXX")"
    cat > "$tmp_file" <<EOF
{
  "instanceNonce": "$nonce",
  "generationUuid": "$generation",
  "createdAt": "$created_at"
}
EOF
    chmod 600 "$tmp_file"
    mv "$tmp_file" "$AUTHORITY_FILE"
    log "wrote authority file $AUTHORITY_FILE (mode 0600, instanceNonce=$nonce generationUuid=$generation)"
}

create_volume() {
    local nonce="$1"
    log "creating volume $VOLUME_NAME with label $LABEL_KEY=$nonce"
    if ! docker volume create --label "$LABEL_KEY=$nonce" "$VOLUME_NAME" >/dev/null; then
        die "docker volume create --label $LABEL_KEY=$nonce $VOLUME_NAME failed"
    fi
    log "volume $VOLUME_NAME created"
}

bring_up_service() {
    log "running: docker compose -f $COMPOSE_FILE --profile ruflo up -d ruflo"
    if ! docker compose -f "$COMPOSE_FILE" --profile ruflo up -d ruflo; then
        die "docker compose -f $COMPOSE_FILE --profile ruflo up -d ruflo failed"
    fi
}

print_facts() {
    log "reading back mount and label facts from the daemon:"
    docker inspect skillsmith-ruflo-1 \
        --format '  container skillsmith-ruflo-1 mount at /srv/ruflo: {{range .Mounts}}{{if eq .Destination "/srv/ruflo"}}Type={{.Type}} Name={{.Name}} Source={{.Source}}{{end}}{{end}}' \
        || log "  (could not read back container mount facts)"
    docker volume inspect "$VOLUME_NAME" \
        --format '  volume {{.Name}}: Labels={{.Labels}} CreatedAt={{.CreatedAt}}' \
        || log "  (could not read back volume facts)"
}

export_expected_digest() {
    [[ -f "$EXPECTED_DIGEST_FILE" ]] || die "expected seed digest file $EXPECTED_DIGEST_FILE is missing -- it is committed by A1.4's acceptance run against the accepted build (ADR-170 SS7); the service will not start without it"
    local digest
    digest="$(tr -d '[:space:]' < "$EXPECTED_DIGEST_FILE")"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "expected seed digest file $EXPECTED_DIGEST_FILE does not hold one lowercase sha256 hex digest (got '${digest:0:80}')"
    export RUFLO_SEED_EXPECTED_DIGEST="$digest"
    log "expected seed digest ${digest:0:12}... exported from $EXPECTED_DIGEST_FILE"
}

# H-5: read one field out of the local authority file. Mirrors
# scripts/mcp-ruflo-launcher.sh's own inline `node -e` reads of the same
# file, so both scripts agree on what "present and well-formed" means.
read_authority_field() {
    local field="$1"
    node -e '
      const fs = require("fs");
      try {
        const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        process.stdout.write(typeof j[process.argv[2]] === "string" ? j[process.argv[2]] : "");
      } catch { process.stdout.write(""); }
    ' "$AUTHORITY_FILE" "$field"
}

# H-5/H-6: probe a single file's store_generation marker, WITHOUT starting
# (or waiting on) the entrypoint's own hold -- `--entrypoint node` bypasses
# scripts/ruflo-service-entrypoint.sh entirely, the same deliberate, narrow
# exception init_store() already documents above for touching a
# freshly-created volume. RUFLO_SEED_EXPECTED_DIGEST is already exported by
# the time this runs (main() calls export_expected_digest first), which this
# probe does not need but does not have to avoid either.
#
# Prints exactly one of:
#   ABSENT       -- the file doesn't exist, the store_generation table
#                    doesn't exist, or the row count isn't exactly 1. This
#                    collapses several distinct failure causes into one
#                    signal deliberately: init_store()'s own idempotent
#                    CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE + verify
#                    (M-6) is the thing that re-derives and refuses on a
#                    genuine anomaly (e.g. a corrupted file) when this probe
#                    routes into it -- this probe only needs to decide
#                    "does init_store need to run against this file".
#   <generation> -- the store_generation row's id, when exactly one exists.
probe_generation() {
    local db_path="$1"
    local probe_js
    probe_js=$(
        cat <<'JS'
const Database = require('/opt/ruflo-seed/node_modules/better-sqlite3');
const dbPath = process.env.RUFLO_PROBE_DB_PATH;
try {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT id FROM store_generation').all();
  db.close();
  if (rows.length === 1) {
    console.log('RUFLO_GEN=' + rows[0].id);
  } else {
    console.log('RUFLO_GEN_ABSENT');
  }
} catch {
  console.log('RUFLO_GEN_ABSENT');
}
JS
    )
    local probe
    probe="$(docker compose -f "$COMPOSE_FILE" --profile ruflo run --rm --no-deps \
        --entrypoint node \
        -e RUFLO_PROBE_DB_PATH="$db_path" \
        ruflo -e "$probe_js" 2>&1)" \
        || die "probe for store_generation at $db_path on volume $VOLUME_NAME failed: docker compose -f $COMPOSE_FILE --profile ruflo run --rm --no-deps --entrypoint node ruflo -e '<probe script>'"
    case "$probe" in
        *RUFLO_GEN_ABSENT*) printf '%s' "ABSENT" ;;
        *RUFLO_GEN=*) printf '%s' "${probe##*RUFLO_GEN=}" ;;
        *) die "probe for store_generation at $db_path on volume $VOLUME_NAME returned unexpected output: $probe" ;;
    esac
}

# H-6: reconcile the two stores' markers against each other and against the
# authority file's expected generation. Three legitimate outcomes plus one
# refusal -- see the "Two stores, one marker" header comment for why this
# needs to consider two files rather than one.
reconcile_store_pair() {
    local mem_gen="$1" agentdb_gen="$2" expected="$3"

    if [[ "$mem_gen" == "ABSENT" ]] && [[ "$agentdb_gen" == "ABSENT" ]]; then
        log "volume $VOLUME_NAME is labelled but has no store_generation marker in .swarm/memory.db or .swarm/agentdb-memory.db -- this is the partial-creation hole (create_volume succeeded on an earlier run, then write_authority_file or init_store died before completing); running init_store now with $AUTHORITY_FILE's generationUuid=$expected for both files"
        init_store "$expected" "memory.db"
        init_store "$expected" "agentdb-memory.db"
        return
    fi

    if [[ "$mem_gen" == "$expected" ]] && [[ "$agentdb_gen" == "$expected" ]]; then
        log "store already present on volume $VOLUME_NAME at $STORE_DB_PATH and $AGENTDB_DB_PATH, both at generation ${expected:0:12}... -- no init needed"
        return
    fi

    if [[ "$mem_gen" == "$expected" ]] && [[ "$agentdb_gen" == "ABSENT" ]]; then
        log "memory.db carries the store_generation marker at $AUTHORITY_FILE's generation (${expected:0:12}...) but agentdb-memory.db has no marker table -- this is the live-volume state predating the two-store fix (SMI-6744 A1.4), NOT a wrong-generation hazard (the generation is proven by memory.db and $AUTHORITY_FILE agreeing); repairing agentdb-memory.db with a same-generation marker"
        init_store "$expected" "agentdb-memory.db"
        return
    fi

    # Every remaining combination is a genuine disagreement: memory.db
    # itself disagrees with the authority file, agentdb-memory.db carries
    # its OWN marker that disagrees with memory.db/the authority file (a
    # forked or copied agentdb-memory.db), or memory.db is absent while
    # agentdb-memory.db already carries a marker (backwards from the normal
    # creation order). Refuse -- this is a manual-intervention case, the
    # same class ADR-170 SS5 (c) already refuses for a single store.
    die "memory.db and agentdb-memory.db on volume $VOLUME_NAME carry DIFFERENT generations (ADR-170 SS5 (c) -- a forked or restored store): memory.db=${mem_gen:0:12}... agentdb-memory.db=${agentdb_gen:0:12}... authority file $AUTHORITY_FILE expects ${expected:0:12}.... This is not auto-repaired; confirm which generation is intended before proceeding."
}

# H-5: main()'s old volume_exists branch short-circuited unconditionally
# ("no create, no store-init") without checking the volume's label or the
# store's presence -- so the two launcher refusals that name THIS script as
# the remedy ("authority quad b" label mismatch, "authority quad d" empty
# volume/no database) looped forever: re-running this script after either
# refusal landed right back on the same no-op branch. This closes both, plus
# the partial-creation hole between create_volume() succeeding and
# write_authority_file()/init_store() dying (a labelled, still-empty
# volume), extended by H-6/reconcile_store_pair() to both store files.
check_existing_volume() {
    if [[ ! -e "$AUTHORITY_FILE" ]]; then
        log "no local authority file at $AUTHORITY_FILE -- volume $VOLUME_NAME predates this machine's authority tracking (or the file was removed); bringing the service up without a generation check (the launcher's authority quad b/c will catch a real mismatch)"
        return
    fi

    local expected_nonce expected_generation
    expected_nonce="$(read_authority_field instanceNonce)"
    expected_generation="$(read_authority_field generationUuid)"
    if [[ -z "$expected_nonce" ]] || [[ -z "$expected_generation" ]]; then
        die "$AUTHORITY_FILE is missing instanceNonce or generationUuid -- cannot verify volume $VOLUME_NAME against it (ADR-170 SS5). This is a manual-intervention case; resolve the authority file's contents before re-running this script."
    fi

    local volume_label
    volume_label="$(docker volume inspect -f "{{index .Labels \"$LABEL_KEY\"}}" "$VOLUME_NAME" 2>&1)" \
        || die "could not inspect volume $VOLUME_NAME to read its $LABEL_KEY label"
    if [[ "$volume_label" != "$expected_nonce" ]]; then
        die "volume $VOLUME_NAME's $LABEL_KEY label ($volume_label) does not match $AUTHORITY_FILE's instanceNonce ($expected_nonce) -- this is the wrong-generation hazard ADR-170 SS5 (b) exists to catch (the volume was deleted and recreated under the same name, or a different generation's authority file is present on this machine). This is a manual-intervention case; the script never resolves it on its own -- confirm which generation is intended, then either restore the volume that matches $AUTHORITY_FILE or remove $AUTHORITY_FILE and re-run this script only if a fresh store is genuinely intended."
    fi
    log "volume $VOLUME_NAME's $LABEL_KEY label matches $AUTHORITY_FILE (instanceNonce=$expected_nonce) -- checking both stores' generation markers"

    local mem_gen agentdb_gen
    mem_gen="$(probe_generation "$STORE_DB_PATH")"
    agentdb_gen="$(probe_generation "$AGENTDB_DB_PATH")"
    reconcile_store_pair "$mem_gen" "$agentdb_gen" "$expected_generation"
}

main() {
    export_expected_digest
    if volume_exists; then
        log "volume $VOLUME_NAME already exists -- checking its label and store before bringing the service up"
        check_existing_volume
    else
        if [[ -e "$AUTHORITY_FILE" ]]; then
            die "volume $VOLUME_NAME is absent but the local authority file $AUTHORITY_FILE already exists -- refusing to auto-create (wrong-generation hazard: a freshly created volume would mint a NEW nonce/generation while $AUTHORITY_FILE still names the OLD one). Resolve manually: confirm whether the volume was deleted deliberately, then either restore it from its own backup or remove $AUTHORITY_FILE and re-run this script to mint a fresh generation."
        fi
        local nonce generation
        nonce="$(mint_token)"
        generation="$(mint_token)"
        # Order matters: create the volume BEFORE writing the durable
        # authority file. If `docker volume create` fails, nothing has been
        # written to disk yet, so a retry lands back on this same clean
        # "volume absent, authority file absent" branch. Writing the
        # authority file first would leave an orphaned file behind a failed
        # create -- every subsequent run would then see "authority file
        # present, volume absent" and refuse forever on a failure that was
        # never a real wrong-generation hazard.
        create_volume "$nonce"
        write_authority_file "$nonce" "$generation"
        init_store "$generation" "memory.db"
        init_store "$generation" "agentdb-memory.db"
    fi

    bring_up_service
    print_facts
}

main "$@"
