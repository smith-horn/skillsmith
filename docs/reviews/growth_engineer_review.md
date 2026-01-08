# Growth Engineering Review: Claude Discovery Hub

**Reviewer**: Growth Engineer (Developer Tool Adoption Specialist)
**Date**: December 26, 2025
**Documents Reviewed**: PRD v2, Architecture, User Research, Curriculum, GTM Strategy, Quality Scoring Research, Transparent Scoring Design
**Status**: Critical Review Complete

---

## Executive Summary

1. **The 5-minute activation target is unrealistic** given documented 50% skill activation failure rates and a multi-step installation process. Actual time-to-value is likely 15-30 minutes for most users.

2. **Distribution strategy relies heavily on hope**: Anthropic partnership (15% probability by their own estimate), HN front page (highly uncertain), and 20% referral rates (2-4x industry norms for dev tools).

3. **Critical cold start paradox**: The recommendation engine needs usage data to recommend well, but users need good recommendations to generate usage data. The UCB1 exploration strategy is mathematically sound but untested at this scale.

4. **Missing viral mechanics**: No team features, no invite system, no embeddable badges, no public profile/leaderboard. The "referral artifacts" (markdown files with links) assume developers share files they generate---this rarely happens organically.

5. **Right North Star metric, wrong supporting metrics**: WAD (Weekly Active Discoverers) is correct. However, "recommendation accept rate" is a vanity metric---what matters is "recommendation activation rate" (did the accepted skill actually trigger?).

---

## Funnel Analysis

### Stage 1: Awareness

| Channel | Proposed | Reality Check | Adjusted Expectation |
|---------|----------|---------------|---------------------|
| HN Front Page | 500 installs | HN Show posts average 5-20 upvotes. Front page requires exceptional timing + luck. ~10% of launches get meaningful traction. | 50-150 installs |
| Reddit r/ClaudeAI | 50 upvotes | Subreddit has ~100K members. 50 upvotes is achievable but not guaranteed. | 20-50 installs |
| Awesome Lists | 3 acceptances | Acceptance rate is ~60% for quality projects. Good bet. | 2-3 acceptances, ~100 installs over 6 months |
| Twitter Build-in-Public | 500 impressions | Without existing following, this is optimistic. Dev tool tweets average 50-200 impressions. | 100-300 impressions, ~10 installs |
| Anthropic Partnership | Official endorsement | Their own doc estimates 15% probability. I'd estimate 5-10% in first 6 months. | Unlikely to be primary driver |

**Awareness Gap**: No paid acquisition strategy. No integration with existing discovery surfaces (VS Code, IDE plugins). No influencer outreach beyond "email devrel."

**Recommendation**: Build a minimal web presence (GitHub Pages) with SEO-optimized content. "Claude Code skills for React," "Best Claude skills for testing," etc. These searches happen. Intercept them.

---

### Stage 2: Activation

**Proposed Time-to-Value**: 5 minutes

**Actual Critical Path Analysis**:

```
Step 1: Learn about Discovery Hub (awareness)
        Time: Variable (not counted)

Step 2: Run MCP installation command
        Time: 2-5 minutes (depending on config)
        Drop-off: ~20% (config issues, permission errors)

Step 3: Initial sync of skill index
        Time: 1-3 minutes (downloading 50K+ skills)
        Drop-off: ~10% (slow connection, timeout)

Step 4: First codebase scan
        Time: 2-5 minutes (parsing files, generating recommendations)
        Drop-off: ~15% (scan errors, no recommendations generated)

Step 5: Receive recommendation
        Time: Instant
        Drop-off: ~30% (recommendations don't match perceived needs)

Step 6: Install recommended skill
        Time: 1-2 minutes
        Drop-off: ~10% (installation errors)

Step 7: Skill activates successfully
        Time: Variable
        Drop-off: ~50% (documented activation failure rate)

TOTAL TIME: 8-17 minutes (optimistic path)
CUMULATIVE DROP-OFF: 73% never reach value
```

**First-Value Moment Analysis**:

The proposed "first value" is: "Skill improves their work." This is too far down the funnel.

