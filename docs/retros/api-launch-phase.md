# API/Launch Phase Retrospective

**Date**: January 8, 2026
**Issues**: SMI-1236, SMI-1244, SMI-1245, SMI-1247, SMI-1248
**Duration**: ~45 minutes

## Summary

Implemented the API client module, caching layer, GitHub indexer Edge Function, and indexer scheduling infrastructure. Also cleaned up deprecated CORS code.

## Metrics

| Metric | Value |
|--------|-------|
| Files Created | 6 |
| Files Modified | 5 |
| Lines of Code | ~1,100 |
| Issues Completed | 5 |
| Issues Pending (external setup) | 4 |

## Files Created

| File | Purpose | Lines |
|------|---------|-------|
| `packages/core/src/api/client.ts` | API client with retry logic | 280 |
| `packages/core/src/api/cache.ts` | In-memory cache with TTL | 220 |
| `packages/core/src/api/index.ts` | API module exports | 28 |
| `supabase/functions/indexer/index.ts` | GitHub indexer Edge Function | 300 |
| `supabase/migrations/003_indexer_schedule.sql` | pg_cron setup | 75 |
| `.github/workflows/indexer.yml` | GitHub Actions schedule | 95 |

## Files Modified

| File | Change |
|------|--------|
| `supabase/functions/_shared/cors.ts` | Removed deprecated `corsHeaders` export |
| `supabase/functions/skills-search/index.ts` | Removed corsHeaders import |
| `supabase/functions/skills-get/index.ts` | Removed corsHeaders import, fixed lint error |
| `packages/core/src/index.ts` | Added API client exports |

## What Went Well

1. **Clean API Design**: The `SkillsmithApiClient` class provides a simple interface with retry logic and timeout handling
2. **Caching Layer**: LRU-like cache with TTL support enables offline functionality
3. **Dual Scheduling Options**: Both pg_cron and GitHub Actions workflows for flexibility
4. **CORS Cleanup**: Successfully removed deprecated wildcard CORS without breaking existing endpoints

## Issues Requiring External Setup

| Issue | Requirement | Status |
|-------|-------------|--------|
| SMI-1234 | Upstash Redis account + credentials | User action needed |
| SMI-1246 | PostHog project setup | User action needed |
| SMI-1235 | k6 installation + test execution | User action needed |
| SMI-1186 | npm publish (depends on SMI-1244, 1246) | Blocked |

## API Client Features

```typescript
const client = new SkillsmithApiClient({
  anonKey: process.env.SUPABASE_ANON_KEY,
  timeout: 30000,
  maxRetries: 3,
});

// Search with filters
const results = await client.search({
  query: 'testing',
  trustTier: 'verified',
  limit: 10,
});

// Get skill by ID
const skill = await client.getSkill('author/skill-name');

// Get recommendations
const recs = await client.getRecommendations({
  stack: ['react', 'typescript'],
  project_type: 'web',
});

// Record telemetry (non-blocking)
await client.recordEvent({
  event: 'skill_view',
  skill_id: 'abc123',
  anonymous_id: generateAnonymousId(),
});
```

## Cache Features

```typescript
const cache = new ApiCache({
  defaultTtl: 3600000, // 1 hour
  maxEntries: 1000,
  enableStats: true,
});

// Cache with endpoint-specific TTL
cache.set('search:testing', results, 'search'); // 1h TTL
cache.set('skill:abc123', skill, 'getSkill'); // 24h TTL

// Get statistics
const stats = cache.getStats();
// { hits: 150, misses: 20, entries: 45, hitRate: 0.88 }
```

## Indexer Features

- Searches GitHub for claude-code related topics
- Rate limit handling with exponential backoff
- Dry-run mode for testing
- Audit logging to Supabase
- Two scheduling options:
  - pg_cron (database-level)
  - GitHub Actions (CI-level)

## Next Steps

1. **User Actions Required**:
   - Set up Upstash Redis for SMI-1234
   - Create PostHog project for SMI-1246
   - Install k6 and run performance tests

2. **After External Setup**:
   - Configure Upstash credentials in Supabase secrets
   - Deploy indexer function: `supabase functions deploy indexer`
   - Enable cron schedule in migration
   - Run k6 tests: `k6 run tests/performance/api-load-test.js`

3. **npm Publish (SMI-1186)**:
   - Bump version to 0.2.0
   - Update CHANGELOG
   - Run `npm publish` workflow

## References

- [API Client](packages/core/src/api/client.ts)
- [Indexer Function](supabase/functions/indexer/index.ts)
- [Wave 3 Retro](docs/retros/wave-3-api-development.md)
- [OpenAPI Spec](docs/api/openapi.yaml)
