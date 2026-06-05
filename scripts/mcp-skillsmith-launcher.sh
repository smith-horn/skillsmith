#!/usr/bin/env bash
#
# Launcher for the skillsmith MCP server.
#
# Wraps `node packages/mcp-server/dist/src/index.js` with a pre-flight check.
# When dist/ or node_modules/ is absent (fresh clone, wiped Docker volume,
# container never started), Node prints an opaque MODULE_NOT_FOUND error that
# the MCP host swallows and surfaces as "Failed to reconnect to skillsmith".
# This wrapper prints an actionable message to stderr (which the MCP host's
# per-server log expansion does surface) and exits 1 before invoking Node.
#
# Canonical path source: packages/mcp-server/package.json `main` / `bin`.
# Sibling sentinel: docker-entrypoint.sh:42 (in-container coverage, SMI-2621).
#
# References: SMI-5049, GitHub issue smith-horn/skillsmith#1260.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_ENTRY="$SCRIPT_DIR/packages/mcp-server/dist/src/index.js"
NM_SENTINEL="$SCRIPT_DIR/node_modules/.package-lock.json"

emit_error() {
  local missing="$1"
  {
    echo "[skillsmith] MCP server cannot start: $missing missing."
    echo "[skillsmith] Run these commands in the repo root, then reconnect via /mcp:"
    echo ""
    echo "    docker compose --profile dev up -d"
    echo "    docker exec skillsmith-dev-1 npm install"
    echo "    docker exec skillsmith-dev-1 npm run build"
    echo ""
    echo "[skillsmith] (See CLAUDE.md > Docker-First Development)"
  } >&2
}

if [ ! -f "$NM_SENTINEL" ]; then
  emit_error "node_modules"
  exit 1
fi

if [ ! -f "$DIST_ENTRY" ]; then
  emit_error "dist/"
  exit 1
fi

exec node "$DIST_ENTRY" "$@"
