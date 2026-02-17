#!/usr/bin/env bash
# scripts/sync-main.sh — Quiet main-branch sync for Claude Code sessions
# Suppresses git-crypt warnings and smudge filter noise (~5,000 → ~75 tokens)
# Usage: ./scripts/sync-main.sh

set -euo pipefail

# Capture all output, filter noise, report result
output=$(git checkout main 2>&1 && git fetch origin main 2>&1 && git reset --hard origin/main 2>&1) || {
  # On failure, show unfiltered output for debugging
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
