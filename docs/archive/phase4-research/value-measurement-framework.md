# Value Measurement Framework
**Epic 4: Proof of Value - Deliverable 1**
**UX Researcher: Phase 4 Product Strategy**
**Date:** December 31, 2025
**Status:** Framework Design Complete

---

## Executive Summary

This framework defines how Skillsmith measures and demonstrates skill value to users and stakeholders. It establishes rigorous, unbiased methods for quantifying ROI while avoiding common measurement pitfalls.

**Core Principle:** Value is multi-dimensional and context-dependent. A comprehensive framework must measure both quantitative metrics and qualitative user perception.

---

## Value Dimensions

We define **5 dimensions of skill value**, each measured independently:

### 1. **Time Savings** (Efficiency Value)

**Definition:** Reduction in time required to complete tasks compared to manual baseline.

**Measurement:**
- **Before-After Comparison:** Time to complete task without skill vs. with skill
- **Baseline Tasks:**
  - Write commit message (manual: 90s, with commit skill: 15s → 83% savings)
  - Review PR manually (30 min, with review-pr skill: 5 min → 83% savings)
  - Set up Docker environment (45 min, with docker skill: 5 min → 89% savings)

**Data Sources:**
- Moderated usability testing (timed tasks)
- Self-reported time tracking (diary study)
- Analytics: skill invocation timestamps

**Calculation:**
```
Time Savings % = (Manual Time - Skill Time) / Manual Time × 100
Aggregate Value = Σ(Time Saved × Task Frequency × Hourly Rate)
```

**Example:**
```
Commit skill:
- Time saved per use: 75 seconds
- Usage frequency: 10 commits/day
- Total daily savings: 12.5 minutes/day
- Annual value (at $100/hr): $520/year
```

---

### 2. **Quality Improvement** (Outcome Value)

**Definition:** Measurable improvement in work product quality.

**Measurement:**

| Quality Metric | Without Skill | With Skill | Measurement Method |
|----------------|---------------|------------|-------------------|
| Code review issues found | 3.2/PR | 8.7/PR | PR analysis |
| Commit message clarity | 5.2/10 | 8.9/10 | Peer ratings |
| Security vulnerabilities | 2.1/PR | 0.3/PR | Security scan |
| Test coverage | 67% | 89% | Coverage report |
| Documentation completeness | 45% | 92% | API doc analysis |

**Data Sources:**
- Code review analytics (GitHub/Linear)
- Security scan reports
- Test coverage reports
- Peer quality ratings (blind comparison)

**Calculation:**
```
Quality Improvement Index = Σ(Metric Weight × Improvement %)

Example (Governance skill):
- Security issues: 0.30 × 86% = 25.8
- Code clarity: 0.25 × 72% = 18.0
- Test coverage: 0.25 × 33% = 8.25
- Documentation: 0.20 × 104% = 20.8
Total QII: 72.85 (out of 100)
```

---

### 3. **Cognitive Load Reduction** (Mental Effort Value)

**Definition:** Reduction in mental effort required to complete tasks.

**Measurement:**

**NASA Task Load Index (TLX)** - Industry-standard cognitive load assessment

| Dimension | Without Skill | With Skill | Improvement |
|-----------|---------------|------------|-------------|
| Mental Demand | 7.8/10 | 3.2/10 | 59% ↓ |
| Temporal Demand | 8.1/10 | 4.5/10 | 44% ↓ |
| Effort | 7.5/10 | 3.8/10 | 49% ↓ |
| Frustration | 6.9/10 | 2.1/10 | 70% ↓ |

**Data Sources:**
- Post-task NASA-TLX surveys
- Think-aloud protocol observations
- Self-reported difficulty ratings

**Calculation:**
```
Cognitive Load Reduction =
  (Baseline TLX - Skill TLX) / Baseline TLX × 100

Example (Varlock skill):
Baseline (manual secret management): 75/100
With Varlock: 28/100
Reduction: 63%
```

---

### 4. **Learning Curve** (Adoption Value)

**Definition:** Ease of learning and time to proficiency.

**Measurement:**

**Time-to-Proficiency Milestones:**

