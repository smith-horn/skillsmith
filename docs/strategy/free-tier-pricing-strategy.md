# Free Tier Pricing Strategy

> **Status:** Proposed
> **Last Updated:** 2026-01-11
> **Context:** Post-API launch cost protection with accessibility focus

## Executive Summary

Skillsmith has deployed a live API using Supabase, PostHog, and Vercel. This document analyzes cost triggers and proposes three pricing tier strategies that balance accessibility for 100k users with protection against power user abuse.

## Current Infrastructure Cost Triggers

### 1. Supabase (Primary Cost Driver)

**Free Tier Limits:**
- Database: 500 MB storage
- Edge Functions: 500k invocations/month (~16k per day)
- Bandwidth: 5 GB/month
- Database queries: Unlimited (soft limit ~2M/month)

**Paid Triggers:**
- Pro Plan: $25/month (first overage)
- Team Plan: $599/month (for scale)
- Enterprise: Custom pricing

**Critical Thresholds:**
- 500k Edge Function calls = ~5 calls per user (100k users)
- 5 GB bandwidth = ~50 KB per user (100k users)

### 2. PostHog (Telemetry)

**Free Tier Limits:**
- 1M events/month
- 1M feature flag requests/month
- Unlimited data retention

**Paid Triggers:**
- $0.00031 per event after 1M
- $0.0001 per feature flag check after 1M

**Critical Thresholds:**
- 1M events = 10 events per user (100k users)
- Risk: Power user with 1000s of searches could trigger overage alone

### 3. Vercel (API Proxy)

**Free Tier Limits:**
- 100 GB bandwidth/month
- Unlimited serverless function executions

**Paid Triggers:**
- Pro: $20/month (first overage)
- Bandwidth overage: $40/TB

**Current Risk:** Very low (proxy is lightweight)

### 4. Upstash Redis (Rate Limiting)

**Free Tier Limits:**
- 10,000 requests/day
- 256 MB storage

**Paid Triggers:**
- Pay-as-you-go: $0.20 per 100k requests

**Current Risk:** Moderate (rate limit checks per API call)

## Cost Risk Analysis

### Worst-Case Scenario: Power User Attack

**Assumptions:**
- 1 power user making 10,000 API calls/day
- Average user making 5 API calls/day

**Monthly Costs (30 days):**
- Power user: 300k Edge Function calls
- 99,999 normal users: ~15M Edge Function calls
- **Total:** 15.3M calls = **$750-1,200/month** (Supabase Team + overages)

### Best-Case Scenario: Organic Growth

**Assumptions:**
- 100k users
- 50% monthly active (50k)
- 10 API calls per active user/month

**Monthly Costs:**
- 500k Edge Function calls = **$0** (within free tier)
- PostHog events: ~1M = **$0** (within free tier)

## Recommended Pricing Strategies

---

## Option 1: "Generous Free Tier" (Recommended)

**Philosophy:** Supabase/Vercel-style accessibility with dormant project cleanup

### Free Tier
- **100 API calls/month** per user/anonymous_id
- **No credit card required**
- **No expiration** for active users
- **Dormant cleanup:** Disable projects inactive for 90 days (email warning at 60 days)

### Paid Tier ($10/month)
- **10,000 API calls/month**
- **Priority support**
- **Advanced analytics**
- **Custom rate limits**

### Enterprise Tier (Custom)
- **Unlimited API calls**
- **SLA guarantees**
- **Dedicated support**
- **Self-hosted option**

### Cost Protection
1. **Per-user rate limiting:** 100 calls/month tracked by `anonymous_id` (PostHog)
2. **IP-based circuit breaker:** 10,000 calls/day per IP (prevents abuse)
3. **Dormant project cleanup:** Auto-disable after 90 days inactivity
4. **Upgrade prompts:** Soft limit warnings at 80%, 90%, 100%

### Financial Model (100k users)
- **Active users (50%):** 50k
- **Heavy users (5% of active):** 2.5k users → upgrade to paid
- **Monthly revenue:** 2,500 × $10 = **$25,000**
- **Infrastructure costs:** ~$600-800/month (Supabase Pro + PostHog overages)
- **Net margin:** ~$24,000/month

### Pros
- Maximum accessibility for hobbyists
- Simple "upgrade when you need it" model
- High conversion potential from free → paid
- Clear path to profitability at scale

### Cons
- Higher initial abuse risk (mitigated by IP circuit breaker)
- Requires robust dormant project cleanup
- Support burden from free tier users

---

## Option 2: "Credit-Based System"

