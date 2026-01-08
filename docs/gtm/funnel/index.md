# Growth Funnel Overview

**Parent Document:** [GTM Index](../index.md)
**Last Updated:** December 26, 2025

---

## Funnel Structure

Our growth funnel has four stages, each with specific goals and metrics:

```
┌─────────────────────────────────────────────────────────────────┐
│                          AWARENESS                               │
│  User learns Discovery Hub exists                                │
│  Metrics: Impressions, Website visits, Install command views     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│                          ACTIVATION                              │
│  User gets first value from the product                          │
│  Metrics: Time to value, First scan complete, First install      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│                          RETENTION                               │
│  User returns and uses product regularly                         │
│  Metrics: WAU, 30-day retention, Skills installed                │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│                          REFERRAL                                │
│  User recommends product to others                               │
│  Metrics: Referral rate, NPS, Badge embeds                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Stage Documents

| Stage | Document | Key Focus |
|-------|----------|-----------|
| Awareness | [awareness.md](./awareness.md) | Entry points, first impressions, discovery surfaces |
| Activation | [activation.md](./activation.md) | Time-to-value, onboarding, first success |
| Retention + Referral | [retention-referral.md](./retention-referral.md) | Engagement loops, viral mechanics |

---

## Critical Path Analysis

From Growth Engineer review, the actual critical path for new users:

```
Step 1: Learn about Discovery Hub
        Drop-off: ~70% (awareness to attempt)
                    |
                    v
Step 2: Run MCP installation command
        Time: 2-5 minutes
        Drop-off: ~20% (config issues, permission errors)
                    |
                    v
Step 3: Initial sync of skill index
        Time: 1-3 minutes
        Drop-off: ~10% (slow connection, timeout)
                    |
                    v
Step 4: First codebase scan
        Time: 2-5 minutes
        Drop-off: ~15% (scan errors, no recommendations)
                    |
                    v
Step 5: Receive recommendation
        Time: Instant
        Drop-off: ~30% (recommendations don't match needs)
                    |
                    v
Step 6: Install recommended skill
        Time: 1-2 minutes
        Drop-off: ~10% (installation errors)
                    |
                    v
Step 7: Skill activates successfully
        Time: Variable
        Drop-off: ~50% (documented activation failure rate)

TOTAL TIME: 8-17 minutes (optimistic path)
CUMULATIVE DROP-OFF: 73% never reach full value
```

---

## Funnel Optimization Priorities

### Phase 1-2 Focus: Reduce Activation Drop-off

| Step | Current Drop-off | Target | Intervention |
|------|-----------------|--------|--------------|
| Install | 20% | 10% | Better docs, install scripts |
| Sync | 10% | 5% | Progress indicator, timeout handling |
| Scan | 15% | 10% | Graceful degradation, partial results |
| Recommendation relevance | 30% | 20% | Better matching, multiple options |
| Skill install | 10% | 5% | Streamlined command generation |
| Activation | 50% | 35% | Activation auditor (Phase 3) |

### Phase 3-4 Focus: Improve Retention + Referral

| Metric | Current (Est.) | Target | Intervention |
|--------|---------------|--------|--------------|
| 30-day retention | 20% | 40% | Regular value delivery |
| Referral rate | 2% | 5% | Author virality tools |
| NPS | Unknown | >40 | Delightful experience |

---

## Key Metrics Summary

| Stage | Primary Metric | Secondary Metrics |
|-------|---------------|-------------------|
| Awareness | Monthly unique visitors | Traffic sources, bounce rate |
| Activation | Time to first value (<15 min) | Install success rate, scan completion |
| Retention | Weekly Active Discoverers | 30-day retention, skills installed |
| Referral | Referral rate (5% target) | NPS, badge embeds, social shares |

---

## Related Documents

- [Awareness](./awareness.md) - First touch optimization
- [Activation](./activation.md) - Time-to-value acceleration
- [Retention & Referral](./retention-referral.md) - Engagement and growth loops

---

**Next:** [Awareness](./awareness.md)
