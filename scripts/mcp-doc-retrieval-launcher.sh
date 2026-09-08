#!/usr/bin/env bash
#
# Launcher for the skillsmith-doc-retrieval MCP server (SMI-5718).
#
# Sibling to scripts/mcp-skillsmith-launcher.sh (SMI-5451) — same contract,
# adapted for this server: doc-retrieval-mcp depends on the native module
# better-sqlite3 (CLAUDE.md Docker-First Development), so it runs INSIDE
# the container (`docker exec ... node .../server.js`), not on the host
# directly like `skillsmith`'s launcher does. If you change the probe
# contract here, check whether mcp-skillsmith-launcher.sh needs the same
# change — the two scripts are intentionally duplicated (not extracted into
# a shared lib; see the plan's Open Questions) and can drift.
#
# This wrapper detects four states and prints an actionable message to
# stderr (surfaced in the MCP host's per-server log expansion) before
# invoking Node:
#   0. the skillsmith-dev-1 container is not running (new — doc-retrieval-mcp
#      is Docker-only, so `docker exec` itself fails opaquely otherwise)
#   1. node_modules/ not installed (root sentinel missing)
#   2. packages/doc-retrieval-mcp/dist/src/server.js not built
#   3. a runtime dependency of @skillsmith/doc-retrieval-mcp that cannot
#      resolve from the dist entry: an empty/corrupt nested dir shadowing
#      the hoisted copy (the SMI-5452 hazard — the trigger for the SMI-5718
#      incident this launcher exists to guard against), a missing package,
#      an unbuilt @skillsmith/* workspace dep, or a missing/corrupt
#      root-hoisted zod-to-json-schema (a new transitive dependency the
#      SMI-5718 code hardening makes load-bearing — see the plan's "New
#      transitive-dependency exposure" section).
#
# The dependency probe (check 3) runs in ESM context with cwd at the dist
# entry dir, INSIDE THE CONTAINER via `docker exec` (SMI-6453). `/app/node_modules`
# and every `/app/packages/*/node_modules` are NAMED VOLUMES (docker-compose.yml
# SMI-5957 correction #5), which shadow the `.:/app` bind mount at exactly
# those paths — the host directory and the container directory are
# independent filesystems, so a host-side probe inspects bytes the server
# never loads (false positives on host-only debris, false negatives on
# container-only corruption). Only `dist/` is still plain bind-mounted (host
# == container), which is why check 2 stays host-side.
#
# Probe failure semantics (mirrors SMI-5451 M5):
#   - confirmed unresolvable dependency -> fail-closed (exit 1, per-state
#     remediation). @skillsmith/* workspace deps are symlinks to real
#     source, so their remediation is npm install + build — NEVER rm -rf.
#   - probe infrastructure error (unreadable package.json, unexpected
#     exception, probe syntax error) -> fail-open with a stderr warning;
#     a bug in the check must not brick the MCP server.
#
# Canonical path source: packages/doc-retrieval-mcp/package.json `main`/`bin`.
# Container name source: docker-compose.yml `container_name`.
#
# References: SMI-5718, SMI-5451 (precedent), SMI-5452 (the trigger hazard),
# SMI-6453 (container-side probe correction).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/doc-retrieval-mcp"
DIST_ENTRY="$PKG_DIR/dist/src/server.js"
CONTAINER_NAME="skillsmith-dev-1"
CONTAINER_APP_ROOT="/app"                                   # docker-compose.yml:40 `.:/app`
CONTAINER_DIST_DIR="$CONTAINER_APP_ROOT/packages/doc-retrieval-mcp/dist/src"
CONTAINER_NM_SENTINEL="$CONTAINER_APP_ROOT/node_modules/.package-lock.json"

# emit_error <state> <remediation-block>
# Tag is [doc-retrieval] throughout (plan-review, VP Design) — distinct from
# mcp-skillsmith-launcher.sh's [skillsmith] tag, and matching the
# [doc-retrieval]-tagged errors jsonSchemaOf() throws in server.ts, so both
# halves of this issue's fix speak with one diagnostic identity.
emit_error() {
  local state="$1"
  local remediation="$2"
  {
    echo "[doc-retrieval] MCP server cannot start: $state."
    echo "[doc-retrieval] Run these commands in the repo root, then reconnect via /mcp:"
    echo ""
    echo "$remediation"
    echo ""
    echo "[doc-retrieval] (See CLAUDE.md > Docker-First Development)"
  } >&2
}