**Philosophy:** Flexible consumption with rollover credits

### Free Tier
- **500 credits/month** (no expiration, rollover enabled)
- **1 credit = 1 API call**
- **Bonus credits:** +100 for email signup, +200 for GitHub verification
- **No credit card required**

### Paid Tiers
- **Starter ($5/month):** 2,000 credits/month
- **Pro ($20/month):** 10,000 credits/month
- **Business ($100/month):** 75,000 credits/month

### Credit Pricing (a la carte)
- **$0.01 per credit** (after monthly allocation)
- **Bulk discount:** 10% off for 10k+ credits

### Cost Protection
1. **Credit consumption tracking:** Real-time balance via PostHog
2. **Auto-pause at 0 credits:** Resume manually or upgrade
3. **Rollover limits:** Max 2× monthly allocation (prevents hoarding)
4. **Fraud detection:** Flag unusual consumption patterns

### Financial Model (100k users)
- **Free users (90%):** 90k × 500 credits = 45M credits/month
- **Equivalent API calls:** 45M = **$2,250 infrastructure cost**
- **Paid users (10%):** 10k users
  - Starter (7k): $35,000
  - Pro (2.5k): $50,000
  - Business (500): $50,000
- **Monthly revenue:** **$135,000**
- **Net margin:** ~$132,000/month

### Pros
- Clear, predictable consumption model
- Natural upgrade path (run out of credits → buy more)
- Rollover incentivizes loyalty
- High revenue potential per user

### Cons
- Complexity: Users must understand "credits"
- Support burden: "Why did I run out of credits?"
- Risk of credit hoarding (rollover limits help)

---

## Option 3: "Time-Based Free Tier"

**Philosophy:** First 30 days unlimited, then meter usage

### Free Trial
- **Unlimited API calls for 30 days** (no credit card)
- **Automatic downgrade** to Free tier after trial

### Free Tier (Post-Trial)
- **50 API calls/month**
- **No expiration**
- **Upgrade anytime**

### Paid Tiers
- **Starter ($8/month):** 5,000 calls/month
- **Pro ($25/month):** 25,000 calls/month
- **Business ($100/month):** 150,000 calls/month
- **Enterprise (Custom):** Unlimited

### Cost Protection
1. **Trial abuse prevention:** Email verification required
2. **One trial per email/GitHub account**
3. **Post-trial rate limiting:** 50 calls/month hard limit
4. **Upgrade CTA:** Prominent in-app messaging

### Financial Model (100k users)
- **Trial users (month 1):** 20k active
  - Unlimited usage = **$1,000 infrastructure cost** (rate-limited per IP)
- **Free tier users (90%):** 90k × 50 calls = 4.5M calls/month = **$200 cost**
- **Paid users (10%):** 10k users
  - Starter (6k): $48,000
  - Pro (3k): $75,000
  - Business (1k): $100,000
- **Monthly revenue:** **$223,000**
- **Net margin:** ~$222,000/month

### Pros
- Converts users after they're hooked (trial period)
- Simple free tier (50 calls = enough for experimentation)
- High conversion rate (post-trial)
- Strong revenue per user

### Cons
- Higher trial abuse risk (mitigated by email verification)
- User frustration after trial ends (sudden limit drop)
- Requires robust trial tracking

---

## Comparison Matrix

| Metric | Option 1: Generous | Option 2: Credits | Option 3: Trial |
|--------|-------------------|-------------------|-----------------|
| **Free tier limit** | 100 calls/month | 500 credits | 30-day unlimited → 50 calls/month |
| **Complexity** | Low | Medium | Low |
| **Conversion rate** | 5% | 10% | 10% |
| **Monthly revenue (100k users)** | $25k | $135k | $223k |
| **Infrastructure cost** | $600-800 | $2,250 | $1,200 |
| **Net margin** | $24k | $132k | $222k |
| **Abuse risk** | Low (IP limits) | Medium (credit hoarding) | Medium (trial abuse) |
| **User experience** | Simple, transparent | Flexible, requires education | Generous trial, sudden drop |
| **Support burden** | Medium | High (credit questions) | Medium |
| **Best for** | Accessibility | Power users | High conversion |

---

## Recommendation: Option 1 (Generous Free Tier)

### Rationale
1. **Aligns with mission:** Maximum accessibility for developers and hobbyists
2. **Proven model:** Supabase, Vercel, and Railway successfully use this approach
3. **Low support burden:** Simple to understand ("100 calls/month, upgrade for more")
4. **Scalable cost protection:** IP circuit breaker + dormant cleanup
5. **High trust:** No credit card required, no time pressure

