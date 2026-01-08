# Performance Requirements

> **Navigation**: [Technical Index](./index.md) | [Overview](./overview.md)

Based on VP Engineering review feedback.

---

## Performance Targets

| Metric | Target | Constraint | Measurement |
|--------|--------|------------|-------------|
| MCP total startup time | <3s | 6 servers was too slow | Time from claude start to MCP ready |
| Memory footprint (all servers) | <300MB | Must work on 8GB machines | RSS at idle |
| Memory footprint (active) | <500MB | During heavy operations | RSS under load |
| Search latency (cached) | <200ms | User-facing | P95 latency |
| Search latency (uncached) | <500ms | Acceptable degradation | P95 latency |
| Codebase scan (typical) | <15s | 1000 files, 100MB | Time to complete |
| Codebase scan (large) | <30s | 10000 files, 1GB | Time to complete |
| Index sync (incremental) | <1min | Normal operation | Time to complete |
| Index sync (full) | <10min | Initial or recovery | Time to complete |
| Embedding search | <100ms | For similarity queries | P95 latency |

---

## Performance Budget Allocation

| Server | Startup | Memory (Idle) | Memory (Active) |
|--------|---------|---------------|-----------------|
| discovery-core | 1.5s | 150MB | 250MB |
| learning | 0.5s | 50MB | 100MB |
| sync | 0.5s | 100MB | 150MB |
| **Total** | **2.5s** | **300MB** | **500MB** |

---

## Optimization Strategies

### Lazy Loading for Embeddings

```typescript
class EmbeddingIndex {
  private embeddings: Float32Array | null = null;

  async search(query: string): Promise<SimilarSkill[]> {
    if (!this.embeddings) {
      // Load on first use, not at startup
      this.embeddings = await this.loadEmbeddings();
    }
    return this.findSimilar(query, this.embeddings);
  }
}
```

### Connection Pooling

```typescript
const githubPool = new ConnectionPool({
  maxConnections: 10,
  idleTimeout: 60000,
  retryOnRateLimit: true,
});
```

### SQLite Optimization

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;  -- 64MB cache
PRAGMA mmap_size = 268435456; -- 256MB mmap
```

---

## Scalability Considerations

### 50K+ Skills Indexing

| Challenge | Solution |
|-----------|----------|
| Index size | SQLite scales to millions of rows; 50K is comfortable |
| Search performance | FTS5 index provides sub-100ms full-text search |
| Embedding storage | ~200MB for 50K skills (384-dim vectors) fits in memory |
| Update latency | Incremental updates via GitHub Events API |

### GitHub API Rate Limits

```typescript
interface RateLimitStrategy {
  // Token rotation for higher limits
  tokens: string[];
  current_token_index: number;

  // Request batching
  batch_size: 100;
  batch_delay_ms: 100;

  // Conditional requests (ETag/If-Modified-Since)
  use_conditional: true;

  // GitHub App for 15K/hr limit
  app_id?: string;
  private_key?: string;
}
```

#### Rate Limit Calculation

```
50K skills, 1 request each = 50K requests
At 5K/hr = 10 hours for full refresh
With batching (100/request) = 500 requests = 6 minutes
With Events API (incremental) = ~100 requests/day = negligible
```

### Local Storage Growth

| Component | Growth Rate | Management |
|-----------|-------------|------------|
| SQLite index | ~1KB/skill | Vacuum on update |
| Embeddings | ~4KB/skill | Replace on refresh |
| Cache | ~10KB/skill | TTL-based eviction |
| User data | ~100B/interaction | Rolling window (90 days) |
| Recommendations | ~5KB/recommendation | Archive old (>1 year) |

---

## Embedding Storage Configuration

```typescript
interface EmbeddingConfig {
  // Model selection
  model: 'all-MiniLM-L6-v2';  // 384 dimensions, good quality/size balance
  dimensions: 384;

  // Storage format
  format: 'binary';           // Raw float32 array
  compression: 'none';        // Fast load, acceptable size

  // Memory management
  mmap: true;                 // Memory-mapped for efficient access
  preload: false;             // Load on demand

  // Update strategy
  rebuild_threshold: 1000;    // Rebuild if >1000 skills added
  incremental_updates: true;  // Add new embeddings without full rebuild
}
```

---

## Performance Monitoring

### Key Metrics

```typescript
interface PerformanceMetrics {
  // Latency histograms
  search_latency_ms: Histogram;
  scan_latency_ms: Histogram;
  install_latency_ms: Histogram;

  // Memory gauges
  heap_used_bytes: Gauge;
  rss_bytes: Gauge;
  external_bytes: Gauge;

  // Throughput counters
  requests_per_second: Counter;
  cache_hit_rate: Gauge;
}
```

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Search P95 latency | >400ms | >800ms |
| Memory RSS | >400MB | >600MB |
| Startup time | >4s | >6s |
| Cache hit rate | <50% | <30% |

---

## Related Documentation

- [Observability](./observability.md) - Performance monitoring
- [Data Caching](./data/caching.md) - Cache configuration
- [MCP Servers](./components/mcp-servers.md) - Server budgets

---

*Back to: [Technical Index](./index.md)*
