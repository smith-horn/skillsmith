# Component Design Index

> **Navigation**: [Technical Index](../index.md) | [Overview](../overview.md) | [Security](../security/index.md)

---

> **For Claude Agents**: This section covers the implementation details of each system component.
> Use this index to find specific component documentation.

## Component Navigation

| Component | Document | Purpose |
|-----------|----------|---------|
| MCP Servers | [mcp-servers.md](./mcp-servers.md) | Server architecture, consolidation, tools provided |
| Skill Index | [skill-index.md](./skill-index.md) | Data model, storage strategy, caching |
| Codebase Scanner | [codebase-scanner.md](./codebase-scanner.md) | Stack detection, performance constraints |
| Recommendation Engine | [recommendation-engine.md](./recommendation-engine.md) | Matching algorithm, exploration/exploitation |
| Activation Auditor | [activation-auditor.md](./activation-auditor.md) | Activation diagnostics, fixes |

## Server Architecture Summary

Based on VP Engineering feedback, we consolidate from 6 servers to 3 servers:

```
+----------------+     +----------------+     +----------------+
| discovery-core |     | learning       |     | sync           |
+----------------+     +----------------+     +----------------+
        |                     |                     |
        v                     v                     v
+================================================================+
|               ~/.claude-discovery/ (shared storage)            |
+================================================================+
```

| Server | Responsibility | Startup | Memory |
|--------|----------------|---------|--------|
| discovery-core | Search, analysis, installation, auditing | <1.5s | <150MB |
| learning | Educational content, exercises, progress | <0.5s | <50MB |
| sync | Background synchronization, index updates | <0.5s | <100MB |

## Consolidation Rationale

| Original Servers | Consolidated Into | Rationale |
|-----------------|-------------------|-----------|
| `skill-index` | `discovery-core` | Core discovery functionality |
| `codebase-scan` | `discovery-core` | Tightly coupled with recommendations |
| `skill-install` | `discovery-core` | Part of install workflow |
| `recommendations` | `discovery-core` | Depends on scan + index |
| `learning` | `learning` | Distinct bounded context |
| `swarm` | Deferred to Phase 5 | Complex, not MVP-critical |
| `index-sync` | `sync` | Background sync operations |

## Related Documentation

- [API Design](../api/index.md) - MCP tool definitions
- [Data Architecture](../data/index.md) - Storage layer details
- [Performance Requirements](../performance.md) - Performance budgets

---

*Next: [MCP Servers](./mcp-servers.md)*
