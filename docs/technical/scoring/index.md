# Quality Scoring Index

> **Navigation**: [Technical Index](../index.md) | [Overview](../overview.md) | [Recommendation Engine](../components/recommendation-engine.md)
>
> **Research Reference**: [Quality Scoring Research](../../research/quality-scoring.md)

---

> **For Claude Agents**: This section covers the quality scoring system.
> Use this index to find scoring algorithm and anti-gaming documentation.

## Scoring Navigation

| Topic | Document | Purpose |
|-------|----------|---------|
| Algorithm | [algorithm.md](./algorithm.md) | Scoring formula, weights, implementation |
| Anti-Gaming | [anti-gaming.md](./anti-gaming.md) | Preventing score manipulation |
| Transparent Scoring | [transparent-scoring.md](./transparent-scoring.md) | Public rubric, score display, community governance |

## Scoring Overview

### Formula

```
Final Score = (0.30 x Quality) + (0.35 x Popularity) + (0.35 x Maintenance)
```

### Component Weights

| Component | Weight | Sub-components |
|-----------|--------|----------------|
| **Quality** | 30% | README (25%), SKILL.md (30%), License (20%), Tests (15%), Examples (10%) |
| **Popularity** | 35% | Stars (50%), Forks (30%), Downloads (20%) |
| **Maintenance** | 35% | Recency (50%), Commit frequency (30%), Issue responsiveness (20%) |

## Data Sources

| Component | Primary Source | Fallback | Update Frequency |
|-----------|---------------|----------|------------------|
| Stars/Forks | GitHub API | Cache | Daily |
| Downloads | claude-plugins.dev (scraped) | Estimate from stars | Daily |
| Recency | GitHub API (updated_at) | Cache | Daily |
| Commit frequency | GitHub API (commits endpoint) | Estimated | Weekly |
| Issue responsiveness | GitHub API (issues endpoint) | Skip | Weekly |
| README quality | Content analysis | Basic presence check | On index |
| SKILL.md quality | Content analysis | Schema validation | On index |

## Related Documentation

- [Recommendation Engine](../components/recommendation-engine.md) - Uses scoring
- [Trust Tiers](../security/trust-tiers.md) - Trust classification
- [Quality Scoring Research](../../research/quality-scoring.md) - Detailed research
- [Transparent Scoring Design](./transparent-scoring.md) - Public rubric design

---

*Next: [Algorithm](./algorithm.md)*
