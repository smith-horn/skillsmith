#!/bin/bash
# audit:host-npm-required — see SMI-4814 (npm runs inside a multi-line `docker exec -w /app sh -c '...'` block the per-line audit scanner cannot see)
# scripts/eval-baseline-cron.sh — SMI-4764 Wave 2; SMI-5353 decoupled-checkout rewrite
#
# Canonical-developer cron entry point for the retrieval-eval baseline.
#
# SMI-5353: the eval runs against an ISOLATED clone (~/.skillsmith/eval-checkout)
# pinned to origin/main, inside a DEDICATED ephemeral container — NEVER the dev's
# live working tree. This decouples the weekly eval from the canonical dev's
# perpetual WIP (submodule pointer drift on docs/internal + .claude/skills, plus
# the cron's own untracked heartbeat), which used to trip the old clean-tree
# guard and silently skip the run every week (last clean run before the rewrite:
# 2026-06-07). A clean checkout pinned to origin/main is also the *intended*
# corpus, so this is more faithful than the old in-place `git reset --hard`.
#
# Plan reference: docs/internal/implementation/smi-5353-eval-cron-decoupled-checkout.md
#
# Flow:
#   1. Guard: Docker daemon reachable.
#   2. Preflight: distinct heartbeat paths, dev-tree heartbeat dir writable, disk.
#   3. Ensure the isolated clone exists (clone origin once).
#   4. Bring up the ephemeral eval container (compose + eval-cron override); trap teardown.
#   5. Sync the clone to origin/main + pin ALL corpus submodules (docs/internal + .claude/skills).
#   6. npm ci inside the eval container.
#   7. Memory bind-mount preflight (corpus REQUIRES the memory adapter).
#   8. Run RETRIEVAL_EVAL_REAL=1 eval in the eval container.
#   9. Write heartbeat (OK / FAIL / WARN-PARTIAL) in the clone; copy it back to the dev tree.
#  10. Drift detection -> auto-PR opened from the clone.
#  11. Cleanup: wipe the clone's .ruvector; container torn down by the EXIT trap.
#
# The old branch==main + clean-working-tree guards on the dev's live tree are
# GONE — the isolated clone is clean + pinned by construction.
#
# Heartbeat lifecycle (SMI-5353): copy-back to the dev tree every run keeps
# `audit:standards` Check 44 fresh locally WITHOUT the old fragile manual-weekly
# heartbeat push. On drift, the auto-PR still commits the tracked heartbeat +
# baseline.json to main.
#
# Usage:
#   ./scripts/eval-baseline-cron.sh             # Real run
#   ./scripts/eval-baseline-cron.sh --dry-run   # Validate setup only, no eval
#
# Logs: ~/.skillsmith/logs/eval-cron-<YYYY-MM-DD>.log (30-day rotation external).

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Paths + setup
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"          # the canonical dev's PRIMARY tree

# Isolated, cron-owned clone (OUTSIDE the repo — never the dev's live tree).
EVAL_CLONE="${SKILLSMITH_EVAL_CLONE:-${HOME}/.skillsmith/eval-checkout}"
EVAL_PROJECT="skillsmith-eval-cron"                # Compose project (scopes the node_modules volume)
EVAL_CONTAINER="skillsmith-eval-cron-1"            # set by docker-compose.eval-cron.yml override

REL_BASELINE="packages/doc-retrieval-mcp/eval/baseline.json"
REL_HEARTBEAT="packages/doc-retrieval-mcp/eval/.cron-heartbeat"
BASELINE_FILE="$EVAL_CLONE/$REL_BASELINE"
ISOLATED_HEARTBEAT_FILE="$EVAL_CLONE/$REL_HEARTBEAT"
DEV_TREE_HEARTBEAT_FILE="$REPO_ROOT/$REL_HEARTBEAT"

MIN_DISK_GB=3
CONTAINER_UP=0

LOG_DIR="${HOME}/.skillsmith/logs"
LOG_FILE="${LOG_DIR}/eval-cron-$(date -u +%Y-%m-%d).log"
mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2
}

# Portable SHA-256: macOS ships `shasum`; most Linux distros ship `sha256sum`
# and may NOT ship `shasum` (it's a separate Perl package). Prefer sha256sum.
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# `docker compose` wrapper: dedicated project + base file + eval override.
compose() {
  docker compose --project-name "$EVAL_PROJECT" \
    -f "$EVAL_CLONE/docker-compose.yml" \
    -f "$EVAL_CLONE/docker-compose.eval-cron.yml" \
    "$@"
}