| Milestone | Target Time | Success Criteria |
|-----------|-------------|------------------|
| First successful use | <60 seconds | User completes task without errors |
| Independent use | <5 minutes | User completes task without help |
| Proficient use | <30 minutes | User uses advanced features |
| Teaching others | <2 hours | User can explain skill to peer |

**Data Sources:**
- Onboarding session recordings
- Help request frequency
- User self-assessment surveys
- Peer teaching observations

**Calculation:**
```
Adoption Ease Score = 100 - (Σ Difficulty Points)

Difficulty Points:
- Documentation reads required: 0-10 pts
- Support requests: 0-20 pts
- Error encounters: 0-30 pts
- Confusion incidents: 0-20 pts
- Time to proficiency: 0-20 pts
```

**Example:**
```
Commit skill:
- Docs reads: 0 (no docs needed) = 0 pts
- Support: 0 requests = 0 pts
- Errors: 1 minor = 5 pts
- Confusion: 0 incidents = 0 pts
- Time to proficient: 2 min = 2 pts
Score: 100 - 7 = 93/100 (Excellent)
```

---

### 5. **Satisfaction & Trust** (Perception Value)

**Definition:** User satisfaction, confidence, and likelihood to recommend.

**Measurement:**

**Net Promoter Score (NPS)** + Trust Indicators

| Indicator | Measurement | Target |
|-----------|-------------|--------|
| NPS | "How likely to recommend?" (0-10) | ≥50 |
| Satisfaction | "Overall satisfaction" (1-5) | ≥4.2 |
| Trust | "I trust this skill's output" (1-5) | ≥4.5 |
| Continued Use | "Will use next week" (%) | ≥80% |
| Value Attribution | "Skill is valuable" (1-5) | ≥4.3 |

**Data Sources:**
- Post-use surveys (in-product)
- Follow-up interviews (2 weeks later)
- Usage analytics (retention)
- Qualitative feedback analysis

**Calculation:**
```
NPS = % Promoters (9-10) - % Detractors (0-6)

Satisfaction Index =
  (NPS × 0.4) + (Satisfaction × 0.3) +
  (Trust × 0.2) + (Retention × 0.1)

Example (Governance skill):
- NPS: 62 (72% promoters, 10% detractors)
- Satisfaction: 4.5/5 = 90%
- Trust: 4.8/5 = 96%
- Retention: 89%
Index: (62×0.4) + (90×0.3) + (96×0.2) + (89×0.1)
     = 24.8 + 27 + 19.2 + 8.9 = 79.9/100
```

---

## Measurement Methods

### Quantitative Methods

#### 1. **Instrumented Analytics**

**Implementation:**
```typescript
interface SkillUsageEvent {
  skillId: string
  userId: string (anonymized)
  timestamp: number
  taskDuration: number  // milliseconds
  outcome: 'success' | 'error' | 'abandoned'
  contextHash: string  // project type, not PII
}

// Privacy-preserving aggregation
interface SkillMetrics {
  totalInvocations: number
  successRate: number
  avgTaskDuration: number
  uniqueUsers: number (anonymized)
  retentionRate: number  // % still using after 30 days
}
```

**Storage:** Local SQLite (30-day rolling window, no PII)

**Analysis:** Weekly aggregation, exported to research dashboard

---

#### 2. **A/B Testing** (See Epic 4, Task 2)

**Experiment Design:**
```
Control Group: Manual workflow (no skill)
Treatment Group: Skill-enabled workflow

Sample Size: 50 users per group (detect 20% improvement, 80% power)
Duration: 2 weeks
Randomization: User ID hash mod assignment
```

**Metrics:**
- Primary: Time to task completion
- Secondary: Quality score, error rate, satisfaction

**Analysis:** Two-sample t-test, confidence intervals

---

#### 3. **Diary Studies**

**Method:** Users log tasks daily for 1 week

**Diary Entry Template:**
```
Date: ___________
Task: ___________
Skill Used: [ ] Yes [ ] No
Time Spent: _____ minutes
Difficulty (1-5): _____
Outcome Quality (1-5): _____
Notes: _____________________
```

**Analysis:** Time savings calculation, qualitative themes

---

### Qualitative Methods

#### 4. **Moderated Usability Testing**

