# V3 Migration Benchmarks

> **Issue**: SMI-1537

Performance benchmarks for the V3 API migration.

## Running Benchmarks

```bash
# Run benchmarks
docker exec skillsmith-dev-1 npm run benchmark:v3

# With JSON output
docker exec skillsmith-dev-1 npx tsx scripts/benchmark-v3-migration.ts --json
```

## Performance Targets

| Operation | V2 Baseline | Target | Speedup |
|-----------|-------------|--------|---------|
| Memory Operations | 200ms | 5ms | 40x |
| Embedding Search (10K) | 500ms | 3ms | 150x |
| Recommendation Pipeline | 800ms | 200ms | 4x |

## CI Integration

Benchmarks run automatically on PRs via GitHub Actions. Results are compared against baseline to detect performance regressions.

## Related Documentation

- [ADR-009: Embedding Service Fallback Strategy](../adr/009-embedding-service-fallback.md)
