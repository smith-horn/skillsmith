# Growth Engineering Review v2: POC-First Lens

**Reviewer**: Growth Engineer (Developer Tool Adoption Specialist)
**Date**: December 26, 2025
**Documents Reviewed**: All GTM v2 documentation, updated funnel, metrics, experiments, risks
**Review Focus**: POC-first approach with CEO strategic direction
**Status**: Second Round Review Complete

---

## Executive Summary

The team has made significant improvements since Round 1:

| Area | Round 1 Issue | Round 2 Status |
|------|---------------|----------------|
| Activation time | Unrealistic 5 min | Revised to 15 min |
| Referral targets | 20% (4x industry) | Revised to 5% |
| Distribution | Hope-based | Multi-channel with realistic estimates |
| Metrics | Vanity-focused | Behavior-focused, trackable |
| Experiments | Missing | Comprehensive plan with gate criteria |

**My assessment of Round 2 improvements: SOLID.**

The GTM strategy is now grounded in reality. However, given the CEO's decision for a **POC-first approach**, much of this elaborate planning is premature. This review reframes the GTM strategy through a POC lens.

---

## Part 1: What Changes with POC-First

### The CEO's Strategic Direction

1. **Build to learn, not learn to build** - Skip upfront interviews
2. **UAT provides early signal** - Real usage beats stated preference
3. **Teresa Torres interviews AFTER POC** - Story-based discovery once we have users
4. **Feasibility first** - GTM refinement after technical validation

### What This Means for Growth Strategy

| Original GTM Assumption | POC Reality | Implication |
|------------------------|-------------|-------------|
| 15 user interviews in Phase 0 | Skipped | Replace with UAT observation |
| 50 beta users committed | Need 10-50 actual POC users | Different recruitment approach |
| Validate demand through interviews | Validate through actual usage | Different success signals |
| Launch Week timeline | No public launch; private POC | Different distribution |
| 100+ users as Phase 1 gate | 10-50 POC users is sufficient | Lower bar, faster learning |

### The Core Question

**Can we learn about growth from 10-50 POC users?**

**Answer: Yes, but we need to be surgical about what we measure.**

---

## Part 2: POC Learning Goals for Growth

### What We CAN Learn with 10-50 Users

| Learning Goal | Minimum Sample | What We'll Know | Why It Matters |
|---------------|----------------|-----------------|----------------|
| Time-to-first-value | 10 users | Is 15 min achievable? | Core activation assumption |
| Major friction points | 15 users | Where do users get stuck? | Must-fix before scaling |
| First-value perception | 10 users | Do users find insight valuable? | Product-market fit signal |
| Natural virality | 20+ users | Does anyone share unprompted? | Organic growth potential |
| Retention pattern | 30+ over 2 weeks | Do users return? | Early retention signal |
| Entry point preference | 30 users | Terminal vs. web vs. IDE? | Channel prioritization |

### What We CANNOT Learn with 10-50 Users

| Metric | Why Not | When To Measure |
|--------|---------|-----------------|
| Referral rate (5%) | Need 200+ users for statistical significance | Post-POC Phase 2 |
| Channel efficiency | No public channels in POC | Post-POC Phase 1 |
| NPS | <100 responses is noise | Post-POC Phase 3 |
| Cohort retention curves | Need 100+ per cohort | Post-POC Phase 2 |
| SEO impact | Takes 3-6 months to measure | Phase 2+ |
| Viral coefficient | Need network effects at scale | Phase 3+ |

### POC Growth Metrics (Trackable with Small N)

**Primary: Individual User Behavior**

| Metric | Definition | POC Target | Why This Works |
|--------|------------|------------|----------------|
| Time to first insight | Minutes from install to first recommendation | <15 min | Observable per user |
| Completion rate | % completing full onboarding flow | 70%+ | Every user counts |
| Return visits | Users who come back in week 2 | 50%+ | Small N is fine |
| Session depth | Actions per session | 3+ | Behavioral engagement |
| Unsolicited feedback | Users who email/message without prompting | Any | Qualitative signal |

**Secondary: Qualitative Signals**

| Signal | What To Look For | Data Source |
|--------|------------------|-------------|
| "Aha moment" verbalization | Users saying "oh cool" or equivalent | Screen recording, observation |
| Spontaneous sharing | User mentions to colleagues without prompting | Exit interview |
| Feature requests | Specific asks for more | Direct feedback |
| Comparison to alternatives | "This is better than X because..." | Exit interview |
| Recommendation language | "I would/wouldn't recommend this to..." | Exit interview |

