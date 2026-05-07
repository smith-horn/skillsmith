#!/usr/bin/env bash
#
# repair-host-native-deps.sh - Idempotent host-side native binding repair (SMI-4549)
#
# The SMI-4381 worktree workflow uses `npm install --ignore-scripts` on the
# host, which skips node-gyp postinstall and leaves host-only consumers
# (the retrieval-logs writer in particular, packages/doc-retrieval-mcp/src/
# retrieval-log/writer.ts) without their compiled native bindings. The
# writer's openDb() silently catches the load error → logRetrievalEvent
# no-ops → instrumentation disappears for days. SMI-4549 RCA documents the
# 7-day soak that ran with zero captured rows.
#
# This script restores the binding. It is intentionally CHEAP on a healthy
# host: the first step is a require() probe that exits in <1s with [skip]
# when the binding already loads. Only on probe failure does it call
# `npm rebuild`.
#
# Host-only. Inside the Docker dev container (IS_DOCKER=true) the writer
# itself no-ops, and Docker's own postinstall handles its bindings — this
# script exits early so it doesn't fight that path.
#
# Usage:  ./scripts/repair-host-native-deps.sh
# Exit:   0 on success ([ok] or [skip]); non-zero with remediation hint on failure.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [[ -z "$REPO_ROOT" ]]; then
  error "Not in a git repository."
fi

# Resolve to main repo if invoked from a worktree (writer's binding lives in
# the main-repo node_modules; per-package symlinks resolve to it via SMI-4381).
MAIN_GIT_DIR="$(get_main_git_dir "$REPO_ROOT")"
if [[ "$MAIN_GIT_DIR" != "$REPO_ROOT/.git" ]] && [[ -n "$MAIN_GIT_DIR" ]]; then
  REPO_ROOT="$(dirname "$MAIN_GIT_DIR")"
fi

# Guard 1: don't run inside Docker — the container has its own postinstall path.
if [[ "${IS_DOCKER:-}" == "true" ]] || [[ -f /.dockerenv ]]; then
  printf '[skip] inside Docker — host-only script; container handles its own postinstall\n'
  exit 0
fi

cd "$REPO_ROOT"

probe_binding() {
  # Returns 0 if better-sqlite3 loads AND can open a database, non-zero otherwise.
  # The require() alone only loads the JS wrapper — the bindings() lookup
  # for the native .node file fires on `new Database(...)`. Without the open
  # call, a host with a missing binding probes green and bypasses the rebuild.
  # Stderr swallowed — callers print their own diagnostics on failure.
  # Optional first arg: cwd to probe from (defaults to current dir). This lets
  # the script probe workspace-local copies in packages/<pkg>/node_modules/.
  local probe_cwd="${1:-$PWD}"
  (cd "$probe_cwd" && node -e "const D=require('better-sqlite3'); new D(':memory:').close()" >/dev/null 2>&1)
}

# Workspace-local better-sqlite3 copies. SMI-4702 retro learning:
# `npm rebuild` at the workspace root only rebuilds the root copy. Packages
# that have their own `node_modules/better-sqlite3` (because better-sqlite3
# is a direct dep, not hoisted) keep stale binaries until rebuilt
# explicitly. mcp-server and enterprise hoist to root and don't need this.
WORKSPACE_BSQLITE_DIRS=(
  "packages/core/node_modules/better-sqlite3"
  "packages/doc-retrieval-mcp/node_modules/better-sqlite3"
)

probe_workspace_bindings() {
  # Returns 0 only if EVERY workspace-local copy that exists also loads.
  # Missing dirs are not failures — that workspace doesn't have a local copy.
  local d
  for d in "${WORKSPACE_BSQLITE_DIRS[@]}"; do
    if [[ -d "$d" ]]; then
      if ! probe_binding "$d"; then
        return 1
      fi
    fi
  done
  return 0
}

# Guard 2: cheap healthy-path probe. Should be the FIRST thing this script
# does so that calls from repair-worktrees.sh stay sub-second on a healthy host.
# SMI-4702 retro: also probe workspace-local copies; the root probe being
# green doesn't mean packages/<pkg>/node_modules/better-sqlite3 are healthy.
if probe_binding && probe_workspace_bindings; then
  printf '[skip] better-sqlite3 binding already loaded (root + workspace-local)\n'
  exit 0
fi

# Guard 3: Node version sanity — npm rebuild compiles against the *current*
# Node's headers, but the user may be running a Node that doesn't match the
# project's pin. Building against the wrong ABI succeeds and then fails on
# load, which is exactly the failure shape we're trying to prevent recurring.
NODE_CURRENT="$(node --version | sed 's/^v//')"
NODE_PINNED=""
if [[ -f .nvmrc ]]; then
  NODE_PINNED="$(tr -d '[:space:]' < .nvmrc)"
fi

if [[ -n "$NODE_PINNED" ]]; then
  # .nvmrc may be a partial version (e.g. "22.22"); accept any current Node
  # whose version starts with the pinned prefix.
  if [[ "$NODE_CURRENT" != "$NODE_PINNED"* ]]; then
    error "Node version mismatch: current $NODE_CURRENT, pinned $NODE_PINNED (.nvmrc).

  Switch to the pinned Node before rebuilding:
    nvm use            # reads .nvmrc
  Then re-run:
    ./scripts/repair-host-native-deps.sh"
  fi
