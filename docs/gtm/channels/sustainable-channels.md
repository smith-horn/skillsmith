# Sustainable Channels

**Parent Document:** [Channels Index](./index.md)
**Last Updated:** December 26, 2025

---

## Purpose

Sustainable channels provide ongoing, predictable growth that compounds over time. Unlike launch channels (one-time spikes), these require upfront investment but deliver long-term returns.

**Timeline:** Phase 1-4 (Weeks 5-20+)

---

## 1. Web Skill Browser (SEO)

### 1.1 Strategic Rationale

From Growth Engineer review:

> "Build a minimal web presence (GitHub Pages) with SEO-optimized content. 'Claude Code skills for React,' 'Best Claude skills for testing,' etc. These searches happen. Intercept them."

**Key insight:** No competitor is optimizing for "Claude skills for X" searches. First-mover advantage in SEO is significant.

### 1.2 Implementation Phases

#### Phase 1: Minimal (GitHub Pages)

**Scope:**
- Static site with skill listing
- Basic search functionality
- Category pages for SEO
- Install command copy button

**Effort:** 20-30 hours
**Expected:** Foundation only; minimal traffic initially

#### Phase 2: Full Browser

**Scope:**
- Full-featured skill catalog
- Side-by-side comparison
- Quality scores displayed prominently
- User reviews (if ready)
- Author profiles
- "Works well with" relationships

**Effort:** 60-80 hours
**Expected:** 5,000+ monthly visitors by Week 16

### 1.3 SEO Strategy

**Target Keywords (Long-tail):**

| Keyword | Monthly Searches (est.) | Competition | Priority |
|---------|------------------------|-------------|----------|
| "claude code skills" | 500-1,000 | Low | P0 |
| "best claude skills" | 200-500 | Low | P0 |
| "claude skills for react" | 100-200 | None | P0 |
| "claude skills for testing" | 50-100 | None | P1 |
| "claude skill tutorial" | 100-200 | Low | P1 |
| "how to find claude skills" | 50-100 | None | P1 |

**Page Structure:**

```
discoveries.dev/
├── / (home - skill browser)
├── /skills (all skills listing)
├── /skills/{id} (individual skill page)
├── /categories/{name} (category page)
├── /for/react (stack-specific page)
├── /for/testing (use-case page)
├── /compare (comparison tool)
├── /@{username} (public profiles, Phase 3)
└── /learn (learning paths, Phase 4)
```

### 1.4 Expected Results

| Phase | Monthly Visitors | Installs/Month | Cumulative (Year 1) |
|-------|-----------------|----------------|---------------------|
| Phase 1 | 100-200 | 10-20 | 50-100 |
| Phase 2 | 2,000-3,000 | 100-200 | 500-800 |
| Phase 3 | 4,000-5,000 | 200-300 | 1,000-1,500 |
| Phase 4 | 5,000-8,000 | 300-500 | 2,000+ |

---

## 2. VS Code Extension

### 2.1 Strategic Rationale

From Design Entry Points research:

> "VS Code is where developers spend their time. Meeting them there removes the friction of context-switching."

**Key insight:** VS Code Marketplace has built-in discovery. Extensions can rank in search results and categories.

### 2.2 Features by Phase

#### Phase 2: Basic Extension

**Scope:**
- Sidebar panel with skill browser
- Context-aware suggestions based on open file
- One-click install (generates terminal command)
- Settings for notification preferences

**Effort:** 60-80 hours

#### Phase 3: Enhanced Extension

**Scope:**
- Learning progress tracker
- Activation auditor integration
- "What's this skill doing?" tooltip
- Quality score display

**Effort:** 40-60 hours additional

### 2.3 Marketplace Strategy

**Category:** "AI & Machine Learning" or "Other"

**Keywords:**
- claude code
- ai skills
- claude skills
- mcp
- skill discovery

**Reviews strategy:**
1. Ask early adopters to review
2. Respond to all reviews (positive and negative)
3. Fix issues mentioned in negative reviews quickly

### 2.4 Expected Results

| Metric | 3 Months | 6 Months | 12 Months |
|--------|----------|----------|-----------|
| Total installs | 300-500 | 700-1,000 | 1,500-2,000 |
| Active users | 100-200 | 300-500 | 700-1,000 |
| Avg rating | 4.0+ | 4.2+ | 4.5+ |

---

## 3. Author Virality Engine

### 3.1 Strategic Rationale

From Growth Engineer review:

> "Focus on skill author virality. Authors have incentive to promote their skills. Give them tools: embeddable score badges, 'Get this skill' buttons, download/install tracking dashboards."

**Key insight:** Every skill author is a potential marketer. Their README is a potential acquisition channel.

### 3.2 Components

#### 3.2.1 Embeddable Badges

**Types:**
- Quality score badge
- Download count badge
- "Compatible with" badge
- "Verified by Discovery Hub" badge

