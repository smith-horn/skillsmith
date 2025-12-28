#!/bin/bash
# Launch focused session for SMI-638: Session Checkpointing
# Uses phase-2b-process worktree

set -e

WORKTREE_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b-process"
ISSUE="SMI-638"
# Get absolute path to prompt file BEFORE cd
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/prompts/smi638-session-checkpointing.md"

echo "=== Launching $ISSUE Session ==="
echo "Worktree: $WORKTREE_DIR"
echo "Branch: phase-2b-process"
echo ""

# Verify worktree exists
if [ ! -d "$WORKTREE_DIR" ]; then
    echo "ERROR: Worktree not found at $WORKTREE_DIR"
    exit 1
fi

# Verify prompt file exists
if [ ! -f "$PROMPT_FILE" ]; then
    echo "ERROR: Prompt file not found at $PROMPT_FILE"
    exit 1
fi

cd "$WORKTREE_DIR"

# Show quick reference
echo "┌─────────────────────────────────────────────┐"
echo "│  SMI-638: Session Checkpointing             │"
echo "├─────────────────────────────────────────────┤"
echo "│  Files to create:                           │"
echo "│  1. session/SessionCheckpoint.ts            │"
echo "│  2. session/CheckpointManager.ts            │"
echo "│  3. session/index.ts                        │"
echo "│  4. tests/SessionCheckpoint.test.ts         │"
echo "│  5. scripts/session-checkpoint.sh           │"
echo "├─────────────────────────────────────────────┤"
echo "│  After EACH file: docker exec ... typecheck │"
echo "│  Progress: /tmp/smi638-progress.log         │"
echo "└─────────────────────────────────────────────┘"
echo ""

# Read prompt content
PROMPT=$(cat "$PROMPT_FILE")

# Launch Claude with the prompt
exec claude -p "$PROMPT"
