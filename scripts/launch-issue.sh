#!/bin/bash
# Generic launcher for focused issue sessions
# Usage: ./scripts/launch-issue.sh <issue-id>
# Example: ./scripts/launch-issue.sh smi627

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

ISSUE_ID="${1:-}"
REPO_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith"
WORKTREE_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b"
BRANCH_NAME="phase-2b"

if [ -z "$ISSUE_ID" ]; then
    echo "Usage: $0 <issue-id>"
    echo ""
    echo "Available prompts:"
    ls -1 "$REPO_DIR/scripts/prompts/" 2>/dev/null | sed 's/.md$//' | sed 's/^/  /'
    echo ""
    echo "Or use the dedicated launcher:"
    echo "  ./scripts/launch-smi627.sh"
    exit 1
fi

PROMPT_FILE="$REPO_DIR/scripts/prompts/${ISSUE_ID}.md"

if [ ! -f "$PROMPT_FILE" ]; then
    # Try with lowercase
    PROMPT_FILE="$REPO_DIR/scripts/prompts/$(echo $ISSUE_ID | tr '[:upper:]' '[:lower:]').md"
fi

if [ ! -f "$PROMPT_FILE" ]; then
    echo "Error: No prompt found for $ISSUE_ID"
    echo ""
    echo "Available prompts:"
    ls -1 "$REPO_DIR/scripts/prompts/" 2>/dev/null | sed 's/.md$//' | sed 's/^/  /'
    exit 1
fi

ISSUE_UPPER=$(echo "$ISSUE_ID" | tr '[:lower:]' '[:upper:]')

echo "=== $ISSUE_UPPER Focused Session Launcher ==="
echo ""

# 1. Setup worktree
echo "Setting up worktree..."
cd "$REPO_DIR"

if [ -d "$WORKTREE_DIR" ]; then
    echo "Worktree exists at $WORKTREE_DIR"
else
    git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" 2>/dev/null || \
    git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"
    echo "Created worktree at $WORKTREE_DIR"
fi

cd "$WORKTREE_DIR"
echo "Working directory: $(pwd)"
echo ""

# 2. Verify dependencies (SMI-1687: use Docker for npm)
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies via Docker..."
    docker exec $DOCKER_CONTAINER npm install
fi

# 3. Show quick reference
cat << REFERENCE
╔══════════════════════════════════════════════════════════════════╗
║                    $ISSUE_UPPER QUICK REFERENCE
╠══════════════════════════════════════════════════════════════════╣
║  After EACH file:                                                ║
║    docker exec $DOCKER_CONTAINER npm run typecheck               ║
║    npx claude-flow@alpha hooks post-edit --file "X" \\
║        --memory-key "${ISSUE_ID}/files"
║                                                                  ║
║  Check progress:                                                 ║
║    cat /tmp/${ISSUE_ID}-progress.log
║                                                                  ║
║  Recovery:                                                       ║
║    npx claude-flow@alpha memory get ${ISSUE_ID}/files
║                                                                  ║
║  Time limit: 45 minutes                                          ║
╚══════════════════════════════════════════════════════════════════╝

REFERENCE

# 4. Initialize progress log
PROGRESS_LOG="/tmp/${ISSUE_ID}-progress.log"
echo "=== $ISSUE_UPPER Session Started: $(date) ===" > "$PROGRESS_LOG"
echo "Progress log: $PROGRESS_LOG"
echo ""

# 5. Show prompt
echo "─────────────────────────────────────────────────────────────────"
cat "$PROMPT_FILE"
echo ""
echo "─────────────────────────────────────────────────────────────────"
echo ""

# 6. Launch Claude
echo "Launching Claude Code with fresh context..."
claude -p "$(cat $PROMPT_FILE)"
