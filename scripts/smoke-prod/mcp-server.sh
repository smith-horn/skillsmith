#!/usr/bin/env bash
# SMI-4459 — published MCP server boot smoke.
# SMI-4590 Wave 4 PR 5/6 — extended with audit-tool registration checks.
#
# SMI-5620 — the version check now shares the same cached install as the
# three audit-tool checks instead of its own `npx -y -p ...@latest` fetch
# (npx re-resolves the registry on every call, so a per-check npx was
# paying the install cost 4x on top of the flakiness of an npx-managed
# temp cache). All four checks now install the published tarball into a
# temp prefix once, then either invoke the installed bin directly or grep
# the compiled tool-dispatch artifact for the registered tool names. The
# grep-based checks catch packaging regressions where a tool source file
# lands in src/ but is excluded from `files` in package.json (the exact
# failure mode that the post-deploy harness is meant to surface). A deeper
# JSON-RPC round-trip is SMI-4460 territory.

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"

SMOKE_MCP_PKG="${SMOKE_MCP_PKG:-@skillsmith/mcp-server}"
SMOKE_MCP_TIMEOUT="${SMOKE_MCP_TIMEOUT:-90}"

# Cached install prefix shared by audit-tool checks. Lazily populated by
# `_smoke_mcp_install_once` so we pay the npm-install cost once per surface
# run rather than four times. We register an EXIT trap to clean it up
# unconditionally (success OR failure), since lib.sh does not own tmp
# cleanup and CI runners may share /tmp across surface modules.
SMOKE_MCP_INSTALL_DIR=""

_smoke_mcp_cleanup() {
  if [ -n "$SMOKE_MCP_INSTALL_DIR" ] && [ -d "$SMOKE_MCP_INSTALL_DIR" ]; then
    rm -rf "$SMOKE_MCP_INSTALL_DIR"
    SMOKE_MCP_INSTALL_DIR=""
  fi
}
# Append (don't overwrite) so other smoke modules' EXIT traps still fire.
trap '_smoke_mcp_cleanup' EXIT

# Lazily install the published mcp-server tarball into a shared temp prefix.
# Subsequent calls reuse the cached install. Sets the global
# $SMOKE_MCP_INSTALL_DIR to the install root; does NOT echo it. Returns 1 on
# install failure (after recording a per-check failure via report_fail).
#
# SMI-5620: callers MUST invoke this directly (`_smoke_mcp_install_once ...
# || return 1` then read `$SMOKE_MCP_INSTALL_DIR`) and must NEVER wrap the
# call in a command substitution (`install=$(_smoke_mcp_install_once ...)`).
# Command substitution forks a subshell, which silently discards BOTH the
# `SMOKE_MCP_INSTALL_DIR="$prefix"` assignment below (so the cache never
# actually got reused — every check paid a full npm install) AND, more
# seriously, the `report_fail` call on the install-failure path below (so a
# real install failure never reached SMOKE_FAIL_COUNT / the JSON report —
# confirmed live: a run with `timeout: command not found` failing every
# install still reported fail=0 for this surface). No echo/printf of the
# install path on stdout, deliberately — this function's stdout must stay
# clean since `smoke-prod.sh --json` writes the report to stdout.
#
# Args: $1=surface-id $2=check-name (used for failure attribution).
_smoke_mcp_install_once() {
  local surface="$1"
  local check="$2"
  if [ -n "$SMOKE_MCP_INSTALL_DIR" ] && [ -d "$SMOKE_MCP_INSTALL_DIR/node_modules" ]; then
    return 0
  fi
  local prefix
  prefix=$(mktemp -d)
  local install_log
  install_log=$(mktemp)
  set +e
  ( cd "$prefix" && timeout "$SMOKE_MCP_TIMEOUT" \
      npm install --silent --no-audit --no-fund --prefix "$prefix" \
      "${SMOKE_MCP_PKG}@latest" >"$install_log" 2>&1 )
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    local snippet
    snippet=$(head -c 200 "$install_log" 2>/dev/null || true)
    rm -rf "$prefix" "$install_log"
    report_fail "$surface" "$check" "npm install ${SMOKE_MCP_PKG}@latest" "exit 0" "exit $rc: $snippet" "0"
    return 1
  fi
  rm -f "$install_log"
  SMOKE_MCP_INSTALL_DIR="$prefix"
  return 0
}