---

## Part 3: Beta User Recruitment Strategy

### The POC Distribution Challenge

We don't have:
- Public launch channels
- Awesome list presence
- Web presence for SEO
- VS Code extension in marketplace
- Author virality engine

We DO have:
- Personal networks
- Existing Claude communities (as observers, not launchers)
- Direct outreach capability

### Finding the First 10-50 Users

#### Tier 1: Direct Network (Target: 10-15 users)

**Source**: Personal contacts who use Claude Code

**Approach**:
1. List everyone you know who uses Claude Code actively
2. Reach out individually with personalized message
3. Explain it's a private POC, seeking honest feedback
4. Offer early access and "founding user" status

**Expected conversion**: 30-40% of asks

**Script**:
```
Subject: Need your help testing something

Hey [Name],

I'm building a skill discovery tool for Claude Code and need
brutally honest feedback before going public.

I know you use Claude Code for [specific context]. Would you
spend 30 minutes trying this and telling me what sucks?

No strings attached. You'd be one of the first 20 people to
see this.

Interested?
```

#### Tier 2: Warm Introductions (Target: 10-15 users)

**Source**: Second-degree connections via trusted intermediaries

**Approach**:
1. Ask Tier 1 participants: "Know anyone else who'd give honest feedback?"
2. Get warm intro or permission to name-drop
3. Same personalized approach

**Expected conversion**: 20-30% of asks

#### Tier 3: Community Observation (Target: 5-10 users)

**Source**: Claude Discord lurking, Reddit observation

**Approach**:
1. Identify active Claude Code users asking about skills
2. DM (not public post) with offer to try private tool
3. Frame as seeking expert feedback

**Warning**: Don't spam. Target only users who demonstrate active skill-related pain.

**Expected conversion**: 10-15% of asks

#### Tier 4: Targeted Outreach (Target: 5-10 users)

**Source**: GitHub profiles of skill creators, active Claude commenters

**Approach**:
1. Find developers who've published Claude skills
2. Email with author-specific angle: "We're testing a tool that could help people discover your skill"
3. Dual motivation: feedback + self-interest

**Expected conversion**: 5-10% of cold outreach

### POC User Selection Criteria

**Ideal POC User Profile**:

| Criterion | Why It Matters | How To Verify |
|-----------|----------------|---------------|
| Uses Claude Code 3+ hrs/week | Has context for the problem | Ask directly |
| Has installed at least 1 skill | Understands skills | Ask directly |
| Willing to be observed/recorded | Enables learning | Ask permission |
| Will give negative feedback | Honest signal | Personal reputation |
| Technical but not expert | Represents target user | Background check |

**Anti-Patterns to Avoid**:

| Avoid | Why |
|-------|-----|
| Only friends who'll be nice | Garbage feedback |
| Only power users | Skews perception of complexity |
| Only beginners | Can't evaluate recommendation quality |
| People who owe you favors | Biased positive feedback |

### Recruitment Timeline

| Week | Target Recruited | Total Users |
|------|------------------|-------------|
| POC Week 1 | 10 (Tier 1) | 10 |
| POC Week 2 | 15 (Tier 1-2) | 25 |
| POC Week 3 | 10 (Tier 2-3) | 35 |
| POC Week 4 | 10 (Tier 3-4) | 45 |

---

## Part 4: Instrumentation Requirements

### The POC Instrumentation Philosophy

**Principle**: Instrument for learning, not for dashboards.

With 10-50 users, you'll read every data point manually. Fancy analytics are overkill. Focus on:
1. Can we reconstruct what happened in each session?
2. Can we identify where users struggled?
3. Can we measure time-to-value accurately?

### Minimum Viable Instrumentation

#### Level 1: Essential (Ship with POC)

```typescript
// Event schema - keep it simple
interface POCEvent {
  user_id: string;           // Anonymous hash
  timestamp: string;         // ISO 8601
  event_type: string;        // Core events only
  duration_ms?: number;      // For timed events
  success?: boolean;         // For completable events
  error_message?: string;    // For failures
  metadata?: object;         // Flexible catch-all
}
```

**Core Events to Track**:

