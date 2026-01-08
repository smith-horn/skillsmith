# Scoring Algorithm

> **Navigation**: [Scoring Index](./index.md) | [Technical Index](../index.md) | [Anti-Gaming](./anti-gaming.md)
>
> **Research Reference**: [Quality Scoring Research](/research-spike-quality-scoring.md)

---

## Scoring Formula

```
Final Score = (0.30 x Quality) + (0.35 x Popularity) + (0.35 x Maintenance)
```

Each component produces a normalized score between 0.0 and 1.0.

---

## Component Weights

```typescript
const SCORING_WEIGHTS = {
  // Top-level weights
  quality: 0.30,
  popularity: 0.35,
  maintenance: 0.35,

  // Quality sub-weights
  quality_components: {
    readme_score: 0.25,
    skillmd_score: 0.30,    // Most important for skills
    has_license: 0.20,
    has_tests: 0.15,
    has_examples: 0.10,
  },

  // Popularity sub-weights
  popularity_components: {
    stars: 0.50,
    forks: 0.30,
    downloads: 0.20,        // If available
  },

  // Maintenance sub-weights
  maintenance_components: {
    recency: 0.50,          // Days since update
    commit_frequency: 0.30,
    issue_responsiveness: 0.20,
  },
};
```

---

## Scoring Implementation

```typescript
class SkillScorer {
  score(skill: Skill): ScoredSkill {
    const quality = this.computeQuality(skill);
    const popularity = this.computePopularity(skill);
    const maintenance = this.computeMaintenance(skill);

    const final =
      SCORING_WEIGHTS.quality * quality +
      SCORING_WEIGHTS.popularity * popularity +
      SCORING_WEIGHTS.maintenance * maintenance;

    return {
      ...skill,
      quality_score: quality,
      popularity_score: popularity,
      maintenance_score: maintenance,
      final_score: final,
      trust_tier: this.computeTier(final, skill),
    };
  }
}
```

---

## Quality Score Calculation

```typescript
private computeQuality(skill: Skill): number {
  const weights = SCORING_WEIGHTS.quality_components;

  const readmeScore = this.assessReadmeQuality(skill.readme);
  const skillmdScore = this.assessSkillMdQuality(skill.skillmd);
  const licenseScore = skill.has_license ? 1.0 : 0.3;
  const testsScore = skill.has_tests ? 1.0 : 0.5;
  const examplesScore = skill.has_examples ? 1.0 : 0.5;

  return (
    weights.readme_score * readmeScore +
    weights.skillmd_score * skillmdScore +
    weights.has_license * licenseScore +
    weights.has_tests * testsScore +
    weights.has_examples * examplesScore
  );
}

private assessReadmeQuality(readme: string): number {
  if (!readme) return 0;

  let score = 0;

  // Length check (normalized)
  const length = readme.length;
  if (length > 2000) score += 0.3;
  else if (length > 500) score += 0.2;
  else if (length > 100) score += 0.1;

  // Has sections
  if (readme.includes('## ')) score += 0.2;

  // Has code examples
  if (readme.includes('```')) score += 0.2;

  // Has installation instructions
  if (/install|setup|getting started/i.test(readme)) score += 0.15;

  // Has usage examples
  if (/usage|example|how to/i.test(readme)) score += 0.15;

  return Math.min(1.0, score);
}

