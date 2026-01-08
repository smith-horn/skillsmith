# Recommendation Engine

> **Navigation**: [Components Index](./index.md) | [Technical Index](../index.md) | [Scoring Algorithm](../scoring/algorithm.md)

---

## Matching Algorithm

```typescript
interface RecommendationEngine {
  recommend(
    codebase: CodebaseAnalysis,
    options?: RecommendOptions
  ): Promise<ScoredRecommendation[]>;
}

interface RecommendOptions {
  max_results: number;          // Default: 10
  min_score: number;            // Default: 0.3
  include_installed: boolean;   // Default: false
  diversity_factor: number;     // 0-1, higher = more diverse results
}

function computeRecommendationScore(
  skill: Skill,
  codebase: CodebaseAnalysis
): number {
  // Relevance (60% weight)
  const relevance = (
    0.40 * semanticSimilarity(skill.description, codebase.description) +
    0.35 * techStackMatch(skill.technologies, codebase.stack) +
    0.25 * categoryMatch(skill.categories, codebase.inferred_categories)
  );

  // Quality (40% weight)
  const quality = skill.final_score;

  return 0.60 * relevance + 0.40 * quality;
}
```

---

## Scoring Breakdown

| Component | Weight | Description |
|-----------|--------|-------------|
| **Relevance** | 60% | How well the skill matches the codebase |
| - Semantic similarity | 40% of relevance | Description embedding similarity |
| - Tech stack match | 35% of relevance | Technology overlap |
| - Category match | 25% of relevance | Inferred category alignment |
| **Quality** | 40% | Skill's overall quality score |

---

## Exploration vs Exploitation (UCB1)

To handle cold start and ensure new skills get visibility:

```typescript
function scoreWithExploration(
  baseScore: number,
  impressions: number,
  installs: number,
  totalImpressions: number
): number {
  if (impressions === 0) {
    return Infinity; // Always show new skills at least once
  }

  const exploitation = installs / impressions;
  const exploration = Math.sqrt(
    (2 * Math.log(totalImpressions)) / impressions
  );

  // Blend base quality with exploration bonus
  return 0.7 * baseScore + 0.3 * (exploitation + exploration);
}
```

### UCB1 Explanation

The Upper Confidence Bound (UCB1) algorithm balances:

1. **Exploitation**: Showing skills that have historically performed well
2. **Exploration**: Giving new skills a chance to be discovered

This prevents popular skills from dominating recommendations and allows quality new skills to surface.

---

## Cold Start Handling

| Stage | Handling |
|-------|----------|
| New skill (<30 days) | Content-based baseline score + "New & Noteworthy" section |
| New skill (<100 impressions) | Exploration bonus via UCB1 |
| Established skill | Full quality scoring model |

### Cold Start Strategy

```typescript
function getBaselineScore(skill: Skill): number {
  // For new skills without interaction data
  const contentScore = (
    0.30 * assessReadmeQuality(skill.readme) +
    0.40 * assessSkillMdQuality(skill.skillmd) +
    0.15 * (skill.has_license ? 1.0 : 0.3) +
    0.15 * (skill.has_examples ? 1.0 : 0.5)
  );

  // Author reputation bonus
  const authorBonus = getAuthorReputation(skill.author) * 0.2;

  return Math.min(1.0, contentScore + authorBonus);
}
```

---

## Recommendation Output

```typescript
interface ScoredRecommendation {
  skill: Skill;
  score: number;              // 0-1
  relevance_score: number;    // 0-1
  quality_score: number;      // 0-1

  // Explanation
  match_reasons: string[];    // Why this skill was recommended
  tech_overlap: string[];     // Technologies that matched

  // Metadata
  is_new: boolean;            // < 30 days old
  is_trending: boolean;       // High recent growth
}
```

---

## Related Documentation

- [Codebase Scanner](./codebase-scanner.md) - Provides analysis input
- [Scoring Algorithm](../scoring/algorithm.md) - Quality scoring details
- [Anti-Gaming](../scoring/anti-gaming.md) - Preventing score manipulation

---

*Next: [Activation Auditor](./activation-auditor.md)*
