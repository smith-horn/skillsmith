# Growth Experiments

**Parent Document:** [GTM Index](./index.md)
**Last Updated:** December 26, 2025

---

## Purpose

This document defines experiments to validate growth assumptions before investing in full implementation. Each experiment follows a structured hypothesis-method-success criteria format.

---

## 1. Phase 0 Experiments (Validation Sprint)

### Experiment 1: Activation Time Validation

**Hypothesis:** Users can reach first value in <15 minutes.

**Risk Being Mitigated:** Building a product with unrealistic time-to-value expectations.

**Method:**
1. Recruit 20 Claude Code users (varied experience levels)
2. Provide Discovery Hub in prototype/manual state
3. Screen record their first session
4. Measure time to each milestone:
   - Install complete
   - Scan complete
   - First recommendation seen
   - First skill installed
   - First activation (if attempted)
5. Ask: "Did you get something useful?" at 5, 10, 15, 20 minutes

**Success Criteria:**
- 80% reach self-reported value in <15 minutes
- Median time to first value <12 minutes
- No critical blocker identified in >30% of users

**Decision if Fails:**
- If median >20 minutes: Simplify scope, defer recommendations
- If blocker >30%: Fix blocker before proceeding

**Effort:** 40 hours (recruitment, sessions, analysis)
**Timeline:** Week 1-2

---

### Experiment 2: Recommendation Quality Baseline

**Hypothesis:** Content-based quality scores predict user satisfaction.

**Risk Being Mitigated:** Building recommendations on an ineffective scoring model.

**Method:**
1. Generate recommendations for 50 real codebases (manual or automated)
2. Present recommendations to codebase owners (blind to scores)
3. Ask:
   - "Would you install this?" (Y/N)
   - "Is this surprising/useful?" (1-5 scale)
   - "What did we miss?" (open text)
4. Calculate correlation between quality score and "would install" rate

**Success Criteria:**
- Pearson r > 0.5 between quality score and "would install" rate
- At least 3 of top 5 recommendations rated useful (3+/5)
- No systematic miss (pattern of missed obvious recommendations)

**Decision if Fails:**
- If r < 0.3: Revisit scoring model fundamentals
- If systematic misses: Add missing signals to scoring

**Effort:** 30 hours
**Timeline:** Week 2-3

---

### Experiment 3: Demand Validation

**Hypothesis:** 70%+ of Claude Code users express willingness to change behavior for this solution.

**Risk Being Mitigated:** Building a product nobody wants.

**Method:**
1. Conduct 15 user interviews with active Claude Code users
2. Explore current skill discovery workflow
3. Present concept (not product) of codebase-aware recommendations
4. Ask:
   - "Would you use this?" (1-5 scale)
   - "Would you change your current workflow?" (Y/N, why)
   - "What would make you not use this?" (barriers)
5. Code responses for themes

**Success Criteria:**
- 70%+ rate interest 4-5
- 70%+ say they'd change workflow
- No fatal barrier in >30% of responses

**Decision if Fails:**
- If <50% interested: Consider narrower wedge (CLAUDE.md generator only)
- If fatal barrier >30%: Address barrier before proceeding

**Effort:** 30 hours
**Timeline:** Week 1-3

---

## 2. Phase 1 Experiments (Foundation)

### Experiment 4: Distribution Channel Efficiency

**Hypothesis:** Awesome list inclusion drives more sustained installs than launch posts.

**Risk Being Mitigated:** Investing in low-ROI channels.

**Method:**
1. Implement referrer tracking (UTM params, GitHub referrer)
2. Track install volume by source for 30 days post-launch
3. Compare:
   - Launch day HN/Reddit posts (spike)
   - Awesome list inclusions (steady)
   - Organic GitHub discovery (baseline)
4. Calculate installs per effort hour for each channel

**Success Criteria:**
- Awesome lists drive >2x monthly installs vs. launch spike average (by month 2)
- At least one channel achieves <0.1 hr/user efficiency

**Decision if Fails:**
- If no channel <0.2 hr/user: Reconsider GTM strategy
- If launch spike only: Focus on improving retention, not acquisition

**Effort:** 10 hours (setup), ongoing tracking
**Timeline:** Week 5-8

---

### Experiment 5: Install Flow Optimization