# Regenerate the index fresh each run — wipe the clone's .ruvector. Defined here
# (before any early-exit point) so the EXIT trap can call it even when the script
# aborts before reaching the eval. Idempotent + safe if the clone is absent.
# shellcheck disable=SC2329  # invoked indirectly via teardown / trap
cleanup_index() {
  rm -rf "$EVAL_CLONE/.ruvector" 2>/dev/null || true
}

# EXIT trap: always tear the ephemeral eval container down (NOT `down -v` — keep
# the project-scoped node_modules volume warm for next week) AND wipe the clone's
# index (so a failed/aborted run can't leave a stale index for next week).
# Preserves the triggering exit code.
# shellcheck disable=SC2329  # invoked indirectly via `trap teardown EXIT`
teardown() {
  local code=$?
  if [ "$CONTAINER_UP" = "1" ]; then
    log "Tearing down eval container (${EVAL_CONTAINER})..."
    compose down >>"$LOG_FILE" 2>&1 || log "WARNING: eval container teardown failed — inspect 'docker ps'."
  fi
  cleanup_index
  exit "$code"
}
trap teardown EXIT

# ---------------------------------------------------------------------------
# Guard: Docker daemon reachable
# ---------------------------------------------------------------------------

if ! docker info >/dev/null 2>&1; then
  log "ERROR: Docker daemon not reachable. Start Docker Desktop and retry."
  exit 1
fi

# ---------------------------------------------------------------------------
# Preflight: distinct heartbeat paths + writable dev-tree target + disk
# ---------------------------------------------------------------------------

# H8: the isolated and dev-tree heartbeats MUST be different files, else the
# copy-back is a no-op and Check 44 reads a stale (or self-overwritten) file.
if [ "$ISOLATED_HEARTBEAT_FILE" = "$DEV_TREE_HEARTBEAT_FILE" ]; then
  log "ERROR: isolated and dev-tree heartbeat paths are identical ($ISOLATED_HEARTBEAT_FILE)."
  log "  EVAL_CLONE must differ from REPO_ROOT. Refusing to run."
  exit 1
fi
if [ "$EVAL_CLONE" = "$REPO_ROOT" ]; then
  log "ERROR: EVAL_CLONE equals REPO_ROOT ($REPO_ROOT). The eval must run in a separate clone."
  exit 1
fi

# M8: disk space. `df -Pk` is POSIX (macOS + Linux); convert KB available -> GB.
AVAIL_GB="$(df -Pk "$HOME" | awk 'NR==2 {print int($4/1048576)}')"
if [ "${AVAIL_GB:-0}" -lt "$MIN_DISK_GB" ]; then
  log "ERROR: only ${AVAIL_GB}GB free at \$HOME; need >= ${MIN_DISK_GB}GB (clone + node_modules + .ruvector). Refusing to run."
  exit 1
fi

# ---------------------------------------------------------------------------
# Ensure the isolated clone exists
# ---------------------------------------------------------------------------

