#!/bin/bash
# Launch focused session for SMI-630: Cache Invalidation Strategy
# Uses phase-2b-parallel worktree

set -e

WORKTREE_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b-parallel"
ISSUE="SMI-630"
# Get absolute path to prompt file BEFORE cd
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/prompts/smi630-cache.md"

echo "=== Launching $ISSUE Session ==="
echo "Worktree: $WORKTREE_DIR"
echo "Branch: phase-2b-parallel"
echo ""

# Verify worktree exists
if [ ! -d "$WORKTREE_DIR" ]; then
    echo "ERROR: Worktree not found at $WORKTREE_DIR"
    exit 1
fi

cd "$WORKTREE_DIR"

# Show quick reference
echo "┌─────────────────────────────────────────────┐"
echo "│  SMI-630: Cache Invalidation Strategy       │"
echo "├─────────────────────────────────────────────┤"
echo "│  Files to create:                           │"
echo "│  1. cache/CacheService.ts                   │"
echo "│  2. cache/TTLManager.ts                     │"
echo "│  3. cache/index.ts                          │"
echo "│  4. tests/CacheService.test.ts              │"
echo "│  5. Update SearchService.ts                 │"
echo "├─────────────────────────────────────────────┤"
echo "│  After EACH file: npm run typecheck         │"
echo "│  Progress: /tmp/smi630-progress.log         │"
echo "└─────────────────────────────────────────────┘"
echo ""

# Read prompt content
PROMPT=$(cat "$PROMPT_FILE")

# Launch Claude with the prompt
exec claude -p "$PROMPT"