| Event | When Fired | Why Essential |
|-------|------------|---------------|
| `install_started` | User runs install command | Funnel start |
| `install_completed` | Install succeeds | Friction point |
| `install_failed` | Install fails | Critical blocker |
| `scan_started` | Codebase scan begins | Engagement point |
| `scan_completed` | Scan finishes | Duration measurement |
| `recommendation_shown` | First recommendation displayed | First value moment |
| `skill_installed` | User installs recommended skill | Conversion |
| `session_ended` | User exits or timeout | Session duration |

**Implementation Options** (pick one):

| Option | Effort | Cost | Best For |
|--------|--------|------|----------|
| Console.log + manual review | 2 hrs | Free | <20 users |
| JSON file per session | 4 hrs | Free | 20-50 users |
| PostHog free tier | 8 hrs | Free | 50+ users, want dashboards |
| Plausible self-hosted | 10 hrs | Free | Privacy-focused |

**Recommendation**: For POC, use JSON file per session. You'll manually review each user anyway.

#### Level 2: Valuable (Add in Week 2)

| Event | Why Valuable |
|-------|--------------|
| `recommendation_rated` | Direct quality signal |
| `recommendation_dismissed` | Why user didn't act |
| `help_accessed` | Where users need guidance |
| `error_encountered` | Specific failure points |

#### Level 3: Nice-to-Have (Post-POC)

| Event | Why Defer |
|-------|-----------|
| `feature_used` | Only matters at scale |
| `page_viewed` | Overkill for POC |
| `button_clicked` | Too granular |
| `scroll_depth` | Irrelevant for CLI |

### Session Reconstruction

**Goal**: Be able to answer "What did user #7 do and where did they struggle?"

**Approach**:
```
Session #7: user_abc123
2025-01-15 14:23:01 - install_started
2025-01-15 14:23:45 - install_completed (44s)
2025-01-15 14:24:02 - scan_started
2025-01-15 14:26:18 - scan_completed (136s)
2025-01-15 14:26:19 - recommendation_shown (skill: frontend-design, score: 87)
2025-01-15 14:27:05 - recommendation_dismissed (reason: "already have one")
2025-01-15 14:27:06 - recommendation_shown (skill: testing-patterns, score: 82)
2025-01-15 14:28:12 - skill_installed (skill: testing-patterns)
2025-01-15 14:32:00 - session_ended

Analysis: 9 min to first install. User knew what they wanted.
Friction: None observed. Short session.
```

### Qualitative Data Collection

**Exit Interview Script** (for first 20 users):

```
1. What did you expect this tool to do?
2. Walk me through what happened when you tried it.
3. What was the most confusing part?
4. Did you find something you didn't know existed?
5. Would you use this again? Why/why not?
6. What's missing?
7. Who else should I show this to?
```

**Screen Recording** (optional but valuable):

- Use Loom or similar for users who consent
- Review each recording manually
- Note exact moments of confusion
- Capture "aha moment" reactions

---

## Part 5: GTM Gaps to Address Post-POC

### What the POC Will NOT Validate

| Gap | Why POC Can't Validate | Post-POC Action |
|-----|------------------------|-----------------|
| Distribution channel efficiency | No public channels | Test during Phase 1 launch |
| SEO potential | Takes months to measure | Build web presence in Phase 2 |
| Author virality | Need author base | Outreach after product stable |
| Referral mechanics | Need network scale | A/B test in Phase 2 |
| VS Code vs. web conversion | Need both entry points | Experiment in Phase 2 |
| Retention at scale | Need cohorts | Cohort analysis Phase 2+ |

### Experiments That CAN'T Wait Until Post-POC

| Experiment | Why It Can't Wait | POC Version |
|------------|-------------------|-------------|
| Activation time | Core assumption | Measure during POC |
| Recommendation quality | Core value prop | Manual quality testing |
| Install friction | Blocks all users | Fix before expanding POC |
| First-value definition | Defines success | Validate in POC |

### Experiments To Run DURING POC

**Experiment P1: Activation Time Validation (POC Version)**

**Hypothesis**: Users reach first value in <15 minutes.

**Method**:
1. Instrument timestamps for each step
2. Calculate median time from install_started to recommendation_shown
3. Ask users: "Did you get something useful?"

**Success**: 80% of POC users reach first insight <15 min.

**Sample needed**: 10 users

**Experiment P2: Recommendation Quality (POC Version)**

**Hypothesis**: Content-based scores correlate with user interest.

**Method**:
1. Show recommendations to POC users
2. Ask: "Would you install this?" (before showing score)
3. Correlate answer with score

**Success**: Higher-scored recommendations get more "yes" responses.

