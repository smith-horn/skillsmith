#!/usr/bin/env bash
# scripts/sync-main.sh — Quiet main-branch sync for Claude Code sessions
# Suppresses git-crypt warnings and smudge filter noise (~5,000 → ~75 tokens)
# Usage: ./scripts/sync-main.sh

set -euo pipefail

# Capture all output, filter noise, report result
output=$(git checkout main 2>&1 && git fetch origin main 2>&1) || {
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

branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  echo "ERROR: Expected main but landed on '$branch' (smudge filter branch switch)"
  exit 1
fi
commit=$(git log --oneline -1)
echo "Synced to main: $commit"
