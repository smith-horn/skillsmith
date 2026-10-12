#!/bin/sh
# scripts/ruflo-service-entrypoint.sh -- container entrypoint (PID 1) for
# the `ruflo` Compose service (ADR-170
# docs/internal/adr/170-ruflo-mcp-server-tree-store-and-topology.md, SS4 and
# SS6). Runs once, at container start, before any MCP session process
# exists:
#
#   1. validates the installed seed under /opt/ruflo-seed against its
#      build-time manifest record (SS6: "validates the seed against ...
#      SEED-MANIFEST.json");
#   2. proves the working directory and its three derived-state
#      subdirectories are actually writable, by a write-and-remove probe in
#      each -- a `mkdir -p` success on an EXISTING read-only directory
#      proves nothing about writing into it (ADR-170 SS4);
#   3. prints the served CLI version, one line; then
#   4. holds forever.
#
# It never execs the served CLI itself. Per ADR-170 SS3, each MCP session's
# own `cli.js mcp start` process is spawned later, once per session, by
# scripts/mcp-ruflo-launcher.sh via `docker exec -i` into THIS
# already-running container -- so this script's job ends at "hold", and the
# Compose `command:` literal (docker-compose.yml's `ruflo` service) is
# inspectable evidence only (round-4 finding 6, ADR-170 SS1), never
# something this script execs. That is why step 4 below ignores "$@"
# entirely rather than `exec "$@"`-ing into it.
#
# ---- Interface contract this script expects the ruflo image stage to
# satisfy (ADR-170 SS1/SS6/SS7, A1.4 part (i): seed lockfile + Dockerfile
# `ruflo` stage + manifest generator). scripts/ruflo-seed/* and the
# Dockerfile are out of scope for this worker to EDIT; both already ship the
# contract below, confirmed by direct read of the Dockerfile's `ruflo` stage
# and the currently-serving container, 2026-09-23. M-13 fix: this block
# previously described a superseded design ("neither ... will exist at ANY
# path, and this script will always refuse"; a SEED-MANIFEST.json this
# script would validate against) that never shipped as written -- the
# generator landed in the same wave that added this script's Check 1 above,
# so the description had already gone stale by the time it was committed.
#   - RUFLO_MANIFEST_GENERATOR (default /opt/ruflo-manifest/generate-manifest.mjs):
#     COPYed into the image by the Dockerfile's `ruflo` stage from the
#     repo's own scripts/ruflo-seed/manifest.mjs. Confirmed usage is
#     `node manifest.mjs <covered-root> --digest`, which writes ONLY the
#     lowercase-hex sha256 digest (newline-terminated) to stdout; WITHOUT
#     `--digest` stdout instead carries the raw serialized manifest BYTES
#     and the digest goes to stderr, so the `--digest` flag below is
#     load-bearing, not decorative. Exits non-zero (manifest refused) on any
#     covered-root entry that isn't a directory/regular-file/symlink, or any
#     regular file whose st_nlink != 1 (ADR-170 SS7's own generator-failure
#     requirements) -- confirmed in the script's own `walk()`.
#   - RUFLO_SEED_EXPECTED_DIGEST: the EXPECTED digest never ships inside the
#     image (ADR-170 SS7 round-4 finding 2: "nothing inside the image is
#     authority") -- it arrives from OUTSIDE at container-start time.
#     scripts/ruflo-service-up.sh reads it from the committed
#     scripts/ruflo-seed/SEED-MANIFEST.sha256 and exports it as
#     RUFLO_SEED_EXPECTED_DIGEST; docker-compose.yml's `ruflo` service passes
#     it through default-empty (`${VAR:-}` -- a required `${VAR:?}` form
#     broke `docker compose --profile dev config` whenever the digest was
#     not exported, A1.4 measured deviation 3). This script refuses
#     immediately below on an empty or non-64-hex value rather than silently
#     skipping validation -- there is no in-image manifest record of any
#     kind for it to fall back to, by design (fail-loudly-over-fall-through:
#     an entrypoint that silently skipped validation because its inputs were
#     missing would be exactly the invisible-success class this file exists
#     to avoid).
#
# POSIX sh (Compose declares entrypoint: ["/bin/sh", ...]). Lint-clean under
# `shellcheck -S warning -s sh` and `dash -n`.
set -eu

MANIFEST_GENERATOR="${RUFLO_MANIFEST_GENERATOR:-/opt/ruflo-manifest/generate-manifest.mjs}"
SEED_ROOT="${RUFLO_SEED_ROOT:-/opt/ruflo-seed}"
# The EXPECTED digest is never read from inside the image (ADR-170 SS7, round-4
# finding 2: nothing inside the image is authority). scripts/ruflo-service-up.sh
# exports it from the checkout's committed scripts/ruflo-seed/SEED-MANIFEST.sha256
# and docker-compose.yml requires it; the generator here only produces the
# CANDIDATE digest of the tree this container actually holds.
EXPECTED_DIGEST="${RUFLO_SEED_EXPECTED_DIGEST:-}"