REMEDIATION_START_CONTAINER="    docker compose --profile dev up -d"

REMEDIATION_INSTALL_BUILD="    docker compose --profile dev up -d
    docker exec $CONTAINER_NAME npm install
    docker exec $CONTAINER_NAME npm run build"

# Check 0: container liveness. doc-retrieval-mcp's actual server process
# runs inside the container (native module better-sqlite3), so every
# subsequent check and the final invocation depend on it being up.
if [ -z "$(docker ps --filter "name=^/${CONTAINER_NAME}\$" --filter "status=running" -q 2>/dev/null || true)" ]; then
  emit_error "$CONTAINER_NAME container is not running" "$REMEDIATION_START_CONTAINER"
  exit 1
fi

# Check 1: node_modules installed — CONTAINER-side (SMI-6453). /app/node_modules
# is a named volume (docker-compose.yml:41); the host's node_modules/ is a
# different filesystem from the one server.js loads. No -i (see check 3).
#
# Content-based, not exit-code-based (plan-review finding, GPT-5.6-Sol,
# 2026-09-08): a bare `docker exec … test -f …`'s exit 1 is ambiguous — it is
# also what `docker exec` itself returns on a daemon-level failure (confirmed
# live: `docker exec __nonexistent__ test -f /x` -> exit 1 on this repo's
# Docker CLI, not only 125-127). Check 3 avoids this by gating on the probe's
# own FAIL-line stdout content, not exit code; Check 1 does the same: the
# inner `sh -c` always exits 0 and always emits one of two unambiguous
# tokens when docker exec itself succeeds, so branch on TEXT, never on
# docker exec's raw exit status.
set +e
nm_out="$(docker exec "$CONTAINER_NAME" sh -c '[ -f "$1" ] && echo SMI6453_PRESENT || echo SMI6453_ABSENT' _ "$CONTAINER_NM_SENTINEL" 2>&1)"
nm_status=$?
set -e
if [ "$nm_status" -eq 0 ] && [ "$nm_out" = "SMI6453_ABSENT" ]; then
  emit_error "node_modules missing" "$REMEDIATION_INSTALL_BUILD"
  exit 1
elif [ "$nm_status" -ne 0 ] || [ "$nm_out" != "SMI6453_PRESENT" ]; then
  # Fail-open: docker exec itself failed, or returned something other than
  # our own two known tokens — never trust a bare exit code here.
  echo "[doc-retrieval] preflight warning: could not inspect container node_modules (docker exec status $nm_status, output: $nm_out); continuing." >&2
fi

# Check 2: dist/ built — HOST-side, deliberately. packages/doc-retrieval-mcp/dist
# is under the `.:/app` bind mount and no docker-compose.yml volume targets a
# `dist` path, so host bytes == container bytes here. This check passing is
# what guarantees $CONTAINER_DIST_DIR exists as check 3's probe cwd below.
if [ ! -f "$DIST_ENTRY" ]; then
  emit_error "dist/ missing" "$REMEDIATION_INSTALL_BUILD"
  exit 1
fi

# Check 3: dependency-integrity probe (SMI-5718, mirrors SMI-5451).
# stdout protocol: one "FAIL <name> <state>" line per unresolvable dep,
# exit 1. Exit 0 = all resolve. Exit 2 = probe infrastructure error.
DEP_PROBE_JS='
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repoRoot = process.env.SKILLSMITH_LAUNCHER_REPO_ROOT;
const pkgDir = join(repoRoot, "packages", "doc-retrieval-mcp");

