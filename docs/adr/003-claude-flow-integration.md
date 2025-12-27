# ADR-003: Claude-flow Integration for Technical Risk Mitigation

**Status**: Accepted
**Date**: 2025-12-27
**Deciders**: Development Team

## Context

Skillsmith faces several technical risks in Phase 2 that require scalable solutions:

1. **Search latency** - User queries must return results quickly (<100ms p50)
2. **GitHub API rate limiting** - Indexing 50,000+ skills risks hitting rate limits
3. **Cache invalidation** - Stale search results degrade user experience
4. **Multi-source indexing** - Skills come from GitHub, SkillsMP, and other sources
5. **Security scan bottlenecks** - Sequential scanning slows installation

These risks compound as the skill database grows. Traditional single-threaded approaches won't scale.

## Decision

Integrate claude-flow MCP server capabilities to address technical risks through:

### 1. Memory Persistence for Cross-Session Context

Use `memory_usage` to maintain state across Claude sessions:

```javascript
// Store project context
mcp__claude-flow__memory_usage({
  action: "store",
  namespace: "skillsmith",
  key: "search/cache",
  value: { query: "react testing", results: [...], timestamp: "..." },
  ttl: 3600 // 1 hour expiration
});
```

**Addresses**: Cache invalidation, session continuity

### 2. Neural Pattern Learning for Search Optimization

Use `neural_train` and `neural_patterns` to learn from user behavior:

```javascript
// Train on search patterns
mcp__claude-flow__neural_train({
  pattern_type: "prediction",
  training_data: JSON.stringify({
    queries: ["react", "testing", "commit"],
    clicks: ["jest-helper", "react-testing-library"],
    conversions: ["jest-helper"]
  })
});

// Predict relevance for ranking
mcp__claude-flow__neural_patterns({
  action: "predict",
  operation: "search-ranking",
  metadata: { query: "react test", candidates: [...] }
});
```

**Addresses**: Search latency (via better ranking), user experience

### 3. Swarm Coordination for Parallel Indexing

Use `swarm_init` and `task_orchestrate` for distributed work:

```javascript
// Initialize indexing swarm
mcp__claude-flow__swarm_init({
  topology: "mesh",
  maxAgents: 5,
  strategy: "balanced"
});

// Orchestrate parallel indexing
mcp__claude-flow__task_orchestrate({
  task: "Index GitHub skills",
  strategy: "parallel",
  priority: "medium"
});
```

**Addresses**: GitHub API rate limiting (distributed across agents), multi-source indexing

### 4. Load Balancing for Security Scans

Use `load_balance` to distribute security scanning:

```javascript
// Distribute scan workload
mcp__claude-flow__load_balance({
  tasks: [
    { type: "security_scan", skillId: "user/skill-1" },
    { type: "security_scan", skillId: "user/skill-2" },
    // ...
  ]
});
```

**Addresses**: Security scan bottlenecks

### 5. Performance Monitoring

Use `bottleneck_analyze` and `performance_report` for observability:

```javascript
// Identify bottlenecks
mcp__claude-flow__bottleneck_analyze({
  component: "search",
  metrics: ["latency", "throughput", "error_rate"]
});

// Generate performance report
mcp__claude-flow__performance_report({
  timeframe: "24h",
  format: "detailed"
});
```

**Addresses**: Ongoing performance optimization

## Consequences

### Positive

- **Scalability**: Parallel processing handles growth without architecture changes
- **Resilience**: Distributed work survives individual failures
- **Learning**: Neural patterns improve search quality over time
- **Observability**: Built-in performance monitoring
- **Session continuity**: Memory persistence maintains context across sessions

### Negative

- **Dependency**: Requires claude-flow MCP server to be running
- **Complexity**: More moving parts than single-threaded approach
- **Learning curve**: Team must understand swarm patterns

### Neutral

- Claude-flow is optional for basic functionality; core MCP tools work without it
- Performance benefits scale with usage volume

## Alternatives Considered

### Alternative 1: Redis for Caching

- Pros: Industry-standard, high performance
- Cons: Additional infrastructure, deployment complexity
- Why rejected: claude-flow memory provides sufficient capability without external dependencies

### Alternative 2: Background Job Queue (Bull/BullMQ)

- Pros: Mature, well-documented
- Cons: Requires Redis, additional setup
- Why rejected: claude-flow task orchestration provides similar capability with AI-native integration

### Alternative 3: No Parallelization

- Pros: Simpler architecture
- Cons: Won't scale, rate limiting issues
- Why rejected: 50,000+ skills cannot be indexed sequentially

## Implementation Plan

### Phase 2a: Foundation

1. Configure memory namespace for skillsmith
2. Implement search result caching with TTL
3. Add performance monitoring hooks

### Phase 2b: Optimization

1. Train neural patterns on search behavior
2. Implement ranking predictions
3. A/B test ranking improvements

### Phase 2c: Scale

1. Implement swarm-based indexing
2. Add load balancing for security scans
3. Multi-source coordination

## References

- [claude-flow Documentation](https://github.com/ruvnet/claude-flow)
- [ADR-001: Monorepo Structure](./001-monorepo-structure.md)
- [Phase 1 Retrospective](../retros/phase-1-ci-testing.md)
- [Memory Persistence Configuration](../../scripts/README.md)
