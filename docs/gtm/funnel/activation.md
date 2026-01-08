# Funnel Stage: Activation

**Parent Document:** [Funnel Index](./index.md)
**Last Updated:** December 26, 2025

---

## Definition

**Activation:** The user gets first meaningful value from the product.

**Success:** User completes an action that demonstrates the product works for them.

---

## 1. Time-to-Value Target (Updated)

### 1.1 Original vs. Revised Target

| Metric | Original Target | Revised Target | Rationale |
|--------|----------------|----------------|-----------|
| Time to first value | 5 minutes | **15 minutes** | Realistic given documented 50% activation failure rate and multi-step install process |

From Growth Engineer review:

> "The 5-minute activation target is unrealistic given documented 50% skill activation failure rates and a multi-step installation process. Actual time-to-value is likely 15-30 minutes for most users."

### 1.2 Redefining "First Value"

**Old definition:** User installs and successfully uses a skill.

**New definition:** User sees personalized, non-obvious insight about their codebase.

**Why this matters:**
- First value happens earlier in the funnel
- Less dependent on external factors (skill activation)
- More reliable success metric

**Examples of first value:**
1. "Your React project is missing a testing skill. 85% of similar projects use one."
2. "There's a skill specifically for Prisma. You might not have known this existed."
3. "Based on your stack, you're in the top 15% of Claude Code sophistication."

---

## 2. Critical Path Analysis

### 2.1 Steps to First Value

```
┌─────────────────────────────────────────────────────────────────┐
│ STEP 1: Run install command                                      │
│ Time: 2-5 minutes | Drop-off: 20%                                │
│ Friction: Config issues, permission errors                       │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│ STEP 2: Skill index syncs                                        │
│ Time: 1-3 minutes | Drop-off: 10%                                │
│ Friction: Slow connection, timeout                               │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│ STEP 3: First codebase scan                                      │
│ Time: 2-5 minutes | Drop-off: 15%                                │
│ Friction: Scan errors, no recommendations                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│ STEP 4: User sees personalized insight (FIRST VALUE)             │
│ Time: Instant | Drop-off: 30%                                    │
│ Friction: Recommendations don't match needs                      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                v (Optional deeper engagement)
┌─────────────────────────────────────────────────────────────────┐
│ STEP 5: User installs recommended skill                          │
│ Time: 1-2 minutes | Drop-off: 10%                                │
│ Friction: Installation errors                                    │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│ STEP 6: Skill activates successfully (FULL VALUE)                │
│ Time: Variable | Drop-off: 50%                                   │
│ Friction: Model behavior, YAML issues, budget limits             │
└─────────────────────────────────────────────────────────────────┘

CUMULATIVE DROP-OFF TO FIRST VALUE: 55%
CUMULATIVE DROP-OFF TO FULL VALUE: 73%
```

### 2.2 Drop-off Reduction Plan

| Step | Current Drop-off | Target | Intervention | Phase |
|------|-----------------|--------|--------------|-------|
| Install | 20% | 10% | Install scripts, better docs | 1 |
| Sync | 10% | 5% | Progress bar, timeout handling | 1 |
| Scan | 15% | 10% | Partial results, graceful errors | 1 |
| First insight | 30% | 15% | Better matching, multiple options | 2 |
| Skill install | 10% | 5% | Streamlined commands | 2 |
| Activation | 50% | 35% | Activation auditor | 3 |

---

## 3. Onboarding Design

### 3.1 Terminal Onboarding