if [ ! -d "$EVAL_CLONE/.git" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    log "ERROR (dry-run): isolated clone missing at $EVAL_CLONE."
    log "  Run the one-time setup first (see .claude/development/eval-cron-setup.md)."
    exit 1
  fi
  ORIGIN_URL="$(git -C "$REPO_ROOT" remote get-url origin)"
  log "Cloning $ORIGIN_URL into $EVAL_CLONE (one-time)..."
  mkdir -p "$(dirname "$EVAL_CLONE")"
  git clone "$ORIGIN_URL" "$EVAL_CLONE" >>"$LOG_FILE" 2>&1
fi

# Sanity: the eval override must be present in the clone (it ships on origin/main).
if [ ! -f "$EVAL_CLONE/docker-compose.eval-cron.yml" ]; then
  log "ERROR: $EVAL_CLONE/docker-compose.eval-cron.yml missing."
  log "  The clone predates SMI-5353 on origin/main — 'git -C $EVAL_CLONE fetch && git -C $EVAL_CLONE reset --hard origin/main' or re-clone."
  exit 1
fi

# ---------------------------------------------------------------------------
# Sync the clone to origin/main
# ---------------------------------------------------------------------------

log "Fetching origin/main in the isolated clone..."
git -C "$EVAL_CLONE" fetch origin main >>"$LOG_FILE" 2>&1

if [ "$DRY_RUN" = "0" ]; then
  # Force checkout — the clone is disposable + cron-owned, so this self-heals from
  # any prior stuck state (e.g. a drift run that died mid-auto-PR left it on a
  # feature branch with staged changes). reset --hard then re-aligns to origin/main.
  git -C "$EVAL_CLONE" checkout -f main >>"$LOG_FILE" 2>&1
  git -C "$EVAL_CLONE" reset --hard origin/main >>"$LOG_FILE" 2>&1
fi

# Pin corpus submodules. docs/internal is REQUIRED (requireSubmodule); fail-fast.
# .claude/skills is in the corpus globs too but non-fatal — warn-and-continue (M2).
PARTIAL=0
if [ "$DRY_RUN" = "0" ]; then
  if ! git -C "$EVAL_CLONE" submodule update --init --force docs/internal >>"$LOG_FILE" 2>&1; then
    log "ERROR: docs/internal submodule update failed — corpus REQUIRES it. Aborting."
    exit 1
  fi
  if ! git -C "$EVAL_CLONE" submodule update --init --force .claude/skills >>"$LOG_FILE" 2>&1; then
    log "WARNING: .claude/skills submodule update failed; continuing with prior checkout (PARTIAL corpus)."
    PARTIAL=1
  fi
fi

# Dry-run: corpus submodule sentinels must already be present.
if [ ! -f "$EVAL_CLONE/docs/internal/index.md" ]; then
  log "ERROR: docs/internal not initialized in the clone (missing index.md sentinel)."
  log "  Run 'git -C $EVAL_CLONE submodule update --init --force docs/internal' (needs private-submodule access)."
  exit 1
fi

# ---------------------------------------------------------------------------
# Bring up the ephemeral eval container
# ---------------------------------------------------------------------------

log "Bringing up eval container (${EVAL_CONTAINER}) on project ${EVAL_PROJECT}..."
# Mark up BEFORE the call: a timed-out/failed `up` aborts under set -e, and a
# half-created container must still be torn down by the EXIT trap — otherwise it
# orphans and the next run collides on container_name (governance High).
CONTAINER_UP=1
compose --profile dev up -d --wait --wait-timeout 300 >>"$LOG_FILE" 2>&1

# Install deps (always — guarantees tsx + runtime deps; ~30-60s warm). M7.
log "Installing dependencies in the eval container (npm ci)..."
docker exec -w /app "$EVAL_CONTAINER" npm ci >>"$LOG_FILE" 2>&1

# tsx must resolve — the eval runner is `tsx eval/eval-runner.ts`.
if ! docker exec -w /app "$EVAL_CONTAINER" sh -c 'npm ls tsx >/dev/null 2>&1 || npx --no-install tsx --version >/dev/null 2>&1'; then
  log "ERROR: tsx not resolvable in the eval container after npm ci."
  exit 1
fi

# ---------------------------------------------------------------------------
# Memory bind-mount preflight (H1)
# ---------------------------------------------------------------------------
#
# The memory-topic-files adapter reads /skillsmith-memory (bind-mounted from
# ${HOME}/.claude/projects/${SKILLSMITH_PROJECT_DIR_ENCODED}/memory). If that env
# var was empty at `compose up`, the mount is an empty dir and the eval's GAP 1
# check would `process.exit(1)` mid-run with a cryptic message. Surface it here.

if ! docker exec "$EVAL_CONTAINER" sh -c '[ -n "$(ls -A /skillsmith-memory 2>/dev/null)" ]'; then
  log "ERROR: /skillsmith-memory is empty in the eval container."
  log "  Export SKILLSMITH_PROJECT_DIR_ENCODED before launch (see eval-cron-setup.md) so the"
  log "  memory bind-mount resolves. Refusing to run a degraded (memory-less) corpus."
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  log "Dry-run OK: clone present, origin reachable, submodules initialized, container up, tsx resolvable, memory mount populated, heartbeat paths distinct. Exiting before eval."
  exit 0
fi

# ---------------------------------------------------------------------------
# Capture baseline.json hash before the eval (drift detection)
# ---------------------------------------------------------------------------

PRE_HASH="$(sha256_file "$BASELINE_FILE")"
log "Pre-eval baseline.json sha256: $PRE_HASH"

# ---------------------------------------------------------------------------
# Run the eval in canonical mode inside the eval container
# ---------------------------------------------------------------------------

log "Running canonical real-mode eval..."
EVAL_EXIT=0
docker exec -w /app "$EVAL_CONTAINER" sh -c \
  'SKILLSMITH_REPO_ROOT=/app SKILLSMITH_EVAL_CANONICAL=true RETRIEVAL_EVAL_REAL=1 \
   npm run eval:retrieval --workspace=packages/doc-retrieval-mcp' \
  >>"$LOG_FILE" 2>&1 || EVAL_EXIT=$?

# ---------------------------------------------------------------------------
# Heartbeat: write in the clone, copy back to the dev tree (H4)
# ---------------------------------------------------------------------------
#
# Status: FAIL (eval errored) | WARN-PARTIAL (.claude/skills not pinned) | OK.

write_heartbeat() {
  local status="$1" line
  # Write the SAME real status directly to BOTH files (no `cp` — the dev-tree
  # write must carry the run's true status, not silently keep a stale prior line
  # if a copy fails). Check 44 reads the dev-tree file.
  line="$(printf '%s\t%s\t%s' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(git -C "$EVAL_CLONE" rev-parse HEAD)" \
    "$status")"
  printf '%s\n' "$line" > "$ISOLATED_HEARTBEAT_FILE"
  mkdir -p "$(dirname "$DEV_TREE_HEARTBEAT_FILE")"
  if ! printf '%s\n' "$line" > "$DEV_TREE_HEARTBEAT_FILE" 2>/dev/null; then
    log "ERROR: could not write heartbeat to the dev tree ($DEV_TREE_HEARTBEAT_FILE). Check 44 may not reflect this run until the 14-day staleness window expires."
  fi
}

