#!/bin/bash
# Launch focused session for SMI-629: Skill Ranking Algorithm
# Uses phase-2b worktree

set -e

WORKTREE_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b"
ISSUE="SMI-629"
# Get absolute path to prompt file BEFORE cd
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/prompts/smi629-ranking.md"

echo "=== Launching $ISSUE Session ==="
echo "Worktree: $WORKTREE_DIR"
echo "Branch: phase-2b"
echo ""

# Verify worktree exists
if [ ! -d "$WORKTREE_DIR" ]; then
    echo "ERROR: Worktree not found at $WORKTREE_DIR"
    exit 1
fi

cd "$WORKTREE_DIR"

# Show quick reference
echo "┌─────────────────────────────────────────────┐"
echo "│  SMI-629: Skill Ranking Algorithm           │"
echo "├─────────────────────────────────────────────┤"
echo "│  Files to create:                           │"
echo "│  1. ranking/RankingService.ts               │"
echo "│  2. ranking/index.ts                        │"
echo "│  3. tests/RankingService.test.ts            │"
echo "│  4. Update SearchService.ts                 │"
echo "├─────────────────────────────────────────────┤"
echo "│  After EACH file: npm run typecheck         │"
echo "│  Progress: /tmp/smi629-progress.log         │"
echo "└─────────────────────────────────────────────┘"
echo ""

# Read prompt content
PROMPT=$(cat "$PROMPT_FILE")

# Launch Claude with the prompt
exec claude -p "$PROMPT"
