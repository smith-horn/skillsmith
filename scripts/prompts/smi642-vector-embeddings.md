Implement SMI-642: Vector Embeddings for Semantic Search

## Context
Working in: /Users/williamsmith/Documents/GitHub/Claude-Skill-Discovery/worktrees/phase-2b-parallel
Branch: phase-2b-parallel

Prerequisites COMPLETE:
- SMI-628: GitHubIndexer
- SMI-627: SearchService
- SMI-629: RankingService
- SMI-630: CacheService

## Deliverables

Create these files IN ORDER:

1. `packages/core/src/embeddings/EmbeddingService.ts`
   - Generate embeddings for skill descriptions
   - Use @xenova/transformers (already in deps)
   - Batch processing for efficiency
   - Embedding dimension: 384 (all-MiniLM-L6-v2)

2. `packages/core/src/embeddings/VectorStore.ts`
   - SQLite-based vector storage
   - Cosine similarity search
   - Index management

3. `packages/core/src/embeddings/index.ts`
   - Module exports

4. `packages/core/tests/EmbeddingService.test.ts`
   - Embedding generation tests
   - Similarity search tests
   - Batch processing tests

5. Update SearchService.ts for hybrid search
   - FTS5 for keyword matching
   - Vector similarity for semantic matching
   - Combined scoring

## CRITICAL: After EACH file

```bash
docker exec skillsmith-dev-1 npm run typecheck
npx claude-flow@alpha hooks post-edit --file "<filename>" --memory-key "smi642/files"
echo "$(date): Completed <filename>" >> /tmp/smi642-progress.log
```

## Constraints
- Maximum 45 minutes
- Focus ONLY on embeddings
- Reuse existing EmbeddingService patterns if present
- Keep vector dimensions consistent (384)

Begin by checking if embeddings/ directory exists and reading any existing code.