check_mcp_server_version_exits_zero() {
  local t0 t1 ms install bin out rc
  t0=$(now_ms)
  _smoke_mcp_install_once "mcp-server-published" "check_mcp_server_version_exits_zero" || return 1
  install="$SMOKE_MCP_INSTALL_DIR"
  bin="$install/node_modules/.bin/skillsmith-mcp"
  set +e
  out=$(timeout "$SMOKE_MCP_TIMEOUT" "$bin" --version 2>&1)
  rc=$?
  set -e
  t1=$(now_ms)
  ms=$((t1 - t0))

  if [ "$rc" -ne 0 ]; then
    local snippet="${out:0:200}"
    report_fail "mcp-server-published" "check_mcp_server_version_exits_zero" "skillsmith-mcp --version (cached install)" "exit 0" "exit $rc: $snippet" "$ms"
    return 1
  fi
  if ! printf '%s' "$out" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
    report_fail "mcp-server-published" "check_mcp_server_version_exits_zero" "skillsmith-mcp --version (cached install)" "semver" "${out:0:80}" "$ms"
    return 1
  fi
  report_pass "mcp-server-published" "check_mcp_server_version_exits_zero" "skillsmith-mcp --version (cached install)" "$ms"
  return 0
}

# SMI-4590 Wave 4 PR 5/6 — verify `skill_inventory_audit` ships in the
# published tarball. Greps the compiled `audit-tool-dispatch.js` for the
# tool name string registered in `buildAuditToolNames`.
check_skill_inventory_audit_tool_listed() {
  local t0 t1 ms install dispatch
  t0=$(now_ms)
  _smoke_mcp_install_once "mcp-server-published" "check_skill_inventory_audit_tool_listed" || return 1
  install="$SMOKE_MCP_INSTALL_DIR"
  dispatch="$install/node_modules/${SMOKE_MCP_PKG}/dist/src/audit-tool-dispatch.js"
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ ! -f "$dispatch" ]; then
    report_fail "mcp-server-published" "check_skill_inventory_audit_tool_listed" "stat ${dispatch#"$install/node_modules/"}" "file present" "missing" "$ms"
    return 1
  fi
  if ! grep -q "'skill_inventory_audit'" "$dispatch"; then
    report_fail "mcp-server-published" "check_skill_inventory_audit_tool_listed" "grep skill_inventory_audit" "string present" "missing in dispatch" "$ms"
    return 1
  fi
  report_pass "mcp-server-published" "check_skill_inventory_audit_tool_listed" "grep skill_inventory_audit" "$ms"
  return 0
}

# SMI-4590 Wave 4 PR 5/6 — verify `apply_namespace_rename` ships.
check_apply_namespace_rename_tool_listed() {
  local t0 t1 ms install dispatch
  t0=$(now_ms)
  _smoke_mcp_install_once "mcp-server-published" "check_apply_namespace_rename_tool_listed" || return 1
  install="$SMOKE_MCP_INSTALL_DIR"
  dispatch="$install/node_modules/${SMOKE_MCP_PKG}/dist/src/audit-tool-dispatch.js"
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ ! -f "$dispatch" ]; then
    report_fail "mcp-server-published" "check_apply_namespace_rename_tool_listed" "stat audit-tool-dispatch.js" "file present" "missing" "$ms"
    return 1
  fi
  if ! grep -q "'apply_namespace_rename'" "$dispatch"; then
    report_fail "mcp-server-published" "check_apply_namespace_rename_tool_listed" "grep apply_namespace_rename" "string present" "missing in dispatch" "$ms"
    return 1
  fi
  report_pass "mcp-server-published" "check_apply_namespace_rename_tool_listed" "grep apply_namespace_rename" "$ms"
  return 0
}

# SMI-4590 Wave 4 PR 5/6 — verify `apply_recommended_edit` is conditionally
# registered. The dispatcher source MUST contain the conditional push
# referencing APPLY_TEMPLATE_REGISTRY (the exact registration mechanism).
# This catches a published artifact where the conditional registration was
# accidentally hoisted to unconditional or removed entirely.
check_apply_recommended_edit_conditional() {
  local t0 t1 ms install dispatch
  t0=$(now_ms)
  _smoke_mcp_install_once "mcp-server-published" "check_apply_recommended_edit_conditional" || return 1
  install="$SMOKE_MCP_INSTALL_DIR"
  dispatch="$install/node_modules/${SMOKE_MCP_PKG}/dist/src/audit-tool-dispatch.js"
  t1=$(now_ms)
  ms=$((t1 - t0))
  if [ ! -f "$dispatch" ]; then
    report_fail "mcp-server-published" "check_apply_recommended_edit_conditional" "stat audit-tool-dispatch.js" "file present" "missing" "$ms"
    return 1
  fi
  if ! grep -q "'apply_recommended_edit'" "$dispatch"; then
    report_fail "mcp-server-published" "check_apply_recommended_edit_conditional" "grep apply_recommended_edit" "string present" "missing in dispatch" "$ms"
    return 1
  fi
  if ! grep -q "APPLY_TEMPLATE_REGISTRY" "$dispatch"; then
    report_fail "mcp-server-published" "check_apply_recommended_edit_conditional" "grep APPLY_TEMPLATE_REGISTRY" "conditional gate present" "missing — registration may be unconditional" "$ms"
    return 1
  fi
  report_pass "mcp-server-published" "check_apply_recommended_edit_conditional" "grep apply_recommended_edit + APPLY_TEMPLATE_REGISTRY" "$ms"
  return 0
}
