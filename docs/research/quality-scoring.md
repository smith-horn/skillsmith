# Research Spike: Quality Scoring for Claude Skill Recommendations

> **Navigation**: [Documentation Index](../index.md) > [Research](./index.md) > Quality Scoring
>
> **Related Documents**:
> - [Technical: Scoring Algorithm](../technical/scoring/algorithm.md)
> - [Technical: Anti-Gaming](../technical/scoring/anti-gaming.md)
> - [Design: Transparent Scoring](../technical/scoring/transparent-scoring.md)

---

> **Purpose**: Define a scoring mechanism that delivers the most competitive solution for recommending Claude skills to users.
>
> **Spike Duration**: 1 week
> **Owner**: Product/Engineering
> **Date**: December 26, 2025

---

## Spike Objectives

1. **Evaluate** existing quality scoring approaches from package ecosystems
2. **Identify** available data sources for Claude skill scoring
3. **Design** candidate scoring models with trade-offs
4. **Define** experiments to validate hypotheses before implementation

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Prior Art Analysis](#2-prior-art-analysis)
3. [Available Data Sources](#3-available-data-sources)
4. [Candidate Scoring Models](#4-candidate-scoring-models)
5. [Cold Start Strategy](#5-cold-start-strategy)
6. [Experiment Design](#6-experiment-design)
7. [Recommendations](#7-recommendations)
8. [Open Questions](#8-open-questions)
9. [Sources](#9-sources)

---

## 1. Problem Statement

### 1.1 Context

Our plugin will recommend Claude skills based on codebase analysis and user intent. With **46,000+ skills** indexed across marketplaces, users need a way to distinguish high-quality, reliable skills from abandoned or poorly-designed ones.

### 1.2 Key Questions

| Question | Impact |
|----------|--------|
| What makes a "good" skill from the user's perspective? | Defines success criteria |
| What data can we access to measure quality? | Constrains possible solutions |
| How do we handle new skills with no usage history? | Cold start problem |
| How do we avoid gaming? | Long-term integrity |
| How do we validate our model before shipping? | Risk mitigation |

### 1.3 Success Criteria

A quality score is successful if:
- Users trust the recommendations (>80% "useful" ratings)
- High-quality skills surface above low-quality ones in >90% of comparisons
- New quality skills can emerge within 2 weeks of publication
- The score is resistant to gaming/manipulation

---

## 2. Prior Art Analysis

### 2.1 npms.io (npm Package Scoring)

**Overview**: Powers npmjs.com search ranking. Open-source analyzer available.

**Scoring Formula**:
```
Final Score = (0.30 × Quality) + (0.35 × Popularity) + (0.35 × Maintenance)
```

**Quality Subscore Components**:
| Component | Weight | What It Measures |
|-----------|--------|------------------|
| Carefulness | High | Linting, code style tools present |
| Tests | Medium | CI integration, coverage reporting |
| Health | High | Security vulnerabilities |
| Branding | Low | Badges, homepage, documentation |

**Maintenance Subscore**:
- Commit frequency
- Release cadence
- Issue response time (controversial—incentivizes auto-closing)
- Open issues ratio

**Popularity Subscore**:
- Download counts (12-month moving average)
- Dependents count
- Stars

**Learnings for Claude Skills**:
- ✅ Three-pillar approach (quality, popularity, maintenance) is proven
- ⚠️ Issue response time can be gamed
- ⚠️ Download counts not available for skills (no package manager)

---

### 2.2 Snyk Advisor (Security-Focused)

**Overview**: Provides "health score" for npm packages with security emphasis.

**Key Metrics**:
| Metric | Measurement |
|--------|-------------|
| Popularity | Downloads (12-month MA, excluding weekends) |
| Maintenance | Version cadence, last release within 12 months |
| Security | Vulnerabilities detected, license issues |
| Community | Contributors, responsiveness |

**Learnings for Claude Skills**:
- ✅ Security scanning is table stakes for trust
- ✅ "Last release within 12 months" is a useful maintenance heuristic
- ⚠️ Claude skills don't have "versions" in the npm sense

---

### 2.3 InnerSource Repository Activity Score (SAP)

**Overview**: Ranks internal open-source projects at SAP.

**Algorithm**:
```javascript
// Starting score gives new active repos a chance
let score = 50;

// Engagement signals (weighted)
score += forks * 5;
score += watchers * 3;
score += stars * 2;
score += open_issues * 1;

// Recency boost
const daysSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60 * 24);
if (daysSinceUpdate < 30) score *= 1.2;

// Documentation boost
if (hasContributingGuide) score *= 1.1;
if (hasReadme && readmeLength > 500) score *= 1.05;
```

**Learnings for Claude Skills**:
- ✅ Weighted combination of signals works well
- ✅ Recency boost helps surface actively maintained projects
- ✅ Documentation quality is measurable and valuable
- ⚠️ Single metrics (stars alone) are insufficient

---

### 2.4 VS Code Marketplace

**Overview**: Trust and verification focused, less algorithmic scoring.

**Trust Signals**:
| Signal | How It Works |
|--------|--------------|
| Verified Publisher | Blue checkmark after 6-month good standing |
| Signature Verification | Package integrity checked at install |
| Malware Scanning | Microsoft Defender + antivirus at upload |
| Metrics Monitoring | Detect unusual patterns (gaming) |

**Learnings for Claude Skills**:
- ✅ Publisher verification builds trust
- ✅ Behavioral monitoring catches gaming
- ⚠️ Requires central authority (we can't verify publishers)

---

### 2.5 Academic Research on GitHub Metrics

**Key Finding**: Stars are the most trusted popularity signal (83% of practitioners rate them useful), followed by forks (72%).

**Maintenance Prediction**: ML model achieved 80% precision predicting unmaintained projects using:
- Commit frequency
- Issue activity
- Pull request activity
- Contributor count

**Insight**: 16% of active projects become unmaintained within 1 year.

---

## 3. Available Data Sources

### 3.1 Data Source Inventory

| Source | Data Available | Access Method | Rate Limits | Cost |
|--------|----------------|---------------|-------------|------|
| **GitHub API** | Stars, forks, issues, commits, contributors, license, topics | REST API | 5,000/hr (authenticated) | Free |
| **GitHub Repo** | README content, SKILL.md content, file structure | Git clone or API | N/A | Free |
| **claude-plugins.dev** | Download counts, categories | Scrape | Unknown | Free |
| **SkillsMP.com** | Categories, descriptions | Scrape | Unknown | Free |
| **User Behavior** | Install rate, activation rate, retention | Our plugin telemetry | N/A | Build cost |

### 3.2 GitHub API Data Example

```json
{
  "stars": 3,
  "forks": 1,
  "issues": 0,
  "updated": "2025-12-24T23:32:47Z",
  "created": "2025-12-14T23:42:51Z",
  "license": "MIT",
  "size": 64,
  "language": "TypeScript",
  "topics": ["claude-code", "claude-code-skills", "claude-skills", "linear", "project-management"]
}
```

### 3.3 SKILL.md Metadata

| Field | Required | Max Length | Purpose |
|-------|----------|------------|---------|
| `name` | Yes | 64 chars | Human-readable identifier |
| `description` | Yes | 200 chars | Activation trigger (Claude uses this) |
| `mode` | No | Boolean | Categorizes as "mode command" |

### 3.4 Derivable Signals

| Signal | Derivation | Reliability |
|--------|------------|-------------|
| README quality | Length, sections, badges, examples | Medium |
| SKILL.md quality | Description clarity, instruction depth | High |
| Activation potential | Description specificity score | Medium |
| Test coverage | Presence of test files, CI config | High |
| Documentation depth | README + SKILL.md combined length | Medium |
| Author reputation | Sum of stars across all their skills | Medium |

---

## 4. Candidate Scoring Models

### 4.1 Model A: Weighted Multi-Signal (npms.io Style)

**Philosophy**: Proven approach from package ecosystems.

**Formula**:
```
Final Score = (0.30 × Quality) + (0.35 × Popularity) + (0.35 × Maintenance)
```

**Component Calculations**:

```python
# Quality (0-1)
quality = (
    0.25 * readme_score +          # README length, sections, examples
    0.25 * skillmd_score +         # Description quality, instruction depth
    0.20 * has_license +           # MIT, Apache, etc.
    0.15 * has_tests +             # Test files present
    0.15 * has_examples            # Example usage in docs
)

# Popularity (0-1, normalized)
popularity = normalize(
    0.50 * stars +
    0.30 * forks +
    0.20 * downloads              # If available from marketplace
)

# Maintenance (0-1)
maintenance = (
    0.40 * recency_score +        # Days since last commit
    0.30 * commit_frequency +     # Commits per month
    0.20 * issue_responsiveness + # % issues with response
    0.10 * contributor_count
)
```

**Pros**:
- Proven in production at scale (npm)
- Balanced across multiple dimensions
- Transparent and explainable

**Cons**:
- Requires weight tuning
- May undervalue new skills (cold start)
- Download data not universally available

---

### 4.2 Model B: Bayesian Ranking (Reddit/HN Style)

**Philosophy**: Handle uncertainty from low sample sizes.

**Formula** (Wilson Score):
```python
def wilson_score(positive, total, confidence=0.95):
    """
    Lower bound of Wilson score confidence interval.
    Handles low sample sizes gracefully.
    """
    if total == 0:
        return 0

    z = 1.96  # 95% confidence
    p = positive / total

    denominator = 1 + z**2 / total
    center = p + z**2 / (2 * total)
    spread = z * sqrt((p * (1 - p) + z**2 / (4 * total)) / total)

    return (center - spread) / denominator
```

**Application**:
```python
# Treat stars as "positive votes", potential viewers as "total"
# Estimate potential viewers from repo age and topic popularity
score = wilson_score(
    positive=stars + (forks * 2),  # Forks weighted more
    total=estimated_views
)
```

**Pros**:
- Mathematically handles uncertainty
- New items with few votes don't get unfairly penalized OR boosted
- Self-correcting as data accumulates

**Cons**:
- Requires estimating "total votes" (views)
- Less interpretable to users
- Doesn't capture quality dimensions directly

---

### 4.3 Model C: Tiered Certification (VS Code Style)

**Philosophy**: Discrete quality tiers rather than continuous scores.

**Tiers**:

| Tier | Badge | Criteria |
|------|-------|----------|
| 🥇 **Certified** | Gold | Author verified + 6mo good standing + >100 stars + maintained |
| 🥈 **Trusted** | Silver | License present + >10 stars + updated in 90 days + quality docs |
| 🥉 **Community** | Bronze | Meets minimum SKILL.md spec + public repo |
| ⚠️ **Unverified** | None | Exists but doesn't meet bronze criteria |

**Pros**:
- Simple to understand
- Clear upgrade path for skill authors
- Resistant to gaming (hard thresholds)

**Cons**:
- Coarse granularity (can't rank within tiers)
- Threshold selection is arbitrary
- May be too restrictive for new ecosystem

---

### 4.4 Model D: Contextual Relevance + Quality (Hybrid)

**Philosophy**: Quality matters, but relevance matters more.

**Formula**:
```
Final Score = (0.60 × Relevance) + (0.40 × Quality)
```

**Relevance Score** (from codebase analysis):
```python
relevance = (
    0.40 * semantic_match +        # Description ↔ user intent
    0.30 * tech_stack_match +      # Skill targets user's stack
    0.20 * category_match +        # Skill category fits task
    0.10 * author_affinity         # User has other skills from author
)
```

**Quality Score** (from Model A):
```python
quality = model_a_score  # Reuse the weighted multi-signal approach
```

**Pros**:
- Relevance prevents "best overall" from always winning
- Quality still matters for tie-breaking
- Personalizable per user/project

**Cons**:
- Two models to maintain
- Relevance scoring is harder to validate

---

### 4.5 Model Comparison Matrix

| Criteria | Model A | Model B | Model C | Model D |
|----------|---------|---------|---------|---------|
| Handles cold start | ⚠️ Poor | ✅ Good | ⚠️ Poor | ⚠️ Medium |
| Interpretable | ✅ High | ⚠️ Low | ✅ High | ⚠️ Medium |
| Gaming resistant | ⚠️ Medium | ✅ High | ✅ High | ⚠️ Medium |
| Personalization | ❌ None | ❌ None | ❌ None | ✅ High |
| Implementation complexity | Medium | Low | Low | High |
| Data requirements | High | Medium | Low | High |

---

## 5. Cold Start Strategy

### 5.1 The Problem

New skills have:
- 0 stars, 0 forks, 0 downloads
- No usage history
- Unknown reliability

Without intervention, new skills will never surface, creating a "rich get richer" dynamic.

### 5.2 Solution Approaches

#### Approach A: Exploration Bonus (Multi-Armed Bandit)

```python
def score_with_exploration(base_score, impressions, installs):
    """
    UCB1 algorithm: balance exploitation vs exploration.
    """
    if impressions == 0:
        return float('inf')  # Always try new items once

    exploitation = installs / impressions  # Install rate
    exploration = sqrt(2 * log(total_impressions) / impressions)

    return exploitation + exploration
```

**How it works**: New skills get shown occasionally. If users install them, their score rises. If not, they fade.

#### Approach B: Content-Based Baseline

```python
def cold_start_score(skill):
    """
    Score new skills purely on content quality.
    """
    return (
        0.30 * readme_quality(skill) +
        0.30 * skillmd_quality(skill) +
        0.20 * has_license(skill) +
        0.10 * has_examples(skill) +
        0.10 * author_reputation(skill)  # From their other repos
    )
```

**How it works**: New skills get a baseline score from content analysis. No popularity data needed.

#### Approach C: "New & Noteworthy" Section

Dedicate a UI section to skills published in the last 30 days with minimum quality bar (license, README, proper SKILL.md).

**How it works**: Guaranteed visibility for new skills, separate from main ranking.

### 5.3 Recommended Strategy

**Hybrid approach**:
1. New skills get **content-based baseline score** (Approach B)
2. Show in **"New & Noteworthy"** section for 30 days (Approach C)
3. Apply **exploration bonus** when ranking alongside established skills (Approach A)
4. After 30 days + 100 impressions, transition to full scoring model

---

## 6. Experiment Design

### 6.1 Hypothesis 1: Quality Score Predicts User Satisfaction

**H1**: Skills with higher quality scores will receive more "useful" ratings from users.

**Experiment**:
1. **Setup**: Score 100 skills using Model A
2. **Treatment**: Show skills to users with scores hidden
3. **Measurement**: After install, prompt "Was this skill useful?" (Yes/No)
4. **Analysis**: Correlation between quality score and "Yes" rate

**Success Criteria**: Pearson r > 0.5 between score and usefulness rating

**Sample Size**: 100 skills × 10 installs each = 1,000 data points

---

### 6.2 Hypothesis 2: Multi-Signal Outperforms Single Signal

**H2**: A composite score outperforms GitHub stars alone for predicting user satisfaction.

**Experiment**:
1. **Setup**: For same 100 skills, compute:
   - Stars-only ranking
   - Model A (multi-signal) ranking
2. **Treatment**: A/B test—50% users see stars-only, 50% see Model A
3. **Measurement**: Install rate, usefulness rating, 7-day retention
4. **Analysis**: Compare metrics between groups

**Success Criteria**: Model A group has >10% higher usefulness rating

---

### 6.3 Hypothesis 3: Cold Start Strategy Enables New Skill Discovery

**H3**: Exploration bonus increases install rate for new skills without degrading overall satisfaction.

**Experiment**:
1. **Setup**:
   - Control: New skills ranked by content-only score
   - Treatment: New skills get exploration bonus
2. **Treatment**: A/B test over 4 weeks
3. **Measurement**:
   - Install rate for skills <30 days old
   - Overall user satisfaction (shouldn't decrease)
4. **Analysis**: Compare new skill install rates; monitor satisfaction

**Success Criteria**:
- New skill installs increase >50%
- Overall satisfaction unchanged (within 5%)

---

### 6.4 Hypothesis 4: Contextual Relevance Improves Recommendation Quality

**H4**: Model D (relevance + quality) outperforms Model A (quality only) for user satisfaction.

**Experiment**:
1. **Setup**: Same codebase analyzed, different models generate recommendations
2. **Treatment**: A/B test—Model A vs Model D recommendations
3. **Measurement**:
   - "Was this recommendation relevant?" (Yes/No)
   - Install rate
   - Activation rate (did the skill actually trigger in usage?)
4. **Analysis**: Compare across groups

**Success Criteria**: Model D has >15% higher relevance rating

---

### 6.5 Experiment Rollout Plan

| Phase | Duration | Focus | Success Gate |
|-------|----------|-------|--------------|
| Alpha | 2 weeks | H1 (score validity) | r > 0.4 |
| Beta | 4 weeks | H2, H3 (model comparison, cold start) | Model A > stars by 10% |
| GA Prep | 2 weeks | H4 (contextual relevance) | Model D > Model A by 10% |

---

## 7. Recommendations

### 7.1 Scoring Model Recommendation

**Start with Model A (Weighted Multi-Signal)** because:
- Proven at scale in npm ecosystem
- Interpretable and debuggable
- Can evolve to Model D by adding relevance layer

**Weights for MVP**:
```python
WEIGHTS = {
    'quality': 0.30,
    'popularity': 0.35,
    'maintenance': 0.35
}

QUALITY_WEIGHTS = {
    'readme_score': 0.25,
    'skillmd_score': 0.30,  # Most important for skills
    'has_license': 0.20,
    'has_tests': 0.15,
    'has_examples': 0.10
}

POPULARITY_WEIGHTS = {
    'stars': 0.50,
    'forks': 0.30,
    'downloads': 0.20  # If available
}

MAINTENANCE_WEIGHTS = {
    'recency': 0.50,  # Days since update
    'commit_frequency': 0.30,
    'issue_responsiveness': 0.20
}
```

### 7.2 Cold Start Recommendation

**Implement hybrid approach**:
1. Content-based baseline for all new skills
2. "New & Noteworthy" UI section
3. Exploration bonus using UCB1 algorithm

### 7.3 Data Collection Recommendation

**Phase 1 (MVP)**:
- GitHub API for all metrics
- Scrape download counts from claude-plugins.dev
- Parse SKILL.md for quality signals

**Phase 2 (Post-MVP)**:
- Collect user behavior via plugin telemetry:
  - Impression → Install conversion rate
  - Install → Activation rate
  - Activation → Retention rate
  - Explicit feedback ("Was this useful?")

### 7.4 Anti-Gaming Recommendation

| Gaming Vector | Mitigation |
|---------------|------------|
| Fake stars | Detect abnormal star velocity; weight forks higher |
| Keyword stuffing | Penalize description >200 chars or keyword repetition |
| Self-installs | Require GitHub OAuth; dedupe by user |
| Review bombing | Wilson score handles low sample sizes |

---

## 8. Open Questions

| Question | Owner | Due |
|----------|-------|-----|
| Can we get download counts via API from claude-plugins.dev? | Engineering | Week 1 |
| What's the legal status of scraping marketplace data? | Legal | Week 1 |
| Should we display scores to users or just use for ranking? | Product | Week 2 |
| How do we handle skills with no GitHub repo (private/local)? | Engineering | Week 2 |
| What telemetry consent model do we need? | Legal/Privacy | Week 2 |

---

## 9. Sources

### Package Ecosystem Scoring
- [npms.io Scoring](https://npms.io/about) - npm search ranking algorithm
- [Snyk Advisor](https://snyk.io/advisor) - Package health analysis
- [Increasing npm Search Score](https://itnext.io/increasing-an-npm-packages-search-score-fb557f859300) - Guy Lichtman

### Repository Metrics
- [Repository Activity Score](https://patterns.innersourcecommons.org/p/repository-activity-score) - InnerSource Commons
- [What's in a GitHub Star?](https://homepages.dcc.ufmg.br/~mtov/pub/2018-jss-github-stars.pdf) - Academic research
- [Is This GitHub Project Maintained?](https://www.sciencedirect.com/science/article/abs/pii/S0950584920300240) - ML prediction

### Marketplace Trust
- [Security and Trust in VS Marketplace](https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace) - Microsoft
- [Navigating VS Code Marketplace](https://www.gocodeo.com/post/navigating-vscodes-marketplace-how-to-vet-and-trust-extension-quality) - Extension vetting

### Cold Start Problem
- [Cold Start in Recommender Systems](https://en.wikipedia.org/wiki/Cold_start_(recommender_systems)) - Wikipedia
- [Cold Start Problem Solutions](https://www.expressanalytics.com/blog/cold-start-problem) - Express Analytics
- [Hybrid Recommender Systems](https://www.tredence.com/blog/solving-the-cold-start-problem-in-collaborative-recommender-systems) - Tredence

### Claude Skills
- [SKILL.md Format Specification](https://deepwiki.com/anthropics/skills/2.2-skill.md-format-specification) - DeepWiki
- [Skill Authoring Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) - Anthropic
- [Agent Skills Deep Dive](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/) - Lee Han Chung

---

## Appendix A: Scoring Algorithm Pseudocode

```python
class SkillScorer:
    """
    Production-ready skill scoring implementation.
    """

    def __init__(self):
        self.github = GitHubAPI()
        self.marketplace = MarketplaceScaper()

    def score(self, skill_repo: str) -> dict:
        """
        Compute composite quality score for a skill.

        Returns:
            {
                'final_score': 0.72,
                'quality': 0.85,
                'popularity': 0.45,
                'maintenance': 0.82,
                'tier': 'silver',
                'components': {...}
            }
        """
        # Fetch data
        gh_data = self.github.get_repo(skill_repo)
        skill_md = self.github.get_file(skill_repo, 'SKILL.md')
        readme = self.github.get_file(skill_repo, 'README.md')
        downloads = self.marketplace.get_downloads(skill_repo)

        # Compute subscores
        quality = self._quality_score(skill_md, readme, gh_data)
        popularity = self._popularity_score(gh_data, downloads)
        maintenance = self._maintenance_score(gh_data)

        # Weighted combination
        final = (
            0.30 * quality +
            0.35 * popularity +
            0.35 * maintenance
        )

        return {
            'final_score': final,
            'quality': quality,
            'popularity': popularity,
            'maintenance': maintenance,
            'tier': self._compute_tier(final, gh_data),
            'components': {
                'stars': gh_data['stars'],
                'forks': gh_data['forks'],
                'days_since_update': self._days_since(gh_data['updated']),
                'has_license': bool(gh_data['license']),
                'readme_length': len(readme) if readme else 0,
                'skillmd_quality': self._skillmd_quality(skill_md)
            }
        }

    def _quality_score(self, skill_md, readme, gh_data) -> float:
        return (
            0.25 * self._readme_score(readme) +
            0.30 * self._skillmd_quality(skill_md) +
            0.20 * (1.0 if gh_data['license'] else 0.0) +
            0.15 * self._has_tests(gh_data) +
            0.10 * self._has_examples(readme, skill_md)
        )

    def _popularity_score(self, gh_data, downloads) -> float:
        # Normalize to 0-1 using logarithmic scale
        stars_norm = min(1.0, log10(gh_data['stars'] + 1) / 4)  # 10k stars = 1.0
        forks_norm = min(1.0, log10(gh_data['forks'] + 1) / 3)  # 1k forks = 1.0
        downloads_norm = min(1.0, log10(downloads + 1) / 5) if downloads else 0.5

        return (
            0.50 * stars_norm +
            0.30 * forks_norm +
            0.20 * downloads_norm
        )

    def _maintenance_score(self, gh_data) -> float:
        days_since = self._days_since(gh_data['updated'])

        # Recency: full points if updated in last 30 days, decay after
        if days_since < 30:
            recency = 1.0
        elif days_since < 90:
            recency = 0.8
        elif days_since < 180:
            recency = 0.5
        elif days_since < 365:
            recency = 0.3
        else:
            recency = 0.1

        # Commit frequency (simplified—would need commits API)
        commit_freq = 0.5  # Default to medium

        # Issue responsiveness (simplified)
        issue_resp = 0.5 if gh_data['issues'] < 10 else 0.3

        return (
            0.50 * recency +
            0.30 * commit_freq +
            0.20 * issue_resp
        )

    def _compute_tier(self, score, gh_data) -> str:
        if score > 0.8 and gh_data['stars'] > 100:
            return 'gold'
        elif score > 0.6 and gh_data['stars'] > 10:
            return 'silver'
        elif score > 0.4:
            return 'bronze'
        else:
            return 'unverified'
```

---

## Appendix B: Data Collection Schema

```sql
-- Skills metadata (refreshed daily)
CREATE TABLE skills (
    id UUID PRIMARY KEY,
    repo_url TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    author TEXT,

    -- GitHub metrics
    stars INT,
    forks INT,
    open_issues INT,
    license TEXT,
    language TEXT,
    topics TEXT[],
    created_at TIMESTAMP,
    updated_at TIMESTAMP,

    -- Computed scores
    quality_score FLOAT,
    popularity_score FLOAT,
    maintenance_score FLOAT,
    final_score FLOAT,
    tier TEXT,

    -- Marketplace data
    downloads INT,
    marketplace_category TEXT,

    -- Metadata
    last_scored_at TIMESTAMP,
    created_in_db_at TIMESTAMP DEFAULT NOW()
);

-- User interactions (for learning)
CREATE TABLE skill_interactions (
    id UUID PRIMARY KEY,
    skill_id UUID REFERENCES skills(id),
    user_id UUID,  -- Anonymized

    -- Funnel events
    impression_at TIMESTAMP,
    click_at TIMESTAMP,
    install_at TIMESTAMP,
    activation_at TIMESTAMP,
    uninstall_at TIMESTAMP,

    -- Feedback
    useful_rating BOOLEAN,  -- Was this useful?

    created_at TIMESTAMP DEFAULT NOW()
);

-- Experiment assignments
CREATE TABLE experiment_assignments (
    id UUID PRIMARY KEY,
    user_id UUID,
    experiment_name TEXT,
    variant TEXT,  -- 'control' or 'treatment'
    assigned_at TIMESTAMP DEFAULT NOW()
);
```

---

*Document generated: December 26, 2025*
*Spike duration: 1 week estimated*
