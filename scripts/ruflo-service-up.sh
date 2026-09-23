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
# Idempotent: on a volume that already exists, this is exactly
# `docker compose --profile ruflo up -d ruflo` plus a fact printout -- no
# volume create, no store-init run.
#
# Four failure/success shapes (ADR-170 SS5's "store authority" quad, the
# fields this script alone is responsible for minting and recording):
#   1. volume absent, no local authority file  -> fresh creation (mint
#      nonce + generation UUID, write authority file 0600, create the
#      labelled volume, run the one-off store_generation init, then up).
#   2. volume present                          -> no create, no init, up.
#   3. volume absent, authority file PRESENT    -> refuse. Silently
#      recreating here would mint a NEW nonce/generation while the local
#      file still names the OLD one -- exactly the "wrong generation"
#      confusion ADR-170 SS5 (d) exists to make impossible. This is a
#      manual-intervention case; the script never resolves it on its own.
#   4. `docker volume create` itself fails      -> non-zero exit naming
#      the exact command that failed.
#
# bash 3.2-safe (macOS default bash: no associative arrays, no `${v,,}`).
# Lint-clean under `shellcheck -S warning`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
VOLUME_NAME="skillsmith-ruflo-data"
LABEL_KEY="app.skillsmith.ruflo.instance"
AUTHORITY_FILE="$HOME/.skillsmith/ruflo-store.json"
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

# One-off store_generation-row init. Runs through --entrypoint node so
# scripts/ruflo-service-entrypoint.sh (which the `ruflo` service's own
# entrypoint: normally is) is bypassed entirely for this call -- that
# script always holds forever and ignores its own "$@" by design, so
# without this override the init run would never execute and would hang
# until the caller's own timeout. This IS the deliberate, narrow exception:
# the up script is the same trusted actor that just created the volume, and
# this is the one supported way anything other than the entrypoint's own
# probes ever touches a freshly-created, still-empty volume.
init_store() {
    local generation="$1"
    log "initialising store_generation row (generation=$generation) via a one-off run"
    local init_js
    init_js=$(
        cat <<'JS'
const path = require('path');
const fs = require('fs');
const Database = require('/opt/ruflo-seed/node_modules/better-sqlite3');
const dir = path.join(process.cwd(), '.swarm');
fs.mkdirSync(dir, { recursive: true });
const dbPath = path.join(dir, 'memory.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS store_generation (id TEXT PRIMARY KEY)');
const info = db.prepare('INSERT OR IGNORE INTO store_generation (id) VALUES (?)').run(process.env.RUFLO_GENERATION_UUID);
db.close();
console.log('store_generation row for ' + process.env.RUFLO_GENERATION_UUID + ': ' + (info.changes === 1 ? 'inserted' : 'already present'));
JS
    )
    if ! docker compose -f "$COMPOSE_FILE" --profile ruflo run --rm --no-deps \
        --entrypoint node \
        -e RUFLO_GENERATION_UUID="$generation" \
        ruflo -e "$init_js"; then
        die "one-off store_generation init run failed: docker compose -f $COMPOSE_FILE --profile ruflo run --rm --no-deps --entrypoint node ruflo -e '<init script>' (requires /opt/ruflo-seed/node_modules/better-sqlite3 in the image)"
    fi
    log "store_generation row initialised"
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

main() {
    export_expected_digest
    if volume_exists; then
        log "volume $VOLUME_NAME already exists -- no create, no store-init"
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
        init_store "$generation"
    fi

    bring_up_service
    print_facts
}

main "$@"
