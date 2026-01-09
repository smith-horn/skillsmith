# Wave 3: API Development Retrospective

**Date**: January 7, 2026
**Issues**: SMI-1180, SMI-1229, SMI-1230, SMI-1231, SMI-1232, SMI-1233
**Duration**: ~90 minutes (including follow-up tasks)

## Summary

Created Supabase Edge Functions to expose the skill registry API. Implemented 4 endpoints: search, get skill, recommend, and telemetry events. All endpoints include CORS support, rate limiting headers, and proper error handling.

## Metrics

| Metric | Value |
|--------|-------|
| Files Created | 10 |
| Lines of Code | ~2,500 |
| Endpoints | 4 |
| Unit Tests | 6 (passing) |
| Integration Tests | 29 (require Supabase) |
| Security Issues Fixed | 2 |
| Deployments | 8 (4 initial + 4 with rate limiting) |
| Linear Issues Completed | 6 (SMI-1180, 1229-1233) |

## Files Created/Modified

| File | Purpose | Lines |
|------|---------|-------|
| `supabase/functions/_shared/cors.ts` | CORS headers with production allowlist | 167 |
| `supabase/functions/_shared/supabase.ts` | Supabase client and validation helpers | 173 |
| `supabase/functions/_shared/rate-limiter.ts` | Upstash Redis rate limiting | 242 |
| `supabase/functions/skills-search/index.ts` | Search endpoint with filters | 186 |
| `supabase/functions/skills-get/index.ts` | Get skill by ID endpoint | 182 |
| `supabase/functions/skills-recommend/index.ts` | Recommendations endpoint | 247 |
| `supabase/functions/events/index.ts` | Telemetry events endpoint | 216 |
| `docs/api/openapi.yaml` | OpenAPI 3.0 specification | 555 |
| `tests/api/integration.test.ts` | API integration and unit tests | 468 |
| `tests/performance/api-load-test.js` | k6 load test scripts | 331 |

## What Went Well

1. **Parallel Implementation**: All 4 endpoints were implemented in parallel using the hive mind pattern
2. **Security First**: Initial code review caught 2 vulnerabilities (filter injection, LIKE wildcard injection) which were fixed before completion
3. **Reusable Utilities**: Shared modules (`cors.ts`, `supabase.ts`, `rate-limiter.ts`) reduce code duplication
4. **Comprehensive Testing**: Both unit tests (no dependencies) and integration tests (require Supabase) were created
5. **Rapid Deployment**: All functions deployed to production Supabase project in minutes
6. **Full Documentation**: OpenAPI spec and k6 performance tests created for future maintainability

## What Could Be Improved

1. **Test Infrastructure**: Integration tests require running Supabase locally, which adds setup complexity
2. **Rate Limiting**: Current implementation uses placeholder headers; real rate limiting needs Redis or similar
3. **CORS Configuration**: Using wildcard `*` for development; should restrict in production

## Lessons Learned

1. **PostgREST Filter Safety**: Never interpolate user input directly into PostgREST filter strings - use RPC functions with parameterized queries instead
2. **LIKE Pattern Escaping**: Always escape `%`, `_`, and `\` in user input before LIKE/ILIKE queries
3. **Input Validation Layers**: Apply multiple validation layers:
   - Format validation (regex, length)
   - Sanitization (strip dangerous characters)
   - Rejection validation (reject if still dangerous)
4. **Edge Functions Structure**: The `_shared/` directory pattern works well for Supabase Edge Functions

## Security Fixes Applied

### 1. Filter Injection (CRITICAL)
- **Location**: `skills-recommend/index.ts`
- **Issue**: User input in `stack` array was interpolated directly into PostgREST filter
- **Fix**: Replaced with `search_skills` RPC function + input sanitization

### 2. LIKE Wildcard Injection (MEDIUM)
- **Location**: `skills-get/index.ts`
- **Issue**: User input used directly in `.ilike()` without escaping
- **Fix**: Added `escapeLikePattern()` function to escape special characters

## Completed Follow-up Tasks

| Issue | Description | Status |
|-------|-------------|--------|
| SMI-1229 | Deploy Edge Functions to production | ✅ Done |
| SMI-1230 | Configure production CORS | ✅ Done |
| SMI-1231 | Implement Redis rate limiting | ✅ Done |
| SMI-1232 | Create OpenAPI documentation | ✅ Done |
| SMI-1233 | k6 performance test scripts | ✅ Done |

## Remaining Next Steps

| Issue | Priority | Description |
|-------|----------|-------------|
| [SMI-1234](https://linear.app/smith-horn-group/issue/SMI-1234) | High | Configure Upstash Redis credentials in Supabase secrets |
| [SMI-1235](https://linear.app/smith-horn-group/issue/SMI-1235) | Medium | Run k6 performance tests and establish baselines |
| [SMI-1236](https://linear.app/smith-horn-group/issue/SMI-1236) | Low | Remove deprecated wildcard `corsHeaders` export |

## Deployment Commands

```bash
# Deploy all functions
supabase functions deploy skills-search
supabase functions deploy skills-get
supabase functions deploy skills-recommend
supabase functions deploy events

# Test locally
supabase functions serve

# Run integration tests (requires Supabase)
supabase start
npm test -- --grep "API Integration"
```

## API Quick Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/skills/search` | GET | Search skills with filters |
| `/v1/skills/:id` | GET | Get skill by ID or author/name |
| `/v1/skills/recommend` | POST | Get skill recommendations |
| `/v1/events` | POST | Record telemetry events |

## References

- [Supabase Edge Functions Docs](https://supabase.com/docs/guides/functions)
- [PostgREST Filtering](https://postgrest.org/en/stable/api.html#horizontal-filtering-rows)
- [ADR-013: Supabase Migration](../adr/013-supabase-migration.md) (if created)
