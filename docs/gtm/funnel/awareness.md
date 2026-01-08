# Funnel Stage: Awareness

**Parent Document:** [Funnel Index](./index.md)
**Last Updated:** December 26, 2025

---

## Definition

**Awareness:** The user learns that Discovery Hub exists and understands what it does.

**Success:** User has enough information to decide whether to try the product.

---

## 1. Entry Points (Updated from Design Research)

### 1.1 Entry Points Matrix

Based on [Design Entry Points Research](../../research/design-entry-points.md):

| Entry Point | Phase | Primary Persona | Emotional State | First Impression Goal |
|-------------|-------|-----------------|-----------------|----------------------|
| **Web skill browser** | 2 | Explorer, Skeptic | Curious, evaluating | "This looks comprehensive and trustworthy" |
| **VS Code extension** | 2 | Optimizer, Overwhelmed | Working, distracted | "This integrates naturally into my workflow" |
| **GitHub README** | 1 | Explorer, Skeptic | Researching | "This is well-documented and maintained" |
| **Awesome list link** | 1 | Explorer | Browsing | "Others have vetted this" |
| **Public skill profile** | 3 | Explorer | Curious about someone | "I want what they have" |
| **Author badge** | 2 | Explorer | Reading skill README | "This skill is verified" |
| **HN/Reddit post** | 1 | Mixed | Browsing community | "This solves a real problem" |
| **Word of mouth** | 1+ | Mixed | Trusting recommendation | "Someone I trust uses this" |

### 1.2 Entry Point Design Requirements

#### Web Skill Browser (Phase 2)

**First impression elements:**
- Clear value proposition above the fold
- Search that works immediately
- Visual skill cards (not text list)
- Quality scores visible
- Category browsing
- No login required

**Copy tone:** Professional, trustworthy, not salesy

**Example hero:**
```
Discover Claude skills that actually work

Search 46,000+ skills with quality scores,
activation verification, and stack-aware
recommendations.

[Search skills...                    ] [Search]

Popular: testing | debugging | frontend | documentation
```

#### VS Code Extension (Phase 2)

**First impression elements:**
- Minimal sidebar footprint
- Context-aware (shows relevant skills for open file)
- Non-intrusive notifications
- Clear value in <10 seconds

**Onboarding flow:**
1. Extension installs
2. Brief tooltip: "Discovery Hub will suggest skills based on your project"
3. First file opened: Contextual suggestion appears
4. User can dismiss or explore

#### GitHub README

**Essential elements:**
- Clear one-sentence description
- Install command prominently displayed
- GIF or screenshot of key feature
- Quality badges (if applicable)
- "Why this exists" section for Skeptics
- Quick start (under 5 min)

---

## 2. Messaging by Persona

### 2.1 The Skeptic

**Fear:** "I've been burned by tools before"

**Messaging principles:**
- Lead with limitations, not features
- Emphasize transparency
- Provide easy exit
- Show evidence, not claims

**Example copy:**
```
We're honest about what Discovery Hub does and doesn't do.

It helps you find skills. It verifies they'll probably work.
It doesn't fix Claude's 50% activation failure rate (that's
on Anthropic).

No account required. Uninstall anytime with one command.

[View our failure rate transparency report]
```

### 2.2 The Overwhelmed

**Fear:** "There are 50,000 skills. How do I choose?"

**Messaging principles:**
- Lead with one recommendation
- Minimize options
- Provide clear path
- Use social proof

**Example copy:**
```
Don't browse 46,000 skills. Just answer one question:

What are you working on?

[React]  [Python]  [Testing]  [Documentation]  [Other]

We'll show you the one skill to start with.
```

### 2.3 The Explorer

**Motivation:** "I want to see what's out there"

**Messaging principles:**
- Enable browsing
- Show variety
- Surface surprises
- Don't force decisions

**Example copy:**
```
Browse 46,000+ Claude skills

[Categories]    [Trending]    [New This Week]    [Top Rated]

Filter by: [Stack v] [Use Case v] [Quality v]

No install needed to browse. Try it.
```

---

## 3. First Impression Optimization

### 3.1 Web Skill Browser

**Above the fold checklist:**
- [ ] Value proposition in <10 words
- [ ] Search bar immediately visible
- [ ] No login wall
- [ ] Visual proof (skill cards, screenshots)
- [ ] Trust signals (stars, user count, Anthropic mention if applicable)

