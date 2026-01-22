#!/bin/bash
# Launch script for Category System Expansion worktree
# Single worktree, sequential wave execution (dependency chain)
#
# Related Linear Issues:
#   SMI-1675: Parent - Skill Categorization Gap Analysis - 77% Coverage Target
#   SMI-1676: Add 'Integrations' category for MCP ecosystem
#   SMI-1677: Expand Development category rules for AI/Claude ecosystem
#   SMI-1678: Expand Productivity category rules for AI assistants
#   SMI-1679: Create migration 019 with expanded categorization rules
#   SMI-1680: Run re-categorization and validate coverage metrics

set -e

WORKTREE_PATH="/Users/williamsmith/Documents/GitHub/Smith-Horn/worktrees/category-expansion"
MAIN_REPO="/Users/williamsmith/Documents/GitHub/Smith-Horn/skillsmith"
BRANCH_NAME="feature/category-expansion"

echo "========================================================================"
echo "Category System Expansion - Worktree Launch"
echo "========================================================================"
echo ""

# Check if worktree exists
if [ ! -d "$WORKTREE_PATH" ]; then
    echo "ERROR: Worktree not found at $WORKTREE_PATH"
    echo "Create it first from main repo:"
    echo "  git worktree add $WORKTREE_PATH -b $BRANCH_NAME"
    exit 1
fi

cd "$WORKTREE_PATH"

# Sync with main
echo "Syncing with origin/main..."
git fetch origin main
git rebase origin/main 2>/dev/null || {
    echo "Rebase had conflicts - resolve manually"
}

# Check Docker
echo ""
echo "Checking Docker..."
if docker ps --filter name=skillsmith-dev-1 --format "{{.Status}}" 2>/dev/null | grep -q "Up"; then
    echo "  Docker container running"
else
    echo "  Starting Docker container..."
    docker compose --profile dev up -d 2>/dev/null || true
    sleep 3
fi

# Display task context
cat << 'PROMPT'
================================================================================
SMI-1675: Category System Expansion - 77% Coverage Target
================================================================================

## Problem
93.5% of skills (13,300 of 14,231) have no category assigned.
Current categorization rules are too narrow.

## Solution: Sequential Waves

### Wave 1: Schema Changes (SMI-1676)
- Add 'integrations' category to categories table
- Update UI dropdowns to include new category

### Wave 2: Rule Expansion (SMI-1677, SMI-1678)
- Expand Development rules: claude, anthropic, ai-coding, llm, ai-agent
- Expand Productivity rules: ai-assistant, chatbot, rag, orchestration

### Wave 3: Migration & Validation (SMI-1679, SMI-1680)
- Create migration 019 combining all rule changes
- Run migration on production
- Validate coverage reaches ~77%

## Key Files
- supabase/migrations/019_expanded_skill_categories.sql (create)
- supabase/functions/indexer/index.ts (update categorizeSkill)
- packages/website/src/pages/skills/index.astro (add integrations option)

## Commands
```bash
# Use Docker for all commands
docker exec skillsmith-dev-1 npm run build
docker exec skillsmith-dev-1 npm test
docker exec skillsmith-dev-1 npm run typecheck

# Deploy edge functions
npx supabase functions deploy indexer
npx supabase functions deploy skills-search --no-verify-jwt

# Run migration
npx supabase db push
```

## When Done
1. Commit with conventional commit messages
2. Push to remote: git push origin feature/category-expansion
3. Create PR: gh pr create --title "feat: Category system expansion (SMI-1675)"
4. Update Linear issues to Done

================================================================================
PROMPT

echo ""
echo "Worktree ready at: $WORKTREE_PATH"
echo "Branch: $BRANCH_NAME"
echo ""
echo "Starting Claude Code..."
echo ""

# Launch Claude Code
claude