### Implementation Plan

#### Phase 1: Rate Limiting (Week 1)
1. Implement per-user rate limiting (100 calls/month by `anonymous_id`)
2. Add IP-based circuit breaker (10k calls/day)
3. Test with synthetic load

#### Phase 2: Monitoring (Week 2)
1. PostHog dashboard for usage tracking
2. Alerts for abuse patterns (single user >500 calls/day)
3. Cost monitoring (Supabase + PostHog + Vercel)

#### Phase 3: Upgrade Flow (Week 3)
1. Stripe integration for paid tiers
2. Upgrade prompts at 80%, 90%, 100% of limit
3. Self-service billing portal

#### Phase 4: Dormant Cleanup (Week 4)
1. Email warnings at 60 days inactivity
2. Auto-disable at 90 days (reversible)
3. Reactivation flow (one-click)

#### Phase 5: Launch (Week 5)
1. Announce pricing publicly
2. Monitor for 30 days
3. Iterate based on feedback

### Pricing Page Copy

```markdown
## Pricing

### Free (Forever)
- 100 API calls/month
- No credit card required
- Perfect for hobbyists and side projects
- Unlimited skills, no feature restrictions

### Pro ($10/month)
- 10,000 API calls/month
- Priority support
- Advanced analytics
- Custom rate limits

### Enterprise (Custom)
- Unlimited API calls
- SLA guarantees
- Dedicated support
- Self-hosted option
- Volume discounts available

**Fair use policy:** Inactive projects (90+ days) may be paused.
**Need more calls?** Upgrade anytime, no long-term commitment.
```

---

## Risk Mitigation

### Abuse Scenarios

#### Scenario 1: Single power user (10k calls/day)
- **Detection:** IP circuit breaker triggers at 10k/day
- **Action:** Temporary 24-hour block, email notification with upgrade CTA
- **Cost impact:** $0 (blocked before damage)

#### Scenario 2: Distributed attack (100 users, 1k calls/day each)
- **Detection:** PostHog anomaly detection (sudden spike)
- **Action:** Manual review, block suspicious IPs
- **Cost impact:** ~$50-100 (Supabase overage for 1-2 days)

#### Scenario 3: Legitimate viral growth (100k users in 1 week)
- **Detection:** Gradual ramp-up in PostHog
- **Action:** Scale Supabase plan, monitor conversion rate
- **Cost impact:** $600-800/month (profitable if 2.5k convert)

### Monitoring Dashboard

**Key Metrics (PostHog + Custom):**
1. Daily API calls (total)
2. API calls per user (P50, P90, P99)
3. Free tier usage distribution (histogram)
4. Conversion rate (free → paid)
5. Monthly recurring revenue (MRR)
6. Infrastructure costs (Supabase + PostHog + Vercel)
7. Cost per active user
8. Abuse incidents (IP blocks, anomaly alerts)

### Escalation Plan

**Tier 1: Automated (no human intervention)**
- IP circuit breaker (10k calls/day)
- Rate limit enforcement (100 calls/month)
- Upgrade prompts (80%, 90%, 100%)

**Tier 2: Alert + Manual Review (within 24 hours)**
- Anomaly detection (sudden spike)
- Cost threshold alert (>$1000/day)
- Support ticket from blocked user

**Tier 3: Emergency (immediate action)**
- DDoS attack detected
- Infrastructure costs >$5000/day
- Database performance degradation

---

## Next Steps

1. **Decision:** Choose pricing strategy (recommend Option 1)
2. **Implement:** Rate limiting + monitoring (Weeks 1-2)
3. **Test:** Synthetic load testing with 10k simulated users
4. **Launch:** Announce pricing, monitor for 30 days
5. **Iterate:** Adjust limits based on real-world data

---

## Appendix: Competitive Analysis

| Service | Free Tier | Paid Start | Model |
|---------|-----------|-----------|-------|
| **Vercel** | 100 GB bandwidth, unlimited functions | $20/month | Generous free, usage-based |
| **Supabase** | 500k Edge Functions, 500 MB DB | $25/month | Generous free, cleanup inactive |
| **Railway** | $5 credit/month | $5/month (PAYG) | Credit-based, no free tier |
| **Render** | Free static sites, limited hours | $7/month | Time-limited free tier |
| **Fly.io** | 3 shared VMs, 3 GB storage | $5/month (PAYG) | Resource-based free tier |

**Conclusion:** Generous free tier (Option 1) aligns with industry leaders and maximizes accessibility.
