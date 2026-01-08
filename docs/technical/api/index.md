# API Design Index

> **Navigation**: [Technical Index](../index.md) | [Overview](../overview.md) | [MCP Servers](../components/mcp-servers.md)

---

> **For Claude Agents**: This section covers MCP tool definitions and error handling.
> Use this index to find API specification documentation.

## API Navigation

| Topic | Document | Purpose |
|-------|----------|---------|
| MCP Tools | [mcp-tools.md](./mcp-tools.md) | Complete tool definitions |
| Error Handling | [error-handling.md](./error-handling.md) | Error codes, retry, degradation |

## API Summary

### discovery-core Tools

| Tool | Description |
|------|-------------|
| `search` | Search the skill index |
| `get_skill` | Get detailed skill information |
| `analyze_codebase` | Analyze codebase for stack detection |
| `recommend_skills` | Get skill recommendations |
| `install_skill` | Install a skill |
| `check_conflicts` | Check for skill conflicts |
| `audit_activation` | Audit skill activation issues |

### learning Tools

| Tool | Description |
|------|-------------|
| `get_path` | Get learning path details |
| `list_paths` | List available learning paths |
| `next_exercise` | Get next exercise |
| `submit_solution` | Submit exercise solution |
| `get_progress` | Get user progress |

### sync Tools

| Tool | Description |
|------|-------------|
| `refresh_index` | Trigger index refresh |
| `get_sync_status` | Get synchronization status |
| `export_recommendations` | Export recommendations |

## Response Format

All tools return responses in a consistent format:

```typescript
interface SuccessResponse<T> {
  success: true;
  data: T;
  metadata?: {
    cached: boolean;
    cache_age_seconds?: number;
    execution_time_ms: number;
  };
}

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

## Related Documentation

- [MCP Servers](../components/mcp-servers.md) - Server architecture
- [Performance](../performance.md) - API performance requirements
- [Observability](../observability.md) - API monitoring

---

*Next: [MCP Tools](./mcp-tools.md)*
