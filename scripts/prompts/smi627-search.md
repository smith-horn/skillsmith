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
   docker exec skillsmith-dev-1 npm run typecheck
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
