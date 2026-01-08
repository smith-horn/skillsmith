# Success Metrics

**Parent Document:** [GTM Index](./index.md)
**Last Updated:** December 26, 2025

---

## 1. Metrics Philosophy

### 1.1 Principles

1. **Behavior over stated preference** - Track what users do, not what they say
2. **Actionable over vanity** - Every metric should suggest an action
3. **Leading over lagging** - Prioritize metrics that predict future success
4. **Honest over flattering** - Track failures as rigorously as successes

### 1.2 Metrics Hierarchy

```
                    NORTH STAR
                  Weekly Active
                   Discoverers
                       |
         +-------------+-------------+
         |             |             |
      LEADING       LAGGING        HEALTH
    (predict)      (confirm)      (monitor)
         |             |             |
  - Activation    - Retention     - Error rates
  - Relevance     - NPS           - Time to value
  - Return rate   - Growth rate   - Support volume
```

---

## 2. North Star Metric

### 2.1 Definition: Weekly Active Discoverers (WAD)

**Definition:** Unique users who performed a discovery action in the past 7 days.

**Discovery actions:**
- Ran codebase scan (`/discover recommend`)
- Installed a skill via Discovery Hub
- Completed a learning exercise
- Viewed skill details in web browser or VS Code

**Why this metric:**
- Captures ongoing engagement, not just installs
- Indicates product is providing repeated value
- Correlates with retention and referral

### 2.2 WAD Targets by Phase

| Phase | Timeline | WAD Target | Rationale |
|-------|----------|------------|-----------|
| Phase 0 | Weeks 1-4 | N/A | Pre-launch validation |
| Phase 1 | Weeks 5-8 | 50-100 | Soft launch, early adopters |
| Phase 2 | Weeks 9-12 | 500+ | Growth launch, multi-channel |
| Phase 3 | Weeks 13-16 | 1,500+ | Feature differentiation |
| Phase 4 | Weeks 17-20 | 5,000+ | Community scale |

### 2.3 WAD Calculation

```sql
SELECT COUNT(DISTINCT user_id) as WAD
FROM events
WHERE event_type IN (
    'codebase_scan',
    'skill_install',
    'exercise_complete',
    'skill_detail_view'
)
AND timestamp >= NOW() - INTERVAL '7 days'
```

---

## 3. Phase-Specific Metrics

### 3.1 Phase 0: Validation Sprint (Weeks 1-4)

| Metric | Target | Measurement | Gate Criteria |
|--------|--------|-------------|---------------|
| User interviews completed | 15+ | Count | Must pass |
| Willingness to change behavior | 70%+ | Interview coding | Must pass |
| Median time-to-value | <15 min | Stopwatch testing | Must pass |
| Manual recommendation quality | 60%+ match expert | Comparison study | Must pass |
| Beta users committed | 50+ | Sign-ups | Must pass |

**Gate Decision:** Proceed to Phase 1 only if ALL criteria pass.

### 3.2 Phase 1: Foundation + Safety (Weeks 5-8)

| Metric | Target | Measurement |
|--------|--------|-------------|
| Skills indexed | 25,000+ | Database count |
| Search success rate | 80%+ | User testing |
| Quality score accuracy | 75%+ | Calibration study |
| Safety scan coverage | 100% | Pipeline completion |
| Install success rate | 80%+ | Error tracking |
| Successful users | 100+ | Funnel completion |

**Key Question:** Can users successfully search and install skills?

### 3.3 Phase 2: Recommendations + Entry Points (Weeks 9-12)

| Metric | Target | Measurement |
|--------|--------|-------------|
| WAD | 500+ | Analytics |
| Stack detection accuracy | 85%+ | Test project validation |
| Recommendation install rate | 30%+ | Funnel tracking |
| Time to first recommendation | <10 min | Instrumentation |
| Web browser monthly visitors | 5,000+ | Analytics |
| VS Code extension installs | 1,000+ | Marketplace stats |
| Author badge adoptions | 100+ | Badge renders |

**Key Question:** Do recommendations drive installs? Do new entry points drive growth?

### 3.4 Phase 3: Activation Auditor (Weeks 13-16)

| Metric | Target | Measurement |
|--------|--------|-------------|
| WAD | 1,500+ | Analytics |
| Auditor usage rate | 50%+ | Funnel tracking |
| Perceived activation improvement | 25%+ | User survey |
| Auto-fix success rate | 70%+ | Automated testing |
| Issues detected | 80%+ of addressable | Test suite |
| User satisfaction (diagnostics) | 3.5/5+ | Feature survey |

**Key Question:** Does the activation auditor meaningfully improve user experience?

### 3.5 Phase 4: Learning + Scale (Weeks 17-20)

| Metric | Target | Measurement |
|--------|--------|-------------|
| WAD | 5,000+ | Analytics |
| Learning path start rate | 30%+ | Progress tracking |
| Learning path completion rate | 50%+ of starters | Progress tracking |
| Public profiles created | 500+ | Database count |
| Community skill submissions | 25+/month | Contribution tracking |
| NPS | >40 | Survey |
| 30-day retention | 40%+ | Cohort analysis |
| Referral rate | 5%+ | Attribution tracking |

**Key Question:** Is the product creating a self-sustaining community?

---

## 4. Supporting Metrics Framework

### 4.1 Leading Indicators (Predict Future WAD)

| Metric | Definition | Why It Leads |
|--------|------------|--------------|
| **First-week activation rate** | % of new users who scan codebase in first 7 days | Predicts retention |
| **Recommendation relevance score** | User rating of recommendation quality | Predicts install rate |
| **Return rate** | % who come back after first session | Predicts WAD |
| **Skill install rate** | % of recommendation views that install | Predicts engagement depth |

### 4.2 Lagging Indicators (Confirm Success)

