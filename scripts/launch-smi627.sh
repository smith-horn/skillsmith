#!/bin/bash
# Launch focused session for SMI-627: Core Search Implementation
# Usage: ./scripts/launch-smi627.sh

set -e

REPO_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/skillsmith"
WORKTREE_DIR="/Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b"
BRANCH_NAME="phase-2b"

echo "=== SMI-627 Focused Session Launcher ==="
echo ""

# 1. Setup worktree
echo "Setting up worktree..."
cd "$REPO_DIR"

if [ -d "$WORKTREE_DIR" ]; then
    echo "Worktree already exists at $WORKTREE_DIR"
else
    git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" 2>/dev/null || \
    git worktree add "$WORKTREE_DIR" "$BRANCH_NAME"
    echo "Created worktree at $WORKTREE_DIR"
fi

cd "$WORKTREE_DIR"
echo "Working directory: $(pwd)"
echo ""

# 2. Verify dependencies
echo "Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi
echo ""

# 3. Verify SMI-628 files exist
echo "Verifying SMI-628 prerequisites..."
REQUIRED_FILES=(
    "packages/core/src/indexer/SkillParser.ts"
    "packages/core/src/indexer/GitHubIndexer.ts"
    "packages/core/src/repositories/IndexerRepository.ts"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "  ✓ $file"
    else
        echo "  ✗ $file (MISSING - pull from main?)"
    fi
done
echo ""

# 4. Create prompt file
PROMPT_FILE="/tmp/smi627-prompt.md"
cat > "$PROMPT_FILE" << 'PROMPT_EOF'
Implement SMI-627: Core Search Functionality

## Context
Working in: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b
This is a git worktree of skillsmith-phase2-indexer on branch phase-2b.

SMI-628 (GitHub Indexing) is COMPLETE. Use the existing:
- packages/core/src/indexer/SkillParser.ts
- packages/core/src/indexer/GitHubIndexer.ts
- packages/core/src/repositories/IndexerRepository.ts

## Deliverables

Create these files IN ORDER, one at a time:

1. `packages/core/src/services/SearchService.ts`
   - Hybrid search: SQLite FTS5 + vector similarity
   - Filter by category, trust_tier, min_quality_score
   - Pagination with limit/offset
   - Return ranked results

2. `packages/core/src/search/FTS5Index.ts`
   - Full-text search on name, description, tags
   - Relevance scoring

3. `packages/core/src/search/index.ts`
   - Module exports

4. `packages/core/tests/SearchService.test.ts`
   - Unit tests for all search methods
   - Edge cases: empty results, special characters, pagination

5. Update `packages/core/src/index.ts` with new exports

## CRITICAL: After EACH file

1. Run typecheck immediately:
   ```bash
   npm run typecheck
   ```

2. If errors, fix before proceeding to next file

3. Checkpoint to memory:
   ```bash
   npx claude-flow@alpha hooks post-edit --file "<filename>" --memory-key "smi627/files"
   ```

4. Log progress:
   ```bash
   echo "$(date): Completed <filename>" >> /tmp/smi627-progress.log
   ```

## Linear Updates

At START: Verify SMI-627 is "In Progress"

After EACH file, log which files are complete.

At END: Move SMI-627 to "Done" with summary including:
- Files created
- Test count
- Any issues encountered

## Constraints

- Maximum 45 minutes of work
- If approaching context limits, checkpoint state and exit cleanly
- Do NOT start SMI-629 or other issues
- Focus ONLY on search functionality
- Keep responses concise to preserve context

## Success Criteria

- [ ] SearchService.ts compiles (typecheck passes)
- [ ] FTS5Index.ts compiles (typecheck passes)
- [ ] All tests pass (npm test)
- [ ] Linear updated with completion summary

## Start

1. First, read packages/core/src/repositories/IndexerRepository.ts to understand the database schema
2. Check if packages/core/src/services/ directory exists
3. Create SearchService.ts

Begin now.
PROMPT_EOF

echo "Created prompt file: $PROMPT_FILE"
echo ""

# 5. Show quick reference
cat << 'REFERENCE'
╔══════════════════════════════════════════════════════════════════╗
║                    SMI-627 QUICK REFERENCE                       ║
╠══════════════════════════════════════════════════════════════════╣
║  After EACH file:                                                ║
║    npm run typecheck                                             ║
║    npx claude-flow@alpha hooks post-edit --file "X" \            ║
║        --memory-key "smi627/files"                               ║
║                                                                  ║
║  Check progress:                                                 ║
║    cat /tmp/smi627-progress.log                                  ║
║                                                                  ║
║  If session stalls:                                              ║
║    npx claude-flow@alpha memory get smi627/files                 ║
║                                                                  ║
║  Time limit: 45 minutes                                          ║
╚══════════════════════════════════════════════════════════════════╝

REFERENCE

# 6. Initialize progress log
echo "=== SMI-627 Session Started: $(date) ===" > /tmp/smi627-progress.log
echo "Initialized progress log: /tmp/smi627-progress.log"
echo ""

# 7. Launch Claude
echo "Launching Claude Code..."
echo "─────────────────────────────────────────────────────────────────"
echo ""

# Use --print to show prompt, then start interactive session
cat "$PROMPT_FILE"
echo ""
echo "─────────────────────────────────────────────────────────────────"
echo ""
echo "Starting Claude with the above prompt..."
echo ""

# Launch Claude with the prompt (fresh session by default)
claude -p "$(cat $PROMPT_FILE)"
