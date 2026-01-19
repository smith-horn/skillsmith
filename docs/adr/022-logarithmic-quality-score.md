# ADR-022: Logarithmic Quality Score Formula

**Status**: Accepted (Feature Flagged)
**Date**: 2025-01-19
**Deciders**: Engineering Team

## Context

All skills displayed 100% quality scores because the linear formula saturated at 1.0 for repositories with ≥500 stars and ≥125 forks. Since all indexed repositories are popular (ranging from 1,700 to 42,000+ stars), every skill appeared identical in quality.

The original formula was:
```javascript
const starScore = Math.min(repo.stars / 10, 50)   // Saturates at 500 stars
const forkScore = Math.min(repo.forks / 5, 25)    // Saturates at 125 forks
qualityScore = (starScore + forkScore + 25) / 100
```

This provided no differentiation between a repo with 500 stars vs one with 40,000 stars.

## Decision

Use logarithmic (log10) scaling for stars and forks to provide meaningful differentiation across wide ranges:

```javascript
const starScore = Math.min(Math.log10(repo.stars + 1) * 15, 50)
const forkScore = Math.min(Math.log10(repo.forks + 1) * 10, 25)
qualityScore = (starScore + forkScore + 25) / 100
```

### Score Components

| Component | Formula | Max Points |
|-----------|---------|------------|
| Stars | `log10(stars + 1) × 15` | 50 |
| Forks | `log10(forks + 1) × 10` | 25 |
| Base | Fixed | 25 |
| **Total** | Sum ÷ 100 | 100 |

### Expected Score Distribution

| Stars | Forks | Star Score | Fork Score | Total |
|-------|-------|------------|------------|-------|
| 10 | 5 | 15.6 | 7.8 | **48%** |
| 100 | 20 | 30.1 | 13.0 | **68%** |
| 500 | 100 | 40.5 | 20.0 | **86%** |
| 1,000 | 200 | 45.1 | 23.0 | **93%** |
| 10,000 | 500 | 50 (cap) | 25 (cap) | **100%** |

### Why log10?

- **log10(10) = 1**: Single-digit star repos contribute minimally
- **log10(100) = 2**: Hundred-star repos are moderately weighted
- **log10(1000) = 3**: Thousand-star repos receive substantial weight
- **log10(10000) = 4**: Ten-thousand-star repos approach the cap

The `+1` prevents log(0) errors for zero-star repositories.

## Consequences

### Positive
- Meaningful differentiation between 500-star and 40,000-star repos
- Users can filter by quality score with useful results
- Logarithmic scale matches human perception of "popularity"
- Small repos still receive fair baseline scores (base 25 points)

### Negative
- Existing cached quality scores become stale until re-indexed
- Very small repos (1-10 stars) may feel "penalized" compared to linear scale
- Requires re-indexing all skills for accurate scores

### Neutral
- High-trust authors still use configured `baseQualityScore` (unchanged)
- Trust tier determination is unaffected (still uses star thresholds)

## Alternatives Considered

### Alternative 1: Square Root Scale
- Formula: `Math.sqrt(repo.stars) * 2.24`
- Pros: Smoother curve than log10
- Cons: Still saturates too quickly (100 = 22.4, 10000 = 224)
- Why rejected: Insufficient differentiation at high end

### Alternative 2: Percentile-Based Scoring
- Compute percentile rank against all indexed repos
- Pros: Always produces good distribution
- Cons: Requires knowing all repo stats; scores change when index changes
- Why rejected: Complexity and instability

### Alternative 3: Weighted Composite Score
- Include additional factors: recent commits, issues, contributors
- Pros: More comprehensive quality signal
- Cons: Requires additional API calls; increases indexing time
- Why rejected: Scope creep; can add later if needed

## Implementation

Files modified:
- `supabase/functions/indexer/index.ts:707-722`
- `packages/core/src/indexer/GitHubIndexer.ts:308-323`

## Feature Flag

The logarithmic formula is controlled by the `SKILLSMITH_LOG_QUALITY_SCORE` environment variable:

```bash
# Enable logarithmic scoring (experimental)
SKILLSMITH_LOG_QUALITY_SCORE=true

# Disable (default) - uses linear scoring
SKILLSMITH_LOG_QUALITY_SCORE=false
```

### Enabling in Supabase

To enable for production testing:

1. Go to Supabase Dashboard → Functions → indexer → Settings
2. Add environment variable: `SKILLSMITH_LOG_QUALITY_SCORE=true`
3. Trigger re-indexing to apply new scores

### Rollout Plan

1. **Phase 1**: Deploy with flag disabled (current)
2. **Phase 2**: Enable for internal testing via Supabase env var
3. **Phase 3**: User acceptance testing with beta testers
4. **Phase 4**: Remove flag and make logarithmic the default

## References

- [GitHub repository popularity distribution](https://github.blog/2023-01-25-100-million-developers-and-counting/)
- [Logarithmic perception in UX](https://www.nngroup.com/articles/logarithmic-scales/)
