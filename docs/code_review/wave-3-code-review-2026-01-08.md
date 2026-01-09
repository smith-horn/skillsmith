# Wave 3 Code Review Summary

**Date**: January 8, 2026
**Scope**: SMI-1234 through SMI-1249 (API/Launch Phase)
**Reviewers**: Automated code review agents + flaky test detector

---

## Executive Summary

| Category | Critical | High | Medium | Low | Info |
|----------|----------|------|--------|-----|------|
| API Client (SMI-1244/1245) | 0 | 3 | 4 | 3 | 2 |
| PostHog Integration (SMI-1246) | 1 | 2 | 3 | 3 | 2 |
| k6 Performance Tests (SMI-1235) | 0 | 2 | 3 | 3 | 2 |
| Edge Functions (SMI-1234/1236) | 0 | 1 | 5 | 4 | 0 |
| Flaky Test Patterns | - | 37 | 258 | 34 | - |
| **Total** | **1** | **45** | **273** | **47** | **6** |

---

## Critical Issues (Requires Immediate Action)

### 1. PII Leakage Risk in PostHog (SMI-1246)

**File**: `packages/core/src/telemetry/posthog.ts`

**Issue**: The `identifyUser()` function accepts arbitrary `traits` properties with no validation. Callers could pass email, name, or other PII, violating the documented "no PII collected" promise.

**Risk**: GDPR/CCPA violations, privacy policy inconsistency.

**Recommendation**:
- Remove `identifyUser()` entirely (not needed for anonymous analytics), or
- Add strict allowlist of permitted trait keys

---

## High Severity Issues

### API Client Module (3 issues)

| Issue | Location | Description | Fix |
|-------|----------|-------------|-----|
| RegExp Injection | `cache.ts:199` | `invalidatePattern()` accepts strings converted to RegExp without escaping | Escape special chars or require RegExp objects |
| Fragile Retry Skip | `client.ts:213` | String matching `'API error'` for retry decisions | Use custom error class with `retryable` flag |
| No Response Validation | `client.ts:205` | Type assertion without runtime validation | Add zod/io-ts schema validation |

### PostHog Integration (2 issues)

| Issue | Location | Description | Fix |
|-------|----------|-------------|-----|
| Shutdown State Reset | Line 221-233 | `isDisabled = false` after shutdown loses original disabled preference | Remove reset or add separate `resetPostHog()` |
| Feature Flag Event Loop | Line 180-199 | Every flag check creates tracking event (high volume + cost) | Remove auto-tracking or add sampling |

### k6 Performance Tests (2 issues)

| Issue | Location | Description | Fix |
|-------|----------|-------------|-----|
| Missing Indexer Coverage | Line 262-276 | `/indexer` endpoint not tested | Add indexer test with dry-run mode |
| Hardcoded Skill ID | Line 153-178 | Uses `test-skill` that returns 404 | Chain with search or seed test data |

### Edge Functions (1 issue)

| Issue | Location | Description | Fix |
|-------|----------|-------------|-----|
| Rate Limit Fail-Open | `rate-limiter.ts:149-192` | Redis failures silently allow all requests | Implement in-memory fallback or configurable fail-closed |

---

## Medium Severity Issues Summary

### API Client (4 issues)
- No automatic cache pruning (expired entries accumulate)
- O(n) eviction strategy (inefficient at scale)
- Single entry eviction per capacity hit
- No input validation on search queries

### PostHog (3 issues)
- Not included in `initializeTelemetry()` unified init
- Zero test coverage for PostHog module
- Unreliable version detection (`npm_package_version` not available in production)

### k6 Tests (3 issues)
- Error rate threshold (20%) too permissive
- Insufficient rate limit testing
- VU count exceeds rate limits in stress test

### Edge Functions (5 issues)
- Client IP spoofing possible via proxy headers
- Development mode CORS bypass uses substring matching
- In-memory filtering after database query (inefficient)
- Multiple sequential database queries in skills-get
- Silent failure in telemetry endpoint

