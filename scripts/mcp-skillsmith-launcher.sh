#!/usr/bin/env bash
#
# Launcher for the skillsmith MCP server.
#
# Wraps `node packages/mcp-server/dist/src/index.js` with pre-flight checks.
# Node's failure modes for a broken install are opaque MODULE_NOT_FOUND
# crashes that the MCP host swallows and surfaces as "Failed to reconnect
# to skillsmith". This wrapper detects three states and prints an actionable
# message to stderr (which the MCP host's per-server log expansion does
# surface) before invoking Node:
#   1. node_modules/ not installed (root sentinel missing)
#   2. packages/mcp-server/dist/src/index.js not built
#   3. a runtime dependency of @skillsmith/mcp-server that cannot resolve
#      from the dist entry: an empty/corrupt nested dir shadowing the
#      hoisted copy (SMI-5451 incident), a missing package, or an unbuilt
#      @skillsmith/* workspace dep.
#
# The dependency probe (check 3) runs in ESM context with cwd at the dist
# entry dir so its resolution walk matches the server's own imports. CJS
# require() falls through an empty nested dir to the hoisted copy and would
# miss the SMI-5451 incident class; ESM resolution stops at the first
# existing package dir, exactly like the server.
#
# Probe failure semantics (SMI-5451 M5):
#   - confirmed unresolvable dependency -> fail-closed (exit 1, per-state
#     remediation). @skillsmith/* workspace deps are symlinks to real
#     source, so their remediation is npm install + build — NEVER rm -rf.
#   - probe infrastructure error (unreadable package.json, unexpected
#     exception, probe syntax error) -> fail-open with a stderr warning;
#     a bug in the check must not brick the MCP server.
#
# Canonical path source: packages/mcp-server/package.json `main` / `bin`.
# Sibling sentinel: docker-entrypoint.sh:42 (in-container coverage, SMI-2621).
#
# References: SMI-5049, SMI-5451, GitHub issue smith-horn/skillsmith#1260.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_ENTRY="$REPO_ROOT/packages/mcp-server/dist/src/index.js"
DIST_DIR="$REPO_ROOT/packages/mcp-server/dist/src"
NM_SENTINEL="$REPO_ROOT/node_modules/.package-lock.json"

# emit_error <state> <remediation-block>
# Keeps the "MCP server cannot start:" prefix — tests assert on it.
emit_error() {
  local state="$1"
  local remediation="$2"
  {
    echo "[skillsmith] MCP server cannot start: $state."
    echo "[skillsmith] Run these commands in the repo root, then reconnect via /mcp:"
    echo ""
    echo "$remediation"
    echo ""
    echo "[skillsmith] (See CLAUDE.md > Docker-First Development)"
  } >&2
}

REMEDIATION_INSTALL_BUILD="    docker compose --profile dev up -d
    docker exec skillsmith-dev-1 npm install
    docker exec skillsmith-dev-1 npm run build"

if [ ! -f "$NM_SENTINEL" ]; then
  emit_error "node_modules missing" "$REMEDIATION_INSTALL_BUILD"
  exit 1
fi

if [ ! -f "$DIST_ENTRY" ]; then
  emit_error "dist/ missing" "$REMEDIATION_INSTALL_BUILD"
  exit 1
fi

# Check 3: dependency-integrity probe (SMI-5451).
# stdout protocol: one "FAIL <name> <state>" line per unresolvable dep,
# exit 1. Exit 0 = all resolve. Exit 2 = probe infrastructure error.
DEP_PROBE_JS='
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const pkgDir = join(process.env.SKILLSMITH_LAUNCHER_REPO_ROOT, "packages", "mcp-server");

function classify(name) {
  try {
    const resolved = import.meta.resolve(name);
    // Existence of the resolved target is only checked for @skillsmith/*
    // workspace deps (exports maps are not stat-checked by resolution, and
    // a missing file there means "not built"). Third-party packages may
    // ship a phantom "." export while being consumed via subpaths only —
    // @modelcontextprotocol/sdk resolves "." to a non-existent
    // dist/esm/index.js — so resolution success is the health signal there.
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
    if (existsSync(join(pkgDir, "node_modules", name))) return "nested-corrupt";
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
process.exit(failed ? 1 : 0);
'

set +e
probe_out="$(cd "$DIST_DIR" && SKILLSMITH_LAUNCHER_REPO_ROOT="$REPO_ROOT" node --input-type=module -e "$DEP_PROBE_JS" 2>&1)"
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
      emit_error "$dep_name dependency corrupt at packages/mcp-server/node_modules/$dep_name" \
"    docker compose --profile dev up -d
    rm -rf packages/mcp-server/node_modules/$dep_name
    docker exec skillsmith-dev-1 npm install"
      ;;
    *)
      emit_error "$dep_name dependency missing" \
"    docker compose --profile dev up -d
    docker exec skillsmith-dev-1 npm install"
      ;;
  esac
  # Diagnostic: every failing dep, one line each (first drives the message).
  printf '%s\n' "$probe_out" | grep '^FAIL ' | sed 's/^/[skillsmith] preflight: /' >&2
  exit 1
elif [ "$probe_status" -ne 0 ]; then
  # Fail-open: the probe itself broke; do not block the server (SMI-5451 M5).
  echo "[skillsmith] preflight warning: dependency probe failed to run (status $probe_status); continuing. First output: $(printf '%s' "$probe_out" | head -1)" >&2
fi

exec node "$DIST_ENTRY" "$@"