**Hypothesis:** Install error rate can be reduced from 20% to 10% with better scripts.

**Risk Being Mitigated:** Losing users to preventable install failures.

**Method:**
1. Implement install event tracking (started, completed, failed, error_code)
2. Run 50 test installs across different environments
3. Categorize failures
4. Build install script with error handling for top 3 failure modes
5. Re-test with 50 new users

**Success Criteria:**
- Install success rate improves from 80% to 90%+
- Time to install decreases by 30%

**Decision if Fails:**
- If still <85%: Document failures, provide manual workarounds
- If specific environment causes >50% of failures: Document as unsupported

**Effort:** 20 hours
**Timeline:** Week 5-7

---

## 3. Phase 2 Experiments (Growth)

### Experiment 6: Referral Mechanism A/B Test

**Hypothesis:** Embeddable skill badges drive more referrals than shareable recommendation files.

**Risk Being Mitigated:** Investing in viral mechanics that don't work.

**Method:**
1. Implement both mechanisms:
   - (A) "Share recommendation" markdown export
   - (B) "Add badge to README" for installed skills
2. Track referral installs from each source (UTM)
3. Run for 60 days post-launch

**Success Criteria:**
- One mechanism drives >3x referrals of other
- Winning mechanism achieves >0.5 referrals per active author

**Decision if Fails:**
- If both <0.1 referrals per user: Abandon referral artifacts, focus on word-of-mouth
- If tie: Continue both, iterate on design

**Effort:** 30 hours (implementation), tracking
**Timeline:** Week 9-16

---

### Experiment 7: VS Code vs. Web Conversion

**Hypothesis:** VS Code extension converts awareness to activation at higher rate than web browser.

**Risk Being Mitigated:** Investing in wrong entry point.

**Method:**
1. Track conversion funnel for both entry points:
   - Web: Visit -> Browse -> Copy install -> Install
   - VS Code: Install extension -> View suggestion -> Install skill
2. Compare conversion rates at each stage
3. Run for 30 days post-launch

**Success Criteria:**
- One channel has >50% higher install conversion rate
- Both channels contribute >100 installs/month

**Decision if Fails:**
- If web >2x VS Code: Deprioritize VS Code enhancements
- If VS Code >2x web: Invest more in IDE integrations

**Effort:** 10 hours (tracking setup)
**Timeline:** Week 9-12

---

### Experiment 8: Cold Start Strategy Validation

**Hypothesis:** Exploration bonus (UCB1) improves new skill discovery without degrading satisfaction.

**Risk Being Mitigated:** Exploration bonus hurts user experience.

**Method:**
1. A/B test:
   - (A) Pure quality score ranking
   - (B) Quality + exploration bonus
2. Track:
   - Install rate for skills <30 days old
   - Overall recommendation acceptance rate
   - User satisfaction scores (quick survey)

**Success Criteria:**
- New skill installs increase >50% in treatment (B)
- Overall satisfaction unchanged (within 5%)

**Decision if Fails:**
- If satisfaction drops >10%: Remove exploration bonus
- If new skill installs unchanged: Increase exploration weight

**Effort:** 20 hours
**Timeline:** Week 9-12

---

## 4. Phase 3 Experiments (Differentiation)

### Experiment 9: Activation Auditor Impact

**Hypothesis:** Activation auditor increases perceived activation success by 25%.

**Risk Being Mitigated:** Building feature that doesn't improve user experience.

**Method:**
1. Survey users on activation experience (baseline, pre-auditor)
2. Launch activation auditor
3. Survey users on activation experience (post-auditor)
4. Compare:
   - "Did your last skill activate as expected?" (Y/N)
   - "How confident are you skills will work?" (1-5)

**Success Criteria:**
- "Activated as expected" increases from ~50% to 65%+
- Confidence score increases by 0.5+ points

**Decision if Fails:**
- If <10% improvement: Iterate on auditor design
- If no improvement: Consider pivoting to simpler diagnostics

**Effort:** 20 hours (surveys, analysis)
**Timeline:** Week 13-16

---

### Experiment 10: Author Dashboard Engagement

**Hypothesis:** Authors who receive dashboard access embed badges at 40%+ rate.

**Risk Being Mitigated:** Author virality loop doesn't engage authors.

