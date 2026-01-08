# Open Technical Questions

> **Navigation**: [Technical Index](./index.md) | [Decisions](./decisions.md)

---

## Unresolved Questions

| Question | Options | Decision Needed By | Owner |
|----------|---------|-------------------|-------|
| Vector database choice | SQLite-vec, Qdrant local, in-memory | Phase 2 start | Engineering |
| Embedding model selection | all-MiniLM-L6-v2, BGE-small, text-embedding-3-small | Phase 2 start | Engineering |
| Sync architecture at scale | Pull-based, webhook-based, hybrid | Phase 3 start | Architecture |
| Telemetry backend | Self-hosted, Posthog, none | Phase 1 | Product + Legal |
| Skill signing mechanism | Sigstore, GPG, custom | Phase 3 | Security |
| Rate limit strategy | Token rotation, GitHub App, caching only | Phase 1 | Engineering |

---

## Investigation Assignments

| Investigation | Duration | Owner | Due |
|---------------|----------|-------|-----|
| MCP performance baseline | 1 week | Engineering | Before Phase 1 |
| Skill conflict simulation | 1 week | Engineering | Before Phase 1 |
| Security threat model validation | 1 week | Security | Before Phase 1 |
| GitHub API sustainability | 3 days | Engineering | Before Phase 1 |
| Vector search prototype | 3 days | Engineering | Before Phase 2 |

---

## Question Details

### Vector Database Choice

**Context:** Need vector similarity search for skill recommendations.

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| SQLite-vec | Embedded, simple | Less mature |
| Qdrant local | Feature-rich | Extra dependency |
| In-memory | Fastest | Memory pressure |

**Considerations:**
- 50K skills = ~200MB embeddings
- Need sub-100ms search
- Prefer embedded for simplicity

**Investigation Plan:**
1. Prototype SQLite-vec with 10K embeddings
2. Benchmark search latency
3. Compare memory usage

---

### Embedding Model Selection

**Context:** Need text embeddings for semantic search.

**Options:**

| Option | Dimensions | Size | Quality |
|--------|------------|------|---------|
| all-MiniLM-L6-v2 | 384 | 80MB | Good |
| BGE-small | 512 | 130MB | Better |
| text-embedding-3-small | 1536 | API | Best |

**Considerations:**
- Must run locally for privacy
- Smaller = faster, less memory
- Quality must be "good enough"

**Investigation Plan:**
1. Test retrieval quality on sample queries
2. Benchmark inference speed
3. Measure memory footprint

---

### Sync Architecture at Scale

**Context:** Current pull-based sync may not scale to 100K+ skills.

**Options:**

| Option | Description | When to Use |
|--------|-------------|-------------|
| Pull-based | Poll sources periodically | <50K skills |
| Webhook-based | Real-time updates | High-volume sources |
| Hybrid | Pull + webhooks | Mixed sources |

**Investigation Plan:**
1. Model growth projections
2. Analyze GitHub API sustainability
3. Prototype webhook integration

---

### Telemetry Backend

**Context:** Need usage analytics without compromising privacy.

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| Self-hosted | Full control | Infrastructure cost |
| Posthog | Privacy-focused | Third party |
| None | No privacy concerns | Blind to usage |

**Dependencies:**
- Legal review of data collection
- User consent model
- Data retention policy

---

### Skill Signing Mechanism

**Context:** Need to verify skill authenticity.

**Options:**

| Option | Pros | Cons |
|--------|------|------|
| Sigstore | Modern, keyless | Complex |
| GPG | Widely understood | Key management |
| Custom | Tailored | More work |

**Investigation Plan:**
1. Research Sigstore adoption
2. Evaluate integration complexity
3. Define trust chain requirements

---

### Rate Limit Strategy

**Context:** GitHub API rate limits constrain sync frequency.

**Options:**

| Option | Requests/hr | Complexity |
|--------|------------|------------|
| Single token | 5,000 | Low |
| Token rotation | 5,000 x N | Medium |
| GitHub App | 15,000 | Higher |
| Caching only | N/A | Low |

**Current Analysis:**
- 50K skills @ 100/request = 500 requests
- Daily full sync = 500 requests
- Hourly incremental = ~50 requests
- Single token sufficient for current scale

**Escalation Plan:**
- Phase 1-2: Single token + aggressive caching
- Phase 3+: Token rotation or GitHub App

---

## Investigation Template

```markdown
### [Investigation Topic]

**Context:** [Why is this investigation needed?]

**Hypothesis:** [What do we think the answer is?]

**Investigation Plan:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Success Criteria:**
- [Criterion 1]
- [Criterion 2]

**Timeline:** [Duration]

**Owner:** [Team/Person]

**Status:** Not Started | In Progress | Complete

**Findings:**
[To be completed]

**Decision:**
[To be completed]
```

---

## Related Documentation

- [Decisions](./decisions.md) - Resolved decisions
- [Technical Debt](./technical-debt.md) - Debt from decisions
- [Overview](./overview.md) - Architecture context

---

*Back to: [Technical Index](./index.md)*
