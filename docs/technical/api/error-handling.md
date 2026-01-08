# Error Handling

> **Navigation**: [API Index](./index.md) | [Technical Index](../index.md) | [MCP Tools](./mcp-tools.md)

---

## Error Response Format

```typescript
interface ErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, any>;
    recovery_suggestions?: string[];
  };
}
```

---

## Error Codes

```typescript
enum ErrorCode {
  // Client errors (4xx equivalent)
  INVALID_PARAMETER = 'INVALID_PARAMETER',
  SKILL_NOT_FOUND = 'SKILL_NOT_FOUND',
  CONFLICT_DETECTED = 'CONFLICT_DETECTED',
  SECURITY_RISK_DETECTED = 'SECURITY_RISK_DETECTED',
  BLOCKED_SKILL = 'BLOCKED_SKILL',
  ALREADY_INSTALLED = 'ALREADY_INSTALLED',

  // Server errors (5xx equivalent)
  INDEX_UNAVAILABLE = 'INDEX_UNAVAILABLE',
  GITHUB_RATE_LIMITED = 'GITHUB_RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SYNC_IN_PROGRESS = 'SYNC_IN_PROGRESS',

  // Recoverable errors
  CACHE_MISS = 'CACHE_MISS',
  PARTIAL_RESULTS = 'PARTIAL_RESULTS',
  STALE_DATA = 'STALE_DATA',
}
```

---

## Error Categories

### Client Errors

Errors caused by invalid requests:

| Code | Description | Recovery |
|------|-------------|----------|
| `INVALID_PARAMETER` | Invalid parameter value | Fix parameter and retry |
| `SKILL_NOT_FOUND` | Skill ID doesn't exist | Check skill ID |
| `CONFLICT_DETECTED` | Skill conflicts with installed | Resolve conflicts first |
| `SECURITY_RISK_DETECTED` | Security scan failed | Review skill carefully |
| `BLOCKED_SKILL` | Skill is on blocklist | Choose different skill |
| `ALREADY_INSTALLED` | Skill already installed | Use existing installation |

### Server Errors

Errors from system issues:

| Code | Description | Recovery |
|------|-------------|----------|
| `INDEX_UNAVAILABLE` | SQLite database unavailable | Retry after delay |
| `GITHUB_RATE_LIMITED` | GitHub API rate limit hit | Wait for reset |
| `INTERNAL_ERROR` | Unexpected error | Report issue |
| `SYNC_IN_PROGRESS` | Sync already running | Wait for completion |

### Recoverable Errors

Non-fatal issues:

| Code | Description | Recovery |
|------|-------------|----------|
| `CACHE_MISS` | Data not in cache | Request will fetch fresh data |
| `PARTIAL_RESULTS` | Some data unavailable | Results may be incomplete |
| `STALE_DATA` | Using cached data | Refresh available |

---

## Error Examples

### Invalid Parameter

```json
{
  "success": false,
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "Invalid value for 'limit': must be between 1 and 50",
    "details": {
      "parameter": "limit",
      "value": 100,
      "min": 1,
      "max": 50
    },
    "recovery_suggestions": [
      "Set limit to a value between 1 and 50"
    ]
  }
}
```

### Skill Not Found

```json
{
  "success": false,
  "error": {
    "code": "SKILL_NOT_FOUND",
    "message": "Skill 'nonexistent/skill' not found in index",
    "details": {
      "skill_id": "nonexistent/skill",
      "searched_sources": ["github", "claude-plugins"]
    },
    "recovery_suggestions": [
      "Check the skill ID spelling",
      "Search for the skill by name",
      "The skill may have been removed"
    ]
  }
}
```

