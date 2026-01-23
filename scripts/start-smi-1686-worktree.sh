#!/bin/bash
# SMI-1686: File Size Reduction Worktree Setup
# Creates isolated worktree for wave-based file splitting
set -e

WORKTREE_NAME="smi-1686-file-reduction"
BRANCH_NAME="refactor/smi-1686-file-reduction"
WORKTREE_PATH="../worktrees/$WORKTREE_NAME"
MAIN_REPO="$(pwd)"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         SMI-1686: File Size Reduction Worktree Setup         ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# 1. Ensure we're in the right directory
if [ ! -f "package.json" ] || ! grep -q "skillsmith" package.json; then
    echo "❌ Must run from skillsmith repository root"
    exit 1
fi

# 2. Ensure on main and up-to-date
echo "📥 Syncing with main branch..."
git checkout main
git pull origin main
echo "✅ Main branch up-to-date"

# 3. Unlock git-crypt if needed
if [ -f .gitattributes ] && grep -q "git-crypt" .gitattributes; then
    if git-crypt status docs/ 2>/dev/null | head -1 | grep -q "encrypted:"; then
        echo "🔓 Unlocking git-crypt..."
        varlock run -- sh -c 'git-crypt unlock "${GIT_CRYPT_KEY_PATH/#\~/$HOME}"'
        echo "✅ Git-crypt unlocked"
    else
        echo "✅ Git-crypt already unlocked"
    fi
fi

# 4. Create worktree
mkdir -p ../worktrees
if [ ! -d "$WORKTREE_PATH" ]; then
    echo "🌳 Creating worktree..."
    git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME"
    echo "✅ Created worktree: $WORKTREE_PATH"
else
    echo "✅ Worktree exists: $WORKTREE_PATH"
    cd "$WORKTREE_PATH"
    git fetch origin main
    echo "📥 Rebasing on main..."
    git rebase origin/main || {
        echo "⚠️  Rebase conflicts - resolve manually"
        exit 1
    }
fi

# 5. Navigate to worktree
cd "$WORKTREE_PATH"
echo "📂 Working in: $(pwd)"

# 6. Start Docker container
echo "🐳 Starting Docker container..."
docker compose --profile dev up -d
sleep 3

# 7. Verify Docker is healthy
if docker ps --filter name=skillsmith-dev-1 --format "{{.Status}}" | grep -q "Up"; then
    echo "✅ Docker container running"
else
    echo "❌ Docker container failed to start"
    exit 1
fi

# 8. Install dependencies (in case of lockfile changes)
echo "📦 Checking dependencies..."
docker exec skillsmith-dev-1 npm install --silent

# 9. Run pre-flight checks
echo ""
echo "🔍 Running pre-flight checks..."
echo ""

echo "  TypeScript..."
docker exec skillsmith-dev-1 npm run typecheck
echo "  ✅ TypeScript passes"

echo "  Tests..."
docker exec skillsmith-dev-1 npm test --silent
echo "  ✅ Tests pass"

echo "  Governance audit..."
docker exec skillsmith-dev-1 npm run audit:standards 2>&1 | tail -10
echo ""

# 10. Snapshot current import state
echo "📸 Saving import snapshot..."
grep -r "from '.*PatternStore" packages/ > /tmp/smi-1686-imports-before.txt 2>/dev/null || true
grep -r "from '.*hnsw-store" packages/ >> /tmp/smi-1686-imports-before.txt 2>/dev/null || true
grep -r "from '.*MultiLLMProvider" packages/ >> /tmp/smi-1686-imports-before.txt 2>/dev/null || true
echo "✅ Import snapshot saved to /tmp/smi-1686-imports-before.txt"

# 11. Create context file for Claude session
cat > .claude-context.md << 'CONTEXT'
# SMI-1686: File Size Reduction

## Objective
Split 53 files from >500 lines to <500 lines using layer-based pattern.

## Current Wave
Execute waves sequentially. See docs/execution/smi-1686-file-size-reduction-plan.md

## Wave 1 Files (SMI-1692)
- packages/core/src/learning/PatternStore.ts (1495 lines)
- packages/core/src/embeddings/hnsw-store.ts (1225 lines)
- packages/core/src/testing/MultiLLMProvider.ts (1164 lines)

## Critical Constraints
1. Keep dynamic imports in main file (lazy loading)
2. Preserve `import type` syntax
3. Update index.ts re-exports immediately after each split

## Commands
```bash
# Execute Wave 1
./claude-flow swarm --config .claude/hive-mind/smi-1686-wave-1.yaml

# Verify after each file
docker exec skillsmith-dev-1 npm run typecheck
docker exec skillsmith-dev-1 npm test

# Full verification after wave
docker exec skillsmith-dev-1 npm run audit:standards
```

## Completion
- [ ] Wave 1: PatternStore, hnsw-store, MultiLLMProvider
- [ ] Wave 2: ReasoningBank, SecurityScanner, SONARouter, AuditEventTypes
- [ ] Wave 3: MCP Tools (5 files)
- [ ] Wave 4: Billing (5 files)
- [ ] Wave 5: Analysis (6 files)
- [ ] Wave 6: Remaining (30 files)
CONTEXT

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    Worktree Ready                            ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Path:   $WORKTREE_PATH"
echo "║  Branch: $BRANCH_NAME"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Execute waves with:                                         ║"
echo "║    cd $WORKTREE_PATH"
echo "║    ./claude-flow swarm --config .claude/hive-mind/smi-1686-wave-1.yaml"
echo "╚══════════════════════════════════════════════════════════════╝"
