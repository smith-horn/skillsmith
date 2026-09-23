#!/usr/bin/env bash
#
# Launcher for the ruflo MCP server (SMI-6744 A1.4, ADR-170).
#
# Sibling to scripts/mcp-doc-retrieval-launcher.sh (SMI-5718) and
# scripts/mcp-skillsmith-launcher.sh (SMI-5049) — same three-part
# [tag] emit_error contract, same "branch on probe TEXT, never on a bare
# docker exec exit code" discipline (ADR-170 § 7 cites
# mcp-doc-retrieval-launcher.sh:131-150 verbatim as the pattern to copy).
#
# This is a HOST macOS/Linux shell script: it has no /proc and cannot see
# the container's process table or uid/gid. ADR-170 §§ 4 and 7 require the
# per-spawn writability probes and the sibling-lock staleness protocol to
# run INSIDE the container, under the server's own uid/gid, immediately
# before the server is exec'd. Rather than ship that Node logic as image
# content (which would put it under scripts/ruflo-seed/, a file this launcher
# does not own — SMI-6744 A1.4 splits ownership across parallel workers),
# it is committed here as scripts/ruflo-launch-guard.mjs and piped into the
# running container's own `node -` over `docker exec -i`'s stdin. This
# avoids needing any bind mount or COPY step owned by another part of this
# issue, at the cost of one extra `docker exec` per spawn — see
# scripts/ruflo-launch-guard.mjs's own header for the guard's contract.
#
# Checks, in order, each ADR-170 section in parenthesis:
#   0. SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1 (kill switch; no npx fallback by
#      design, SMI-6744 Wave 4 removes `ruflo` from the host tree entirely) —
#      checked FIRST, before any docker call, so a disabled launcher touches
#      neither `docker` nor the network.
#   1. Container liveness (§ 3: one server process per session, N docker
#      execs into one container) — remediation: scripts/ruflo-service-up.sh.
#      Immediately after, the container's ID is resolved ONCE (`docker
#      inspect -f '{{.Id}}'`) and every later docker inspect/exec — Checks
#      2-5, the guard pipe, and the final exec — targets that ID, never the
#      name again, so a container swapped in under the same name between
#      this check and the exec fails closed with "no such container"
#      instead of silently attaching to the replacement (governance review
#      TOCTOU finding, Q2).
#   2. Service command authentication (§ 1, round-4 finding 6; § 4 for the
#      cwd leg): the RUNNING container's configured Entrypoint/Cmd must
#      equal the literal
#      `node /opt/ruflo-seed/node_modules/@claude-flow/cli/bin/cli.js mcp start`
#      verbatim, and its configured WorkingDir must equal $SERVICE_CWD — a
#      launcher that runs the right argv (or passes -w itself) establishes
#      nothing about the Compose/image configuration, so all three are
#      authenticated on the running container separately (governance review
#      finding H-3: a recreated container with a different working_dir
#      passed every prior check and served onto a silently forked store,
#      since cwd decides the store location per § 4).
#   3. RUFLO_CLI_PIN vs the served version (§ 7): the one pin literal,
#      compared against a sentinel-tagged `require(<cli>/package.json).version`
#      run inside the container, text-gated on the LAST `RUFLO_VER=` token
#      rather than the whole probe output — a bare Node stderr line
#      (an ExperimentalWarning, a deprecation notice) must not cause a false
#      refusal, and an absent sentinel must not be silently accepted as a
#      raw version string (governance review finding M-9). Never trust a
#      bare docker-exec exit code.
#   4. Authority quad (§ 5): (a) the /srv/ruflo mount is Type volume, Name
#      the committed literal; (b) the volume carries the expected instance
#      nonce label; (c) the store's store_generation row matches the
#      machine-local authority file's generation UUID; (d) an empty volume
#      with no database is refused by name, distinctly from a generation
#      mismatch, naming scripts/ruflo-service-up.sh as the remediation.
#   5. Per-spawn guard (§ 4, § 7): scripts/ruflo-launch-guard.mjs, run inside
#      the container immediately before exec, performs the writability
#      probes and the sibling-lock staleness decision and refuses by name on
#      any failure.
#
# Env moved here from .mcp.json (ADR-170 § 7): CLAUDE_FLOW_LOG_LEVEL,
# CLAUDE_FLOW_MEMORY_BACKEND, passed via `docker exec -e`. No
# AGENTDB_MODEL_PATH (ADR-170 § 2 — the served chain does not consult it).
#
# References: SMI-6744, ADR-170 (docs/internal/adr/170-ruflo-mcp-server-tree-store-and-topology.md).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---- Constants (ADR-170 committed literals) --------------------------------
CONTAINER_NAME="skillsmith-ruflo-1"
VOLUME_NAME="skillsmith-ruflo-data"
SERVICE_CWD="/srv/ruflo"
CLI_DIR="/opt/ruflo-seed/node_modules/@claude-flow/cli"
CLI_PATH="$CLI_DIR/bin/cli.js"
CLI_PKG_JSON="$CLI_DIR/package.json"
STORE_DB_PATH="$SERVICE_CWD/.swarm/memory.db"
GUARD_SCRIPT="$REPO_ROOT/scripts/ruflo-launch-guard.mjs"
AUTHORITY_FILE="$HOME/.skillsmith/ruflo-store.json"
VOLUME_LABEL_KEY="app.skillsmith.ruflo.instance" # the key scripts/ruflo-service-up.sh applies
# ADR-170 § 5 names the store's "store_generation row" without pinning a
# table/column name — the schema is owned by the seed/manifest work (A1.4
# parts i/ii), not this launcher. These two are the documented assumption;
# adjust here if that work names it differently.
# scripts/ruflo-service-up.sh initialises the store with exactly one row:
#   CREATE TABLE IF NOT EXISTS store_generation (id TEXT PRIMARY KEY); INSERT ... (id)
STORE_GENERATION_TABLE="store_generation"