**Sample needed**: 15 users with 3+ recommendations each

**Experiment P3: First-Value Definition**

**Hypothesis**: Seeing a personalized insight is valuable even without installing.

**Method**:
1. Show recommendation with context (e.g., "85% of similar projects use this")
2. Ask: "Was this information useful regardless of whether you install?"
3. Track if users who answer "yes" have higher engagement

**Success**: >70% find insight valuable; these users have 2x return rate.

**Sample needed**: 20 users

### Post-POC GTM Priorities

Based on POC learnings, prioritize:

| Priority | If POC Shows | GTM Action |
|----------|--------------|------------|
| P0 | Activation works | Proceed to Phase 1 launch |
| P1 | Entry point preference | Invest in preferred channel first |
| P1 | Friction points | Fix before expanding distribution |
| P2 | Spontaneous sharing | Accelerate viral mechanics |
| P2 | No return visits | Invest in retention before acquisition |
| P3 | Positive reception | Proceed with planned GTM |

---

## Part 6: Metrics to Track from Day 1

### The Day-1 Dashboard (Simple Version)

```
POC HEALTH CHECK - Day 7
========================

Total Users: 23
Installs Attempted: 28
Install Success Rate: 82% (target: 80%)

Activation Funnel:
  - Install complete: 23 (100%)
  - Scan complete: 21 (91%)
  - Saw recommendation: 20 (87%)
  - Installed skill: 14 (61%)

Time to First Value:
  - Median: 11 min (target: <15 min)
  - 80th percentile: 18 min

Return Visits (Day 2+):
  - Returned: 12 of 23 (52%)

Qualitative Signals:
  - Unprompted positive: 4
  - Unprompted negative: 2
  - Feature requests: 7
  - Asked to share with others: 3

BLOCKERS IDENTIFIED:
  1. Permission error on macOS (3 users)
  2. Slow scan on large repos (2 users)
  3. No recommendation for Go projects (1 user)
```

### What Each Metric Tells You

| Metric | If Low | If High | Action |
|--------|--------|---------|--------|
| Install success | Major friction | Move on | Fix install scripts |
| Scan complete | Scan is broken | Move on | Debug scan errors |
| Saw recommendation | Matching problem | Move on | Improve matching |
| Installed skill | UX or relevance | Move on | Review recommendations |
| Return visits | No ongoing value | Growth potential | Investigate why |
| Unprompted shares | No virality | Organic growth | Note what drives it |

### Tracking Implementation for POC

**Day 1 Setup** (4 hours total):

1. **Event logging** (2 hrs)
   - Add console.log or file write for core events
   - Include timestamp, user_id, event_type

2. **User tracking** (1 hr)
   - Simple spreadsheet with columns:
     - User ID | Recruited From | Date Started | Notes

3. **Feedback collection** (1 hr)
   - Set up simple form (Google Forms, Typeform)
   - Share link in exit message

**Daily Review** (15 min):

1. Scan event logs for new users
2. Note any errors or unusual patterns
3. Update spreadsheet with observations

**Weekly Review** (1 hr):

1. Calculate funnel metrics
2. Review qualitative feedback
3. Identify top friction points
4. Decide what to fix

---

## Part 7: Updated Risk Assessment for POC

### Risks Appropriately DEFERRED by POC-First

| Risk | Original Mitigation | POC Approach | Why OK to Defer |
|------|---------------------|--------------|-----------------|
| Distribution void | Multi-channel investment | Private recruitment | No public presence yet |
| Referral rate unrealistic | 5% target with mechanics | Don't measure | Need 200+ users |
| Channel efficiency | Track ROI per channel | None | No channels active |
| Maintainer burnout | 35 hr/week estimate | Flexible POC scope | Learning phase |
| Anthropic platform risk | Diversification | Ignore | Too early to worry |

### Risks That NEED ATTENTION During POC

| Risk | Why It Matters for POC | POC Mitigation |
|------|------------------------|----------------|
| **Activation chasm** | 50% failure kills POC | Monitor every activation; fix issues |
| **15 min still unrealistic** | Core assumption | Validate with real users immediately |
| **Cold start quality** | Early users get bad recs | Hand-pick first recommendations |
| **No demand exists** | Entire premise | Exit interviews after each user |
| **Install friction** | Blocks all learning | Fix aggressively in first week |

