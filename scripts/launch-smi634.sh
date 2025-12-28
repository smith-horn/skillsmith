#!/bin/bash
# Launch focused session for SMI-634: Swarm Coordination
# Uses phase-2b-swarm worktree

set -e

WORKTREE_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b-swarm"
ISSUE="SMI-634"
# Get absolute path to prompt file BEFORE cd
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/prompts/smi634-swarm-coordination.md"

echo "=== Launching $ISSUE Session ==="
echo "Worktree: $WORKTREE_DIR"
echo "Branch: phase-2b-swarm"
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
echo "│  SMI-634: Swarm Coordination Improvements   │"
echo "├─────────────────────────────────────────────┤"
echo "│  Files to create:                           │"
echo "│  1. swarm/SwarmCoordinator.ts               │"
echo "│  2. swarm/AgentState.ts                     │"
echo "│  3. swarm/TaskQueue.ts                      │"
echo "│  4. swarm/index.ts                          │"
echo "│  5. tests/SwarmCoordinator.test.ts          │"
echo "├─────────────────────────────────────────────┤"
echo "│  After EACH file: docker exec ... typecheck │"
echo "│  Progress: /tmp/smi634-progress.log         │"
echo "└─────────────────────────────────────────────┘"
echo ""

# Read prompt content
PROMPT=$(cat "$PROMPT_FILE")

# Launch Claude with the prompt
exec claude -p "$PROMPT"
