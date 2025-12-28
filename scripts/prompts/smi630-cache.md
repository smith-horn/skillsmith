Implement SMI-630: Cache Invalidation Strategy

## Context
Working in: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b-parallel
Branch: phase-2b-parallel

Prerequisites COMPLETE:
- SMI-628: GitHubIndexer
- SMI-627: SearchService
- SMI-629: RankingService

## Deliverables

Create these files IN ORDER:

1. `packages/core/src/cache/CacheService.ts`
   - L1: In-memory LRU (hot queries)
   - L2: SQLite cache table (warm data)
   - TTL configuration per cache type
   - Cache key generation

2. `packages/core/src/cache/TTLManager.ts`
   - 1 hour for search results
   - 24 hours for skill details
   - 4 hours for popular queries
   - Expiration checking

3. `packages/core/src/cache/index.ts`
   - Module exports

4. `packages/core/tests/CacheService.test.ts`
   - Hit/miss scenarios
   - TTL expiration
   - LRU eviction

5. Update SearchService.ts to use CacheService

## CRITICAL: After EACH file

```bash
docker exec skillsmith-dev-1 npm run typecheck
npx claude-flow@alpha hooks post-edit --file "<filename>" --memory-key "smi630/files"
echo "$(date): Completed <filename>" >> /tmp/smi630-progress.log
```

## Constraints
- Maximum 45 minutes
- Focus ONLY on caching
- Do NOT start SMI-631

Begin by reading SearchService.ts to understand cache integration points.