function classify(name, { rootOnly = false } = {}) {
  try {
    const resolved = import.meta.resolve(name);
    if (
      name.startsWith("@skillsmith/") &&
      resolved.startsWith("file:") &&
      !existsSync(fileURLToPath(resolved))
    ) {
      return "unbuilt-workspace";
    }
    return null;
  } catch (err) {
    if (err && err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return null; // intact, no "." export
    if (name.startsWith("@skillsmith/")) return "unbuilt-workspace";
    if (!rootOnly && existsSync(join(pkgDir, "node_modules", name))) return "nested-corrupt";
    if (rootOnly && existsSync(join(repoRoot, "node_modules", name))) return "root-hoisted-corrupt";
    return "missing";
  }
}

let names;
try {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const declared = Object.keys(pkg.dependencies ?? {});
  let nested = [];
  try {
    nested = readdirSync(join(pkgDir, "node_modules"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .flatMap((e) =>
        e.name.startsWith("@")
          ? readdirSync(join(pkgDir, "node_modules", e.name)).map((s) => e.name + "/" + s)
          : [e.name]
      );
  } catch {
    nested = []; // no nested node_modules — nothing extra to check
  }
  names = [...new Set([...declared, ...nested])];
} catch (err) {
  console.error("PROBE_INFRA_ERROR " + (err && err.message ? err.message : err));
  process.exit(2);
}

let failed = false;
for (const name of names) {
  const state = classify(name);
  if (state) {
    console.log("FAIL " + name + " " + state);
    failed = true;
  }
}

// SMI-5718: zod-to-json-schema is not a doc-retrieval-mcp-declared
// dependency — it is a transitive dependency of @modelcontextprotocol/sdk,
// resolved solely via the ROOT-hoisted node_modules (not nested under this
// package). jsonSchemaOf()s v3 conversion path now depends on it being
// resolvable, so it is checked explicitly here rather than relying on the
// declared-deps ∪ nested-node_modules scan above (which would never see it).
const ztjsState = classify("zod-to-json-schema", { rootOnly: true });
if (ztjsState) {
  console.log("FAIL zod-to-json-schema " + ztjsState);
  failed = true;
}

process.exit(failed ? 1 : 0);
'

set +e
# SMI-6453: run INSIDE the container. /app/node_modules and
# /app/packages/*/node_modules are named volumes (docker-compose.yml:41,
# :65-72), so the host's view of those paths is a different filesystem
# from the one server.js resolves against. No -i: never attach the MCP
# host's stdin to a preflight exec.
probe_out="$(docker exec -w "$CONTAINER_DIST_DIR" -e "SKILLSMITH_LAUNCHER_REPO_ROOT=$CONTAINER_APP_ROOT" "$CONTAINER_NAME" node --input-type=module -e "$DEP_PROBE_JS" 2>&1)"
probe_status=$?
set -e

if [ "$probe_status" -eq 1 ] && printf '%s\n' "$probe_out" | grep -q '^FAIL '; then
  first_fail="$(printf '%s\n' "$probe_out" | grep '^FAIL ' | head -1)"
  dep_name="$(printf '%s' "$first_fail" | cut -d' ' -f2)"
  dep_state="$(printf '%s' "$first_fail" | cut -d' ' -f3)"
  case "$dep_state" in
    unbuilt-workspace)
      emit_error "$dep_name dependency unresolvable (workspace package not built)" \
        "$REMEDIATION_INSTALL_BUILD"
      ;;
    nested-corrupt)
      # packages/doc-retrieval-mcp/node_modules is a NAMED VOLUME
      # (docker-compose.yml:67, SMI-5957 correction #5): the host directory at
      # that path is a different filesystem from the container's copy, so the
      # rm -rf must run INSIDE the container, then npm install repopulates the
      # volume (SMI-6453). A host-side rm -rf here was a confirmed no-op.
      emit_error "$dep_name dependency corrupt at packages/doc-retrieval-mcp/node_modules/$dep_name (container-side, not host)" \
"    docker compose --profile dev up -d
    docker exec $CONTAINER_NAME rm -rf $CONTAINER_APP_ROOT/packages/doc-retrieval-mcp/node_modules/$dep_name
    docker exec $CONTAINER_NAME npm install"
      ;;
    root-hoisted-corrupt)
      # Root node_modules is likewise a NAMED VOLUME (docker-compose.yml:41);
      # npm install inside the container repairs the volume directly. No rm -rf
      # is needed for a root-hoisted package (npm reifies over it).
      emit_error "$dep_name dependency corrupt at root node_modules/$dep_name (container-side, not host)" \
"    docker compose --profile dev up -d
    docker exec $CONTAINER_NAME npm install"
      ;;
    *)
      emit_error "$dep_name dependency missing" \
"    docker compose --profile dev up -d
    docker exec $CONTAINER_NAME npm install"
      ;;
  esac
  # Diagnostic: every failing dep, one line each (first drives the message).
  printf '%s\n' "$probe_out" | grep '^FAIL ' | sed 's/^/[doc-retrieval] preflight: /' >&2
  exit 1
elif [ "$probe_status" -ne 0 ]; then
  # Fail-open: the probe itself broke; do not block the server.
  echo "[doc-retrieval] preflight warning: dependency probe failed to run (status $probe_status); continuing. First output: $(printf '%s' "$probe_out" | head -1)" >&2
fi

exec docker exec -i "$CONTAINER_NAME" node "$CONTAINER_DIST_DIR/server.js" "$@"
