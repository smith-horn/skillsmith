#!/usr/bin/env bash
# SMI-4459 — published MCP server boot smoke. Intentionally minimal per
# plan Q8: we only verify --version exits 0 and prints a semver. Deeper
# round-trip (spawning + list_tools) is SMI-4460 territory.

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"

SMOKE_MCP_PKG="${SMOKE_MCP_PKG:-@skillsmith/mcp-server}"
SMOKE_MCP_TIMEOUT="${SMOKE_MCP_TIMEOUT:-90}"

check_mcp_server_version_exits_zero() {
  local t0 t1 ms tmp out rc
  t0=$(now_ms)
  tmp=$(mktemp -d)
  set +e
  out=$(cd "$tmp" && timeout "$SMOKE_MCP_TIMEOUT" npx -y "${SMOKE_MCP_PKG}@latest" --version 2>&1)
  rc=$?
  set -e
  rm -rf "$tmp"
  t1=$(now_ms)
  ms=$((t1 - t0))

  if [ "$rc" -ne 0 ]; then
    local snippet="${out:0:200}"
    report_fail "mcp-server-published" "check_mcp_server_version_exits_zero" "npx ${SMOKE_MCP_PKG}@latest --version" "exit 0" "exit $rc: $snippet" "$ms"
    return 1
  fi
  if ! printf '%s' "$out" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
    report_fail "mcp-server-published" "check_mcp_server_version_exits_zero" "npx ${SMOKE_MCP_PKG}@latest --version" "semver" "${out:0:80}" "$ms"
    return 1
  fi
  report_pass "mcp-server-published" "check_mcp_server_version_exits_zero" "npx ${SMOKE_MCP_PKG}@latest --version" "$ms"
  return 0
}