**Method:**
1. Email top 50 skill authors with dashboard invitation
2. Track:
   - Dashboard login rate
   - Badge embed rate (within 30 days)
   - Return visits to dashboard

**Success Criteria:**
- 50%+ login to dashboard at least once
- 40%+ of those who login embed badge
- 20%+ return within 30 days

**Decision if Fails:**
- If <30% login: Improve outreach messaging
- If <20% embed: Add more compelling badge designs

**Effort:** 20 hours (outreach, tracking)
**Timeline:** Week 13-16

---

## 5. Phase 4 Experiments (Scale)

### Experiment 11: Learning Path Completion

**Hypothesis:** 50% of users who start learning path will complete it.

**Risk Being Mitigated:** Learning path abandonment.

**Method:**
1. Track learning path progress:
   - Start rate (% of active users who start)
   - Stage completion (per exercise)
   - Completion rate (finish all 5 exercises)
2. Survey completers and abandoners

**Success Criteria:**
- 30%+ of active users start learning path
- 50%+ of starters complete
- Abandonment survey reveals fixable issues

**Decision if Fails:**
- If <20% start: Improve awareness/positioning
- If <30% complete: Shorten path or add incentives

**Effort:** 15 hours (tracking, surveys)
**Timeline:** Week 17-20

---

### Experiment 12: Public Profile Virality

**Hypothesis:** Public profiles generate measurable referral traffic.

**Risk Being Mitigated:** Public profiles don't drive growth.

**Method:**
1. Launch public profiles with sharing features
2. Track:
   - Profile views (external vs. internal)
   - "Clone setup" clicks
   - Referral installs from profile links

**Success Criteria:**
- 500+ public profiles created
- Average profile generates 5+ views/month
- 10%+ of profile views result in Discovery Hub awareness (visit or install)

**Decision if Fails:**
- If <100 profiles: Add incentives (badges, recognition)
- If <1% conversion: Improve "clone setup" experience

**Effort:** 10 hours (tracking)
**Timeline:** Week 17-20

---

## 6. Experiment Prioritization

### Priority Matrix

| Experiment | Phase | Risk Mitigated | Effort | Priority |
|------------|-------|----------------|--------|----------|
| Activation Time Validation | 0 | Unrealistic expectations | High | P0 |
| Recommendation Quality | 0 | Bad recommendations | Medium | P0 |
| Demand Validation | 0 | No market | Medium | P0 |
| Channel Efficiency | 1 | Wasted distribution effort | Low | P1 |
| Install Flow Optimization | 1 | User loss | Medium | P1 |
| Referral Mechanism A/B | 2 | Wrong viral mechanic | Medium | P1 |
| VS Code vs. Web | 2 | Wrong entry point focus | Low | P2 |
| Cold Start Validation | 2 | Poor recommendations | Medium | P2 |
| Auditor Impact | 3 | Useless feature | Medium | P1 |
| Author Dashboard | 3 | No author engagement | Medium | P1 |
| Learning Completion | 4 | Path abandonment | Low | P2 |
| Profile Virality | 4 | Profiles don't grow | Low | P2 |

### Experiment Calendar

| Week | Experiments Running |
|------|---------------------|
| 1-2 | Activation Time, Demand Validation |
| 2-3 | Recommendation Quality, Demand Validation |
| 3-4 | All Phase 0 complete, gate decision |
| 5-8 | Channel Efficiency, Install Flow |
| 9-12 | Referral A/B, VS Code vs. Web, Cold Start |
| 13-16 | Auditor Impact, Author Dashboard |
| 17-20 | Learning Completion, Profile Virality |

---

## 7. Experiment Template

For new experiments, use this template:

```markdown
### Experiment N: [Name]

**Hypothesis:** [One sentence hypothesis]

**Risk Being Mitigated:** [What bad outcome are we avoiding?]

**Method:**
1. [Step 1]
2. [Step 2]
3. [Step N]

**Success Criteria:**
- [Specific, measurable criterion 1]
- [Specific, measurable criterion 2]

**Decision if Fails:**
- If [condition]: [action]

**Effort:** [Hours]
**Timeline:** [Weeks]
```

---

## Related Documents

- [Metrics](./metrics.md) - How we measure experiment outcomes
- [Risks](./risks.md) - Risks that experiments mitigate

---

**Next:** [Risks](./risks.md)