**Better First-Value Moments** (faster, more reliable):
1. **Codebase scan reveals something interesting** (2-3 min): "Your React project is missing a testing skill. 85% of similar projects use one." This is value even if user doesn't install anything.
2. **Discovery of unknown skill** (3-5 min): "There's a skill specifically for your ORM (Prisma). You might not have known this existed."

**Recommendation**: Redefine activation as "user sees personalized, non-obvious insight about their codebase" not "user installs and uses a skill successfully."

---

### Stage 3: Retention

**Proposed Mechanism**: CLAUDE.md integration with weekly automated recommendations.

**Reality Check**:

| Retention Tactic | Effectiveness | Concern |
|------------------|---------------|---------|
| Weekly recommendations in CLAUDE.md | Medium | Users must manually add this. Friction point. |
| Learning progress tracking | Low-Medium | Requires ongoing engagement with exercises. |
| Skill update notifications | Low | Updates don't equal value. Could become noise. |
| "Projects like yours" comparisons | Medium | Interesting but not actionable. |

**Retention Risk**: The product is "pull" not "push." Users must remember to engage. There's no notification system, no email, no push mechanism to re-engage dormant users.

**Missing Retention Mechanics**:
1. **No streak/habit formation**: Daily or weekly engagement rewards
2. **No progress visibility**: How good is my setup compared to peers?
3. **No degradation alerts**: "3 of your installed skills haven't been updated in 6 months"
4. **No skill usage analytics**: Users can't see which skills they actually use

**Recommendation**: Implement "skill health check" that runs automatically and surfaces issues. This creates re-engagement trigger that's valuable, not nagging.

---

### Stage 4: Referral

**Proposed Referral Rate**: 5% (Week 8) to 20% (Month 12)

**Reality Check**:

Typical developer tool referral rates:
- Command-line tools: 2-5%
- IDE extensions: 5-10%
- SaaS dev tools: 8-15%
- Exceptional products (Notion, Figma): 15-25%

**20% is exceptionally optimistic** for a terminal tool with no visual shareability.

**Proposed Viral Mechanics Analysis**:

| Mechanic | Proposed | Will It Work? |
|----------|----------|---------------|
| Recommendation artifacts (markdown with links) | Share recommendation files | **No**. Developers don't share config files. These are private project docs. |
| Learning badges | Share completion certificates | **Maybe**. Works for LinkedIn. Need embed-friendly format. |
| Setup export | "Get this setup" links | **Unlikely**. Sharing your dev environment setup is uncommon. |
| Comparison stats | "Top 15% skill utilization" | **No**. This requires public profiles, which don't exist. |

**Missing Viral Mechanics**:
1. **Public skill profiles**: "See what skills @username uses"
2. **Embeddable badges**: "Powered by Claude Discovery" for READMEs
3. **Team invites**: Invite colleagues to shared workspace
4. **Skill author attribution**: When skills spread, authors get credit (and incentive to promote)
5. **Integration badges**: Skills can display "Verified by Discovery Hub" badge

**Recommendation**: Focus on skill author virality. Authors have incentive to promote their skills. Give them tools: embeddable score badges, "Get this skill" buttons, download/install tracking dashboards.

---

## Growth Risks

### Risk 1: Distribution Void (Severity: CRITICAL)

**The Problem**: Terminal tools are invisible. No App Store, no website SEO, no marketplace browse experience. The GTM doc acknowledges this but doesn't solve it.

**Current Mitigation**: Hope for Anthropic partnership, awesome list inclusion, community seeding.

**Why This Fails**: All proposed channels are low-volume:
- Awesome lists: ~100 monthly visitors per list
- Discord/Reddit: Requires ongoing effort, not scalable
- Anthropic partnership: Low probability, long timeline

**Recommended Fix**:
1. **Build web presence**: Minimal site with skill browser. SEO for "Claude skills for X" searches.
2. **VS Code extension**: Display recommendations in IDE sidebar. This is where developers spend time.
3. **GitHub Action**: Auto-generate recommendations on PR open. Creates touchpoint in existing workflow.

### Risk 2: Activation Chasm (Severity: HIGH)

**The Problem**: 50% skill activation failure rate is documented in user research. This means half of all "successful" recommendations fail silently.

