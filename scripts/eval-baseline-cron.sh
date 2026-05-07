#!/bin/bash
# scripts/eval-baseline-cron.sh — SMI-4764 Wave 2
#
# Canonical-developer cron entry point for the retrieval-eval baseline.
# Runs `RETRIEVAL_EVAL_REAL=1` weekly against the canonical dev's local
# corpus (docs/internal + memory adapter), opens an auto-PR via `gh` if
# the resulting baseline.json drifts from origin/main, and always writes
# a heartbeat row to packages/doc-retrieval-mcp/eval/.cron-heartbeat.
#
# Plan reference: docs/internal/implementation/smi-4764-eval-baseline-automation.md §Wave 2
#
# Hard guards (refuse to run otherwise — addresses plan-review v2 #3):
#   1. Current branch == main (no feature-branch contamination)
#   2. Working tree clean (no half-staged developer edits)
#   3. Docker container running (skillsmith-dev-1)
#
# Heartbeat lifecycle:
#   - Always written on each invocation (even on no-drift runs).
#   - Committed by canonical dev as part of the auto-PR (drift case)
#     or via a manual weekly heartbeat-only push (no-drift case).
#   - Stale heartbeat (>14d) triggers `audit:standards` warning (Wave 2 Step 4)
#     prompting designated-replacement protocol.
#
# Usage:
#   ./scripts/eval-baseline-cron.sh             # Real run
#   ./scripts/eval-baseline-cron.sh --dry-run   # Validate guards only, no eval
#
# Logs: ~/.skillsmith/logs/eval-cron-<YYYY-MM-DD>.log (30-day rotation
# managed externally — keep recent runs only).

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
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HEARTBEAT_FILE="packages/doc-retrieval-mcp/eval/.cron-heartbeat"
BASELINE_FILE="packages/doc-retrieval-mcp/eval/baseline.json"
DOCKER_CONTAINER="skillsmith-dev-1"
LOG_DIR="${HOME}/.skillsmith/logs"
LOG_FILE="${LOG_DIR}/eval-cron-$(date -u +%Y-%m-%d).log"
mkdir -p "$LOG_DIR"

cd "$REPO_ROOT"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2
}

# ---------------------------------------------------------------------------
# Guard 1: must run from main
# ---------------------------------------------------------------------------

CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "")"
if [ "$CURRENT_BRANCH" != "main" ]; then
  log "ERROR: cron must run from 'main' (current: '$CURRENT_BRANCH')"
  log "Refusing to run — switch to main and re-invoke."
  exit 1
fi

# ---------------------------------------------------------------------------
# Guard 2: clean working tree
# ---------------------------------------------------------------------------
#
# `git status --porcelain` lists modified, staged, untracked, and conflicted
# entries. We tolerate:
#   - Untracked files in worktrees/ (created by parallel create-worktree.sh)
#   - Submodule dirty content (untracked + modified files INSIDE the submodule),
#     because docs/internal often carries parallel-session WIP files. The
#     parent's submodule POINTER (the SHA the parent commit references) is
#     still validated — `--ignore-submodules=dirty` ignores dirty content
#     but NOT pointer changes, so an unstaged SHA bump still flags `M`.

PORCELAIN="$(git -c submodule.recurse=false status --porcelain --ignore-submodules=dirty | grep -vE '^\?\? worktrees/' || true)"
if [ -n "$PORCELAIN" ]; then
  log "ERROR: cron requires clean working tree. Found:"
  echo "$PORCELAIN" | tee -a "$LOG_FILE" >&2
  log "Refusing to run — commit or stash changes and re-invoke."
  exit 1
fi

# ---------------------------------------------------------------------------
# Guard 3: Docker container running
# ---------------------------------------------------------------------------

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DOCKER_CONTAINER}\$"; then
  log "ERROR: Docker container '${DOCKER_CONTAINER}' is not running."
  log "Start it: docker compose --profile dev up -d"
  exit 1
fi

log "Guards passed: branch=main, tree=clean, container=${DOCKER_CONTAINER}"

if [ "$DRY_RUN" = "1" ]; then
  log "Dry-run mode — exiting before eval invocation."
  exit 0
fi

# ---------------------------------------------------------------------------
# Sync main + submodule before run
# ---------------------------------------------------------------------------

