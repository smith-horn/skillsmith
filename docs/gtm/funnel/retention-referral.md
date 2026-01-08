# Funnel Stage: Retention & Referral

**Parent Document:** [Funnel Index](./index.md)
**Last Updated:** December 26, 2025

---

## Definition

**Retention:** User returns and continues to get value from the product.

**Referral:** User recommends the product to others.

These stages are combined because strong retention drives organic referral.

---

## 1. Retention Strategy

### 1.1 The Retention Challenge

From Growth Engineer review:

> "The product is 'pull' not 'push.' Users must remember to engage. There's no notification system, no email, no push mechanism to re-engage dormant users."

**Reality:** CLI tools have low natural retention because they're invisible.

### 1.2 Retention Mechanics

| Mechanic | Description | Effort | Expected Impact |
|----------|-------------|--------|-----------------|
| **Skill health checks** | Automated notifications when skills are outdated | Low | High |
| **Weekly recommendations** | New skills matching their stack | Medium | Medium |
| **Progress tracking** | Learning path completion | Medium | Medium |
| **Usage analytics** | Show users their skill usage | Low | Low |
| **Degradation alerts** | "3 skills haven't been updated in 6 months" | Low | Medium |

### 1.3 Re-engagement Triggers

**Natural triggers (user-initiated):**
- New project started
- Dependency added
- Team member asks for setup

**Designed triggers (product-initiated):**
- Weekly recommendation digest (opt-in)
- "New skill for your stack" notification
- Learning path reminder
- Skill update notification

### 1.4 Skill Health Check (Key Feature)

**Concept:** Automated check that runs periodically and surfaces issues.

**Implementation:**
```
┌─────────────────────────────────────────────────────────────────┐
│                      Skill Health Report                         │
│                      December 26, 2025                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  You have 7 skills installed.                                     │
│                                                                   │
│  Healthy (5):                                                     │
│    frontend-design        v2.1 | Updated 3 days ago              │
│    react-testing          v1.8 | Updated 1 week ago              │
│    systematic-debugging   v1.5 | Updated 2 weeks ago             │
│    ...                                                            │
│                                                                   │
│  Needs attention (2):                                             │
│    old-documentation-tool v0.9 | Not updated in 8 months         │
│      Recommendation: Replace with docs-generator (score: 91)     │
│                                                                   │
│    broken-test-helper     v1.0 | 23% activation rate             │
│      Recommendation: Remove or try test-assistant (score: 87)    │
│                                                                   │
│  [View Full Report]  [Auto-Fix Issues]  [Dismiss]                 │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**Why this works:**
- Creates re-engagement without being spammy
- Provides genuine value (skill hygiene)
- Drives feature usage (recommendations)

---

## 2. Referral Strategy (Updated)

### 2.1 Revised Referral Targets

| Metric | Original Target | Revised Target | Rationale |
|--------|----------------|----------------|-----------|
| Referral rate (Week 8) | 5% | **3%** | Conservative start |
| Referral rate (Month 12) | 20% | **5%** | Realistic for CLI tool |

From Growth Engineer review:

> "20% is exceptionally optimistic for a terminal tool with no visual shareability. Typical developer tool referral rates: Command-line tools: 2-5%"

### 2.2 Viral Mechanics Analysis

| Mechanic | Proposed | Will It Work? | Priority |
|----------|----------|---------------|----------|
| **Recommendation markdown files** | Share recommendation files | **No** - Developers don't share config files | Skip |
| **Learning badges** | Share completion certificates | **Maybe** - Works for LinkedIn | P2 |
| **Setup export** | "Get this setup" links | **Unlikely** - Uncommon behavior | P3 |
| **Public profiles** | See what @username uses | **Yes** - Social proof works | P1 |
| **Author badges** | Quality/download badges for READMEs | **Yes** - Authors have incentive | P0 |
| **Embeddable widgets** | "Powered by Discovery Hub" | **Maybe** - If valuable enough | P2 |

### 2.3 Primary Viral Mechanic: Author Virality

**Why this works:**
- Authors have intrinsic motivation (more downloads = more recognition)
- Every skill README is a potential acquisition channel
- Badges are passive (embed once, work forever)
- Compounds with ecosystem growth

**Implementation:**

```markdown
# My Awesome Skill