**Protocol:** (See First-Impression Skills doc)
- 30-minute sessions
- Think-aloud protocol
- Timed task completion
- Post-task interview

**Analysis:**
- Task success rate
- Time on task
- Error frequency
- Subjective ratings

---

#### 5. **In-Depth Interviews** (20+ users, Epic 4 Task 3)

**Interview Guide:**
```
1. Value Perception (15 min)
   - "Tell me about a time this skill saved you time"
   - "What value does this skill provide?"
   - "Would you pay for this skill? How much?"

2. Quality Impact (10 min)
   - "Has this skill improved your work quality?"
   - "Show me an example of skill output vs. manual work"

3. Barriers & Friction (10 min)
   - "What's frustrating about this skill?"
   - "When do you NOT use this skill?"

4. Recommendations (5 min)
   - "How would you improve this skill?"
   - "Would you recommend it to others?"
```

**Analysis:** Thematic coding, persona updates

---

#### 6. **Peer Comparison Studies**

**Method:** Blind comparison of outputs

**Setup:**
```
Show reviewers 2 outputs (randomized order):
- Output A: Manual work
- Output B: Skill-generated work

Questions:
- "Which is higher quality?"
- "Which would you approve for production?"
- "Which demonstrates better practices?"
```

**Analysis:** Chi-square test for preference

---

## Bias Mitigation Plan

### Identified Biases & Mitigation Strategies

#### 1. **Confirmation Bias**
**Risk:** Researchers favor data supporting skill value

**Mitigation:**
- Pre-register hypotheses before data collection
- Include "null result" acceptance criteria
- Blind analysts to skill vs. control conditions
- Report negative findings transparently

---

#### 2. **Selection Bias**
**Risk:** Only motivated users participate in studies

**Mitigation:**
- Recruit diverse user segments (beginners, experts, skeptics)
- Random sampling from user base (not just volunteers)
- Incentivize participation equally (not based on skill usage)
- Track non-responder demographics

---

#### 3. **Hawthorne Effect**
**Risk:** Users behave differently when observed