### POC-Specific Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Can't recruit 30+ users | Medium | High | Start Tier 1 outreach immediately |
| Users don't give honest feedback | Medium | Medium | Select for honesty, not politeness |
| POC users not representative | Medium | Medium | Diverse recruitment sources |
| Technical issues dominate feedback | High | Low | Fix quickly, re-recruit if needed |
| Scope creep during POC | Medium | Medium | Strict 4-week timebox |

### Data from POC That Would Change GTM Strategy

| POC Finding | GTM Strategy Change |
|-------------|---------------------|
| Time-to-value >20 min | Simplify product before scaling |
| <50% find first insight valuable | Pivot to different value prop |
| Terminal users prefer web | Web-first distribution |
| Authors highly engaged | Accelerate author virality |
| No spontaneous shares | Deprioritize viral mechanics |
| Users return without prompting | Invest more in acquisition |
| Users don't return | Invest in retention before acquisition |

---

## Part 8: POC Exit Criteria

### When to End POC

**Positive Exit** (proceed to Phase 1):

- 30+ users completed onboarding
- Median time-to-value <15 min
- 60%+ find first insight valuable (exit interview)
- No critical unresolved blockers
- 40%+ return within 1 week

**Negative Exit** (pivot or stop):

- <20 users after 4 weeks of recruitment
- Median time-to-value >25 min
- <40% find first insight valuable
- Critical blocker not fixable
- 0% spontaneous positive feedback

**Pivot Signals**:

- Users want simpler tool (e.g., just CLAUDE.md generator)
- Users want different entry point (e.g., web-only)
- Specific persona more engaged than others (narrow focus)

### Post-POC Decision Framework

```
IF positive exit:
  - Proceed to Phase 1
  - Begin public launch preparation
  - Implement minimum instrumentation for scale
  - Start awesome list submissions

IF negative exit + pivot signal:
  - Identify pivot direction
  - Design new POC for pivot
  - Recycle willing users for new POC

IF negative exit + no signal:
  - Stop project
  - Document learnings
  - Archive for future reference
```

---

## Part 9: Summary and Recommendations

### What the Team Got Right (Round 2)

1. **Realistic metrics** - 15 min activation, 5% referral are grounded
2. **Multi-channel thinking** - Not dependent on single channel
3. **Author virality** - Smart focus on aligned incentives
4. **Experiment-driven** - Clear hypotheses with success criteria
5. **Risk acknowledgment** - Honest about distribution challenges

### What to Adjust for POC-First

1. **Defer Phase 0 interviews** - POC usage replaces stated preference
2. **Simplify instrumentation** - Manual review > fancy dashboards
3. **Recruitment over marketing** - Private outreach, not public channels
4. **Lower user targets** - 30-50 is enough for POC learning
5. **Focus on blockers** - Find and fix friction, not optimize conversion

### The One Thing to Do First

**Start recruiting POC users TODAY.**

The biggest risk to POC success is not having users to learn from. Everything else can be figured out once you have 10 people actively trying the product.

### POC Success Looks Like

After 4 weeks:
- 35 users have tried the product
- Median time-to-value: 12 minutes
- 70% say "this is useful" in exit interview
- 50% return in week 2
- 3+ users ask "can I share this with my team?"
- Top 3 friction points identified and fixed
- Clear data on which entry point users prefer

### What I'll Look for in Round 3 Review

After POC completes, I'll review:
1. POC metrics vs. predictions (did we hit targets?)
2. Qualitative themes from exit interviews
3. Friction points fixed vs. remaining
4. Evidence of organic sharing (if any)
5. Updated GTM priorities based on POC learnings

---

## Appendix: POC Checklist

### Before POC Launch

- [ ] Core product functional (install, scan, recommend)
- [ ] Basic event logging implemented
- [ ] User tracking spreadsheet created
- [ ] Exit interview script ready
- [ ] First 10 users recruited (Tier 1)
- [ ] Screen recording consent process

### During POC (Weekly)

- [ ] Review all new user sessions
- [ ] Conduct exit interviews with completers
- [ ] Calculate weekly funnel metrics
- [ ] Fix top friction point from prior week
- [ ] Recruit next wave of users

### POC Completion

- [ ] 30+ users completed onboarding
- [ ] All exit interviews completed
- [ ] Metrics summary compiled
- [ ] Friction points documented
- [ ] Go/no-go recommendation drafted
- [ ] Teresa Torres interview questions prepared (for post-POC)

---

*Review completed December 26, 2025*
*Round 3 review: After POC completion (target Week 4)*