### Conflict Detected

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT_DETECTED",
    "message": "Installing 'fast-shipping' conflicts with installed 'test-first'",
    "details": {
      "new_skill": "fast-shipping",
      "conflicting_skill": "test-first",
      "conflict_type": "behavioral",
      "severity": "high"
    },
    "recovery_suggestions": [
      "Uninstall 'test-first' first",
      "Use --skip_conflict_check to force install",
      "Set priority order in config"
    ]
  }
}
```

### Rate Limited

```json
{
  "success": false,
  "error": {
    "code": "GITHUB_RATE_LIMITED",
    "message": "GitHub API rate limit exceeded",
    "details": {
      "limit": 5000,
      "remaining": 0,
      "reset_at": "2025-12-26T11:00:00Z"
    },
    "recovery_suggestions": [
      "Wait until 11:00 UTC for rate limit reset",
      "Cached data available - use offline mode",
      "Configure additional GitHub tokens"
    ]
  }
}
```

---

## Retry Configuration

```typescript
const RETRY_CONFIG = {
  github_api: {
    max_retries: 3,
    backoff_ms: [1000, 2000, 4000],
    retriable_errors: ['RATE_LIMITED', 'TIMEOUT', 'SERVER_ERROR'],
  },

  scraping: {
    max_retries: 2,
    backoff_ms: [5000, 10000],
    retriable_errors: ['TIMEOUT', 'SERVER_ERROR'],
  },

  database: {
    max_retries: 3,
    backoff_ms: [100, 200, 500],
    retriable_errors: ['BUSY', 'LOCKED'],
  },
};
```

### Retry Implementation

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < config.max_retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!config.retriable_errors.includes(error.code)) {
        throw error; // Non-retriable, fail immediately
      }

      if (attempt < config.max_retries - 1) {
        const backoff = config.backoff_ms[attempt] || config.backoff_ms[config.backoff_ms.length - 1];
        await sleep(backoff);
      }
    }
  }

  throw lastError;
}
```

---

## Graceful Degradation

```typescript
async function searchSkills(query: string): Promise<SearchResult> {
  try {
    // Try primary search with fresh data
    return await primarySearch(query);
  } catch (error) {
    if (error.code === 'GITHUB_RATE_LIMITED') {
      // Fall back to cached data
      console.warn('Using cached results due to rate limit');
      return await cachedSearch(query);
    }

    if (error.code === 'INDEX_UNAVAILABLE') {
      // Fall back to basic search
      console.warn('Using basic search - index unavailable');
      return await basicSearch(query);
    }

    throw error;
  }
}
```

### Degradation Strategies

| Scenario | Primary | Fallback 1 | Fallback 2 |
|----------|---------|------------|------------|
| GitHub rate limit | Fresh data | Cached data | Basic index |
| Database locked | Immediate query | Retry with backoff | Read-only mode |
| Network failure | API request | Local cache | Offline mode |
| Partial failure | Full results | Partial + warning | Error |

---

## Error Logging

```typescript
function logError(error: Error, context: ErrorContext): void {
  logger.error({
    code: error.code,
    message: error.message,
    component: context.component,
    operation: context.operation,
    request_id: context.request_id,
    stack: error.stack,
    details: error.details,
  });

  // Track metrics
  metrics.increment('errors_total', {
    code: error.code,
    component: context.component,
  });
}
```

---

## Client Error Handling

Recommended client-side handling:

```typescript
async function safeSearch(query: string): Promise<SearchResult | null> {
  try {
    const result = await mcp.search({ query });
    return result.data;
  } catch (error) {
    switch (error.code) {
      case 'INVALID_PARAMETER':
        console.error('Search query invalid:', error.message);
        return null;

      case 'GITHUB_RATE_LIMITED':
        console.warn('Rate limited, using cache');
        return await getCachedResults(query);

      case 'INDEX_UNAVAILABLE':
        console.warn('Index unavailable, try again later');
        return null;

      default:
        console.error('Unexpected error:', error);
        throw error;
    }
  }
}
```

---

## Related Documentation

- [MCP Tools](./mcp-tools.md) - Tool definitions
- [Observability](../observability.md) - Error tracking
- [Performance](../performance.md) - Timeout configuration

---

*Back to: [API Index](./index.md)*
