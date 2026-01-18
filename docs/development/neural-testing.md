# Neural Integration Tests

> **Issue**: SMI-1535, SMI-1536

The Recommendation Learning Loop has comprehensive integration tests in `packages/core/tests/integration/neural/`.

## Running Neural Tests

```bash
# Run all neural tests
docker exec skillsmith-dev-1 npm test -- packages/core/tests/integration/neural/

# Run specific test suite
docker exec skillsmith-dev-1 npm test -- packages/core/tests/integration/neural/signal-collection.test.ts
docker exec skillsmith-dev-1 npm test -- packages/core/tests/integration/neural/e2e-learning.test.ts
```

## Test Suites

| File | Tests | Coverage |
|------|-------|----------|
| `signal-collection.test.ts` | 11 | Signal recording/querying |
| `preference-learner.test.ts` | 14 | Profile updates, weight decay |
| `personalization.test.ts` | 13 | Recommendation re-ranking |
| `privacy.test.ts` | 13 | GDPR compliance, data wipe |
| `e2e-learning.test.ts` | 7 | Full learning loop validation |

## Test Infrastructure

- **`setup.ts`**: Mock implementations of all learning interfaces
- **`helpers.ts`**: Signal generation utilities (`generateSignal`, `generateUserJourney`, etc.)

## Related Documentation

- [Phase 5: Neural Testing](../execution/phase5-neural-testing.md)
- [ADR-009: Embedding Service Fallback Strategy](../adr/009-embedding-service-fallback.md)