**Current Mitigation**: Quality scoring, verification tiers.

**Why This Fails**: Even high-quality skills can fail to activate due to description issues, which are outside the Hub's control.

**Recommended Fix**:
1. **Activation verification**: Before recommending, test if skill actually activates in simulated context.
2. **Activation guidance**: When skill fails to activate, explain why (description too vague, conflicting skills, etc.).
3. **Fallback recommendations**: "If X doesn't activate, try Y as alternative."

### Risk 3: Cold Start Death Spiral (Severity: HIGH)

**The Problem**: Recommendations need usage data. Usage needs good recommendations. The UCB1 algorithm helps, but initial recommendations will be poor.

**Current Mitigation**: Content-based baseline + exploration bonus.

**Why This Fails**: Content-based scoring (README quality, stars) correlates weakly with actual usefulness. Early users will get mediocre recommendations, churn, and spread negative word-of-mouth.

**Recommended Fix**:
1. **Seed with expert curation**: First 100 recommendations should be hand-picked by team.
2. **Beta user cohort**: Get 50 engaged users to provide explicit feedback for 4 weeks before public launch.
3. **Delayed launch of "smart" features**: Launch search first, add recommendations only after gathering data.

### Risk 4: Maintainer Burnout (Severity: MEDIUM)

**The Problem**: GTM doc estimates "Minimum Viable Team" as 35 hours/week across 3 roles. This is unsustainable for a side project.

**Current Mitigation**: "Build contributor community early."

**Why This Fails**: Contributors don't appear spontaneously. They're attracted by momentum, which requires initial investment.

**Recommended Fix**:
1. **Reduce scope**: Launch with only skill search. Defer recommendations, learning, advanced features.
2. **Automate everything**: Automated index updates, automated quality scoring, automated stale skill detection.
3. **Define "done"**: What's the minimum viable state where the project can survive on 5 hrs/week?

### Risk 5: Anthropic Platform Risk (Severity: MEDIUM)

**The Problem**: If Anthropic builds competing solution, this project becomes redundant. GTM doc estimates "move fast, position for acquisition."

**Current Mitigation**: Seek partnership early.

**Reality**: Anthropic has no incentive to acquire a community project when they can build their own with full ecosystem data access.

**Recommended Fix**:
1. **Build unique assets Anthropic can't easily replicate**: Learning curriculum, community-curated quality signals, cross-project comparison data.
2. **Open source everything**: Make the project more valuable forked than acquired.
3. **Diversify**: Support other AI coding tools (Cursor, Copilot) to reduce single-platform dependency.

---

## Friction Points to Address

| Friction Point | Stage | Severity | Fix Effort |
|---------------|-------|----------|------------|
| MCP server installation complexity | Activation | High | Medium (better docs, install scripts) |
| Two-step skill installation (marketplace + skill) | Activation | Medium | Low (automate in wrapper) |
| No visibility into skill activation failure | Activation | Critical | High (requires instrumentation) |
| CLAUDE.md integration is manual | Retention | Medium | Low (generate snippet, copy button) |
| No mobile/web access to recommendations | Retention | Low | High (requires web presence) |
| Learning exercises require local setup | Activation | Medium | Medium (cloud-based test environments) |
| Quality scores not visible during native `/plugin discover` | Discovery | High | High (requires Anthropic integration) |

---

## Missing Growth Mechanics

### 1. Team/Organization Features

**Current State**: Individual focus only.

**Opportunity**: Teams standardizing Claude setups is a real use case (documented in personas). No features support this.

**Recommended**:
- Shared skill lists (team-approved skills)
- Team CLAUDE.md templates
- Usage analytics across team (admin dashboard)
- Onboarding flows for new team members

### 2. Skill Author Dashboard

**Current State**: Authors get quality scores. No other feedback.

**Opportunity**: Authors want to know if their skills are being discovered, installed, activated. This creates advocates who promote the Hub.

**Recommended**:
- Install/activate funnel for each skill
- "How users found your skill" analytics
- Improvement suggestions based on scoring
- Embeddable badges for READMEs

### 3. Social Proof in Terminal