![Discovery Hub Score](https://discoveries.dev/badge/score/my-awesome-skill)
![Downloads](https://discoveries.dev/badge/downloads/my-awesome-skill)

This skill helps you...

## Installation

Via Discovery Hub (recommended):
\`\`\`
/discover install my-awesome-skill
\`\`\`

[View on Discovery Hub](https://discoveries.dev/skills/my-awesome-skill)
```

### 2.4 Secondary Viral Mechanic: Public Profiles

**Concept:** Shareable pages showing a user's skill setup.

**URL:** `discoveries.dev/@username`

**Content:**
- Skills installed with usage frequency
- Learning paths completed
- "Recommended stack" curation
- "Clone this setup" button

**Why this works:**
- Social proof (respected developers use these skills)
- Discovery (explore what others use)
- Shareability (link in bio, blog posts)

---

## 3. Retention Metrics

### 3.1 Primary Metrics

| Metric | Definition | Target (Phase 4) |
|--------|------------|------------------|
| Weekly Active Discoverers (WAD) | Users who scanned codebase OR installed skill in past 7 days | 5,000+ |
| 30-day retention | % of Week 1 users active in Week 5 | 40%+ |
| Churn rate | % of WAU lost per month | <15% |

### 3.2 Cohort Analysis Framework

**Weekly cohorts:**
```
Week 1: 100 new users
  Week 2: 60 return (60%)
  Week 3: 45 return (45%)
  Week 4: 35 return (35%)
  Week 8: 25 return (25%)

Target curve:
  Week 2: 60%
  Week 4: 40%
  Week 8: 30%
  Week 12: 25%
```

**Segmentation:**
- By entry point (web vs. VS Code vs. terminal)
- By persona (power user vs. new user)
- By first action (search vs. recommendation)

---

## 4. Referral Metrics

### 4.1 Primary Metrics

| Metric | Definition | Target (Phase 4) |
|--------|------------|------------------|
| Referral rate | % of users who refer at least one new user | 5% |
| Viral coefficient (k) | New users per existing user per month | 0.3 |
| Referral installs | Installs attributed to referral | 500/month |

### 4.2 Tracking Implementation

**Attribution sources:**

| Source | Tracking Method | Attribution |
|--------|----------------|-------------|
| Author badges | Click with referrer | Direct |
| Public profiles | UTM params | Direct |
| Word of mouth | "How did you hear about us?" | Survey |
| Social shares | UTM params | Direct |

**Example tracking:**
```
https://discoveries.dev/skills/frontend-design?
  utm_source=readme_badge&
  utm_medium=github&
  utm_campaign=author_virality&
  ref=anthropics/frontend-design
```

---

## 5. Net Promoter Score (NPS)

### 5.1 NPS Target

| Phase | Target NPS | Measurement Frequency |
|-------|------------|----------------------|
| Phase 2 | Baseline | First survey |
| Phase 3 | 20+ | Quarterly |
| Phase 4 | 40+ | Quarterly |

### 5.2 NPS Survey Implementation

**Trigger:** 30 days after first successful install

**Question:**
"How likely are you to recommend Claude Discovery Hub to a colleague? (0-10)"

**Follow-up by score:**
- Detractors (0-6): "What could we do better?"
- Passives (7-8): "What would make you a 9 or 10?"
- Promoters (9-10): "What do you like most?" + "Would you share with a link?"

### 5.3 NPS Action Framework

| NPS Range | Action |
|-----------|--------|
| <0 | Critical issues. Pause growth, fix experience. |
| 0-20 | Below average. Focus on top detractor feedback. |
| 20-40 | Good. Balanced growth and improvement. |
| 40+ | Excellent. Scale growth confidently. |

---

## 6. Engagement Loops

### 6.1 Daily Loop (Power Users)

```
User codes
    |
    v
Skill activates naturally
    |
    v
User notices skill helped
    |
    v
User checks for new skills occasionally
```

**Design requirement:** Skills should "just work" without daily intervention.

### 6.2 Weekly Loop (Regular Users)

```
User receives weekly digest (opt-in)
    |
    v
Sees new skills matching their stack
    |
    v
Explores one or two
    |
    v
Maybe installs one
```

**Design requirement:** Weekly digest must be genuinely useful, not noise.

### 6.3 Project Loop (All Users)

```
User starts new project
    |
    v
Runs codebase scan
    |
    v
Gets fresh recommendations
    |
    v
Installs relevant skills
```

**Design requirement:** Scan should be fast and produce different results for different projects.

---

## 7. Phase-Specific Retention/Referral Focus

### Phase 1-2 (Weeks 5-12)

**Retention focus:** Establish baseline, identify drop-off points

**Actions:**
- Implement basic analytics
- Run first cohort analysis
- Identify top retention drivers

**Referral focus:** Author badges only

**Actions:**
- Launch badge service
- Email top 50 skill authors
- Track badge adoption

### Phase 3 (Weeks 13-16)

**Retention focus:** Skill health check, activation auditor

**Actions:**
- Launch health check feature
- Measure impact on return rate
- Iterate based on feedback

**Referral focus:** Public profiles

**Actions:**
- Launch profile pages
- Enable "clone setup" feature
- Measure profile view to install conversion

### Phase 4 (Weeks 17-20)

**Retention focus:** Learning paths, community

**Actions:**
- Launch learning path
- Track completion rates
- Build community contribution pipeline

**Referral focus:** Scale what works

**Actions:**
- Double down on highest-performing viral mechanic
- Launch NPS program
- Formalize referral program if k > 0.3

---

## 8. Summary

### Key Retention Levers

1. **Skill health checks** - Creates valuable re-engagement without spam
2. **Learning paths** - Deepens engagement, creates completion motivation
3. **Usage visibility** - Shows users the value they're getting

### Key Referral Levers

1. **Author badges** - Aligned incentives, passive distribution
2. **Public profiles** - Social proof, "clone this" virality
3. **NPS program** - Identifies promoters, asks for action

### Success Metrics

| Metric | Phase 2 | Phase 4 |
|--------|---------|---------|
| 30-day retention | 25% | 40% |
| WAU | 500+ | 5,000+ |
| Referral rate | 3% | 5% |
| NPS | Baseline | 40+ |

---

## Related Documents

- [Metrics](../metrics.md) - Full metrics framework
- [Experiments](../experiments.md) - Retention/referral experiments

---

**Next:** [Metrics](../metrics.md)
