#!/usr/bin/env bash
# scripts/regen-lockfile.sh
# SMI-5513: Regenerate package-lock.json (and sync node_modules) WITHOUT wiping
# the container's native bindings.
#
# The trap this replaces: a bare `docker exec skillsmith-dev-1 npm install`
# regenerates the lockfile but, with .npmrc ignore-scripts=true, leaves
# better-sqlite3 unbuilt ("invalid ELF header") — surfacing later as ~51 cryptic
# db.close()-on-undefined test failures. (The pre-push native guard,
# scripts/lib/check-native-modules.sh, catches that; this helper avoids it.)
#
# Default: full safe sync — container `npm install` + rebuild native modules
#   (build scripts enabled) + VERIFY via the real consumer (@skillsmith/core) +
#   host `npm install` + host native repair + refresh the deps-freshness sentinel.
# --lockfile-only: `npm install --package-lock-only` — regenerates only the
#   lockfile; node_modules is untouched (so natives cannot be wiped) and the
#   freshness sentinel is deliberately NOT refreshed (node_modules is now stale
#   vs the lockfile; the pre-push freshness guard will remind you to sync).
#
# Prerequisites: Docker container running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

CONTAINER="skillsmith-dev-1"
NATIVE_MODULES="better-sqlite3 onnxruntime-node esbuild hnswlib-node"
LOCKFILE_ONLY=false

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --lockfile-only) LOCKFILE_ONLY=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) error "Unknown argument: $arg (run with --help)" ;;
  esac
done

# Consumer-path native probe (resolves whichever better-sqlite3 copy core uses;
# the sync path has no WASM fallback, so a broken binding fails loudly).
verify_container_native() {
  docker exec "$CONTAINER" node -e \
    "require('@skillsmith/core').createDatabaseSync(':memory:').close()" >/dev/null 2>&1
}

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  error "Dev container '$CONTAINER' is not running. Start: docker compose --profile dev up -d"
fi

if $LOCKFILE_ONLY; then
  info "Regenerating package-lock.json (lockfile only — node_modules untouched)…"
  docker exec "$CONTAINER" npm install --package-lock-only --ignore-scripts
  if git diff --quiet package-lock.json 2>/dev/null; then
    success "Lockfile already up to date."
  else
    git --no-pager diff --stat package-lock.json
    warn "node_modules is now stale vs the lockfile. The pre-push freshness guard"
    warn "will block a push until you sync. Re-run WITHOUT --lockfile-only to sync"
    warn "node_modules + heal natives, or commit a lockfile-only PR (CI installs fresh)."
  fi
  exit 0
fi

# ---- Full safe sync ----
info "Regenerating lockfile + syncing container node_modules…"
docker exec "$CONTAINER" npm install

info "Rebuilding native modules with build scripts (the anti-wipe step)…"
# shellcheck disable=SC2086
docker exec "$CONTAINER" npm rebuild $NATIVE_MODULES --ignore-scripts=false

info "Verifying the native binding via its real consumer (@skillsmith/core)…"
if ! verify_container_native; then
  error "better-sqlite3 is still broken after rebuild (a non-hoisted workspace copy may need it). Run: docker compose --profile dev restart dev"
fi
success "Container native bindings healthy."

info "Syncing host node_modules…"
npm install --ignore-scripts

# SMI-4549: host `npm install` can pull a fresh better-sqlite3 without building
# its binding (ignore-scripts) and has non-hoisted workspace copies — repair
# handles both. Best-effort: host retrieval/vitest degrade gracefully to WASM.
if [ -x "$SCRIPT_DIR/repair-host-native-deps.sh" ]; then
  info "Repairing host platform native deps (SMI-4549)…"
  "$SCRIPT_DIR/repair-host-native-deps.sh" ||
    warn "Host native repair did not fully complete; host vitest/retrieval may need attention."
fi

# Refresh the deps-freshness sentinel on the HOST (the pre-push freshness guard
# reads the host sentinel; the container has no sentinel reader today).
if [ -r "$SCRIPT_DIR/lib/check-node-modules-fresh.sh" ]; then
  info "Refreshing deps-freshness sentinel (host)…"
  bash "$SCRIPT_DIR/lib/check-node-modules-fresh.sh" --write-sentinel || true
fi

echo ""
git --no-pager diff --stat package-lock.json || true
success "Lockfile regenerated + node_modules synced + native bindings verified healthy."
