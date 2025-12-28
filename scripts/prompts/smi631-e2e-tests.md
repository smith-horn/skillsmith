Implement SMI-631: E2E Tests with Claude Code Integration

## Context
Working in: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b
Branch: phase-2b

Prerequisites COMPLETE:
- SMI-628: GitHubIndexer
- SMI-627: SearchService
- SMI-629: RankingService
- SMI-630: CacheService

## Deliverables

Create these files IN ORDER:

1. `packages/core/tests/e2e/setup.ts`
   - Test database initialization
   - Mock GitHub API responses
   - Test fixtures for skills

2. `packages/core/tests/e2e/search-flow.test.ts`
   - Full search workflow: query → rank → cache → return
   - Pagination testing
   - Filter combinations

3. `packages/core/tests/e2e/indexing-flow.test.ts`
   - Repository discovery → parsing → storage
   - Rate limit handling
   - Error recovery

4. `packages/mcp-server/tests/e2e/mcp-tools.test.ts`
   - search tool integration
   - get_skill tool integration
   - install_skill workflow

5. Update `vitest.config.ts` with e2e test configuration

## CRITICAL: After EACH file

```bash
docker exec skillsmith-dev-1 npm run typecheck
npx claude-flow@alpha hooks post-edit --file "<filename>" --memory-key "smi631/files"
echo "$(date): Completed <filename>" >> /tmp/smi631-progress.log
```

## Constraints
- Maximum 45 minutes
- Focus ONLY on E2E tests
- Use existing test utilities where possible
- Mock external APIs (GitHub, etc.)

Begin by reading existing test files to understand patterns.
