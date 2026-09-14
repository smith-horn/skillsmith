#!/usr/bin/env bash
# audit:host-npm-required — see SMI-4814 (a worktree's --lockfile-only host `npm install --package-lock-only`, and the pre-existing main-checkout full-sync host `npm install --ignore-scripts` step — both are host-side by necessity, see below)
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
# SMI-5724: Worktree routing. From the MAIN checkout, behavior is unchanged
#   (both modes target the skillsmith-dev-1 container; output states
#   "(container: skillsmith-dev-1)"). From a WORKTREE:
#   --lockfile-only runs `npm install --package-lock-only --ignore-scripts`
#   on the HOST (not the container) — a worktree's root node_modules is
#   bind-mounted :ro from main (SMI-5560/5626), so a container npm call
#   would be a no-op against main's own tree, not this worktree's. Output
#   states "(host, worktree)" so the target run is never ambiguous.
#   Full sync (no flags) REFUSES with a pointer to the main checkout or
#   --lockfile-only — node_modules here is intentionally read-only and
#   main-derived; a full `npm install` from a worktree would either fail
#   (container, :ro mount) or corrupt main's real node_modules via the
#   SMI-4377 symlink (host). See SMI-5724.
#
# SMI-6614 (ADR-158, change 5b): this is the advised refresh command for a
# real lockfile-drift verdict. Every container node_modules mutation
# (`npm install`, `npm rebuild`) is mount-gated: the mountpoint check and the
# mutation run in ONE `docker exec … sh -c` process, so a container recreated
# between them can't redirect the mutation onto a freshly-detached mount
# (R2-1). The gate is identified by BOTH exit 97 AND a literal
# `MOUNT_GATE <rc>` line on the captured stderr (R3-1) — `npm rebuild`'s own
# lifecycle scripts can independently exit 97, and that must read as an npm
# failure, not a mount failure. `--lockfile-only` never touches node_modules
# and is unaffected.
#
# SMI-6614 (ADR-158, change 5c): refuses to start a full sync while
# retrieval-autoheal.sh or repair-host-native-deps.sh is already running
# (both are host native-repair writers), and kicks the detached auto-heal
# once its own host repair + sentinel write finish — restoring the
# "heal after install" ordering .husky/post-merge's deferral (change 4)
# depends on. Both checks are point-in-time `pgrep` snapshots — the same
# residual class the auto-heal already documents for a human install; true
# mutual exclusion is SMI-6627's scope.
#
# Prerequisites: Docker container running (main checkout path only).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"
# shellcheck source=./lib/running-script-pids.sh
source "$SCRIPT_DIR/lib/running-script-pids.sh"

CONTAINER="skillsmith-dev-1"
NATIVE_MODULES="better-sqlite3 onnxruntime-node esbuild hnswlib-node"
LOCKFILE_ONLY=false

usage() {
  sed -n '3,35p' "$0" | sed 's/^# \{0,1\}//'
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

# SMI-5724: worktree vs main-checkout detection — the git-dir-vs-git-common-dir
# idiom used elsewhere in this repo (scripts/lib/hook-docker-detect.sh,
# resolve_container_name(), check-node-modules-fresh.sh, check-dist-fresh.sh),
# but STRICTER than those precedents. There, a failed `rev-parse` silently
# defaults to "main checkout" — correct there, because the consequence is
# only recomputing a path for a fail-soft freshness check (exit 0 if nothing
# usable). Here, the consequence of the same silent default is a live
# `docker exec`/`npm install` ROUTING decision — silently falling back to
# "main checkout" on a `rev-parse` failure would BE the exact silent-misroute
# bug this script exists to fix, reproduced inside the fix itself. So:
# hard-error (exit 1) if either `rev-parse` call fails, rather than falling
# through to IS_WORKTREE=false.
GIT_DIR="$(git rev-parse --git-dir 2>/dev/null)" || error "Not inside a git checkout — cannot determine worktree vs main checkout."
GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null)" || error "Not inside a git checkout — cannot determine worktree vs main checkout."
IS_WORKTREE=false
[[ "$GIT_DIR" != "$GIT_COMMON_DIR" ]] && IS_WORKTREE=true

# Consumer-path native probe (resolves whichever better-sqlite3 copy core uses;
# the sync path has no WASM fallback, so a broken binding fails loudly).
verify_container_native() {
  docker exec "$CONTAINER" node -e \
    "require('@skillsmith/core').createDatabaseSync(':memory:').close()" >/dev/null 2>&1
}

# SMI-6614 (ADR-158, change 5b/R3-1): reports a failed docker-exec-wrapped
# npm mutation and exits. Distinguishes a mount-gate refusal (exit 97 AND a
# literal `MOUNT_GATE <rc>` line on the captured stderr — BOTH required,
# since `npm rebuild`'s own lifecycle scripts can independently exit 97) from
# an ordinary npm failure.
report_docker_npm_failure() {
  local label="$1" rc="$2" err_text="$3" mount_rc
  if [ "$rc" -eq 97 ] && printf '%s\n' "$err_text" | grep -q '^MOUNT_GATE '; then
    mount_rc="$(printf '%s\n' "$err_text" | sed -n 's/^MOUNT_GATE //p' | head -1)"
    case "$mount_rc" in
      32)
        error "$CONTAINER's /app/node_modules is not a mountpoint (detached, SMI-6516) — refusing to run $label, which would write into the HOST tree instead. Recreate: docker compose --profile dev up -d --force-recreate dev (from the main checkout), verify with 'docker exec $CONTAINER mountpoint -q /app/node_modules', then retry."
        ;;
      127)
        error "Cannot verify $CONTAINER's node_modules mount ('mountpoint' unavailable inside the container) — refusing to run $label blind."
        ;;
      *)
        error "Mount check for $CONTAINER's node_modules failed unexpectedly (exit $mount_rc) — refusing to run $label."
        ;;
    esac
  fi
  printf '%s\n' "$err_text" >&2
  error "$label failed inside $CONTAINER (see output above, exit $rc)."
}

