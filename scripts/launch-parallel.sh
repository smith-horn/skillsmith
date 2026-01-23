#!/bin/bash
# Launch a parallel session in a separate worktree
# Usage: ./scripts/launch-parallel.sh <issue-id>
# Example: ./scripts/launch-parallel.sh smi643

set -e

# =============================================================================
# SMI-1687: Docker container check (required for npm execution)
# =============================================================================
DOCKER_CONTAINER="skillsmith-dev-1"

if ! command -v docker &> /dev/null; then
  echo "Error: Docker is not installed"
  exit 1
fi

if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${DOCKER_CONTAINER}$"; then
  echo "Error: Docker container '${DOCKER_CONTAINER}' is not running"
  echo "Start it with: docker compose --profile dev up -d"
  exit 1
fi

echo "Using Docker container: ${DOCKER_CONTAINER}"

ISSUE_ID="${1:-smi643}"
REPO_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith"
WORKTREE_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b-parallel"
BRANCH_NAME="phase-2b-parallel"

PROMPT_FILE="$REPO_DIR/scripts/prompts/${ISSUE_ID}-swarm-indexing.md"

if [ ! -f "$PROMPT_FILE" ]; then
    PROMPT_FILE="$REPO_DIR/scripts/prompts/${ISSUE_ID}.md"
fi

if [ ! -f "$PROMPT_FILE" ]; then
    echo "Error: No prompt found for $ISSUE_ID"
    echo "Available prompts:"
    ls -1 "$REPO_DIR/scripts/prompts/"
    exit 1
fi

ISSUE_UPPER=$(echo "$ISSUE_ID" | tr '[:lower:]' '[:upper:]')

echo "=== $ISSUE_UPPER PARALLEL Session Launcher ==="
echo ""

# 1. Setup SEPARATE worktree for parallel work
echo "Setting up parallel worktree..."
cd "$REPO_DIR"

if [ -d "$WORKTREE_DIR" ]; then
    echo "Parallel worktree exists at $WORKTREE_DIR"
else
    git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" 2>/dev/null || \
    git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"
    echo "Created parallel worktree at $WORKTREE_DIR"
fi

cd "$WORKTREE_DIR"
echo "Working directory: $(pwd)"
echo ""

# 2. Verify dependencies (SMI-1687: use Docker for npm)
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies via Docker..."
    docker exec $DOCKER_CONTAINER npm install
fi

# 3. Show info
cat << INFO
╔══════════════════════════════════════════════════════════════════╗
║              $ISSUE_UPPER PARALLEL SESSION
╠══════════════════════════════════════════════════════════════════╣
║  Worktree: skillsmith-phase2b-parallel                           ║
║  Branch:   phase-2b-parallel                                     ║
║                                                                  ║
║  This runs SEPARATELY from SMI-627 in skillsmith-phase2b         ║
║                                                                  ║
║  After EACH file:                                                ║
║    docker exec $DOCKER_CONTAINER npm run typecheck               ║
║    npx claude-flow@alpha hooks post-edit --file "X" \\
║        --memory-key "${ISSUE_ID}/files"
║                                                                  ║
║  Progress: /tmp/${ISSUE_ID}-progress.log
╚══════════════════════════════════════════════════════════════════╝

INFO

# 4. Initialize progress log
echo "=== $ISSUE_UPPER Session Started: $(date) ===" > "/tmp/${ISSUE_ID}-progress.log"

# 5. Launch
echo "Launching Claude Code..."
echo ""
claude -p "$(cat $PROMPT_FILE)"