| Metric | Definition | Why It Lags |
|--------|------------|-------------|
| **30-day retention** | % of cohort active 30 days after first use | Confirms value |
| **NPS** | Net Promoter Score | Confirms satisfaction |
| **Organic growth rate** | Month-over-month WAD growth (excluding launches) | Confirms product-market fit |
| **Referral attribution** | % of new users from referrals | Confirms word-of-mouth |

### 4.3 Health Indicators (Watch for Problems)

| Metric | Healthy Range | Alert Threshold |
|--------|---------------|-----------------|
| **Install error rate** | <10% | >20% |
| **Scan timeout rate** | <5% | >10% |
| **Time to first value** | <15 min | >25 min |
| **Support ticket volume** | <10/week | >30/week |
| **Skill activation failure rate** | <40% | >50% |
| **Negative reviews** | <10% | >25% |

---

## 5. Metrics Critique (Growth Engineer Feedback)

### 5.1 Revised Metrics

| Original Metric | Problem | Revised Metric |
|-----------------|---------|----------------|
| Total installs | Vanity metric | **Active installs** (used in past 30 days) |
| Skills indexed | More isn't better | **Verified skills** (meeting quality threshold) |
| Recommendation accept rate | Acceptance doesn't mean value | **Recommendation activation rate** (accepted + activated) |
| Referral rate (20%) | Unmeasurable, unrealistic | **Referral installs** (trackable via UTM) at 5% |
| Exercises completed | Assumes curriculum popularity | **Learning path completion rate** (% who start and finish) |

### 5.2 New Metrics Added

| Metric | Definition | Rationale |
|--------|------------|-----------|
| **Cumulative drop-off** | % lost at each funnel stage | Identifies leaky bucket |
| **Activation rate** | % reaching first value | Better than time-to-value alone |
| **Channel efficiency** | Users acquired / effort invested | Prioritizes channels |
| **Author engagement** | Badge embeds, dashboard visits | Drives viral loop |

---

## 6. Measurement Implementation

### 6.1 Analytics Stack

**Recommended:**
- **Event tracking:** Plausible Analytics (privacy-focused) or PostHog
- **Funnel analysis:** Custom dashboard or PostHog
- **Cohort analysis:** Spreadsheet or custom script
- **User surveys:** Typeform or in-product modal

**Privacy considerations:**
- Opt-in telemetry only
- No PII collection
- Local-first where possible
- Clear data usage policy

### 6.2 Event Schema

```typescript
interface Event {
  event_type: string;       // e.g., 'skill_install', 'codebase_scan'
  timestamp: string;        // ISO 8601
  user_id: string;          // Anonymous hash
  session_id: string;       // Session identifier
  properties: {
    source?: string;        // Entry point (terminal, web, vscode)
    skill_id?: string;      // If applicable
    duration_ms?: number;   // Time taken
    success?: boolean;      // Outcome
    error_code?: string;    // If failed
    utm_source?: string;    // Attribution
    utm_medium?: string;
    utm_campaign?: string;
  }
}
```

### 6.3 Key Events to Track

| Event | Properties | Funnel Stage |
|-------|------------|--------------|
| `page_view` | source, path | Awareness |
| `install_started` | source | Activation |
| `install_completed` | duration_ms, success | Activation |
| `codebase_scan` | duration_ms, files_scanned, success | Activation |
| `recommendation_shown` | skill_id, score, rank | Activation |
| `skill_install` | skill_id, source | Activation/Retention |
| `skill_activated` | skill_id, success | Retention |
| `exercise_started` | exercise_id | Retention |
| `exercise_completed` | exercise_id, duration_ms | Retention |
| `profile_viewed` | username, viewer_source | Referral |
| `badge_clicked` | skill_id, referrer | Referral |

---

## 7. Reporting Cadence

### 7.1 Daily (Automated)

- WAD count
- Install error rate
- Critical error alerts

### 7.2 Weekly (Manual Review)

- Funnel conversion rates
- Channel performance
- Top user feedback themes
- Week-over-week WAD growth

### 7.3 Monthly (Comprehensive)

- Cohort retention analysis
- NPS results (if surveyed)
- Channel ROI analysis
- Metric trends and forecasts

### 7.4 Per-Phase (Gate Reviews)

- All gate criteria metrics
- Go/no-go recommendation
- Key learnings and adjustments

---

## 8. Dashboard Template

### 8.1 North Star Dashboard

```
┌────────────────────────────────────────────────────────────────┐
│                    WEEKLY ACTIVE DISCOVERERS                    │
│                                                                  │
│     Current: 523 (+12% WoW)          Target: 500               │
│                                                                  │
│     [=============>                    ] 104% of target         │
│                                                                  │
│     Trend: ▲ Growing                                            │
└────────────────────────────────────────────────────────────────┘

┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│    ACTIVATION    │ │    RETENTION     │ │    REFERRAL      │
│                  │ │                  │ │                  │
│    First Value   │ │   30-Day Return  │ │   Referral Rate  │
│      47%         │ │      32%         │ │       4.1%       │
│    Target: 45%   │ │    Target: 40%   │ │    Target: 5%    │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

### 8.2 Funnel Dashboard

```
AWARENESS  -->  ACTIVATION  -->  RETENTION  -->  REFERRAL
   |               |                |               |
  5,000          523              167              21
 visitors        WAD          30d active      referrals
   |               |                |               |
  10.5%          32%             12.5%
 convert       retain           refer
```

---

## Related Documents

- [Experiments](./experiments.md) - Experiments to validate metrics
- [Funnel: Activation](./funnel/activation.md) - Activation metric deep dive
- [Funnel: Retention](./funnel/retention-referral.md) - Retention metric deep dive

---

**Next:** [Experiments](./experiments.md)
