# Distribution Risks and Mitigations

**Parent Document:** [GTM Index](./index.md)
**Last Updated:** December 26, 2025

---

## Overview

This document addresses the Growth Engineer critique that our original distribution strategy was "hope-based." Each risk includes realistic assessment, concrete mitigations, and decision criteria.

---

## 1. Critical Risks

### Risk 1.1: Distribution Void

**Description:** Terminal tools are invisible. No App Store, no marketplace, no organic discovery surface. Every user must be actively acquired.

**Likelihood:** Certain (it's a structural reality)
**Impact:** High (limits growth ceiling)

**Why Previous Strategy Failed:**
> "Hope for Anthropic partnership, awesome list inclusion, community seeding" is not a strategy because all proposed channels are low-volume or uncertain.

**Mitigations:**

| Mitigation | Implementation | Expected Impact |
|------------|----------------|-----------------|
| **Web skill browser** | SEO-optimized static site | Creates discoverable surface |
| **VS Code extension** | Marketplace listing | Built-in discovery via VS Code |
| **Author virality** | Badges, dashboards | Turns every README into channel |
| **Content marketing** | Blog, tutorials | SEO long-tail |

**Decision Criteria:**
- If 6 months post-launch, organic discovery <30% of new users: Invest more in paid/partnership
- If organic >60%: Double down on content and SEO

**Owner:** Growth Lead
**Timeline:** Phase 1-2

---

### Risk 1.2: Activation Chasm

**Description:** 50% skill activation failure rate means half of successful recommendations fail silently. Users blame Discovery Hub for problems outside our control.

**Likelihood:** High (documented in research)
**Impact:** High (destroys trust, drives churn)

**Why This Is Critical:**
> Users will blame Discovery Hub when recommended skills don't work, even if the failure is external.

**Mitigations:**

| Mitigation | Phase | Expected Impact |
|------------|-------|-----------------|
| **Activation auditor** | 3 | Detects 80%+ of addressable failures |
| **Pre-install validation** | 3 | Warns before installing problem skills |
| **Clear failure messaging** | 2 | Sets expectations, explains limitations |
| **Honest limitation docs** | 1 | Builds trust through transparency |

**Decision Criteria:**
- If perceived activation success <55%: Accelerate auditor development
- If <40%: Consider pausing recommendations until auditor ships

**Owner:** Product Lead
**Timeline:** Phase 2-3

---

### Risk 1.3: No Demand Exists

**Description:** The problem we're solving (skill discovery) may not be painful enough to drive behavior change.

**Likelihood:** Medium (validated in some interviews, not broadly)
**Impact:** Fatal (product fails)

**Validation Approach:**
- Phase 0 interviews: 70%+ must express willingness to change behavior
- Phase 1 soft launch: 100+ users must complete search-install flow

**Mitigations:**

| Mitigation | Implementation | Expected Impact |
|------------|----------------|-----------------|
| **Phase 0 validation** | 15 interviews, prototype testing | Proves/disproves demand |
| **Narrow wedge** | If broad demand fails, try CLAUDE.md generator | Smaller but validated market |
| **Pivot options** | Learning platform, quality certification | Alternative products |

**Decision Criteria:**
- If Phase 0: <50% interview interest: Pivot to narrower wedge
- If Phase 1: <50 users despite marketing: Stop or major pivot

**Owner:** Product Lead
**Timeline:** Phase 0-1

---

## 2. High Risks

### Risk 2.1: Cold Start Death Spiral

**Description:** Recommendations need usage data to recommend well, but users need good recommendations to generate usage data. Early users get poor recommendations, churn, and spread negative word-of-mouth.

**Likelihood:** High (inherent to recommendation systems)
**Impact:** High (kills early growth)

**Mitigations:**

| Mitigation | Phase | Implementation |
|------------|-------|----------------|
| **Expert curation** | 1 | First 100 recommendations hand-picked |
| **Beta cohort** | 0 | 50 engaged users provide explicit feedback |
| **Content-based fallback** | 1 | Quality scoring works without usage data |
| **Staged rollout** | 2 | "Smart" recommendations only after data gathered |

**Decision Criteria:**
- If Phase 1 recommendation satisfaction <3/5: Delay ML-based recommendations
- If satisfaction >4/5: Proceed with hybrid approach

**Owner:** Engineering Lead
**Timeline:** Phase 0-2

---

### Risk 2.2: 15-Minute Activation Still Unrealistic

**Description:** Even the revised 15-minute target may be optimistic given multi-step installation and potential failures.

**Likelihood:** Medium (better than 5 min, but unvalidated)
**Impact:** High (user abandonment)

**Mitigations:**

| Mitigation | Implementation | Expected Impact |
|------------|----------------|-----------------|
| **Stopwatch testing** | Phase 0 with 20 users | Validates or invalidates target |
| **Faster first value** | Redefine as "insight" not "activation" | Earlier success moment |
| **Install scripts** | Automate error handling | Reduces install friction |
| **Progress indicators** | Show time remaining | Manages expectations |

**Decision Criteria:**
- If Phase 0 median >20 min: Further simplify or redefine first value
- If <10 min achievable: Use as differentiator

**Owner:** Product Lead
**Timeline:** Phase 0

---

### Risk 2.3: Unrealistic Referral Expectations

**Description:** Original 20% referral target was 4x industry norms. Even revised 5% may be optimistic for CLI tool.

**Likelihood:** Medium (5% is achievable but not guaranteed)
**Impact:** Medium (slower growth, not fatal)

**Industry Benchmarks:**
- Command-line tools: 2-5%
- IDE extensions: 5-10%
- SaaS dev tools: 8-15%
- Exceptional (Notion, Figma): 15-25%

**Mitigations:**

| Mitigation | Implementation | Expected Impact |
|------------|----------------|-----------------|
| **Author virality** | Badges, dashboards | Authors have incentive to promote |
| **Public profiles** | Shareable setups | Social proof virality |
| **Focus on retention** | Skill health checks | Happy users refer naturally |
| **NPS program** | Identify promoters | Activate willing advocates |

**Decision Criteria:**
- If 3 months post-launch referral <2%: Abandon referral focus, invest in paid/content
- If >5%: Scale viral mechanics investment

**Owner:** Growth Lead
**Timeline:** Phase 2-4

---

### Risk 2.4: Maintainer Burnout

**Description:** Estimated 35 hours/week across 3 roles is unsustainable as side project.

**Likelihood:** High (burnout is common in OSS)
**Impact:** Medium (project stalls or degrades)

**Mitigations:**

| Mitigation | Implementation | Expected Impact |
|------------|----------------|-----------------|
| **Scope reduction** | Launch search only, defer recommendations | Reduced initial effort |
| **Automation** | Automated index updates, quality scoring | Reduced ongoing effort |
| **Contributor pipeline** | Good first issues, contributor guide | Distributed maintenance |
| **"Done" definition** | 5 hrs/week maintenance mode | Sustainable floor |

**Decision Criteria:**
- If team capacity <20 hrs/week: Enter maintenance mode
- If >40 hrs/week: Seek funding or partnership

**Owner:** Product Lead
**Timeline:** Ongoing

---

## 3. Medium Risks

### Risk 3.1: Anthropic Platform Risk

**Description:** Anthropic could build competing solution, making Discovery Hub redundant.

**Likelihood:** Medium (they have resources, unclear priority)
**Impact:** High (existential if they do)

**Mitigations:**

| Mitigation | Implementation | Expected Impact |
|------------|----------------|-----------------|
| **Build unique assets** | Learning curriculum, community signals | Can't be easily replicated |
| **Open source core** | Full transparency | More valuable forked than killed |
| **Platform diversification** | Support Cursor, Copilot | Reduce single-platform dependency |
| **Seek partnership** | If traction, propose integration | Become asset not threat |

**Decision Criteria:**
- If Anthropic announces competing solution: Evaluate pivot to learning/certification
- If partnership offered: Evaluate terms carefully

**Owner:** Product Lead
**Timeline:** Ongoing

---

### Risk 3.2: Quality Scoring Gaming

**Description:** Authors could game quality scores to boost rankings.

**Likelihood:** Medium (happens in all rating systems)
**Impact:** Low (degrades trust, not fatal)

**Gaming Vectors:**
- Fake GitHub stars
- Artificially inflated documentation
- Self-referencing maintainer activity

**Mitigations:**

| Mitigation | Implementation | Expected Impact |
|------------|----------------|-----------------|
| **Multi-signal scoring** | Combine many weak signals | Harder to game all at once |
| **Usage-based signals** | Phase 2+ | Real usage hard to fake |
| **Community flagging** | Report suspicious skills | Crowdsourced moderation |
| **Manual review** | Spot-check top-ranked skills | Quality assurance |

**Decision Criteria:**
- If gaming reports >5%: Add manual review layer
- If systematic gaming detected: Redesign affected signals

**Owner:** Engineering Lead
**Timeline:** Phase 2+

---

### Risk 3.3: Learning Platform Scope Creep

**Description:** Learning platform could expand beyond sustainable scope (78 exercises, 40 repos as originally proposed).

**Likelihood:** Medium (addressed in PRD v3, but risk remains)
**Impact:** Medium (dilutes focus, burns resources)

**Current Scope (PRD v3):**
- 1 learning path
- 5 exercises
- 2 test repositories

**Mitigations:**

| Mitigation | Implementation | Expected Impact |
|------------|----------------|-----------------|
| **Strict scope limits** | 1 path, 5 exercises max in Phase 4 | Prevents expansion |
| **Completion metrics** | Must prove 50%+ completion before expanding | Data-driven growth |
| **Separate product option** | If demand, spin off as separate project | Clean separation |

**Decision Criteria:**
- If learning completion <30%: Don't expand
- If >70% completion + demand: Consider expansion post-Phase 4

**Owner:** Product Lead
**Timeline:** Phase 4

---

## 4. Risk Summary Matrix

| Risk | Likelihood | Impact | Mitigation Status | Owner |
|------|------------|--------|-------------------|-------|
| Distribution void | Certain | High | Web + VS Code + author virality | Growth |
| Activation chasm | High | High | Auditor, messaging, transparency | Product |
| No demand exists | Medium | Fatal | Phase 0 validation | Product |
| Cold start spiral | High | High | Curation, beta cohort, staging | Engineering |
| 15-min still unrealistic | Medium | High | Stopwatch testing, redefine value | Product |
| Unrealistic referral | Medium | Medium | Author focus, retention first | Growth |
| Maintainer burnout | High | Medium | Scope reduction, automation | Product |
| Anthropic platform risk | Medium | High | Unique assets, diversification | Product |
| Quality score gaming | Medium | Low | Multi-signal, community flagging | Engineering |
| Learning scope creep | Medium | Medium | Strict limits, metrics gates | Product |

---

## 5. Risk Monitoring

### Weekly Check

| Risk | Indicator to Watch | Alert Threshold |
|------|-------------------|-----------------|
| Distribution void | Organic % of new users | <20% |
| Activation chasm | User-reported activation success | <50% |
| Cold start | Recommendation satisfaction | <3/5 |
| Burnout | Team capacity utilization | >120% |

### Monthly Check

| Risk | Indicator to Watch | Alert Threshold |
|------|-------------------|-----------------|
| Platform risk | Anthropic announcements | Any competing feature |
| Referral | Referral rate | <2% after 3 months |
| Quality gaming | Flagged skills | >5% of top 100 |

### Phase Gate Check

| Risk | Gate Metric | Proceed If |
|------|-------------|------------|
| No demand | Interview interest | >70% |
| Activation | Time to value | <15 min median |
| Cold start | Recommendation quality | 60%+ match expert |

---

## Related Documents

- [Experiments](./experiments.md) - Experiments that validate risk mitigations
- [Strategy Overview](./strategy-overview.md) - Strategic context for risks
- [PRD v3](../prd-v3.md) - Product scope that defines risk surface

---

**Back to:** [GTM Index](./index.md)