if [ "$EVAL_EXIT" != "0" ]; then
  log "ERROR: eval invocation failed with exit $EVAL_EXIT — see $LOG_FILE"
  write_heartbeat "FAIL"
  exit "$EVAL_EXIT"
fi

if [ "$PARTIAL" = "1" ]; then
  write_heartbeat "WARN-PARTIAL"
  log "Heartbeat written (WARN-PARTIAL): $DEV_TREE_HEARTBEAT_FILE"
else
  write_heartbeat "OK"
  log "Heartbeat written (OK): $DEV_TREE_HEARTBEAT_FILE"
fi

# ---------------------------------------------------------------------------
# Drift detection
# ---------------------------------------------------------------------------

POST_HASH="$(sha256_file "$BASELINE_FILE")"
log "Post-eval baseline.json sha256: $POST_HASH"

if [ "$PRE_HASH" = "$POST_HASH" ]; then
  log "No drift — baseline.json unchanged. Heartbeat written to the dev tree (no commit needed)."
  exit 0  # EXIT trap tears down the container + wipes the index.
fi

log "Drift detected — opening auto-PR from the isolated clone..."

# ---------------------------------------------------------------------------
# Open auto-PR via gh CLI (from the clone)
# ---------------------------------------------------------------------------
#
# Minute-resolution branch suffix (M1) so a scheduled + manual run on the same
# day cannot collide. PR/push failures are non-fatal: the heartbeat is already
# fresh, and the drift can be re-PR'd next run.

BRANCH="chore/eval-baseline-cron-$(date -u +%Y%m%dT%H%M)"
PR_OK=1
{
  git -C "$EVAL_CLONE" checkout -b "$BRANCH" &&
  git -C "$EVAL_CLONE" add "$REL_BASELINE" "$REL_HEARTBEAT" &&
  git -C "$EVAL_CLONE" commit --no-verify -m "chore(eval): cron-detected baseline drift ($(date -u +%Y-%m-%d))

Auto-generated by scripts/eval-baseline-cron.sh in the isolated eval checkout.
baseline.json sha256 changed: ${PRE_HASH:0:12} -> ${POST_HASH:0:12}

CI Retrieval Eval Gate exercises the hybrid threshold against this diff;
review the per-category breakdown in the gate output before merging.

[skip-impl-check]" &&
  git -C "$EVAL_CLONE" push -u origin "$BRANCH" --no-verify
} >>"$LOG_FILE" 2>&1 || PR_OK=0

if [ "$PR_OK" = "1" ]; then
  ( cd "$EVAL_CLONE" && gh pr create \
    --base main \
    --head "$BRANCH" \
    --title "chore(eval): cron-detected baseline drift ($(date -u +%Y-%m-%d))" \
    --label "eval-baseline-cron" \
    --body "Auto-generated by \`scripts/eval-baseline-cron.sh\` in the isolated eval checkout. Review the Retrieval Eval Gate per-category breakdown before merging.

baseline.json sha256: \`${PRE_HASH:0:12}\` -> \`${POST_HASH:0:12}\`

[skip-impl-check]" ) >>"$LOG_FILE" 2>&1 || PR_OK=0
fi

if [ "$PR_OK" = "1" ]; then
  log "Auto-PR opened on branch ${BRANCH}"
else
  log "WARNING: auto-PR creation failed (gh auth / existing branch?). Drift recorded; will retry next run. See $LOG_FILE."
fi

git -C "$EVAL_CLONE" checkout -f main >>"$LOG_FILE" 2>&1 || log "WARNING: could not return clone to main."
# Delete the per-run local branch so they don't accumulate in the clone (Low).
git -C "$EVAL_CLONE" branch -D "$BRANCH" >>"$LOG_FILE" 2>&1 || true

exit 0  # EXIT trap tears down the container + wipes the index.