# Test-only override (scripts/tests/ruflo-service-entrypoint.test.sh runs
# this script against a scratch directory rather than the real /srv/ruflo
# mount). Production containers never set this.
CWD="${RUFLO_SERVICE_CWD:-/srv/ruflo}"

refuse() {
    echo "[ruflo-entrypoint] REFUSED: $1" >&2
    exit 1
}

# ---- 1. seed validation ----
if [ ! -f "$MANIFEST_GENERATOR" ]; then
    refuse "manifest generator missing at $MANIFEST_GENERATOR -- seed image incomplete"
fi
case "$EXPECTED_DIGEST" in
    *[!0-9a-f]*|"") refuse "RUFLO_SEED_EXPECTED_DIGEST is unset or not a lowercase sha256 hex digest (got '${EXPECTED_DIGEST}') -- start the service with scripts/ruflo-service-up.sh, which exports it from scripts/ruflo-seed/SEED-MANIFEST.sha256" ;;
esac
if [ "${#EXPECTED_DIGEST}" -ne 64 ]; then
    refuse "RUFLO_SEED_EXPECTED_DIGEST has length ${#EXPECTED_DIGEST}, expected 64 hex characters"
fi

if ! ACTUAL_DIGEST="$(node "$MANIFEST_GENERATOR" "$SEED_ROOT" --digest)"; then
    # L-15: stderr is deliberately NOT redirected here (unlike the version-string
    # probe below) -- the generator's own refusal reason (e.g. "refused:
    # unsupported entry type=FIFO ...") is diagnostic content this container's
    # log must carry, not noise to discard. Only its stdout is captured above.
    refuse "manifest generator ($MANIFEST_GENERATOR) failed against $SEED_ROOT"
fi
if [ -z "$ACTUAL_DIGEST" ]; then
    refuse "manifest generator ($MANIFEST_GENERATOR) produced no digest for $SEED_ROOT"
fi

if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then
    refuse "seed tree digest mismatch under $SEED_ROOT: actual=$ACTUAL_DIGEST expected=$EXPECTED_DIGEST"
fi

# ---- 2. writability probes ----
# mkdir -p on an existing read-only directory succeeds and proves nothing
# (ADR-170 SS4); only a write-and-remove into the directory itself proves
# it is writable by this process.
probe_writable() {
    dir="$1"
    if ! mkdir -p "$dir" 2>/dev/null; then
        refuse "cannot create directory $dir"
    fi
    probe="$dir/.ruflo-entrypoint-probe.$$"
    if ! printf '' > "$probe" 2>/dev/null; then
        refuse "directory not writable (probe write failed): $dir"
    fi
    if ! rm -f "$probe" 2>/dev/null; then
        refuse "directory not writable (probe remove failed): $dir"
    fi
}

probe_writable "$CWD"
probe_writable "$CWD/.claude-flow"
probe_writable "$CWD/.claude-flow/policy"
probe_writable "$CWD/.swarm"

# ---- 3. served version, one line ----
if ! SEED_VERSION="$(node -p "require('$SEED_ROOT/node_modules/@claude-flow/cli/package.json').version" 2>/dev/null)"; then
    refuse "could not read served cli version from $SEED_ROOT/node_modules/@claude-flow/cli/package.json"
fi
echo "[ruflo-entrypoint] serving @claude-flow/cli@$SEED_VERSION from $SEED_ROOT, cwd=$CWD -- holding (sessions are spawned by docker exec, ADR-170 SS3)"

# ---- 4. hold. `sleep infinity` over `tail -f /dev/null`: it opens no file
# descriptor and depends on no /dev/null semantics, and this script must
# deliberately ignore its own "$@" (the trailing Compose `command:` literal)
# rather than exec it -- see the header comment.
#
# H-2 fix: NOT `exec sleep infinity`. Exec'ing replaces this shell's process
# image with `sleep`, which installs no handler of its own and so receives
# SIGTERM only as an unconditional kill (measured: /proc/1/status SigCgt
# 0000000000000000 under the old form) -- `docker stop` then burns the full
# 10 s grace period before SIGKILLing PID 1, taking every in-flight
# `docker exec`-spawned `mcp start` session down mid-write with it. Trapping
# TERM/INT in this script (still PID 1) and backgrounding `sleep infinity`
# lets the trap fire and `exit 0` immediately on SIGTERM instead. This holds
# even without docker-compose.yml's own `init: true` on the `ruflo` service,
# which is the belt-and-suspenders fix for the same signal reaching every
# OTHER process in the container (the docker-exec'd `mcp start` sessions
# themselves, which this script does not and cannot trap on their behalf).
trap 'exit 0' TERM INT
sleep infinity &
wait $!