fi

info "better-sqlite3 binding missing/broken; rebuilding from source..."
info "(this can take 30-60s on first run)"

# Capture rebuild output so we can show the tail on failure without flooding
# the caller's terminal on success.
REBUILD_LOG="$(mktemp -t skillsmith-rebuild-better-sqlite3.XXXXXX)"
trap 'rm -f "$REBUILD_LOG"' EXIT

if ! npm rebuild better-sqlite3 --build-from-source >"$REBUILD_LOG" 2>&1; then
  printf '\n--- npm rebuild output (tail) ---\n'
  tail -20 "$REBUILD_LOG"
  printf '\n'
  error "npm rebuild better-sqlite3 failed.

  Common causes:
    - missing build toolchain (Xcode CLT on macOS, build-essential on Linux)
    - Node header download failure (corporate proxy / offline)
    - C++ toolchain version mismatch

  Diagnose:
    cat $REBUILD_LOG
  Then re-run this script."
fi

# Re-probe — building succeeded, but did the binding actually load?
#
# SMI-4780: `npm rebuild better-sqlite3 --build-from-source` reports exit 0 and
# stdout claims a successful rebuild, but on macOS Docker Desktop the binary
# at build/Release/better_sqlite3.node sometimes isn't actually written. The
# v0.6.0 / v0.5.0 release session (2026-05-06) hit this and only recovered
# by running `cd node_modules/better-sqlite3 && npm run build-release`
# directly — same fallback the workspace-local loop already uses below.
#
# Apply the same fallback at the root level before erroring out: drop the
# stale binary, run `npm run build-release` from inside the package, then
# re-probe. Only if THAT also fails do we surface the ABI mismatch error.
ROOT_BSQLITE_DIR="node_modules/better-sqlite3"
if ! probe_binding; then
  if [[ -d "$ROOT_BSQLITE_DIR" ]]; then
    info "root npm rebuild reported success but binding still missing"
    info "  → applying SMI-4780 fallback: build-release from inside $ROOT_BSQLITE_DIR"
    FALLBACK_LOG="$(mktemp -t skillsmith-rebuild-root-fallback.XXXXXX)"
    if (cd "$ROOT_BSQLITE_DIR" && rm -f build/Release/better_sqlite3.node && npm run build-release) >"$FALLBACK_LOG" 2>&1; then
      rm -f "$FALLBACK_LOG"
    else
      printf '\n--- root build-release fallback output (tail) ---\n'
      tail -20 "$FALLBACK_LOG"
      printf '\n'
      rm -f "$FALLBACK_LOG"
    fi
  fi
fi

if ! probe_binding; then
  printf '\n--- npm rebuild output (tail) ---\n'
  tail -20 "$REBUILD_LOG"
  printf '\n'
  error "rebuild completed but require('better-sqlite3') still fails.

  This usually means the rebuild produced a binary for a different Node ABI
  than the one currently running. Confirm:
    node -p \"process.versions.modules\"
  matches the binding path under node_modules/better-sqlite3/lib/binding/.

  Then:
    rm -rf node_modules/better-sqlite3
    npm install better-sqlite3
    ./scripts/repair-host-native-deps.sh"
fi

printf '[ok] better-sqlite3 binding loaded (root)\n'

# SMI-4702 retro: workspace-local copies. Rebuild any that fail to load.
# This MUST run after the root rebuild because it builds against the same
# Node ABI, and we already validated the toolchain works on the root copy.
WORKSPACE_REBUILT=0
WORKSPACE_FAILED=()
for d in "${WORKSPACE_BSQLITE_DIRS[@]}"; do
  if [[ ! -d "$d" ]]; then
    continue
  fi
  if probe_binding "$d"; then
    continue
  fi
  info "rebuilding workspace-local copy: $d"
  WORKSPACE_LOG="$(mktemp -t skillsmith-rebuild-ws-bsqlite3.XXXXXX)"
  if ! (cd "$d" && rm -f build/Release/better_sqlite3.node && npm run build-release) >"$WORKSPACE_LOG" 2>&1; then
    printf '\n--- workspace rebuild output (tail, %s) ---\n' "$d"
    tail -20 "$WORKSPACE_LOG"
    printf '\n'
    WORKSPACE_FAILED+=("$d")
    rm -f "$WORKSPACE_LOG"
    continue
  fi
  rm -f "$WORKSPACE_LOG"
  if ! probe_binding "$d"; then
    WORKSPACE_FAILED+=("$d")
    continue
  fi
  WORKSPACE_REBUILT=$((WORKSPACE_REBUILT + 1))
  printf '[ok] better-sqlite3 binding loaded (%s)\n' "$d"
done

if [[ ${#WORKSPACE_FAILED[@]} -gt 0 ]]; then
  error "Workspace-local rebuild failed for: ${WORKSPACE_FAILED[*]}.

  Manual recovery:
    cd <failed-dir> && rm -rf build && npm run build-release
  Then re-run this script."
fi

if [[ "$WORKSPACE_REBUILT" -gt 0 ]]; then
  printf '[ok] %d workspace-local copy/copies rebuilt\n' "$WORKSPACE_REBUILT"
fi