**Principles:**
- Progressive disclosure (don't overwhelm)
- Clear progress indication
- Celebrate milestones
- Provide exit points

**Onboarding flow:**

```
Welcome to Claude Discovery!

Step 1 of 3: Syncing skill index...
    [=========>                ] 45% | 23,456 skills indexed

Step 2 of 3: Scanning your codebase...
    Detected: TypeScript, React, Jest, PostgreSQL
    Analyzing 847 files...

Step 3 of 3: Finding relevant skills...

+------------------------------------------------------------------+
|                                                                   |
|  Based on your project, here's your top recommendation:           |
|                                                                   |
|  react-testing-patterns                                           |
|  "Comprehensive testing patterns for React components"            |
|                                                                   |
|  Score: 87/100 | 12,340 installs | Updated 3 days ago            |
|                                                                   |
|  Why this? You have React + Jest but no testing skill.            |
|  78% of similar projects use a testing skill.                     |
|                                                                   |
|  [Install This] [See 2 More Options] [Explore on My Own]          |
|                                                                   |
+------------------------------------------------------------------+
```

### 3.2 Web Onboarding

**First visit flow:**
1. Show search immediately (no gate)
2. If user searches, show results
3. If user browses, show categories
4. After any interaction, show "Try it in Claude Code" CTA

**Returning visit:**
1. Remember last search/category
2. Show "New since you visited" if applicable
3. Highlight install command prominently

### 3.3 VS Code Onboarding

**First install flow:**
1. Extension activates silently
2. First file open: Subtle tooltip appears
3. "Based on this file, you might like: [skill]"
4. User can dismiss, snooze, or explore

**Key principle:** Non-intrusive. Users are working, not shopping.

---

## 4. Failure Recovery

### 4.1 Designed Failure States

From Design Entry Points research:

> "The moment when something goes wrong is often the moment when love is won or lost."

#### Failure: Install Command Fails

**Current state:** User sees error message, gives up.

**Designed recovery:**
```
Install encountered an issue.

What happened: Permission denied when writing to ~/.claude/

Likely cause: You may need to run with elevated permissions.

Try this:
  sudo /plugin install discovery-hub@claude-discovery

Still not working?
  [View Troubleshooting Guide] [Report This Issue]
```

#### Failure: Scan Returns No Recommendations

**Current state:** "No recommendations found."

**Designed recovery:**
```
I couldn't find specific recommendations for your project yet.

What I tried:
- Analyzed 234 files
- Detected stack: Python (but no specific framework)
- Searched 46,847 skills for matches

This happens when:
- Your stack is uncommon (we're always adding more)
- The project is very new (not enough signals)

What you can do:
- [Browse all Python skills] (127 available)
- [Tell us what you're building] (improves future recommendations)
- [Search manually] with specific keywords
```

#### Failure: Skill Doesn't Activate

**Current state:** Silent failure. User confused.

**Designed recovery (Phase 3: Activation Auditor):**
```
It looks like systematic-debugging didn't activate as expected.

Diagnosis:
- Skill is installed correctly
- YAML is valid
- Character budget: OK (8,234/15,000)
- Issue found: Description doesn't match your task

Your task: "Fix bug in authentication"
Skill triggers: "systematic debugging workflows"

Options:
1. Rephrase: "Help me systematically debug authentication"
2. Force: /skill use systematic-debugging
3. Try alternative: debugging-assistant (89% match)

This is a known limitation of Claude skill activation.
Learn more: [Why skills don't always activate]
```

### 4.2 Error Message Principles

1. **Acknowledge the failure** - Don't pretend it didn't happen
2. **Explain what happened** - Technical but accessible
3. **Show what we tried** - Demonstrate effort
4. **Provide next steps** - Always a path forward
5. **Collect feedback** - Help us improve

---

## 5. Persona-Specific Activation

### 5.1 The Skeptic

**Activation goal:** Prove value without commitment

**Approach:**
- Allow full browsing without install
- Show quality scores, explain methodology
- Provide "try before you buy" preview
- Emphasize easy uninstall

**First message:**
```
You don't have to install anything to browse skills.

When you're ready, installation takes one command
and uninstall is just as easy.

No account. No tracking (unless you opt in).
We're not going anywhere with your data.
```

### 5.2 The Overwhelmed

**Activation goal:** Reduce cognitive load

**Approach:**
- One recommendation, not many
- Clear "recommended" choice
- Defer complexity
- Social proof ("78% of React developers...")

**First message:**
```
Let's keep this simple.

Based on your project, one skill would help most:

  frontend-design
  "Create distinctive, production-grade interfaces"

This takes 30 seconds to install and 30 seconds to undo
if you change your mind.

[Install This One]  [Show Me Alternatives]  [Later]
```

### 5.3 The Explorer

**Activation goal:** Enable discovery

**Approach:**
- Categories, not single recommendation
- "Trending" and "New" sections
- Comparison tools
- No pressure to install

**First message:**
```
Your project stack: React, TypeScript, Jest

Here's what developers with similar stacks are exploring:

Testing (23 skills)     Frontend (45 skills)
Debugging (18 skills)   Documentation (12 skills)

[Browse by category]  [See trending]  [Random discovery]
```

---

## 6. Activation Metrics

### 6.1 Primary Metrics

| Metric | Definition | Target | Measurement |
|--------|------------|--------|-------------|
| Time to first value | Median time from install to first insight | <15 min | Instrumentation |
| Activation rate | % who see personalized insight | 45%+ | Funnel tracking |
| Install success rate | % who complete install without error | 80%+ | Error tracking |

### 6.2 Step-by-Step Metrics

| Step | Metric | Target |
|------|--------|--------|
| Install command | Success rate | 80%+ |
| Index sync | Completion rate | 90%+ |
| Codebase scan | Success rate | 85%+ |
| First insight shown | Relevance rating | 3.5/5+ |
| Skill installed | Install rate | 30%+ |
| Skill activated | Activation rate | 50%+ |

### 6.3 Experiment: Activation Time Validation

From Growth Engineer recommendations:

**Hypothesis:** Users can reach first value in <15 minutes.

**Method:**
1. Recruit 20 Claude Code users (varied experience)
2. Screen record first Discovery Hub session
3. Measure time to each milestone
4. Define "value" as user's own assessment

**Success criteria:** 80% reach self-reported value in <15 minutes.

---

## 7. Activation Summary by Phase

### Phase 1 (Weeks 5-8)

**Focus:** Core flow works reliably

**Interventions:**
- Install script with error handling
- Progress indicators for sync
- Graceful scan failures
- Basic recommendation display

**Target:** 40% activation rate

### Phase 2 (Weeks 9-12)

**Focus:** Personalized first value

**Interventions:**
- Stack-aware recommendations
- "Why this?" explanations
- Persona-specific onboarding
- Designed failure states

**Target:** 50% activation rate, <15 min median

### Phase 3 (Weeks 13-16)

**Focus:** Activation auditor reduces failure

**Interventions:**
- Pre-install validation
- Post-install health check
- Activation diagnostics
- Auto-fix for common issues

**Target:** 25% improvement in perceived activation success

---

## Related Documents

- [Retention & Referral](./retention-referral.md) - After first value
- [Experiments](../experiments.md) - Activation experiments

---

**Next:** [Retention & Referral](./retention-referral.md)
