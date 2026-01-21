# ADR-019: Filter-Only Skill Search

**Status**: Accepted
**Date**: 2026-01-21
**Deciders**: Skillsmith Team
**Related Issues**: SMI-XXXX (Remove skill search minimum)

## Context

The current skill search implementation requires a text query of at least 2 characters to perform any search. This creates a poor user experience for category-based browsing on the Skillsmith web application (`skillsmith.app/skills`).

### Problem Statement

When users navigate to the skills page and select a category filter (e.g., "Security") without entering a text query:

1. The API returns a `400 Bad Request` error: "Query parameter required (minimum 2 characters)"
2. Users see no results even though security-related skills exist in the database
3. The category dropdown appears to be broken or non-functional

### Current Validation

The 2-character minimum is enforced in multiple locations:

1. **Supabase Edge Function** (`supabase/functions/skills-search/index.ts`):
   ```typescript
   if (!query || query.trim().length < 2) {
     return errorResponse('Query parameter required (minimum 2 characters)', 400)
   }
   ```

2. **MCP Server Schema** (`packages/mcp-server/src/tools/search.ts`):
   ```typescript
   inputSchema: {
     // ...
     required: ['query'],  // Query is required
   }
   ```

3. **MCP Server Validation** (`packages/mcp-server/src/tools/search.ts`):
   ```typescript
   if (!input.query || input.query.trim().length < 2) {
     throw new SkillsmithError(ErrorCodes.SEARCH_QUERY_EMPTY, 'Search query must be at least 2 characters')
   }
   ```

4. **CLI Command** (`packages/cli/src/commands/search.ts`):
   ```typescript
   if (query.length < 2) {
     console.error(chalk.red('Error: Search query must be at least 2 characters'))
     process.exit(1)
   }
   ```

### User Expectations

Users expect to:
- Browse all skills in a category by selecting a category filter
- Filter by trust tier (e.g., "verified only") without a text query
- Combine filters with optional text search
- Use single-character searches (e.g., searching for "R" to find R-related skills)

## Decision

Change search validation from requiring a query to requiring **either**:
- A search query (any length, including single characters), **OR**
- At least one filter parameter (`category`, `trust_tier`, or `min_score`)

Empty requests (no query AND no filters) return a `400` error with a helpful message.

### New Validation Logic

```typescript
// Supabase Edge Function
if (!query && !category && !trustTier && !minScore) {
  return errorResponse(
    'Provide a search query or at least one filter (category, trust_tier, min_score)',
    400,
    { code: 'SEARCH_QUERY_OR_FILTER_REQUIRED' }
  )
}

// MCP Server
if (!input.query && !input.category && !input.trust_tier && input.min_score === undefined) {
  throw new SkillsmithError(
    ErrorCodes.SEARCH_QUERY_EMPTY,
    'Provide a search query or at least one filter'
  )
}

// CLI (non-interactive mode)
if (!query && !opts.tier && !opts.category && opts.minScore === undefined) {
  console.error(chalk.red('Error: Provide a search query or at least one filter'))
  process.exit(1)
}
```

### Schema Changes

```typescript
// MCP Server - remove 'query' from required array
inputSchema: {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search query for finding skills (optional if filters provided)',
    },
    category: { /* ... */ },
    trust_tier: { /* ... */ },
    min_score: { /* ... */ },
  },
  required: [],  // No required fields - validation handles query OR filter
}
```

## Implementation

### 1. Supabase Edge Function (`supabase/functions/skills-search/index.ts`)

Add a filter-only query path that skips FTS and uses direct SQL:

```typescript
// If no query but filters provided, skip FTS and use direct SQL
if (!query && (trustTier || category || normalizedMinScore !== null)) {
  let filterQuery = supabase.from('skills').select('*')

  if (trustTier) {
    filterQuery = filterQuery.eq('trust_tier', trustTier)
  }
  if (normalizedMinScore !== null) {
    filterQuery = filterQuery.gte('quality_score', normalizedMinScore)
  }

  const { data, error } = await filterQuery
    .order('quality_score', { ascending: false })
    .range(offset, offset + limit - 1)

  // Handle category join separately...
}
```

### 2. MCP Server (`packages/mcp-server/src/tools/search.ts`)

- Update `inputSchema.required` from `['query']` to `[]`
- Add combined query/filter validation
- Add filter-only search path using `SearchService.getPopular()` or new method