private assessSkillMdQuality(skillmd: string): number {
  if (!skillmd) return 0;

  let score = 0;

  // Valid frontmatter
  const frontmatter = parseFrontmatter(skillmd);
  if (frontmatter) {
    score += 0.3;

    // Required fields present
    if (frontmatter.name) score += 0.1;
    if (frontmatter.description) score += 0.2;

    // Description quality
    if (frontmatter.description && frontmatter.description.length > 50) {
      score += 0.1;
    }
  }

  // Has content beyond frontmatter
  const content = skillmd.replace(/^---[\s\S]*?---/, '').trim();
  if (content.length > 500) score += 0.2;
  if (content.length > 200) score += 0.1;

  return Math.min(1.0, score);
}
```

---

## Popularity Score Calculation

```typescript
private computePopularity(skill: Skill): number {
  // Logarithmic normalization prevents extreme values
  const starsNorm = Math.min(1.0, Math.log10(skill.stars + 1) / 4);
  const forksNorm = Math.min(1.0, Math.log10(skill.forks + 1) / 3);
  const downloadsNorm = skill.downloads
    ? Math.min(1.0, Math.log10(skill.downloads + 1) / 5)
    : 0.5; // Default if no download data

  return (
    0.50 * starsNorm +
    0.30 * forksNorm +
    0.20 * downloadsNorm
  );
}
```

### Logarithmic Normalization

| Stars | Normalized Score |
|-------|------------------|
| 0 | 0.00 |
| 10 | 0.25 |
| 100 | 0.50 |
| 1,000 | 0.75 |
| 10,000 | 1.00 |

---

## Maintenance Score Calculation

```typescript
private computeMaintenance(skill: Skill): number {
  const recency = this.computeRecency(new Date(skill.updated_at));
  const commitFreq = this.computeCommitFrequency(skill);
  const issueResponse = this.computeIssueResponsiveness(skill);

  return (
    0.50 * recency +
    0.30 * commitFreq +
    0.20 * issueResponse
  );
}

private computeRecency(updatedAt: Date): number {
  const days = daysSince(updatedAt);

  if (days < 30) return 1.0;
  if (days < 90) return 0.8;
  if (days < 180) return 0.5;
  if (days < 365) return 0.3;
  return 0.1;
}

private computeCommitFrequency(skill: Skill): number {
  if (!skill.commits_last_year) return 0.5; // Default if unknown

  const commitsPerMonth = skill.commits_last_year / 12;

  if (commitsPerMonth >= 4) return 1.0;
  if (commitsPerMonth >= 2) return 0.8;
  if (commitsPerMonth >= 1) return 0.6;
  if (commitsPerMonth >= 0.5) return 0.4;
  return 0.2;
}

private computeIssueResponsiveness(skill: Skill): number {
  if (skill.open_issues === 0) return 0.8; // No issues is neutral-good
  if (!skill.avg_issue_close_days) return 0.5;

  const avgDays = skill.avg_issue_close_days;

  if (avgDays < 7) return 1.0;
  if (avgDays < 14) return 0.8;
  if (avgDays < 30) return 0.6;
  if (avgDays < 90) return 0.4;
  return 0.2;
}
```

---

## Recency Decay Curve

| Days Since Update | Score |
|-------------------|-------|
| 0-30 | 1.0 |
| 31-90 | 0.8 |
| 91-180 | 0.5 |
| 181-365 | 0.3 |
| 365+ | 0.1 |

---

## Trust Tier Mapping

```typescript
private computeTier(finalScore: number, skill: Skill): TrustTier {
  // Official namespace always gets official tier
  if (skill.id.startsWith('anthropic/')) {
    return TrustTier.OFFICIAL;
  }

  // Score-based tiers (modified by other factors)
  if (finalScore >= 0.8 && skill.publisher_verified) {
    return TrustTier.VERIFIED;
  }

  if (finalScore >= 0.4 && skill.scan_passed) {
    return TrustTier.COMMUNITY;
  }

  return TrustTier.UNVERIFIED;
}
```

---

## Configurable Weights

Weights can be overridden in configuration:

```yaml
# ~/.claude-discovery/config/scoring.yaml
version: "1.0"
weights:
  quality: 0.30
  popularity: 0.35
  maintenance: 0.35

  quality_components:
    readme_score: 0.25
    skillmd_score: 0.30
    has_license: 0.20
    has_tests: 0.15
    has_examples: 0.10

tier_thresholds:
  verified: 0.8
  community: 0.4
```

---

## Related Documentation

- [Anti-Gaming](./anti-gaming.md) - Preventing manipulation
- [Recommendation Engine](../components/recommendation-engine.md) - Uses scoring
- [Trust Tiers](../security/trust-tiers.md) - Trust classification

---

*Next: [Anti-Gaming](./anti-gaming.md)*