---

## Flaky Test Analysis

**Total Files Scanned**: 127
**Patterns Found**: 329

### By Severity

| Severity | Count | Primary Pattern |
|----------|-------|-----------------|
| High | 37 | Short timeouts (<100ms), second-boundary timestamps |
| Medium | 258 | Unmocked `Date.now()`, `new Date()` |
| Low | 34 | `Math.random()` without seeding |

### Top Offenders

| File | High | Medium | Description |
|------|------|--------|-------------|
| `LicenseKeyGenerator.test.ts` | 17 | 13 | Timestamp calculations |
| `LicenseValidator.test.ts` | 7 | 4 | Expiration testing |
| `MemoryProfiler.test.ts` | 4 | 5 | Short setTimeout delays |
| `metrics-aggregator.test.ts` | 0 | 24 | Unmocked Date.now() |
| `RetentionEnforcer.test.ts` | 0 | 12 | Date-based logic |

### Recommended Fixes

1. **Add global fake timers**:
   ```typescript
   beforeEach(() => {
     vi.useFakeTimers()
     vi.setSystemTime(new Date('2024-01-01T12:00:00Z'))
   })

   afterEach(() => {
     vi.useRealTimers()
   })
   ```

2. **Replace short timeouts**:
   ```typescript
   // Before
   await new Promise(r => setTimeout(r, 10))

   // After
   await vi.advanceTimersByTimeAsync(10)
   ```

3. **Mock Math.random() for determinism**:
   ```typescript
   vi.spyOn(Math, 'random').mockReturnValue(0.5)
   ```

---

## Strengths Observed

### API Client
- Clean exponential backoff with jitter
- Proper AbortController timeout handling
- Telemetry fails silently (non-blocking)
- Good JSDoc documentation

### Edge Functions
- Parameterized RPC functions prevent SQL injection
- `escapeLikePattern()` for ILIKE queries
- Metadata sanitization with allowlist approach
- Request ID tracking for debugging
- Good use of shared utility modules

### k6 Tests
- Well-structured scenarios (smoke, load, stress)
- Custom metrics per endpoint
- Rate limit hit tracking
- Proper setup/teardown lifecycle

---

## Action Items by Priority

### P0 - Critical (Before Merge)
1. [ ] Remove or restrict `identifyUser()` in PostHog module

### P1 - High (This Sprint)
2. [ ] Fix RegExp injection in cache `invalidatePattern()`
3. [ ] Replace string-based retry skip with error class
4. [ ] Add runtime validation for API responses
5. [ ] Implement fail-closed or fallback rate limiter
6. [ ] Add PostHog to unified telemetry init
7. [ ] Add test coverage for PostHog module

### P2 - Medium (Next Sprint)
8. [ ] Add automatic cache pruning
9. [ ] Extend search_skills RPC to support filter parameters
10. [ ] Create unified skill lookup RPC
11. [ ] Add indexer endpoint to k6 tests
12. [ ] Lower k6 error rate thresholds per scenario

### P3 - Low (Backlog)
13. [ ] Fix 37 high-severity flaky test patterns
14. [ ] Add global fake timers to test setup
15. [ ] Document production CORS_ALLOWED_ORIGINS requirement

---

## Metrics

| Metric | Status | Notes |
|--------|--------|-------|
| Critical Issues | 1 | PostHog PII risk |
| Code Coverage | Partial | PostHog has 0% |
| Type Safety | Good | Minor assertions without validation |
| Security | Good | Rate limiting fail-open is main concern |
| Performance | Good | Some O(n) operations noted |
| Test Stability | At Risk | 329 flaky patterns detected |

---

## Conclusion

Wave 3 delivers solid API infrastructure with good security practices. The main concerns are:

1. **Privacy**: PostHog's `identifyUser()` could leak PII
2. **Availability**: Rate limiter fails open on Redis issues
3. **Test Stability**: High number of timing-dependent tests

Recommended to address P0 and P1 items before production release.
