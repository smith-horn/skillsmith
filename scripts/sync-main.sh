#!/usr/bin/env bash
# scripts/sync-main.sh — Quiet main-branch sync for Claude Code sessions
# Suppresses git-crypt warnings and smudge filter noise (~5,000 → ~75 tokens)
# Usage: ./scripts/sync-main.sh

set -euo pipefail

# Capture all output, filter noise, report result
# Submodules are synchronized independently below. Disable recursive fetching
# here so one inaccessible submodule cannot abort the parent fetch before the
# per-path fail-soft reporting has a chance to run.
output=$(git checkout main 2>&1 && git fetch --no-recurse-submodules origin main 2>&1) || {
  # On failure, show unfiltered output for debugging
  echo "$output"
  exit 1
}

# SMI-4212: Divergence summary — before we hard-reset, tell the user why local
# differs from origin/main so they know whether the reset is discarding real work.
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  AHEAD=$(git rev-list --count "$REMOTE..$LOCAL" 2>/dev/null || echo 0)
  BEHIND=$(git rev-list --count "$LOCAL..$REMOTE" 2>/dev/null || echo 0)
  if [ "$AHEAD" -gt 0 ]; then
    echo "Local ahead by $AHEAD commit(s):"
    git log --oneline "$REMOTE..$LOCAL" 2>/dev/null | sed 's/^/  /' || true
    # Squash-merge heuristic: if a local commit's tree matches any of the last 50
    # origin commits, the content is already on main under a different SHA.
    RECENT_TREES=$(git log origin/main -n 50 --format='%T' 2>/dev/null || true)
    for sha in $(git rev-list "$REMOTE..$LOCAL" 2>/dev/null || true); do
      TREE=$(git rev-parse "$sha^{tree}" 2>/dev/null || true)
      if [ -n "$TREE" ] && echo "$RECENT_TREES" | grep -q "$TREE" 2>/dev/null; then
        echo "  └─ $sha matches a recent squash-merge on origin (safe to discard)"
      fi
    done || true
  fi
  if [ "$BEHIND" -gt 0 ]; then
    echo "Remote ahead by $BEHIND commit(s)"
  fi
fi

output=$(git reset --hard origin/main 2>&1) || {
  echo "$output"
  exit 1
}

# SMI-5823 Phase 2: keep every declared submodule checkout aligned with the
# gitlink recorded by the freshly-reset parent. Update paths independently so
# one inaccessible private remote does not hide successful updates elsewhere.
# Dirty initialized submodules are never passed to `submodule update`: even
# without --force, skipping explicitly makes the preservation contract clear.
submodule_mismatches=()
if [ -f .gitmodules ]; then
  repo_root=$(git rev-parse --show-toplevel)
  gitmodules="$repo_root/.gitmodules"
  while IFS= read -r submodule_path; do
    [ -n "$submodule_path" ] || continue

    expected_sha=$(git ls-tree HEAD -- "$submodule_path" 2>/dev/null | awk '{print $3}')
    [ -n "$expected_sha" ] || continue

    mismatch_reason=""
    if git -C "$submodule_path" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
      [ -n "$(git -C "$submodule_path" status --porcelain 2>/dev/null)" ]; then
      mismatch_reason="dirty worktree preserved"
    else
      git submodule update --init -- "$submodule_path" >/dev/null 2>&1 || {
        mismatch_reason="update failed"
      }
    fi

    actual_sha=$(git -C "$submodule_path" rev-parse HEAD 2>/dev/null || true)
    if [ "$actual_sha" != "$expected_sha" ]; then
      [ -n "$mismatch_reason" ] || mismatch_reason="checkout remains mismatched"
      submodule_mismatches+=(
        "$submodule_path|$mismatch_reason|${actual_sha:-unavailable}|$expected_sha"
      )
    fi
  done < <(
    (cd / && git config --file "$gitmodules" --get-regexp 'submodule\..*\.path' 2>/dev/null) |
      awk '{print $2}' || true
  )
fi

if [ "${#submodule_mismatches[@]}" -gt 0 ]; then
  echo "WARNING: Submodule sync incomplete:"
  for mismatch in "${submodule_mismatches[@]}"; do
    IFS='|' read -r path reason actual expected <<<"$mismatch"
    echo "  - $path: $reason (found ${actual:0:12}, expected ${expected:0:12})"
  done
  echo "Parent main is synced; resolve the named submodule path(s) and retry."
fi

# SMI-5548: cheap dist-staleness hint — NO build here, just a heads-up. If
# source moved while syncing, dist/ (built before the sync) likely no longer
# matches; the pre-commit/pre-push dist-freshness guards will catch it for
# real, but a hint right after sync saves the "why did the guard fire" step.
# Fail-soft: a git diff hiccup just skips the hint, never blocks the sync.
if [ "$LOCAL" != "$REMOTE" ]; then
  if git diff --name-only "$LOCAL..$REMOTE" 2>/dev/null | grep -q '^packages/[^/]*/src/'; then
    echo "ℹ️  Source changed on sync — dist may be stale; run: docker exec skillsmith-dev-1 npm run build"
  fi
fi

branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  echo "ERROR: Expected main but landed on '$branch' (smudge filter branch switch)"
  exit 1
fi
commit=$(git log --oneline -1)
echo "Synced to main: $commit"