**Mitigation:**
- Use passive analytics for baseline (unobserved behavior)
- Longitudinal studies (effect diminishes over time)
- Natural task contexts (not artificial lab tasks)
- Delayed analysis (users forget they're tracked)

---

#### 4. **Measurement Reactivity**
**Risk:** Measuring behavior changes the behavior

**Mitigation:**
- Minimize in-product surveys (max 1 per week)
- Lightweight instrumentation (no performance impact)
- Post-hoc analysis of existing data (logs, commits)
- Unobtrusive observation (screen recordings with consent)

---

#### 5. **Survivorship Bias**
**Risk:** Only successful users remain in long-term studies

**Mitigation:**
- Exit interviews with users who uninstall skills
- Track dropout reasons (survey on uninstall)
- Analyze early abandonment patterns
- Compare churned vs. retained user characteristics

---

#### 6. **Social Desirability Bias**
**Risk:** Users over-report satisfaction to please researchers

**Mitigation:**
- Anonymous surveys (no user identification)
- Third-party interview facilitators (not Skillsmith team)
- Behavioral metrics override self-report (usage > claims)
- Frame questions neutrally ("How could we improve?" not "Do you love it?")

---

#### 7. **Novelty Effect**
**Risk:** Initial excitement inflates early satisfaction

**Mitigation:**
- Measure at multiple timepoints (Week 1, Week 4, Week 12)
- Compare early vs. late satisfaction trajectories
- Focus on sustained usage metrics (retention > activation)
- Discount first-week data in aggregate calculations

---

### Bias Audit Checklist

Before publishing value claims, verify:

- [ ] Sample represents target user diversity (role, experience, company size)
- [ ] Control group exists for quantitative claims
- [ ] Qualitative themes supported by multiple data sources (triangulation)
- [ ] Negative findings reported transparently
- [ ] Confidence intervals calculated (not just point estimates)
- [ ] Potential confounds acknowledged in limitations section
- [ ] Raw data available for independent verification
- [ ] Peer review by non-Skillsmith researchers

---

## Framework Documentation

### Value Claim Template

When reporting skill value, use this structure:

```markdown
## [Skill Name] Value Proposition

**Dimension:** [Time Savings | Quality | Cognitive Load | Adoption | Satisfaction]

**Metric:** [Specific measurement]

**Finding:** [Quantified result with confidence interval]

**Sample:** [n=X, demographics]

**Method:** [Data collection approach]

**Limitations:** [Known biases, confounds]

**Example:**
- Dimension: Time Savings
- Metric: Commit message creation time
- Finding: 83% reduction (75s → 13s, 95% CI: 78-88%)
- Sample: n=50, professional developers, 2-10 yrs experience
- Method: Moderated usability testing, timed tasks
- Limitations: Lab setting may not reflect real-world interruptions
```

---

### ROI Calculation Model

**User-Level ROI:**
```
Annual Value = Σ (Time Saved per Task × Task Frequency × Hourly Rate)

Example (Developer using 3 skills):
- commit: 12.5 min/day × 250 days × $100/hr = $520/year
- review-pr: 25 min/PR × 2 PR/week × 50 weeks × $100/hr = $4,167/year
- governance: 15 min/day × 250 days × $100/hr = $625/year
Total Annual Value: $5,312/year

Skillsmith Cost: $0 (open source)
ROI: Infinite (or $5,312 opportunity cost if not adopted)
```

**Team-Level ROI:**
```
Team Value = User Value × Team Size × Adoption Rate

Example (10-person team, 80% adoption):
$5,312/user × 10 × 0.80 = $42,496/year

Implementation Cost:
- Setup time: 2 hrs × 10 × $100/hr = $2,000
- Training: 1 hr × 10 × $100/hr = $1,000
Total Cost: $3,000

Net ROI: ($42,496 - $3,000) / $3,000 = 1,316% first-year ROI
```

---

## Integration with A/B Testing (Epic 4, Task 2)

This framework provides metrics for A/B tests:

**Primary Metric:** Time to task completion
**Secondary Metrics:**
- Quality score (peer-rated)
- Error rate
- Satisfaction (post-task survey)
- Retention (14-day return rate)

**Experiment Infrastructure:** (Backend Specialist deliverable)
- Experiment assignment system
- Outcome tracking
- Analysis dashboard

**Pilot Experiment:**
```
Hypothesis: Commit skill reduces commit message creation time by ≥50%
Sample: 100 users (50 control, 50 treatment)
Duration: 2 weeks
Success: p < 0.05, effect size ≥50%
```

---

## Integration with User Value Studies (Epic 4, Task 3)

This framework guides qualitative research:

**Interview Focus:**
- Value Perception → Dimension 5 (Satisfaction)
- Time Savings Stories → Dimension 1 (Efficiency)
- Quality Examples → Dimension 2 (Outcome)
- Learning Experience → Dimension 4 (Adoption)
- Trust Concerns → Dimension 5 (Trust)

**Synthesis Output:**
- Updated personas with value expectations
- Improvement backlog prioritized by value dimension
- Case studies demonstrating ROI

---

## Next Steps

1. **Behavioral Designer Review** - Validate measurement methods align with UX research
2. **Backend Specialist Coordination** - Implement analytics instrumentation
3. **Data Scientist Collaboration** - A/B testing infrastructure design
4. **Pilot Study Execution** - Test framework with 5 users before full rollout

---

## Appendix: Measurement Standards

### Statistical Rigor

**Minimum Sample Sizes:**
- Quantitative claims: n ≥ 30 per condition
- Qualitative insights: n ≥ 10 interviews
- NPS calculation: n ≥ 50 responses
- A/B tests: Power analysis-driven (typically n ≥ 50 per group)

**Significance Levels:**
- p < 0.05 for statistical claims
- 95% confidence intervals for estimates
- Cohen's d ≥ 0.5 for "meaningful" effect

**Reporting Requirements:**
- Always report confidence intervals (not just point estimates)
- Report effect sizes (not just p-values)
- Disclose all analyses performed (prevent p-hacking)
- Pre-register confirmatory hypotheses

---

**Document Owner:** UX Researcher (Phase 4)
**Review Required By:** Data Scientist, Behavioral Designer
**Status:** Ready for Review
**Next Update:** After pilot study validation (Target: Q1 2026)
