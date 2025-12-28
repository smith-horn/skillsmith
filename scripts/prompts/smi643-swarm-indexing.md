Implement SMI-643: Swarm Coordination for Parallel Repository Indexing

## Context
Working in: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b-parallel
This is a git worktree of skillsmith-phase2-indexer on branch phase-2b-parallel.

SMI-628 (GitHub Indexing) is COMPLETE. Use the existing:
- packages/core/src/indexer/GitHubIndexer.ts

## Deliverables

Create these files IN ORDER, one at a time:

1. `packages/core/src/indexer/SwarmIndexer.ts`
   - Partition repositories by letter range (A-F, G-L, M-R, S-Z)
   - Spawn parallel indexer workers
   - Coordinate via claude-flow swarm
   - Aggregate results to shared database
   - Rate limit coordination across workers

2. `packages/core/src/indexer/PartitionStrategy.ts`
   - Partition logic for repository lists
   - Load balancing across workers
   - Handle uneven distributions

3. `packages/core/tests/SwarmIndexer.test.ts`
   - Unit tests for partitioning
   - Mock swarm coordination
   - Aggregation tests

4. Update `packages/core/src/indexer/index.ts` with new exports

## CRITICAL: After EACH file

1. Run typecheck immediately:
   ```bash
   docker exec skillsmith-dev-1 npm run typecheck
   ```

2. If errors, fix before proceeding to next file

3. Checkpoint to memory:
   ```bash
   npx claude-flow@alpha hooks post-edit --file "<filename>" --memory-key "smi643/files"
   ```

4. Log progress:
   ```bash
   echo "$(date): Completed <filename>" >> /tmp/smi643-progress.log
   ```

## Constraints

- Maximum 45 minutes of work
- Focus ONLY on swarm indexing
- Do NOT modify SearchService or other SMI-627 files
- Only modify files in packages/core/src/indexer/

## Success Criteria

- [ ] SwarmIndexer.ts compiles
- [ ] PartitionStrategy.ts compiles
- [ ] All tests pass
- [ ] Linear updated with completion summary

## Start

1. First, read packages/core/src/indexer/GitHubIndexer.ts to understand the interface
2. Create SwarmIndexer.ts that wraps GitHubIndexer with parallel execution

Begin now.