**Current State**: Scores exist but no social validation.

**Opportunity**: Terminal UX can include social proof without being a web app.

**Recommended**:
```
Recommended: playwright-skill by @lackeyjb
Score: 85/100 | 11.9K installs | Used by 23% of React+Testing projects
"Finally got my E2E tests working" - verified user
```

### 4. Progressive Disclosure Onboarding

**Current State**: `/discover tour` mentioned but not designed.

**Opportunity**: Guided first experience dramatically improves activation.

**Recommended**:
```
Welcome to Claude Discovery!

Step 1 of 3: Scanning your codebase...
    Detected: TypeScript, React, Jest, PostgreSQL

Step 2 of 3: Finding relevant skills...
    Found: 12 skills matching your stack

Step 3 of 3: Here are your top 3 recommendations:
    [Press Enter to see more, or 'skip' to explore on your own]
```

---

## Recommended Experiments

### Experiment 1: Activation Time Validation

**Hypothesis**: Users can reach first value in <5 minutes.

**Method**:
1. Recruit 20 Claude Code users (varied experience)
2. Screen record their first Discovery Hub session
3. Measure time to each milestone (install, scan, first recommendation, first skill install, first activation)
4. Define "value" as user's own assessment ("did you get something useful?")

**Success Criteria**: 80% reach self-reported value in <10 minutes.

**What We'll Learn**: Real activation time, primary drop-off points.

### Experiment 2: Recommendation Quality Baseline

**Hypothesis**: Content-based quality scores predict user satisfaction.

**Method**:
1. Generate recommendations for 50 real codebases
2. Show recommendations to codebase owners (blind to scores)
3. Ask: "Would you install this? Was this surprising/useful?"
4. Correlate scores with user responses

**Success Criteria**: Pearson r > 0.5 between quality score and "would install" rate.

**What We'll Learn**: Whether scoring model is directionally correct before launch.

### Experiment 3: Distribution Channel Efficiency

**Hypothesis**: Awesome list inclusion drives more sustained installs than launch posts.

**Method**:
1. Track install referrers (GitHub referrer header, UTM params)
2. Compare 30-day install volume from:
   - Launch day HN/Reddit posts
   - Awesome list inclusions (post-acceptance)
   - Organic GitHub discovery

**Success Criteria**: Awesome lists drive >2x installs per month vs. launch spike average.

**What We'll Learn**: Where to focus ongoing distribution effort.

### Experiment 4: Referral Mechanism A/B Test

**Hypothesis**: Embeddable skill badges drive more referrals than shareable recommendation files.

**Method**:
1. Implement both: (A) "Share recommendation" markdown export, (B) "Add badge to README" for installed skills
2. Track referral installs from each source
3. Run for 60 days post-launch

**Success Criteria**: One mechanism drives >3x referrals of other.

**What We'll Learn**: Which viral mechanic to invest in.

### Experiment 5: Cold Start Strategy Validation

**Hypothesis**: Exploration bonus (UCB1) improves new skill discovery without degrading satisfaction.

**Method**:
1. A/B test: (A) Pure quality score ranking, (B) Quality + exploration bonus
2. Track:
   - Install rate for skills <30 days old
   - Overall recommendation acceptance rate
   - User satisfaction scores

**Success Criteria**:
- New skill installs increase >50% in treatment
- Overall satisfaction unchanged (within 5%)

**What We'll Learn**: Whether exploration bonus is safe to deploy.

---

## Metrics Reassessment

### Current North Star: Weekly Active Discoverers (WAD)

**Verdict**: Good choice. Captures ongoing engagement, not just installs.

**Refinement**: Define "discover" precisely. Is it:
- Any search? (too easy to game)
- Codebase scan? (requires active engagement)
- Recommendation viewed? (passive)
- Skill installed? (conversion, not discovery)

**Recommendation**: WAD = users who ran codebase scan OR installed a recommended skill in past 7 days.

### Supporting Metrics Critique