### 3. CLI (`packages/cli/src/commands/search.ts`)

- Allow `--tier` and `--category` flags without positional query
- Update help text to reflect optional query
- Add filter-only search path

### 4. Core SearchService (`packages/core/src/services/SearchService.ts`)

The `SearchService.search()` method already handles empty queries gracefully by returning empty results. Add a new method for filter-only search:

```typescript
/**
 * Search skills using filters only (no FTS query)
 * Used when browsing by category/tier without text search
 */
searchByFilters(options: Omit<SearchOptions, 'query'>): PaginatedResults<SearchResult> {
  const { limit = 20, offset = 0, trustTier, minQualityScore, category } = options

  // Build filter-only SQL (no FTS MATCH clause)
  let sql = `SELECT * FROM skills s`
  const params: (string | number)[] = []
  const filters: string[] = []

  // Add category join if needed
  if (category) {
    sql += ` INNER JOIN skill_categories sc ON s.id = sc.skill_id
             INNER JOIN categories c ON sc.category_id = c.id`
    filters.push('c.name = ?')
    params.push(category)
  }

  if (trustTier) {
    filters.push('s.trust_tier = ?')
    params.push(trustTier)
  }

  if (minQualityScore !== undefined) {
    filters.push('s.quality_score >= ?')
    params.push(minQualityScore)
  }

  if (filters.length > 0) {
    sql += ` WHERE ${filters.join(' AND ')}`
  }

  sql += ` ORDER BY s.quality_score DESC NULLS LAST LIMIT ? OFFSET ?`
  params.push(limit, offset)

  // Execute and return...
}
```

## Consequences

### Positive

- **Improved UX**: Users can browse skills by category without requiring a text query
- **Intuitive discovery**: Filter-based browsing matches user expectations from other skill/plugin marketplaces
- **Backward compatible**: Existing queries with text search continue to work unchanged
- **Single-character search**: Users can search for "R" or "K" to find language-specific skills
- **Web app fixes**: The `skillsmith.app/skills` category filter will work as expected

### Negative

- **Additional code path**: Filter-only search requires different SQL (no FTS MATCH clause)
- **Slightly more complex validation**: Must check for query OR filter instead of just query
- **Potential for large result sets**: Filter-only queries may return many results (mitigated by pagination)

### Neutral

- Filter-only queries use `ORDER BY quality_score DESC` for relevance (no BM25 ranking)
- Caching keys must include filter parameters even when query is empty
- Documentation and API reference need updates

### Risks

| Risk | Mitigation |
|------|------------|
| Empty FTS queries cause SQL errors | Skip FTS entirely for filter-only; use direct SQL path |
| Performance degradation for filter-only | Ensure indexes exist on `trust_tier`, `quality_score`, and category join |
| Large unfiltered result sets | Require at least one filter; enforce pagination limits |

## Alternatives Considered

### Alternative 1: Default Empty Query to "*"

- **Pros**: Minimal code changes, reuses existing FTS path
- **Cons**: FTS wildcard queries are inefficient; may not work well with BM25 ranking
- **Why rejected**: Performance concerns and semantic mismatch (users aren't searching for "everything")

### Alternative 2: Keep Query Required, Add Browse Endpoint

- **Pros**: Clear separation of search vs. browse use cases
- **Cons**: Duplicates functionality; requires new API endpoint; confusing API surface
- **Why rejected**: Overcomplicates the API; the search endpoint should handle both cases

### Alternative 3: Minimum 1 Character Query

- **Pros**: Simple change from 2 to 1 character minimum
- **Cons**: Still requires a query character; doesn't solve category-only browsing
- **Why rejected**: Doesn't address the core UX issue of filter-only browsing

## References

- [ADR-009: Embedding Service Fallback](./009-embedding-service-fallback.md) - Related pattern for graceful fallback
- [SMI-579: SearchService with FTS5](https://linear.app/smith-horn-group/issue/SMI-579) - Original search implementation
- [SMI-789: Wire search tool to SearchService](https://linear.app/smith-horn-group/issue/SMI-789) - MCP search integration
- Implementation files to change:
  - `supabase/functions/skills-search/index.ts`
  - `packages/mcp-server/src/tools/search.ts`
  - `packages/cli/src/commands/search.ts`
  - `packages/core/src/services/SearchService.ts`