log "Syncing main from origin..."
git fetch origin main >>"$LOG_FILE" 2>&1
git reset --hard origin/main >>"$LOG_FILE" 2>&1
git submodule update --init docs/internal >>"$LOG_FILE" 2>&1

# ---------------------------------------------------------------------------
# Capture baseline.json hash before the eval (for drift detection)
# ---------------------------------------------------------------------------

PRE_HASH="$(shasum -a 256 "$BASELINE_FILE" | awk '{print $1}')"
log "Pre-eval baseline.json sha256: $PRE_HASH"

# ---------------------------------------------------------------------------
# Run eval in canonical mode inside Docker
# ---------------------------------------------------------------------------

log "Running canonical real-mode eval..."
EVAL_EXIT=0
docker exec -w /app "$DOCKER_CONTAINER" sh -c \
  'SKILLSMITH_REPO_ROOT=/app SKILLSMITH_EVAL_CANONICAL=true RETRIEVAL_EVAL_REAL=1 \
   npm run eval:retrieval --workspace=packages/doc-retrieval-mcp' \
  >>"$LOG_FILE" 2>&1 || EVAL_EXIT=$?

if [ "$EVAL_EXIT" != "0" ]; then
  log "ERROR: eval invocation failed with exit $EVAL_EXIT — see $LOG_FILE"
  # Still write heartbeat so the freshness check can distinguish "cron
  # ran but eval failed" from "cron not running at all". Append a marker.
  printf '%s\t%s\tFAIL\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(git rev-parse HEAD)" \
    > "$HEARTBEAT_FILE"
  exit "$EVAL_EXIT"
fi

# ---------------------------------------------------------------------------
# Always write heartbeat (success path)
# ---------------------------------------------------------------------------

printf '%s\t%s\tOK\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(git rev-parse HEAD)" \
  > "$HEARTBEAT_FILE"
log "Heartbeat written: $HEARTBEAT_FILE"

# ---------------------------------------------------------------------------
# Drift detection
# ---------------------------------------------------------------------------

POST_HASH="$(shasum -a 256 "$BASELINE_FILE" | awk '{print $1}')"
log "Post-eval baseline.json sha256: $POST_HASH"

if [ "$PRE_HASH" = "$POST_HASH" ]; then
  log "No drift — baseline.json unchanged. Heartbeat-only commit deferred to manual weekly push."
  exit 0
fi

log "Drift detected — opening auto-PR..."

# ---------------------------------------------------------------------------
# Open auto-PR via gh CLI
# ---------------------------------------------------------------------------
#
# Pattern mirrors `release-cadence.yml` (plan §7 / Surface Grounding).
# Branch name embeds the date so consecutive cron runs don't collide.

BRANCH="chore/eval-baseline-cron-$(date -u +%Y%m%d)"
git checkout -b "$BRANCH" >>"$LOG_FILE" 2>&1
git add "$BASELINE_FILE" "$HEARTBEAT_FILE"
# baseline.md is regenerated by hand by the canonical dev when shape changes;
# cron-driven drifts are typically corpus-only so the prose copy stays valid.
git commit -m "chore(eval): cron-detected baseline drift ($(date -u +%Y-%m-%d))

Auto-generated by scripts/eval-baseline-cron.sh on canonical dev's machine.
baseline.json sha256 changed: ${PRE_HASH:0:12} → ${POST_HASH:0:12}

CI Retrieval Eval Gate exercises the hybrid threshold against this diff;
review the per-category breakdown in the gate output before merging.

[skip-impl-check]" >>"$LOG_FILE" 2>&1

git push -u origin "$BRANCH" --no-verify >>"$LOG_FILE" 2>&1

gh pr create \
  --base main \
  --head "$BRANCH" \
  --title "chore(eval): cron-detected baseline drift ($(date -u +%Y-%m-%d))" \
  --label "eval-baseline-cron" \
  --body "Auto-generated by \`scripts/eval-baseline-cron.sh\` on the canonical dev's machine. Review the Retrieval Eval Gate per-category breakdown before merging.

baseline.json sha256: \`${PRE_HASH:0:12}\` → \`${POST_HASH:0:12}\`

[skip-impl-check]" \
  >>"$LOG_FILE" 2>&1

log "Auto-PR opened on branch ${BRANCH}"
git checkout main >>"$LOG_FILE" 2>&1

exit 0