**Implementation:**
```markdown
![Quality Score](https://discoveries.dev/badge/score/{skill-id})
![Downloads](https://discoveries.dev/badge/downloads/{skill-id})
```

**Effort:** 10-15 hours (serverless badge generation)

#### 3.2.2 Author Dashboard

**Features:**
- Download/install statistics
- Quality score breakdown
- Improvement suggestions
- "How users found your skill" analytics
- Comparison to similar skills
- Version adoption curve

**Effort:** 40-60 hours

#### 3.2.3 "Get This Skill" Button

**Implementation:**
```html
<a href="https://discoveries.dev/skills/{id}?ref=readme">
  <img src="https://discoveries.dev/button/install/{id}" />
</a>
```

**Effort:** 5-10 hours

### 3.3 Author Adoption Funnel

```
All indexed skills (46K+)
         |
         v
Skills with active maintainer (est. 5K)
         |
         v
Maintainers aware of Discovery Hub (target: 500)
         |
         v
Maintainers who add badges (target: 100)
         |
         v
Badges generate clicks (est. 10/badge/month)
         |
         v
Clicks convert to users (est. 20%)
         |
         v
New users per month: 100-300
```

### 3.4 Author Outreach Strategy

**Phase 2 (Weeks 9-12):**
1. Identify top 50 skills by quality score
2. Email authors with dashboard invitation
3. Provide personalized quality report
4. Include badge embed code

**Template:**
```
Subject: Your Claude skill "{name}" - quality report

Hi {author},

Your skill "{name}" is indexed in Discovery Hub with a
quality score of {score}/100.

Here's your detailed breakdown:
- Documentation: {doc_score}/25
- Community: {community_score}/25
- Maintenance: {maintenance_score}/25
- Reliability: {reliability_score}/25

Top improvement opportunity: {top_suggestion}

Add this badge to your README:
![Score](https://discoveries.dev/badge/score/{id})

View your full dashboard: {dashboard_link}

{signature}
```

**Expected results:**
- 20% response rate (10 of 50)
- 40% badge adoption among respondents (4 of 10)
- Scale to 100+ badges by Week 16

---

## 4. Content Marketing

### 4.1 Content Types

| Type | Effort | Frequency | Expected Impact |
|------|--------|-----------|-----------------|
| Blog posts | High | 2/month | SEO, authority |
| Tutorials | Medium | 1/month | User education |
| Changelog updates | Low | Weekly | Retention |
| Social threads | Low | 2/week | Awareness |

### 4.2 Blog Topics by Phase

**Phase 2:**
- "How to evaluate Claude skill quality"
- "5 skills every React developer should know"
- "Why skill activation fails (and how to fix it)"

**Phase 3:**
- "The activation auditor: How it works"
- "Skill author success stories"
- "Building your first Claude skill"

**Phase 4:**
- "Learning Claude Code: A structured approach"
- "Team skill standardization best practices"
- "The future of AI-assisted development"

### 4.3 Distribution

**Blog posts:**
- Cross-post to dev.to, hashnode
- Share in Claude Discord
- Tweet thread summary

**Expected results:**
- 500-1,000 views per post
- 10-30 installs per popular post
- SEO value compounds over time

---

## 5. Sustainable Channels Summary

### 5.1 Investment vs. Return

| Channel | Upfront Investment | Ongoing Effort | Year 1 Users |
|---------|-------------------|----------------|--------------|
| Web browser | 80-100 hrs | 10 hrs/mo | 2,000+ |
| VS Code extension | 80-120 hrs | 5 hrs/mo | 1,000-1,500 |
| Author virality | 60-80 hrs | 5 hrs/mo | 1,500+ |
| Content marketing | 20 hrs initial | 10 hrs/mo | 500-1,000 |
| **Total** | **240-320 hrs** | **30 hrs/mo** | **5,000+** |

### 5.2 Compound Growth Model

```
Month 1: 100 users (launch spike)
Month 2: 150 users (+50% organic growth)
Month 3: 250 users (web browser launches)
Month 4: 400 users (VS Code extension)
Month 5: 600 users (author badges scaling)
Month 6: 850 users (content SEO kicking in)
...
Month 12: 3,000+ users (compound effect)
```

### 5.3 Success Metrics

| Channel | Primary Metric | Target (Month 6) |
|---------|---------------|------------------|
| Web browser | Monthly visitors | 5,000+ |
| VS Code extension | Active installs | 500+ |
| Author badges | Repos with badges | 100+ |
| Content | Monthly post views | 2,000+ |

---

## Related Documents

- [Partnership Channels](./partnership-channels.md) - Acceleration strategies
- [Funnel: Awareness](../funnel/awareness.md) - First touch optimization

---

**Next:** [Partnership Channels](./partnership-channels.md)