# RUFLO_CLI_PIN is the one pin literal (ADR-170 § 7). Grepped by
# scripts/audit-cli-pin-drift-helpers.mjs and scripts/cli-pin-drift-check.sh —
# keep this a plain, unindented, single-line assignment.
RUFLO_CLI_PIN=3.42.4

MAIN_CHECKOUT="$REPO_ROOT"
_gcd="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || echo '')"
if [ -n "$_gcd" ]; then
  case "$_gcd" in
    /*) _abs_gcd="$_gcd" ;;
    *) _abs_gcd="$REPO_ROOT/$_gcd" ;;
  esac
  _resolved_main="$(cd "$_abs_gcd/.." 2>/dev/null && pwd || echo '')"
  [ -n "$_resolved_main" ] && MAIN_CHECKOUT="$_resolved_main"
fi

# emit_error <state> <remediation-block> [note]
# Tag is [ruflo] throughout — distinct from [doc-retrieval] and [skillsmith].
emit_error() {
  local state="$1"
  local remediation="$2"
  local note="${3:-(See CLAUDE.md > Docker-First Development)}"
  {
    echo "[ruflo] MCP server cannot start: $state."
    echo "[ruflo] Run these commands, then reconnect via /mcp:"
    echo ""
    echo "$remediation"
    echo ""
    echo "[ruflo] $note"
  } >&2
}

# ---- Check 0: kill switch, before any docker call --------------------------
if [ "${SKILLSMITH_RUFLO_LAUNCHER_DISABLE:-}" = "1" ]; then
  emit_error \
    "disabled by SKILLSMITH_RUFLO_LAUNCHER_DISABLE=1 (no npx fallback by design, SMI-6744 Wave 4)" \
    "    unset SKILLSMITH_RUFLO_LAUNCHER_DISABLE" \
    "(See .claude/development/claude-flow-guide.md > Launcher)"
  exit 1
fi

REMEDIATION_START_SERVICE="    ( cd \"$MAIN_CHECKOUT\" && ./scripts/ruflo-service-up.sh )"

# ---- Check 1: container liveness -------------------------------------------
if [ -z "$(docker ps --filter "name=^/${CONTAINER_NAME}\$" --filter "status=running" -q 2>/dev/null || true)" ]; then
  emit_error "$CONTAINER_NAME container is not running" "$REMEDIATION_START_SERVICE"
  exit 1
fi

# Resolve the container's ID ONCE, here, and use it — never $CONTAINER_NAME —
# for every docker inspect/exec below, including the guard pipe and the
# final exec (TOCTOU, governance review Q2). A name-based lookup can be
# satisfied by a DIFFERENT container between this check and the exec (the
# original stopped and a same-named one started, or `docker rename`d into
# place); an ID-pinned call instead fails closed with "no such container"
# the instant the original is gone, rather than silently authenticating the
# original and then attaching the exec to whatever now holds the name.
# $CONTAINER_NAME is still used in human-facing messages below.
set +e
cid="$(docker inspect -f '{{.Id}}' "$CONTAINER_NAME" 2>&1)"
cid_status=$?
set -e
if [ "$cid_status" -ne 0 ] || [ -z "$cid" ]; then
  emit_error "could not resolve the container id for $CONTAINER_NAME" \
"    docker inspect $CONTAINER_NAME
    # confirm the container is running and this host can reach the Docker daemon"
  exit 1
fi

# ---- Check 2: service command authentication (ADR-170 § 1, round-4 f.6; ---
# ---- § 4 for the cwd leg, governance review finding H-3) -------------------
# The daemon reports Path/Args as the concatenation of the compose entrypoint (the
# holding script ADR-170 §§ 3 and 6 require) and the § 1 command literal, so the
# literal is authenticated as Config.Cmd and the wrapper as Config.Entrypoint --
# both exact, no shell wrapper or override anywhere else (recorded for v5.4).
# Config.WorkingDir is authenticated too: § 4 makes cwd decide the store
# location, so a container recreated with a different working_dir would
# otherwise pass Entrypoint/Cmd authentication and serve onto a silently
# forked store.
EXPECTED_PATH='["/bin/sh","/opt/ruflo-service-entrypoint.sh"]'
EXPECTED_ARGS_JSON="[\"node\",\"$CLI_PATH\",\"mcp\",\"start\"]"
set +e
actual_path="$(docker inspect -f '{{json .Config.Entrypoint}}' "$cid" 2>&1)"
path_status=$?
actual_args="$(docker inspect -f '{{json .Config.Cmd}}' "$cid" 2>&1)"
args_status=$?
actual_workdir="$(docker inspect -f '{{.Config.WorkingDir}}' "$cid" 2>&1)"
workdir_status=$?
set -e
if [ "$path_status" -ne 0 ] || [ "$args_status" -ne 0 ] || [ "$workdir_status" -ne 0 ]; then
  emit_error "could not authenticate the running container's configured command (docker inspect failed)" \
"    docker inspect $CONTAINER_NAME
    # confirm the container is running and this host can reach the Docker daemon"
  exit 1
fi
if [ "$actual_path" != "$EXPECTED_PATH" ] || [ "$actual_args" != "$EXPECTED_ARGS_JSON" ]; then
  emit_error "the running container's configured command does not match the ADR-170 § 1 literal" \
"    expected: entrypoint $EXPECTED_PATH cmd $EXPECTED_ARGS_JSON
    actual:   entrypoint $actual_path cmd $actual_args
    ( cd \"$MAIN_CHECKOUT\" && docker compose --profile ruflo up -d --force-recreate ruflo )"
  exit 1
fi
if [ "$actual_workdir" != "$SERVICE_CWD" ]; then
  emit_error "the running container's configured working directory does not match ADR-170 § 4" \
"    expected: workdir $SERVICE_CWD
    actual:   workdir $actual_workdir
    ( cd \"$MAIN_CHECKOUT\" && docker compose --profile ruflo up -d --force-recreate ruflo )"
  exit 1
fi

# ---- Check 3: RUFLO_CLI_PIN vs the served version --------------------------
# Content-based, not exit-code-based (mirrors mcp-doc-retrieval-launcher.sh
# Check 1): a bare docker-exec exit 1 is ambiguous (also what docker exec
# itself returns on a daemon-level failure), so branch on the probe's own
# stdout text. The probe emits a sentinel-tagged value rather than the bare
# version (governance review finding M-9): comparing the WHOLE 2>&1-captured
# output to RUFLO_CLI_PIN made any Node stderr line (an ExperimentalWarning,
# a deprecation notice) a false refusal, since that text rides along on the
# same fd. Extracting the value after the LAST "RUFLO_VER=" token is immune
# to stderr noise appearing anywhere else in the captured text.
set +e
version_probe_out="$(docker exec "$cid" node -p "'RUFLO_VER='+require('$CLI_PKG_JSON').version" 2>&1)"
version_status=$?
set -e
if [ "$version_status" -ne 0 ] || [ -z "$version_probe_out" ]; then
  emit_error "could not read the served @claude-flow/cli version from the container" \
"    docker exec $CONTAINER_NAME node -p \"'RUFLO_VER='+require('$CLI_PKG_JSON').version\"
    # inspect the output above; the ruflo image may need a rebuild"
  exit 1
fi
case "$version_probe_out" in
  *RUFLO_VER=*) sentinel_found=1 ;;
  *) sentinel_found=0 ;;
esac
if [ "$sentinel_found" != "1" ]; then
  emit_error "the served-version probe produced no RUFLO_VER= sentinel (unexpected Node output)" \
"$(printf '%s' "$version_probe_out" | sed 's/^/    /')"
  exit 1
fi
# ##*RUFLO_VER= strips the longest matching prefix, i.e. up to and including
# the LAST occurrence of the sentinel, so trailing stderr text before it
# cannot be mistaken for the version; trimming to [0-9.] then discards
# anything the sentinel's own line still carries (e.g. a trailing newline).
served_version="$(printf '%s' "${version_probe_out##*RUFLO_VER=}" | tr -cd '0-9.')"
if [ "$served_version" != "$RUFLO_CLI_PIN" ]; then
  emit_error "RUFLO_CLI_PIN=$RUFLO_CLI_PIN does not match the served @claude-flow/cli@$served_version" \
"    pinned:  $RUFLO_CLI_PIN
    served:  $served_version
    # rebuild the ruflo image stage, or update RUFLO_CLI_PIN in this launcher if the pin moved (ADR-170 § 7)"
  exit 1
fi

# ---- Check 4: authority quad (ADR-170 § 5) ---------------------------------
# (a) the /srv/ruflo mount is Type volume, Name the committed literal.
set +e
mount_info="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$SERVICE_CWD\"}}{{.Type}} {{.Name}}{{end}}{{end}}" "$cid" 2>&1)"
mount_status=$?
set -e
if [ "$mount_status" -ne 0 ]; then
  emit_error "could not inspect the $SERVICE_CWD mount on $CONTAINER_NAME" "    docker inspect $CONTAINER_NAME"
  exit 1
fi
if [ "$mount_info" != "volume $VOLUME_NAME" ]; then
  emit_error "$SERVICE_CWD is not backed by the expected named volume (authority quad a)" \
"    expected: volume $VOLUME_NAME
    actual:   $mount_info
    $REMEDIATION_START_SERVICE"
  exit 1
fi

# (b) the volume carries the expected instance-nonce label.
if [ ! -f "$AUTHORITY_FILE" ]; then
  emit_error "no local ruflo store authority file at $AUTHORITY_FILE (authority quad b)" "$REMEDIATION_START_SERVICE"
  exit 1
fi
expected_nonce="$(node -e '
  const fs = require("fs");
  try {
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(typeof j.instanceNonce === "string" ? j.instanceNonce : "");
  } catch { process.stdout.write(""); }
' "$AUTHORITY_FILE")"
expected_generation="$(node -e '
  const fs = require("fs");
  try {
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(typeof j.generationUuid === "string" ? j.generationUuid : "");
  } catch { process.stdout.write(""); }
' "$AUTHORITY_FILE")"
if [ -z "$expected_nonce" ] || [ -z "$expected_generation" ]; then
  emit_error "$AUTHORITY_FILE is missing instanceNonce or generationUuid (authority quad b/c)" "$REMEDIATION_START_SERVICE"
  exit 1
fi
set +e
volume_label="$(docker volume inspect -f "{{index .Labels \"$VOLUME_LABEL_KEY\"}}" "$VOLUME_NAME" 2>&1)"
label_status=$?
set -e
if [ "$label_status" -ne 0 ]; then
  emit_error "could not inspect volume $VOLUME_NAME (authority quad b)" "$REMEDIATION_START_SERVICE"
  exit 1
fi
if [ "$volume_label" != "$expected_nonce" ]; then
  emit_error "volume $VOLUME_NAME's instance-nonce label does not match $AUTHORITY_FILE (authority quad b — the volume was deleted and recreated)" \
"    expected label $VOLUME_LABEL_KEY=${expected_nonce:0:12}...
    actual   label $VOLUME_LABEL_KEY=${volume_label:0:12}...
    # this is not auto-repaired; see ADR-170 § 5 (Store authority) before proceeding"
  exit 1
fi

# (d) an empty volume with no database is refused distinctly from (c).
set +e
db_probe="$(docker exec "$cid" sh -c '[ -f "$1" ] && echo RUFLO_DB_PRESENT || echo RUFLO_DB_ABSENT' _ "$STORE_DB_PATH" 2>&1)"
db_probe_status=$?
set -e
if [ "$db_probe_status" -ne 0 ] || { [ "$db_probe" != "RUFLO_DB_PRESENT" ] && [ "$db_probe" != "RUFLO_DB_ABSENT" ]; }; then
  emit_error "could not check for $STORE_DB_PATH inside $CONTAINER_NAME (authority quad d)" "$REMEDIATION_START_SERVICE"
  exit 1
fi
if [ "$db_probe" = "RUFLO_DB_ABSENT" ]; then
  emit_error "the $VOLUME_NAME volume is empty (no database at $STORE_DB_PATH) — this is a fresh volume, not a generation mismatch (authority quad d)" "$REMEDIATION_START_SERVICE"
  exit 1
fi

# (c) the store's store_generation row equals the authority file's generation.
read_store_generation() {
  set +e
  local out
  out="$(docker exec "$cid" sh -c '
    if command -v sqlite3 >/dev/null 2>&1; then
      n="$(sqlite3 "$1" "SELECT count(*) FROM $2;" 2>/dev/null)"
      [ "$n" = "1" ] || { echo "store_generation rows=$n (expected exactly 1)"; exit 3; }
      sqlite3 "$1" "SELECT id FROM $2;" 2>/dev/null
    else
      node -e "
        const Database = require(\"/opt/ruflo-seed/node_modules/better-sqlite3\");
        const db = new Database(process.argv[1], { readonly: true });
        const rows = db.prepare(\"SELECT id FROM \" + process.argv[2]).all();
        if (rows.length !== 1) { process.stdout.write(\"store_generation rows=\" + rows.length + \" (expected exactly 1)\"); process.exit(3); }
        process.stdout.write(String(rows[0].id));
      " "$1" "$2" 2>/dev/null
    fi
  ' _ "$STORE_DB_PATH" "$STORE_GENERATION_TABLE" 2>&1)"
  local status=$?
  set -e
  printf '%s\t%s' "$status" "$out"
}
_gen_result="$(read_store_generation)"
_gen_status="${_gen_result%%$'\t'*}"
_gen_value="${_gen_result#*$'\t'}"
if [ "$_gen_status" -ne 0 ] || [ -z "$_gen_value" ]; then
  emit_error "could not read store_generation from $STORE_DB_PATH inside $CONTAINER_NAME (authority quad c)" \
"    docker exec $CONTAINER_NAME sh -c 'sqlite3 $STORE_DB_PATH \"SELECT id FROM $STORE_GENERATION_TABLE;\"'
    # if this is a freshly created store, run: $REMEDIATION_START_SERVICE"
  exit 1
fi
if [ "$_gen_value" != "$expected_generation" ]; then
  emit_error "the served store's generation does not match $AUTHORITY_FILE (authority quad c — a forked or restored store)" \
"    expected generation: ${expected_generation:0:12}...
    served   generation: ${_gen_value:0:12}...
    # this is not auto-repaired; see ADR-170 § 5 (Store authority) before proceeding"
  exit 1
fi

# ---- Check 5: per-spawn guard (ADR-170 §§ 4, 7) ----------------------------
# Runs INSIDE the container, immediately before exec, under the server's own
# uid/gid — the per-spawn writability probes and the sibling-lock staleness
# decision. Piped over docker exec's stdin (`node -`) so no file needs to
# exist inside the image ahead of this launcher.
if [ ! -f "$GUARD_SCRIPT" ]; then
  emit_error "scripts/ruflo-launch-guard.mjs is missing from this checkout" \
"    git status scripts/ruflo-launch-guard.mjs
    # this file must be committed alongside scripts/mcp-ruflo-launcher.sh"
  exit 1
fi
set +e
guard_out="$(docker exec -i -w "$SERVICE_CWD" -e RUFLO_GUARD_CLI_PATH="$CLI_PATH" "$cid" node - <"$GUARD_SCRIPT" 2>&1)"
guard_status=$?
set -e
if [ "$guard_status" -ne 0 ]; then
  emit_error "the per-spawn guard refused to authorize a new server" \
"$(printf '%s\n' "$guard_out" | sed 's/^/    /')"
  exit 1
fi

# ---- Success ----------------------------------------------------------------
echo "[ruflo] serving @claude-flow/cli@$served_version from $MAIN_CHECKOUT via $CONTAINER_NAME" >&2

# -w "$SERVICE_CWD" (governance review finding H-3): the guard exec above
# already pins the working directory explicitly; the final exec must match
# it rather than rely on the image's default Config.WorkingDir, which Check
# 2 authenticates but which a future image/compose edit could still change
# out from under this literal exec.
exec docker exec -i -w "$SERVICE_CWD" -e CLAUDE_FLOW_LOG_LEVEL=info -e CLAUDE_FLOW_MEMORY_BACKEND=sqlite "$cid" node "$CLI_PATH" mcp start
