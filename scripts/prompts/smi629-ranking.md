Implement SMI-629: Skill Ranking Algorithm

## Context
Working in: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b
Branch: phase-2b

Prerequisites COMPLETE:
- SMI-628: GitHubIndexer (indexer/)
- SMI-627: SearchService (services/SearchService.ts)

## Deliverables

Create these files IN ORDER:

1. `packages/core/src/ranking/RankingService.ts`
   - GitHub stars/forks weighting
   - Recency scoring (last_updated)
   - Trust tier multiplier
   - Quality score integration
   - Semantic relevance from search

2. `packages/core/src/ranking/index.ts`
   - Module exports

3. `packages/core/tests/RankingService.test.ts`
   - Unit tests for scoring algorithms
   - Edge cases: missing data, ties

4. Update SearchService.ts to use RankingService

## CRITICAL: After EACH file

```bash
docker exec skillsmith-dev-1 npm run typecheck
npx claude-flow@alpha hooks post-edit --file "<filename>" --memory-key "smi629/files"
echo "$(date): Completed <filename>" >> /tmp/smi629-progress.log
```

## Constraints
- Maximum 45 minutes
- Focus ONLY on ranking
- Do NOT start SMI-630

Begin by reading SearchService.ts to understand the integration point.
