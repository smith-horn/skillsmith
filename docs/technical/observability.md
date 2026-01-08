# Observability

> **Navigation**: [Technical Index](./index.md) | [Overview](./overview.md)

---

## Logging Strategy

### Configuration

```typescript
interface LogConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'text';
  output: 'stdout' | 'file';
  file_path?: string;
  max_size_mb?: number;
  max_files?: number;
}
```

### Structured Logging

```typescript
interface LogEntry {
  timestamp: string;
  level: string;
  component: string;       // 'discovery-core', 'learning', 'sync'
  operation: string;       // 'search', 'install', 'scan'
  duration_ms?: number;
  metadata?: Record<string, any>;
  error?: {
    code: string;
    message: string;
    stack?: string;
  };
}
```

### Example Log Entries

```typescript
logger.info({
  component: 'discovery-core',
  operation: 'search',
  duration_ms: 145,
  metadata: {
    query: 'react testing',
    results_count: 10,
    cache_hit: true,
  },
});

logger.warn({
  component: 'sync',
  operation: 'github_fetch',
  metadata: {
    rate_limit_remaining: 100,
    rate_limit_reset: '2025-12-26T11:00:00Z',
  },
});

logger.error({
  component: 'discovery-core',
  operation: 'install',
  error: {
    code: 'CONFLICT_DETECTED',
    message: 'Skill conflicts with installed skills',
    stack: '...',
  },
  metadata: {
    skill_id: 'community/fast-shipping',
    conflicting_with: ['anthropic/test-first'],
  },
});
```

---

## Metrics Collection

### Metric Types

```typescript
interface Metrics {
  // Counters
  search_requests_total: Counter;
  install_requests_total: Counter;
  errors_total: Counter;

  // Histograms
  search_latency_ms: Histogram;
  scan_latency_ms: Histogram;

  // Gauges
  index_skills_count: Gauge;
  cache_size_bytes: Gauge;
  memory_usage_bytes: Gauge;
}
```

### Prometheus Export

```
# HELP search_requests_total Total search requests
# TYPE search_requests_total counter
search_requests_total{status="success"} 1234
search_requests_total{status="error"} 12

# HELP search_latency_ms Search latency in milliseconds
# TYPE search_latency_ms histogram
search_latency_ms_bucket{le="100"} 800
search_latency_ms_bucket{le="200"} 1100
search_latency_ms_bucket{le="500"} 1200
search_latency_ms_bucket{le="+Inf"} 1234
search_latency_ms_sum 156789
search_latency_ms_count 1234

# HELP index_skills_count Number of skills in index
# TYPE index_skills_count gauge
index_skills_count 45678
```

---

## Error Tracking

### Error Aggregation

```typescript
interface ErrorTracker {
  // Capture and aggregate errors
  captureError(error: Error, context: ErrorContext): void;

  // Get error summary
  getErrorSummary(timeRange: TimeRange): ErrorSummary;
}

interface ErrorContext {
  component: string;
  operation: string;
  user_id?: string;        // Anonymized
  skill_id?: string;
  request_id?: string;
}

interface ErrorSummary {
  total_errors: number;
  by_type: Record<string, number>;
  by_component: Record<string, number>;
  top_errors: AggregatedError[];
}
```

### Error Categories

| Category | Description | Action |
|----------|-------------|--------|
| User errors | Invalid input | Log, return helpful message |
| System errors | Internal failures | Log, alert, retry if possible |
| External errors | API failures | Log, cache fallback |
| Security errors | Suspicious activity | Log, alert, block if needed |

---

## Debugging Support

### Debug Mode Configuration

```typescript
const DEBUG_CONFIG = {
  enabled: process.env.CLAUDE_DISCOVERY_DEBUG === 'true',

  log_sql_queries: true,
  log_api_requests: true,
  log_cache_operations: true,

  // Performance profiling
  profile_enabled: true,
  profile_threshold_ms: 100,  // Log operations >100ms
};
```

### Debug Output Example

```
[DEBUG] SQL: SELECT * FROM skills WHERE name LIKE ? (took 12ms)
[DEBUG] GitHub API: GET /repos/anthropic/skills (took 234ms, cached: false)
[DEBUG] Cache: SET skill:anthropic/skills/test-fixing (expires: 1h)
[PROFILE] search() completed in 267ms
  - db_query: 12ms
  - github_fetch: 234ms
  - scoring: 15ms
  - serialization: 6ms
```

### Request Tracing

```typescript
interface RequestTrace {
  request_id: string;
  start_time: number;
  operations: OperationSpan[];
}

interface OperationSpan {
  name: string;
  start_ms: number;
  duration_ms: number;
  metadata?: Record<string, any>;
  children?: OperationSpan[];
}

// Example trace
{
  "request_id": "req_abc123",
  "start_time": 1703577600000,
  "operations": [
    {
      "name": "search",
      "start_ms": 0,
      "duration_ms": 267,
      "children": [
        { "name": "db_query", "start_ms": 0, "duration_ms": 12 },
        { "name": "github_fetch", "start_ms": 12, "duration_ms": 234 },
        { "name": "scoring", "start_ms": 246, "duration_ms": 15 },
        { "name": "serialization", "start_ms": 261, "duration_ms": 6 }
      ]
    }
  ]
}
```

---

## Health Checks

```typescript
interface HealthCheck {
  name: string;
  check(): Promise<HealthStatus>;
}

interface HealthStatus {
  healthy: boolean;
  message?: string;
  details?: Record<string, any>;
}

const healthChecks: HealthCheck[] = [
  {
    name: 'database',
    async check() {
      try {
        await db.query('SELECT 1');
        return { healthy: true };
      } catch (error) {
        return { healthy: false, message: error.message };
      }
    },
  },
  {
    name: 'github_api',
    async check() {
      const rateLimit = await github.getRateLimit();
      return {
        healthy: rateLimit.remaining > 100,
        details: { remaining: rateLimit.remaining },
      };
    },
  },
  {
    name: 'embeddings',
    async check() {
      const loaded = embeddingIndex.isLoaded();
      return {
        healthy: loaded,
        details: { loaded, size: embeddingIndex.size() },
      };
    },
  },
];

// GET /health
async function healthEndpoint(): Promise<HealthResponse> {
  const results = await Promise.all(
    healthChecks.map(async (check) => ({
      name: check.name,
      status: await check.check(),
    }))
  );

  const healthy = results.every((r) => r.status.healthy);

  return {
    status: healthy ? 'healthy' : 'unhealthy',
    checks: results,
    timestamp: new Date().toISOString(),
  };
}
```

---

## Alerting

### Alert Rules

| Condition | Severity | Action |
|-----------|----------|--------|
| Error rate > 5% | Warning | Notify on-call |
| Error rate > 20% | Critical | Page on-call |
| P95 latency > 800ms | Warning | Notify on-call |
| Memory > 600MB | Critical | Page on-call |
| GitHub rate limit < 100 | Warning | Notify on-call |

---

## Related Documentation

- [Performance](./performance.md) - Performance targets
- [API Error Handling](./api/error-handling.md) - Error codes
- [Testing](./testing.md) - Test monitoring

---

*Back to: [Technical Index](./index.md)*
