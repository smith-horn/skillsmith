# Phase 5: Neural Testing & Documentation

## Overview

Phase 5 implements comprehensive integration tests for the V3 Migration neural features (Recommendation Learning Loop) and adds performance benchmarks for the migration.

**Linear Issues:** SMI-1535, SMI-1536, SMI-1537
**Status:** Complete
**Date:** January 2026

## Test Infrastructure

### Files Created

```
packages/core/tests/integration/neural/
├── setup.ts              # Test context factory and mock implementations
├── helpers.ts            # Signal generation utilities
├── signal-collection.test.ts   # 12 tests
├── preference-learner.test.ts  # 15 tests
├── personalization.test.ts     # 13 tests
├── privacy.test.ts             # 14 tests
└── e2e-learning.test.ts        # 7 tests
```

**Total Tests:** 61

### Mock Implementations

The test infrastructure provides mock implementations of all learning interfaces:

| Interface | Mock Class | Purpose |
|-----------|------------|---------|
| `ISignalCollector` | `MockSignalCollector` | In-memory signal storage with filtering |
| `IPreferenceLearner` | `MockPreferenceLearner` | Profile updates, weight decay, scoring |
| `IPersonalizationEngine` | `MockPersonalizationEngine` | Recommendation re-ranking |
| `IPrivacyManager` | `MockPrivacyManager` | Data purge, export, wipe |
| `IUserPreferenceRepository` | `MockUserPreferenceRepository` | Profile persistence |

### Test Helpers

Key helper functions in `helpers.ts`:

```typescript
// Generate single signal
generateSignal({ type, skillId, category, trustTier, timestamp })

// Generate batch
generateSignalBatch(count, options)

// Generate user journey
generateUserJourney(skillId, 'successful' | 'abandoned' | 'uninstalled', category)

// Generate skill set for recommendations
generateSkillSet(count)

// Time helpers
daysAgo(days), hoursAgo(hours), minutesAgo(minutes)
```

## Test Coverage

### Signal Collection (SMI-1535)

1. Record ACCEPT signal with skill metadata
2. Record DISMISS signal with reason
3. Record USAGE_DAILY signal
4. Record USAGE_WEEKLY signal
5. Record ABANDONED signal after 30 days
6. Record UNINSTALL signal
7. Query signals by type filter
8. Query signals by date range

### Preference Learner (SMI-1535)

1. Update profile from single ACCEPT signal
2. Update profile from single DISMISS signal
3. Batch update with 100 signals
4. Weight decay after 30 days
5. Weight bounds enforcement (-2.0 to 2.0)
6. Category weight accumulation
7. Trust tier preference learning
8. Author preference learning
9. Cold start default weights
10. Profile persistence across sessions

### Personalization Engine (SMI-1536)

1. shouldPersonalize() returns false with <5 signals
2. shouldPersonalize() returns true with 5+ signals
3. personalizeRecommendations() re-ranks by learned scores
4. Category weight boosts preferred categories
5. Dismiss patterns reduce scores for related skills
6. Uninstall patterns have strongest negative effect
7. Score breakdown shows contributing factors
8. Personalization disabled by user preference

### Privacy Manager (SMI-1536)

1. purgeOldSignals() removes signals older than 90 days
2. exportUserData() returns all user signals and profile
3. wipeAllData() removes profile and all signals
4. Signal anonymization strips PII
5. Retention policy configurable per-tenant
6. Privacy audit log records all operations

### E2E Learning Loop (SMI-1536)

1. Learning improves recommendations over 10 interactions
2. Dismiss patterns reduce category scores measurably
3. Combined signals (accept + usage) boost scores higher
4. Learning persists across session restart

## Running Tests

```bash
# Run all neural tests
docker exec skillsmith-dev-1 npm test -- packages/core/tests/integration/neural/

# Run specific test file
docker exec skillsmith-dev-1 npm test -- packages/core/tests/integration/neural/signal-collection.test.ts

# Run with coverage
docker exec skillsmith-dev-1 npm run coverage -- packages/core/tests/integration/neural/
```

## Performance Benchmarks (SMI-1537)

### Benchmark Script

Location: `scripts/benchmark-v3-migration.ts`

**Targets:**

| Operation | V2 Baseline | Target Speedup |
|-----------|-------------|----------------|
| Memory Store | 200ms | 40x |
| Memory Get | 150ms | 40x |
| Memory Delete | 180ms | 40x |
| Embedding Search (10K) | 500ms | 150x |
| Recommendation Pipeline | 800ms | 4x |

### Running Benchmarks

```bash
# Run benchmarks locally
docker exec skillsmith-dev-1 npx tsx scripts/benchmark-v3-migration.ts

# With JSON output
docker exec skillsmith-dev-1 npx tsx scripts/benchmark-v3-migration.ts --json

# Custom iterations
docker exec skillsmith-dev-1 npx tsx scripts/benchmark-v3-migration.ts --iterations 100
```

### CI Integration

Benchmarks run automatically on pull requests via GitHub Actions:

```yaml
# .github/workflows/ci.yml
benchmark:
  name: Performance Benchmarks
  if: github.event_name == 'pull_request'
  # ... runs V3 migration benchmarks
```

Results are posted as comments on PRs.

## Wave Execution Summary

| Wave | Agents | Tests Created | Status |
|------|--------|---------------|--------|
| 1 | tester, coder | 12 (signal collection) | ✅ Complete |
| 2 | tester, coder | 28 (preference + personalization) | ✅ Complete |
| 3 | security-manager, tester | 21 (privacy + e2e) | ✅ Complete |
| 4 | performance-benchmarker, coder | Benchmark script + CI | ✅ Complete |
| 5 | researcher | Documentation | ✅ Complete |

## Related Documentation

- [ADR-020: Phase 4 Security Hardening](../adr/020-phase4-security-hardening.md)
- [Learning Interfaces](../../packages/core/src/learning/interfaces.ts)
- [Learning Types](../../packages/core/src/learning/types.ts)
- [Hive Mind Waves Phase 5-7](hive-mind-waves-phase5-6-7.md)