| Metric | Current | Problem | Better Alternative |
|--------|---------|---------|-------------------|
| Total installs | 500 by Week 8 | Vanity metric. Doesn't indicate value. | Active installs (used in past 30 days) |
| Skills indexed | 50K+ | More isn't better if quality is low. | Verified skills (meeting quality threshold) |
| Recommendation accept rate | 65% target | Acceptance doesn't mean value. | Recommendation activation rate (accepted + activated) |
| Referral rate | 20% target | Unmeasurable without accounts. | Referral installs (trackable via UTM) |
| Exercises completed | 15K by Month 12 | Assumes curriculum is launched and popular. | Learning path completion rate (% who start and finish) |

### Proposed Metrics Framework

**North Star**: Weekly Active Discoverers (WAD)

**Leading Indicators** (predict future WAD):
- First-week activation rate (% of installs who scan codebase within 7 days)
- Recommendation relevance score (user feedback on recommendations)
- Return rate (% who come back after first session)

**Lagging Indicators** (confirm success):
- 30-day retention rate
- Net Promoter Score (quarterly survey)
- Organic install growth rate (excluding launches)

**Health Metrics** (watch for problems):
- Skill activation failure rate (should decrease)
- Average time to first value (should decrease)
- Support ticket volume (should stay low)

---

## Growth Roadmap Recommendation

### Phase 1: Validate Activation (Weeks 1-4)

**Goal**: Prove users can get value before scaling distribution.

**Actions**:
1. Run Experiment 1 (activation time)
2. Run Experiment 2 (recommendation quality)
3. Fix top 3 friction points identified
4. Define and instrument metrics

**Gate**: Proceed only if 70%+ of test users report value within 15 minutes.

### Phase 2: Seed Distribution (Weeks 5-8)

**Goal**: Establish presence in 3+ discovery channels.

**Actions**:
1. Submit to awesome lists (target 3 acceptances)
2. Create minimal web presence (GitHub Pages skill browser)
3. Soft launch in Claude Discord
4. Run Experiment 3 (distribution channel efficiency)

**Gate**: Proceed only if achieving 200+ organic weekly installs.

### Phase 3: Enable Virality (Weeks 9-12)

**Goal**: Implement and test referral mechanics.

**Actions**:
1. Build skill author dashboard
2. Implement embeddable badges
3. Run Experiment 4 (referral A/B test)
4. Double down on winning channel from Phase 2

**Gate**: Proceed only if referral rate exceeds 5%.

### Phase 4: Scale or Pivot (Months 4-6)

**Goal**: Achieve sustainable growth or identify pivot.

**Actions**:
- If growth: Expand team, pursue Anthropic partnership, add enterprise features
- If stagnant: Narrow to highest-value feature (likely learning curriculum), open-source core, reduce maintenance burden

---

## Final Assessment

### What's Strong

1. **Git-native architecture is differentiated**. No competitor offers this.
2. **Transparent scoring builds trust**. OpenSSF Scorecard approach is smart.
3. **Learning curriculum has standalone value**. Can succeed even if discovery fails.
4. **Realistic risk acknowledgment**. The 20% archive probability is honest.

### What Needs Work

1. **Distribution strategy is hope-based**. Need concrete, measurable channels.
2. **Activation assumptions are untested**. 5-minute target needs validation.
3. **Viral mechanics are weak**. Terminal tools don't spread through markdown files.
4. **Cold start is underestimated**. First 1000 users will have poor experience.

### My Prediction

| Outcome | Probability | Rationale |
|---------|-------------|-----------|
| Anthropic partnership/acquisition | 5% | They have no incentive; will build their own |
| Sustainable community project (5K+ users) | 20% | Requires hitting multiple uncertain milestones |
| Niche tool for power users (500-2K users) | 50% | Most likely outcome given distribution challenges |
| Archive after 6 months | 25% | Higher than their 20% if activation isn't fixed |

**The key unlock is NOT Anthropic partnership---it's proving that codebase-aware recommendations provide enough value that users actively recommend the tool to peers.** If that happens, distribution solves itself. If it doesn't, no amount of marketing will save the project.

### One Thing to Do First

Before writing any code: **Run Experiment 1 (activation time) with 10 real users.** Use manual processes (you curate recommendations, not an algorithm). If users don't get value from the *concept*, the *implementation* won't matter.

---

*Review completed December 26, 2025*
