# CI Coverage Fix Plan

**Created**: January 19, 2026
**Status**: Ready for execution
**Priority**: High (CI blocking)

---

## Problem Summary

CI is failing due to branch coverage dropping below the 67% threshold after PR #17 (Phase 6 Website Completion) was merged.

```
ERROR: Coverage for branches (66.8%) does not meet global threshold (67%)
```

### Current State

| Metric | Current | Threshold | Gap |
|--------|---------|-----------|-----|
| Branch Coverage | 66.8% | 67% | -0.2% |

### CI Run Reference

- **Failed Run**: `21124729124`
- **Commit**: `97b083a` (fix(types): resolve TypeScript strict mode errors in CI)
- **Workflow**: CI → Test job

---

## Root Cause Analysis

### PR #17 Changes

PR #17 added significant new code in Phase 6 Website Completion:
- New website pages and components
- API client enhancements
- Fresh install CI tests

The new code has lower branch coverage than the existing codebase average, pulling the overall coverage below threshold.

### Low Coverage Files (from CI output)

| File | Branch Coverage | Lines |
|------|----------------|-------|
| `mcp-server/src/context.ts` | 46.26% | 75-396, 414-432 |
| `enterprise/src/license/quotas.ts` | 0% | 139-242 |
| `mcp-server/src/middleware/license.ts` | 54.09% | 96-298, 319-354 |
| `mcp-server/src/tools/get-skill.ts` | 42.85% | 64-269, 304-319 |
| `mcp-server/src/tools/search.ts` | 54.54% | 165-214, 263 |

---

## Solution Options

### Option 1: Add Missing Tests (Recommended)

Add tests to cover the uncovered branches in low-coverage files.

**Estimated effort**: Medium
**Files to target** (highest impact):
1. `packages/enterprise/src/license/quotas.ts` - 0% branch coverage
2. `packages/mcp-server/src/context.ts` - 46% branch coverage
3. `packages/mcp-server/src/middleware/license.ts` - 54% branch coverage

### Option 2: Lower Threshold Temporarily

Reduce the coverage threshold from 67% to 66% temporarily.

```typescript
// vitest.config.ts
coverage: {
  thresholds: {
    branches: 66, // was 67
  }
}
```

**Pros**: Quick fix
**Cons**: Technical debt, coverage may drift further

### Option 3: Exclude New Files from Coverage

Exclude specific new files that are pulling down coverage.

```typescript
// vitest.config.ts
coverage: {
  exclude: [
    'packages/website/**', // New website code
  ]
}
```

**Pros**: Doesn't affect existing coverage requirements
**Cons**: Hides untested code

---

## Recommended Approach

**Phase 1**: Add tests to reach 67% threshold (quick win)
**Phase 2**: Improve coverage to 70%+ for robustness

### Priority Test Files

#### 1. `packages/enterprise/src/license/quotas.ts`

Current coverage: 0% branches, 16.66% lines

**Uncovered lines**: 139-242 (quota enforcement logic)

```bash
# Create test file
touch packages/enterprise/tests/license/quotas.test.ts
```

**Test scenarios needed**:
- Quota limits by tier (community, individual, team, enterprise)
- Quota enforcement when limit exceeded
- Quota reset logic
- Grace period handling

#### 2. `packages/mcp-server/src/context.ts`

Current coverage: 46.26% branches

**Uncovered lines**: 75-396, 414-432 (context detection logic)

**Test scenarios needed**:
- Project type detection
- Stack detection edge cases
- Context caching behavior
- Error handling paths

#### 3. `packages/mcp-server/src/middleware/license.ts`

Current coverage: 54.09% branches

**Uncovered lines**: 96-298, 319-354

**Test scenarios needed**:
- License validation edge cases
- Feature gating logic
- Cache invalidation
- Error recovery paths

---

## Implementation Steps

### Step 1: Verify Current Coverage

```bash
docker exec skillsmith-dev-1 npm test -- --coverage
```

### Step 2: Identify Specific Uncovered Branches

```bash
# Generate detailed coverage report
docker exec skillsmith-dev-1 npx vitest run --coverage --reporter=verbose
```

### Step 3: Add Tests for quotas.ts

```typescript
// packages/enterprise/tests/license/quotas.test.ts
import { describe, it, expect } from 'vitest'
import {
  TIER_QUOTAS,
  checkQuota,
  enforceQuota,
  getQuotaUsage,
} from '../../src/license/quotas.js'

describe('Quota System', () => {
  describe('TIER_QUOTAS', () => {
    it('should define quotas for all tiers', () => {
      expect(TIER_QUOTAS.community).toBeDefined()
      expect(TIER_QUOTAS.individual).toBeDefined()
      expect(TIER_QUOTAS.team).toBeDefined()
      expect(TIER_QUOTAS.enterprise).toBeDefined()
    })
  })

  describe('checkQuota', () => {
    // Add tests for quota checking logic
  })

  describe('enforceQuota', () => {
    // Add tests for enforcement logic
  })
})
```

### Step 4: Run Tests and Verify Coverage

```bash
docker exec skillsmith-dev-1 npm test
```

### Step 5: Commit and Push

```bash
git add -A
git commit -m "test(coverage): add quota and license middleware tests

Increases branch coverage from 66.8% to 67%+ to fix CI threshold failure.

- Add quotas.test.ts for enterprise quota enforcement
- Add context detection edge case tests
- Add license middleware validation tests"
git push origin main
```

### Step 6: Verify CI Passes

```bash
gh run list --limit 3
gh run view <run-id>
```

---

## Success Criteria

- [ ] Branch coverage ≥ 67%
- [ ] CI workflow passes
- [ ] No test regressions
- [ ] New tests are meaningful (not just coverage padding)

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `packages/enterprise/tests/license/quotas.test.ts` | Create | Test quota enforcement |
| `packages/mcp-server/tests/context.test.ts` | Modify | Add edge case tests |
| `packages/mcp-server/src/__tests__/middleware/license.test.ts` | Modify | Add branch coverage |

---

## Related Issues

- **PR #17**: Phase 6 Website Completion (introduced coverage drop)
- **SMI-1590**: Flaky tests (already fixed)
- **SMI-1587**: Skills search page (already fixed)

---

## Quick Start Commands

```bash
# Start fresh session
cd /Users/williamsmith/Documents/GitHub/Smith-Horn/skillsmith

# Check current coverage
docker exec skillsmith-dev-1 npm test -- --coverage 2>&1 | tail -50

# Run specific test file
docker exec skillsmith-dev-1 npx vitest run packages/enterprise/tests/license/quotas.test.ts

# Check CI status
gh run list --limit 5
```

---

## Context from Previous Session

### What Was Fixed

1. **SMI-1587**: Skills search page stuck on "Loading"
   - Deployed Supabase Edge Function
   - Fixed `import.meta.env` in inline script

2. **SMI-1590**: Flaky license validation tests
   - Extended timeouts from 5000ms to 15000ms

3. **Type Errors**: TypeScript strict mode CI failures
   - `ApiPartialResponses.test.ts`: Added type definitions
   - `merge.ts`: Fixed `exactOptionalPropertyTypes`

### Current Branch State

```
main branch: 97b083a
All type errors resolved
Tests pass locally (4,610 passed)
CI failing only on coverage threshold
```

---

## Notes

- The coverage gap is small (0.2%), so minimal test additions should fix it
- Focus on the 0% coverage file (`quotas.ts`) first for maximum impact
- Consider creating a Linear issue to track this work (SMI-1591 suggested)