**Performance targets:**
- First contentful paint: <1s
- Interactive: <2s
- Search results: <500ms

### 3.2 GitHub README

**First 10 lines checklist:**
- [ ] One-sentence description
- [ ] Install command
- [ ] What problem it solves
- [ ] Quick demo (GIF or screenshot)

**Example structure:**
```markdown
# Claude Discovery Hub

Find Claude Code skills that actually work.

## Quick Start

```bash
/plugin install discovery-hub@claude-discovery
```

## What It Does

- Search 46,000+ skills from one place
- Quality scores so you know what's good
- Activation verification so you know it works
- Stack-aware recommendations for your project

![Demo](./demo.gif)

[Full Documentation](https://discoveries.dev/docs)
```

### 3.3 VS Code Marketplace

**Listing optimization:**
- Clear, keyword-rich title
- Feature list with emojis
- Screenshots of UI
- Comparison to alternatives
- Quick "get started" section

---

## 4. Traffic Acquisition

### 4.1 Organic Search (SEO)

**Target keywords:**

| Keyword | Search Volume | Competition | Target Page |
|---------|--------------|-------------|-------------|
| "claude code skills" | Medium | Low | Homepage |
| "best claude skills for react" | Low | None | /for/react |
| "claude skill not working" | Low | None | /docs/troubleshooting |
| "how to find claude skills" | Low | None | Homepage |
| "claude skills list" | Medium | Low | /skills |

**Content strategy:**
- Category pages for each major use case
- Troubleshooting content for problem searches
- Comparison pages (us vs. alternatives)

### 4.2 Social Traffic

**Shareability elements:**
- Public profiles (Phase 3)
- Skill comparison links
- Badge embeds
- Learning achievements

**Social proof displays:**
- "12,340 developers use this skill"
- "Used by developers at [company logos]"
- "Top skill in Testing category"

### 4.3 Referral Traffic

**Referral sources:**
- Skill author READMEs (badges)
- Blog post mentions
- Discord/Reddit recommendations
- Word of mouth

**Tracking:**
- UTM parameters for all links
- Referrer analysis
- Source attribution in analytics

---

## 5. Awareness Metrics

### 5.1 Primary Metrics

| Metric | Definition | Target (Phase 2) |
|--------|------------|------------------|
| Monthly unique visitors | Distinct users visiting any property | 5,000+ |
| Awareness-to-attempt rate | % of visitors who run install | 10%+ |
| Source diversity | % from top 3 sources | <60% |

### 5.2 Channel-Specific Metrics

| Channel | Metric | Target |
|---------|--------|--------|
| Web browser | Monthly visitors | 3,000+ |
| VS Code | Marketplace impressions | 5,000+ |
| GitHub README | Visitors | 1,000+ |
| Awesome lists | Referral clicks | 500+ |
| Social | Impressions | 10,000+ |

### 5.3 Tracking Implementation

```javascript
// Event tracking examples
analytics.track('page_view', {
  source: utm_source,
  medium: utm_medium,
  campaign: utm_campaign,
  page: path
});

analytics.track('install_command_viewed', {
  source: referrer,
  page: path
});

analytics.track('vs_code_install_clicked', {
  source: 'marketplace'
});
```

---

## 6. Awareness Stage Summary

### 6.1 Phase 1 (Weeks 5-8)

**Focus:** Establish presence

**Actions:**
- GitHub README optimized
- Awesome list submissions
- Discord/Reddit soft launch

**Target:** 500+ visitors, 50+ installs

### 6.2 Phase 2 (Weeks 9-12)

**Focus:** Multi-surface presence

**Actions:**
- Launch web skill browser
- Ship VS Code extension
- Begin SEO content

**Target:** 3,000+ visitors, 300+ installs

### 6.3 Phase 3-4 (Weeks 13-20)

**Focus:** Compound growth

**Actions:**
- Public profiles for social sharing
- Content marketing
- Author badge adoption

**Target:** 5,000+ visitors, 500+ installs monthly

---

## Related Documents

- [Activation](./activation.md) - Converting awareness to first value
- [Entry Points Research](../../research/design-entry-points.md) - Deep dive on personas

---

**Next:** [Activation](./activation.md)