# SMI-6614 (ADR-158, change 5c/1): refuses to start a full sync while a host
# native repair (retrieval-autoheal.sh or repair-host-native-deps.sh) is
# already running — both mutate the same host tree this script is about to
# mutate. pgrep unavailable -> proceed with a warning (today's behavior).
refuse_if_native_repair_running() {
  local pids
  if ! pids="$(running_script_pids retrieval-autoheal.sh repair-host-native-deps.sh)"; then
    warn "pgrep unavailable — cannot check for a running host native repair; proceeding."
    return 0
  fi
  if [ -n "$pids" ]; then
    error "A host native repair is already running (retrieval-autoheal.sh or repair-host-native-deps.sh, pid(s): $(printf '%s' "$pids" | tr '\n' ' ')) — retry when it finishes."
  fi
}

# SMI-6614 (ADR-158, change 5c/3): kicks the detached auto-heal AFTER this
# script's own host repair + sentinel write finish, restoring the
# "heal after install" ordering .husky/post-merge's deferral depends on
# (change 4). MUST wait for THIS process to exit first — retrieval-autoheal.sh's
# own foreign_install_running() detector (change 5c/2) would otherwise see the
# still-running refresh and defer, silently dropping the retrigger. The wait
# is bounded in practice since this script exits on the next line after
# backgrounding it.
kick_autoheal_after_exit() {
  local autoheal="$SCRIPT_DIR/retrieval-autoheal.sh"
  [ -r "$autoheal" ] || return 0
  nohup sh -c 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; exec bash "$2"' \
    _ "$$" "$autoheal" </dev/null >/dev/null 2>&1 &
}

if $IS_WORKTREE; then
  if $LOCKFILE_ONLY; then
    info "Regenerating package-lock.json (lockfile only — node_modules untouched) (host, worktree)…"
    npm install --package-lock-only --ignore-scripts
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

  error "Full sync cannot run from a worktree: node_modules here is intentionally
read-only and derived from the main checkout (SMI-5560/5626) — a full \`npm
install\` here would either fail (container) or corrupt main's real node_modules
via the SMI-4377 symlink (host).

If this dependency change is already on main:
  cd <main-checkout-path> && ./scripts/regen-lockfile.sh

If you only need an updated lockfile (not synced node_modules) from THIS worktree:
  ./scripts/regen-lockfile.sh --lockfile-only

Note: a worktree-local, not-yet-merged dependency change has no supported path
to a synced node_modules today — see SMI-5724 follow-up (filed) for that gap."
fi

# ---- Main checkout ----
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  error "Dev container '$CONTAINER' is not running. Start: docker compose --profile dev up -d"
fi

if $LOCKFILE_ONLY; then
  info "Regenerating package-lock.json (lockfile only — node_modules untouched) (container: skillsmith-dev-1)…"
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
refuse_if_native_repair_running

info "Regenerating lockfile + syncing container node_modules… (container: skillsmith-dev-1)"
# SMI-6614 (ADR-158, change 5b): mount check + mutation run as ONE `sh -c`
# process inside the container (R2-1) — no window opens between the two for
# a container recreate to redirect the install onto a freshly-detached
# mount.
INSTALL_ERR_FILE="$(mktemp)"
if docker exec "$CONTAINER" sh -c 'mountpoint -q /app/node_modules; rc=$?; [ "$rc" -eq 0 ] || { echo "MOUNT_GATE $rc" >&2; exit 97; }; exec npm install' 2>"$INSTALL_ERR_FILE"; then
  rm -f "$INSTALL_ERR_FILE"
else
  INSTALL_RC=$?
  INSTALL_ERR_TEXT="$(cat "$INSTALL_ERR_FILE" 2>/dev/null || true)"
  rm -f "$INSTALL_ERR_FILE"
  report_docker_npm_failure "npm install" "$INSTALL_RC" "$INSTALL_ERR_TEXT"
fi

info "Rebuilding native modules with build scripts (the anti-wipe step)…"
REBUILD_ERR_FILE="$(mktemp)"
# shellcheck disable=SC2086
if docker exec "$CONTAINER" sh -c 'mountpoint -q /app/node_modules; rc=$?; [ "$rc" -eq 0 ] || { echo "MOUNT_GATE $rc" >&2; exit 97; }; exec npm rebuild "$@"' _ $NATIVE_MODULES --ignore-scripts=false 2>"$REBUILD_ERR_FILE"; then
  rm -f "$REBUILD_ERR_FILE"
else
  REBUILD_RC=$?
  REBUILD_ERR_TEXT="$(cat "$REBUILD_ERR_FILE" 2>/dev/null || true)"
  rm -f "$REBUILD_ERR_FILE"
  report_docker_npm_failure "npm rebuild" "$REBUILD_RC" "$REBUILD_ERR_TEXT"
fi

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

# SMI-6614 (ADR-158, change 5c/3): re-kick the detached retrieval auto-heal
# now that this refresh has finished — .husky/post-merge defers it (change 4)
# precisely so it doesn't race this script; this is the retrigger.
kick_autoheal_after_exit

echo ""
git --no-pager diff --stat package-lock.json || true
success "Lockfile regenerated + node_modules synced + native bindings verified healthy."
