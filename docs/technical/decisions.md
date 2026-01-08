# Decision Log

> **Navigation**: [Technical Index](./index.md) | [Overview](./overview.md)

---

## Active Decisions

| ID | Decision | Date | Options Considered | Choice | Rationale |
|----|----------|------|-------------------|--------|-----------|
| D001 | MCP server consolidation | 2025-12-26 | 6 servers, 3 servers, 1 server | 3 servers | Balance of performance (startup <3s) and separation of concerns |
| D002 | Storage engine | 2025-12-26 | PostgreSQL, SQLite, Elasticsearch | SQLite | Embedded, zero-config, portable, offline-capable |
| D003 | Scoring model | 2025-12-26 | Stars-only, Multi-signal, Bayesian | Multi-signal (npms.io style) | Proven at scale, interpretable, extensible |
| D004 | Cold start strategy | 2025-12-26 | Ignore, Boost new, UCB1 | UCB1 + content baseline | Mathematically sound, balances exploration/exploitation |
| D005 | Conflict resolution default | 2025-12-26 | Fail, warn, auto-resolve | Warn + user choice | User control, transparency |
| D006 | Security tier system | 2025-12-26 | Binary (trusted/not), 4-tier | 4-tier (official/verified/community/unverified) | Granular trust, clear upgrade path |

---

## Decision Details

### D001: MCP Server Consolidation

**Date:** 2025-12-26
**Status:** Approved

**Context:**
Initial design proposed 6 separate MCP servers for modularity. VP Engineering feedback highlighted startup time concerns.

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| 6 servers | Maximum modularity | Slow startup (~8s), high memory |
| 3 servers | Good balance | Moderate complexity |
| 1 server | Fastest startup | Monolithic, harder to maintain |

**Decision:** 3 servers (discovery-core, learning, sync)

**Consequences:**
- Startup time <3s target achievable
- Memory footprint <300MB
- Still maintains logical separation
- Requires careful internal modularization

---

### D002: Storage Engine

**Date:** 2025-12-26
**Status:** Approved

**Context:**
Need persistent storage for 50K+ skills with full-text search.

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| PostgreSQL | Battle-tested, powerful | Requires server, heavy |
| SQLite | Embedded, portable, offline | Less scalable |
| Elasticsearch | Best search | Heavy, complex setup |

**Decision:** SQLite with FTS5

**Consequences:**
- Zero external dependencies
- Works offline
- ~50MB for 50K skills
- FTS5 provides adequate search performance

---

### D003: Scoring Model

**Date:** 2025-12-26
**Status:** Approved

**Context:**
Need quality scoring for ranking skills in search and recommendations.

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| Stars-only | Simple | Easily gamed, biased to old |
| Multi-signal | Balanced, proven | More complex |
| Bayesian | Statistically rigorous | Hard to explain |

**Decision:** Multi-signal model (npms.io style)

**Formula:**
```
Final = 0.30 * Quality + 0.35 * Popularity + 0.35 * Maintenance
```

**Consequences:**
- Interpretable to users
- Resistant to gaming
- Extensible for future signals

---

### D004: Cold Start Strategy

**Date:** 2025-12-26
**Status:** Approved

**Context:**
New skills have no interaction data for scoring.

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| Ignore | Simple | New skills invisible |
| Boost new | Promotes discovery | Quality unknown |
| UCB1 | Mathematically optimal | More complex |

**Decision:** UCB1 + content-based baseline

**Implementation:**
- Content analysis provides baseline quality estimate
- UCB1 adds exploration bonus for new skills
- Transitions to full scoring as data accumulates

---

### D005: Conflict Resolution Default

**Date:** 2025-12-26
**Status:** Approved

**Context:**
Skills may conflict with each other (contradictory instructions, overlapping triggers).

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| Fail | Safe | Frustrating UX |
| Warn | Informative | User must decide |
| Auto-resolve | Seamless | May make wrong choice |

**Decision:** Warn + user choice

**Consequences:**
- User maintains control
- Transparent about conflicts
- Priority system for recurring choices

---

### D006: Security Tier System

**Date:** 2025-12-26
**Status:** Approved

**Context:**
Need to communicate trustworthiness of skills to users.

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| Binary (trusted/not) | Simple | Loses nuance |
| 4-tier | Granular | More complex |

**Decision:** 4-tier system

**Tiers:**
1. Official - Anthropic published
2. Verified - Publisher verified, scanned
3. Community - Basic scan passed
4. Unverified - No verification

**Consequences:**
- Clear upgrade path for authors
- Users can filter by trust level
- Supports future verification programs

---

## Pending Decisions

| ID | Topic | Options | Decision Needed By | Owner |
|----|-------|---------|-------------------|-------|
| P001 | Vector database choice | SQLite-vec, Qdrant local, in-memory | Phase 2 start | Engineering |
| P002 | Embedding model | all-MiniLM-L6-v2, BGE-small, text-embedding-3-small | Phase 2 start | Engineering |
| P003 | Telemetry backend | Self-hosted, Posthog, none | Phase 1 | Product + Legal |

---

## Decision Template

```markdown
### DXXX: [Decision Title]

**Date:** YYYY-MM-DD
**Status:** Proposed | Approved | Superseded

**Context:**
[Why is this decision needed?]

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| ... | ... | ... |

**Decision:** [Chosen option]

**Consequences:**
- [What happens as a result?]
```

---

## Related Documentation

- [Open Questions](./open-questions.md) - Unresolved items
- [Technical Debt](./technical-debt.md) - Debt from decisions
- [Overview](./overview.md) - Architecture context

---

*Back to: [Technical Index](./index.md)*
