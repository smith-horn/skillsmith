#!/usr/bin/env bash
# SMI-4459 — published CLI smoke checks.
# Boot smoke ONLY (per plan-review Edit 3). We deliberately do NOT regex
# the source for command names — that misses commands registered via
# program.addCommand(createXxxCommand()) factories. Instead, we verify the
# published binary boots (--help exits 0 and lists at least one command;
# --version exits 0 and prints a semver). The R-1 audit-standards check
# (Section 31) covers source-vs-hint drift at lint time; this surface
# verifies the binary itself is reachable + runnable on npm.

# shellcheck shell=bash
# shellcheck source=scripts/smoke-prod/lib.sh
SMOKE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SMOKE_LIB_DIR/lib.sh"

SMOKE_CLI_PKG="${SMOKE_CLI_PKG:-@skillsmith/cli}"
# Bound npx — fresh-install can pull large native deps (better-sqlite3,
# onnxruntime-node), so we allow up to 90s here. The orchestrator's 60s
# total budget still caps the run; this is the per-check ceiling.
SMOKE_CLI_TIMEOUT="${SMOKE_CLI_TIMEOUT:-90}"

# ---- check_cli_help_lists_known_commands ------------------------------
# Runs `npx -y @skillsmith/cli@latest --help` in a clean tmpdir. Asserts:
#   1. exit 0
#   2. stdout contains a "Commands:" section header (Commander.js convention)
#   3. at least one indented command line follows
check_cli_help_lists_known_commands() {
  local t0 t1 ms tmp out rc
  t0=$(now_ms)
  tmp=$(mktemp -d)
  set +e
  out=$(cd "$tmp" && timeout "$SMOKE_CLI_TIMEOUT" npx -y "${SMOKE_CLI_PKG}@latest" --help 2>&1)
  rc=$?
  set -e
  rm -rf "$tmp"
  t1=$(now_ms)
  ms=$((t1 - t0))

  if [ "$rc" -ne 0 ]; then
    local snippet="${out:0:200}"
    report_fail "cli-published" "check_cli_help_lists_known_commands" "npx ${SMOKE_CLI_PKG}@latest --help" "exit 0" "exit $rc: $snippet" "$ms"
    return 1
  fi
  if ! printf '%s' "$out" | grep -q '^Commands:'; then
    report_fail "cli-published" "check_cli_help_lists_known_commands" "npx ${SMOKE_CLI_PKG}@latest --help" "Commands: section" "missing-commands-section" "$ms"
    return 1
  fi
  # At least one indented command-name token after "Commands:".
  if ! printf '%s' "$out" | awk '/^Commands:/{flag=1;next} flag && /^[[:space:]]+[a-z]/{found=1; exit} END{exit !found}'; then
    report_fail "cli-published" "check_cli_help_lists_known_commands" "npx ${SMOKE_CLI_PKG}@latest --help" "≥1 command listed" "no-commands-after-section" "$ms"
    return 1
  fi
  report_pass "cli-published" "check_cli_help_lists_known_commands" "npx ${SMOKE_CLI_PKG}@latest --help" "$ms"
  return 0
}

# ---- check_cli_version_exits_zero ------------------------------------
# Smallest possible smoke: --version exits 0 and stdout contains a semver.
check_cli_version_exits_zero() {
  local t0 t1 ms tmp out rc
  t0=$(now_ms)
  tmp=$(mktemp -d)
  set +e
  out=$(cd "$tmp" && timeout "$SMOKE_CLI_TIMEOUT" npx -y "${SMOKE_CLI_PKG}@latest" --version 2>&1)
  rc=$?
  set -e
  rm -rf "$tmp"
  t1=$(now_ms)
  ms=$((t1 - t0))

  if [ "$rc" -ne 0 ]; then
    local snippet="${out:0:200}"
    report_fail "cli-published" "check_cli_version_exits_zero" "npx ${SMOKE_CLI_PKG}@latest --version" "exit 0" "exit $rc: $snippet" "$ms"
    return 1
  fi
  if ! printf '%s' "$out" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
    report_fail "cli-published" "check_cli_version_exits_zero" "npx ${SMOKE_CLI_PKG}@latest --version" "semver" "${out:0:80}" "$ms"
    return 1
  fi
  report_pass "cli-published" "check_cli_version_exits_zero" "npx ${SMOKE_CLI_PKG}@latest --version" "$ms"
  return 0
}
