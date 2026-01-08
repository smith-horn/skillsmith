# Design: Transparent Scoring System with Public Rubric

> **Navigation**: [Documentation Index](../../index.md) > [Technical](../index.md) > [Scoring](./index.md) > Transparent Scoring
>
> **Related Documents**:
> - [Scoring Algorithm](./algorithm.md)
> - [Anti-Gaming](./anti-gaming.md)
> - [Research: Quality Scoring](../../research/quality-scoring.md)

---

> **Decision**: Scores will be visible to users. The scoring rubric will be public in the repository.
>
> **Date**: December 26, 2025
> **Status**: Design Complete
> **Rationale**: Transparency builds trust, enables community feedback, and positions us as the "OpenSSF Scorecard for Claude Skills"

---

## Executive Summary

This document designs a transparent scoring system where:
1. **All scoring logic** is open-source in our GitHub repository
2. **Scores are visible** to users when browsing recommendations
3. **Detailed breakdowns** are available on demand
4. **Community can contribute** improvements to the rubric

This approach follows the precedent set by [OpenSSF Scorecard](https://scorecard.dev/) and [npm quality scores](https://npms.io/), which have proven that transparency increases trust and adoption.

---

## 1. Design Principles

### 1.1 Why Transparency?

| Benefit | Description |
|---------|-------------|
| **Trust** | Users can verify scores aren't manipulated |
| **Feedback** | Community can identify blind spots in rubric |
| **Improvement** | Skill authors know exactly how to improve their scores |
| **Differentiation** | No competitor offers this level of transparency |
| **Accountability** | We can't hide behind "proprietary algorithms" |

### 1.2 Precedents

| Project | Transparency Level | Impact |
|---------|-------------------|--------|
| **OpenSSF Scorecard** | Full (open-source checks, public scores) | Adopted by GitHub, npm, PyPI |
| **npms.io** | High (open analyzer, documented weights) | Powers npm search |
| **Snyk Advisor** | Medium (scores visible, formula not public) | Widely trusted |
| **VS Code Marketplace** | Low (rankings opaque) | Frequent complaints about discoverability |

---

## 2. Score Display Design

### 2.1 Summary Score Badge

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│  🏆 linear-claude-skill                        Score: 78/100    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  ██████████████████████████████████████░░░░░░░░░░░░░░░░░░░░░░   │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │ Quality  │  │Popularity│  │Maintained│                       │
│  │   85     │  │    62    │  │    82    │                       │
│  └──────────┘  └──────────┘  └──────────┘                       │
│                                                                  │
│  📊 View detailed breakdown                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Detailed Score Breakdown

```
┌─────────────────────────────────────────────────────────────────┐
│  Score Breakdown: linear-claude-skill                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  OVERALL SCORE: 78/100                                          │
│  ══════════════════════════════════════════════════════════════ │
│                                                                  │
│  📝 QUALITY (30% weight)                            85/100      │
│  ───────────────────────────────────────────────────────────    │
│  │ SKILL.md Description    │ ████████████████████░░ │  90  │   │
│  │ README Completeness     │ ██████████████████░░░░ │  80  │   │
│  │ License Present         │ ████████████████████   │ 100  │   │
│  │ Examples Provided       │ ████████████████░░░░░░ │  70  │   │
│  │ Test Coverage           │ ██████████████░░░░░░░░ │  60  │   │
│                                                                  │
│  ⭐ POPULARITY (35% weight)                         62/100      │
│  ───────────────────────────────────────────────────────────    │
│  │ GitHub Stars (3)        │ ██████░░░░░░░░░░░░░░░░ │  30  │   │
│  │ GitHub Forks (1)        │ ████░░░░░░░░░░░░░░░░░░ │  20  │   │
│  │ Install Count (est.)    │ ████████████████████   │ 100  │   │
│  │ Author Reputation       │ ████████████████████   │ 100  │   │
│                                                                  │
│  🔧 MAINTENANCE (35% weight)                        82/100      │
│  ───────────────────────────────────────────────────────────    │
│  │ Last Updated (2 days)   │ ████████████████████   │ 100  │   │
│  │ Commit Frequency        │ ████████████████░░░░░░ │  70  │   │
│  │ Issue Responsiveness    │ ████████████████░░░░░░ │  70  │   │
│  │ Active Contributors     │ ██████████████████░░░░ │  80  │   │
│                                                                  │
│  ──────────────────────────────────────────────────────────────  │
│                                                                  │
│  💡 How to improve this score:                                   │
│  • Add more usage examples to README (+5 points)                 │
│  • Add automated tests (+10 points)                              │
│  • Increase GitHub stars through community engagement            │
│                                                                  │
│  📖 View scoring rubric                                          │
│  🔄 Last scored: 2 hours ago                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 Tier Badges

For quick recognition, assign tier badges based on score thresholds:

| Tier | Score Range | Badge | Meaning |
|------|-------------|-------|---------|
| **Certified** | 90-100 | 🥇 | Exceptional quality, highly maintained |
| **Trusted** | 70-89 | 🥈 | Good quality, actively maintained |
| **Community** | 50-69 | 🥉 | Meets standards, may need attention |
| **Emerging** | 30-49 | 🌱 | New or improving |
| **Needs Work** | 0-29 | ⚠️ | Significant improvements needed |

---

## 3. Public Rubric Structure

### 3.1 Repository Structure

```
/scoring/
├── README.md                 # Overview and quick start
├── RUBRIC.md                 # Human-readable rubric documentation
├── rubric.yaml               # Machine-readable rubric definition
├── src/
│   ├── scorer.ts             # Main scoring implementation
│   ├── checks/
│   │   ├── quality.ts        # Quality checks
│   │   ├── popularity.ts     # Popularity checks
│   │   └── maintenance.ts    # Maintenance checks
│   └── utils/
│       ├── github.ts         # GitHub API wrapper
│       └── normalize.ts      # Score normalization
├── tests/
│   ├── scorer.test.ts        # Unit tests
│   └── fixtures/             # Test skill repos
└── CHANGELOG.md              # Version history of rubric changes
```

### 3.2 RUBRIC.md Template

```markdown
# Skill Scoring Rubric v1.0

This document defines how skills are scored in Skill Recommender.
All scoring logic is open-source: [View source code](./src/scorer.ts)

## Score Formula

\`\`\`
Total Score = (0.30 × Quality) + (0.35 × Popularity) + (0.35 × Maintenance)
\`\`\`

## Quality Checks (30% of total)

### SKILL.md Description Quality (30% of Quality)

| Score | Criteria |
|-------|----------|
| 100 | Description is specific, mentions trigger phrases, <200 chars |
| 75 | Description is clear but generic |
| 50 | Description exists but is vague |
| 25 | Description is too short (<50 chars) |
| 0 | No description or >200 chars |

**Why this matters**: Claude uses the description to decide when to activate
the skill. Vague descriptions lead to 50% activation failure rates.

**Source code**: [`src/checks/quality.ts#L45-L78`](./src/checks/quality.ts#L45-L78)

### README Completeness (25% of Quality)

| Score | Criteria |
|-------|----------|
| 100 | README has: installation, usage, examples, API docs |
| 75 | README has: installation, usage, examples |
| 50 | README has: installation, usage |
| 25 | README exists but minimal |
| 0 | No README |

[... continue for all checks ...]

## Popularity Checks (35% of total)

### GitHub Stars (50% of Popularity)

Normalized using logarithmic scale:

\`\`\`
score = min(100, log10(stars + 1) / log10(10000) * 100)
\`\`\`

| Stars | Score |
|-------|-------|
| 10,000+ | 100 |
| 1,000 | 75 |
| 100 | 50 |
| 10 | 25 |
| 1 | 0 |

[... continue for all checks ...]

## Maintenance Checks (35% of total)

### Last Updated (50% of Maintenance)

| Days Since Update | Score |
|-------------------|-------|
| 0-30 | 100 |
| 31-90 | 80 |
| 91-180 | 50 |
| 181-365 | 30 |
| 365+ | 10 |

[... continue for all checks ...]

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2025-12-26 | Initial rubric |

## Contributing

Found an issue with the rubric? [Open an issue](https://github.com/you/skill-recommender/issues)
or submit a PR with your proposed changes.
```

### 3.3 rubric.yaml (Machine-Readable)

```yaml
version: "1.0"
updated: "2025-12-26"

formula:
  total:
    quality: 0.30
    popularity: 0.35
    maintenance: 0.35

quality:
  weight: 0.30
  checks:
    skillmd_description:
      weight: 0.30
      description: "Quality of SKILL.md description"
      scoring:
        - score: 100
          criteria: "Specific, mentions triggers, <200 chars"
        - score: 75
          criteria: "Clear but generic"
        - score: 50
          criteria: "Vague"
        - score: 25
          criteria: "Too short (<50 chars)"
        - score: 0
          criteria: "Missing or >200 chars"

    readme_completeness:
      weight: 0.25
      description: "README documentation quality"
      scoring:
        - score: 100
          criteria: "Has installation, usage, examples, API docs"
        - score: 75
          criteria: "Has installation, usage, examples"
        - score: 50
          criteria: "Has installation, usage"
        - score: 25
          criteria: "Minimal"
        - score: 0
          criteria: "Missing"

    license:
      weight: 0.20
      description: "Open source license present"
      scoring:
        - score: 100
          criteria: "MIT, Apache-2.0, or similar permissive"
        - score: 75
          criteria: "GPL or similar copyleft"
        - score: 0
          criteria: "No license or proprietary"

    examples:
      weight: 0.15
      description: "Usage examples provided"
      scoring:
        - score: 100
          criteria: "Multiple examples with context"
        - score: 50
          criteria: "Basic examples"
        - score: 0
          criteria: "No examples"

    tests:
      weight: 0.10
      description: "Automated tests present"
      scoring:
        - score: 100
          criteria: "CI configured with tests"
        - score: 50
          criteria: "Test files present"
        - score: 0
          criteria: "No tests"

popularity:
  weight: 0.35
  checks:
    stars:
      weight: 0.50
      description: "GitHub stars (log scale)"
      formula: "min(100, log10(stars + 1) / 4 * 100)"

    forks:
      weight: 0.30
      description: "GitHub forks (log scale)"
      formula: "min(100, log10(forks + 1) / 3 * 100)"

    downloads:
      weight: 0.20
      description: "Install count (if available)"
      formula: "min(100, log10(downloads + 1) / 5 * 100)"
      fallback: 50  # Use 50 if data unavailable

maintenance:
  weight: 0.35
  checks:
    recency:
      weight: 0.50
      description: "Days since last update"
      scoring:
        - score: 100
          criteria: "0-30 days"
        - score: 80
          criteria: "31-90 days"
        - score: 50
          criteria: "91-180 days"
        - score: 30
          criteria: "181-365 days"
        - score: 10
          criteria: "365+ days"

    commit_frequency:
      weight: 0.30
      description: "Commits per month (last 6 months)"
      scoring:
        - score: 100
          criteria: "10+ commits/month"
        - score: 75
          criteria: "5-9 commits/month"
        - score: 50
          criteria: "2-4 commits/month"
        - score: 25
          criteria: "1 commit/month"
        - score: 10
          criteria: "<1 commit/month"

    issue_responsiveness:
      weight: 0.20
      description: "% of issues with maintainer response"
      formula: "response_rate * 100"
```

---

## 4. Implementation

### 4.1 Scorer Class

```typescript
import { readFileSync } from 'fs';
import * as yaml from 'yaml';

interface Rubric {
  version: string;
  formula: { total: { quality: number; popularity: number; maintenance: number } };
  quality: CategoryConfig;
  popularity: CategoryConfig;
  maintenance: CategoryConfig;
}

interface CategoryConfig {
  weight: number;
  checks: Record<string, CheckConfig>;
}

interface CheckConfig {
  weight: number;
  description: string;
  scoring?: Array<{ score: number; criteria: string }>;
  formula?: string;
  fallback?: number;
}

export class TransparentScorer {
  private rubric: Rubric;

  constructor(rubricPath: string = './scoring/rubric.yaml') {
    // Load rubric from public file
    const content = readFileSync(rubricPath, 'utf-8');
    this.rubric = yaml.parse(content);
  }

  /**
   * Score a skill with full transparency.
   */
  async score(repoUrl: string): Promise<ScoreResult> {
    const data = await this.fetchData(repoUrl);

    const quality = this.scoreCategory('quality', data);
    const popularity = this.scoreCategory('popularity', data);
    const maintenance = this.scoreCategory('maintenance', data);

    const total = Math.round(
      this.rubric.formula.total.quality * quality.score +
      this.rubric.formula.total.popularity * popularity.score +
      this.rubric.formula.total.maintenance * maintenance.score
    );

    return {
      total,
      tier: this.getTier(total),
      categories: {
        quality,
        popularity,
        maintenance
      },
      rubricVersion: this.rubric.version,
      scoredAt: new Date().toISOString(),
      // Include the rubric URL for transparency
      rubricUrl: 'https://github.com/you/skill-recommender/blob/main/scoring/RUBRIC.md'
    };
  }

  /**
   * Get improvement suggestions based on current scores.
   */
  getImprovementSuggestions(result: ScoreResult): Suggestion[] {
    const suggestions: Suggestion[] = [];

    for (const [category, scores] of Object.entries(result.categories)) {
      for (const [check, score] of Object.entries(scores.checks)) {
        if (score.score < 70) {
          suggestions.push({
            check,
            currentScore: score.score,
            potentialGain: 100 - score.score,
            suggestion: this.getSuggestionText(check, score.score),
            rubricSection: `${category}.${check}`
          });
        }
      }
    }

    // Sort by potential gain
    return suggestions.sort((a, b) => b.potentialGain - a.potentialGain);
  }

  private scoreCategory(category: string, data: SkillData): CategoryResult {
    const config = this.rubric[category as keyof Rubric] as CategoryConfig;
    const checks: Record<string, CheckResult> = {};

    let weightedSum = 0;
    let totalWeight = 0;

    for (const [checkName, checkConfig] of Object.entries(config.checks)) {
      const score = this.runCheck(checkName, checkConfig, data);
      checks[checkName] = {
        score,
        weight: checkConfig.weight,
        description: checkConfig.description
      };
      weightedSum += score * checkConfig.weight;
      totalWeight += checkConfig.weight;
    }

    return {
      score: Math.round(weightedSum / totalWeight),
      weight: config.weight,
      checks
    };
  }

  private runCheck(name: string, config: CheckConfig, data: SkillData): number {
    // Use formula if provided
    if (config.formula) {
      return this.evaluateFormula(config.formula, data);
    }

    // Use scoring table
    if (config.scoring) {
      return this.matchScoringTable(name, config.scoring, data);
    }

    return config.fallback ?? 0;
  }

  private getTier(score: number): string {
    if (score >= 90) return 'certified';
    if (score >= 70) return 'trusted';
    if (score >= 50) return 'community';
    if (score >= 30) return 'emerging';
    return 'needs-work';
  }

  // ... additional implementation details
}

interface ScoreResult {
  total: number;
  tier: string;
  categories: {
    quality: CategoryResult;
    popularity: CategoryResult;
    maintenance: CategoryResult;
  };
  rubricVersion: string;
  scoredAt: string;
  rubricUrl: string;
}

interface CategoryResult {
  score: number;
  weight: number;
  checks: Record<string, CheckResult>;
}

interface CheckResult {
  score: number;
  weight: number;
  description: string;
}

interface Suggestion {
  check: string;
  currentScore: number;
  potentialGain: number;
  suggestion: string;
  rubricSection: string;
}
```

### 4.2 API Response Format

```json
{
  "skill": "wrsmith108/linear-claude-skill",
  "score": {
    "total": 78,
    "tier": "trusted",
    "badge": "🥈",
    "categories": {
      "quality": {
        "score": 85,
        "weight": 0.30,
        "checks": {
          "skillmd_description": {
            "score": 90,
            "weight": 0.30,
            "description": "Quality of SKILL.md description",
            "details": "Specific, mentions triggers, 156 chars"
          },
          "readme_completeness": {
            "score": 80,
            "weight": 0.25,
            "description": "README documentation quality",
            "details": "Has installation, usage, examples"
          }
        }
      },
      "popularity": {
        "score": 62,
        "weight": 0.35,
        "checks": {
          "stars": {
            "score": 30,
            "weight": 0.50,
            "description": "GitHub stars (log scale)",
            "details": "3 stars → 30/100 (need ~100 for 50/100)"
          }
        }
      },
      "maintenance": {
        "score": 82,
        "weight": 0.35,
        "checks": {
          "recency": {
            "score": 100,
            "weight": 0.50,
            "description": "Days since last update",
            "details": "Updated 2 days ago"
          }
        }
      }
    },
    "suggestions": [
      {
        "check": "tests",
        "currentScore": 0,
        "potentialGain": 3,
        "suggestion": "Add automated tests to improve reliability",
        "rubricSection": "quality.tests"
      }
    ]
  },
  "metadata": {
    "rubricVersion": "1.0",
    "scoredAt": "2025-12-26T14:30:00Z",
    "rubricUrl": "https://github.com/you/skill-recommender/blob/main/scoring/RUBRIC.md",
    "sourceCode": "https://github.com/you/skill-recommender/blob/main/scoring/src/scorer.ts"
  }
}
```

---

## 5. Community Governance

### 5.1 Rubric Change Process

```
┌─────────────────────────────────────────────────────────────────┐
│                    RUBRIC CHANGE PROCESS                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. PROPOSAL                                                     │
│     └─ Open GitHub Issue with RFC template                       │
│     └─ Tag: `rubric-change`                                      │
│                                                                  │
│  2. DISCUSSION (7 days minimum)                                  │
│     └─ Community feedback                                        │
│     └─ Impact analysis on existing scores                        │
│                                                                  │
│  3. IMPLEMENTATION                                               │
│     └─ PR with code + RUBRIC.md + CHANGELOG updates              │
│     └─ Requires 2 maintainer approvals                           │
│                                                                  │
│  4. RELEASE                                                      │
│     └─ Bump rubric version                                       │
│     └─ Publish changelog                                         │
│     └─ Re-score all skills (async)                               │
│                                                                  │
│  5. COMMUNICATION                                                │
│     └─ Announce in Discord/GitHub Discussions                    │
│     └─ Allow 14-day grace period before major changes            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 RFC Template

```markdown
## Rubric Change Proposal

### Summary
[One-sentence description of the proposed change]

### Motivation
[Why is this change needed? What problem does it solve?]

### Proposed Change

**Current behavior:**
\`\`\`yaml
# Current rubric definition
\`\`\`

**Proposed behavior:**
\`\`\`yaml
# New rubric definition
\`\`\`

### Impact Analysis

- **Skills affected**: [X out of Y total]
- **Average score change**: [+/- X points]
- **Skills that would change tier**: [list]

### Alternatives Considered
[What other approaches were considered?]

### Checklist
- [ ] I've tested this change locally
- [ ] I've updated RUBRIC.md
- [ ] I've updated CHANGELOG.md
- [ ] I've run impact analysis
```

---

## 6. Anti-Gaming Measures

### 6.1 Known Gaming Vectors

| Vector | Detection | Mitigation |
|--------|-----------|------------|
| **Star farming** | Abnormal star velocity | Weight forks higher; flag anomalies |
| **Fake README** | Low content-to-length ratio | Check for meaningful content |
| **Keyword stuffing** | Description >200 chars or repetition | Hard cap; penalize repetition |
| **Empty commits** | Commits with no meaningful changes | Check diff size |
| **Self-reviewing** | Same author opens/closes issues | Exclude self-interactions |

### 6.2 Anomaly Detection

```typescript
interface AnomalyCheck {
  check: string;
  threshold: number;
  action: 'flag' | 'penalize' | 'exclude';
}

const ANOMALY_CHECKS: AnomalyCheck[] = [
  {
    check: 'star_velocity',
    threshold: 50,  // >50 stars in 24 hours
    action: 'flag'
  },
  {
    check: 'description_repetition',
    threshold: 3,  // Same word >3 times
    action: 'penalize'
  },
  {
    check: 'empty_commits',
    threshold: 0.5,  // >50% of commits are empty
    action: 'penalize'
  }
];
```

### 6.3 Transparency in Anti-Gaming

Even anti-gaming measures should be documented:

```markdown
## Anti-Gaming Measures

We detect and mitigate the following gaming attempts:

| Behavior | Detection | Impact |
|----------|-----------|--------|
| Unusual star growth | >50 stars in 24h triggers review | Manual review, potential flag |
| Keyword stuffing | >3 repetitions in description | -10 points to quality |
| Empty commits | >50% commits with <5 lines changed | -20 points to maintenance |

If you believe your skill was incorrectly flagged, [open an appeal](link).
```

---

## 7. Benefits of This Approach

| Stakeholder | Benefit |
|-------------|---------|
| **Users** | Can trust recommendations; understand why skills are ranked |
| **Skill Authors** | Know exactly how to improve; fair playing field |
| **Community** | Can contribute improvements; feels ownership |
| **Us** | Reduced support burden; community-driven quality |
| **Ecosystem** | Raises quality bar for all Claude skills |

---

## 8. Next Steps

| Action | Owner | Timeline |
|--------|-------|----------|
| Create `/scoring` directory structure | Engineering | Week 1 |
| Write RUBRIC.md v1.0 | Product + Engineering | Week 1 |
| Implement TransparentScorer | Engineering | Week 2 |
| Build score display UI | Engineering | Week 2 |
| Create RFC template | Product | Week 2 |
| Document anti-gaming measures | Engineering | Week 3 |
| Beta test with community | Product | Week 3-4 |

---

## Sources

- [OpenSSF Scorecard](https://scorecard.dev/) - Transparent security scoring
- [OpenSSF Scorecard GitHub](https://github.com/ossf/scorecard) - Open-source implementation
- [Apereo OSS Rubric](https://github.com/apereo/oss-rubric) - Open source maturity rubric
- [npms.io Analyzer](https://github.com/npms-io/npms-analyzer) - Open npm quality scoring
- [OpenSSF Best Practices Badge](https://www.bestpractices.dev/) - Tiered certification

---

*Document generated: December 26, 2025*
