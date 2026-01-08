# GTM Strategy Overview

**Parent Document:** [GTM Index](./index.md)
**Last Updated:** December 26, 2025

---

## 1. Strategic Context

### 1.1 Market Opportunity

The Claude Code skills ecosystem is at an inflection point:

| Factor | Current State | Implication |
|--------|--------------|-------------|
| **Skill Volume** | 46,000+ skills across fragmented sources | Discovery is genuinely hard |
| **Quality Variance** | No standardized quality metrics | Users can't evaluate effectively |
| **Activation Failure** | ~50% of skills fail to activate reliably | Trust is fragile |
| **Official Tooling** | Basic `/plugin discover` command | Gap for value-added discovery |

### 1.2 The Distribution Challenge

**Core Problem:** Terminal tools are invisible.

Unlike mobile apps (App Store), web tools (Google/SEO), or IDE extensions (VS Code Marketplace), CLI tools have no natural discovery surface. Every user must be actively acquired through:

1. **Content marketing** - Blog posts, tutorials, social media
2. **Community presence** - Discord, Reddit, HN
3. **Referral** - Word of mouth, team sharing
4. **Integration** - Showing up in existing workflows

**This is expensive.** Most CLI tools fail not because they're bad, but because nobody knows they exist.

### 1.3 Strategic Response: Multi-Surface Presence

The solution is to **create discovery surfaces** rather than relying on them:

```
                    +-----------------+
                    |   Web Browser   | <-- SEO, browsing, sharing
                    +-----------------+
                            |
                            v
+----------------+  +-----------------+  +------------------+
| VS Code Ext    |->|  Claude Code    |<-| GitHub Action    |
| (IDE sidebar)  |  |   (Terminal)    |  | (PR comments)    |
+----------------+  +-----------------+  +------------------+
        ^                   ^                     ^
        |                   |                     |
        +-------+-----------+-----------+---------+
                |           |           |
          +---------+  +---------+  +---------+
          | Author  |  | Public  |  | Awesome |
          | Badges  |  | Profiles|  |  Lists  |
          +---------+  +---------+  +---------+
                            |
                            v
                    +-----------------+
                    | Organic Growth  |
                    +-----------------+
```

---

## 2. Value Proposition

### 2.1 Evolution of Positioning

| Version | Positioning | Problem |
|---------|-------------|---------|
| Original | "Help developers discover skills they don't know exist" | Doesn't address activation failures |
| PRD v3 | "Help developers discover skills and ensure they actually work" | Adds reliability layer |

### 2.2 Positioning by Persona

| Persona | Key Pain | Our Message |
|---------|----------|-------------|
| **Explorer** | Too many options, no way to browse | "Browse 46K skills visually, filtered by quality" |
| **Optimizer** | Want best-in-class for their stack | "Stack-aware recommendations from usage data" |
| **Skeptic** | Been burned by tools before | "Transparent scores, honest failure rates, easy exit" |
| **Overwhelmed** | Decision paralysis | "One recommended skill to start. You can explore later." |
| **Standardizer** | Need team consistency | "Share verified skill stacks with your team" |
| **Creator** | Want recognition and feedback | "See who uses your skills and how to improve them" |

### 2.3 Competitive Differentiation

| Alternative | What They Do | Our Differentiation |
|-------------|--------------|---------------------|
| **awesome-claude-skills repos** | Curated lists | We add search, quality scores, recommendations |
| **skillsmp.com** | Aggregated web index | We add terminal-native, codebase-aware, activation auditor |
| **Manual GitHub browsing** | Full control | We save time with intelligent filtering |
| **Claude Plugins Dev** | Visual browsing | We add recommendations and reliability verification |

**Unique Value:** We are the only tool that:
1. Provides codebase-aware recommendations
2. Verifies skills will actually activate before recommending
3. Works across web, IDE, and terminal
4. Gives skill authors actionable feedback

---

## 3. Target Users

### 3.1 Primary Target: Power Users First

**Who:** Developers who already use Claude Code actively (5+ hrs/week) and have installed at least one skill.

**Why them first:**
- They understand the problem space
- They can evaluate quality of recommendations
- They're connected to other Claude users
- Their feedback is most valuable

**Size estimate:** ~10,000 users globally (based on Claude Code adoption estimates)

### 3.2 Secondary Target: New Claude Code Users

**Who:** Developers just starting with Claude Code, need guidance on setup.

**Why them second:**
- They need more education
- Their expectations are unformed
- They're valuable for growth but not for product feedback

**Approach:** Capture them through VS Code extension and web browser, convert to power users.

### 3.3 Tertiary Target: Skill Authors

**Who:** Developers who create and publish Claude skills.

**Why important:**
- They have incentive to promote the Hub (drives discovery of their skills)
- They create content (skills) that attracts users
- They're the viral engine if we give them tools

**Approach:** Author dashboards, embeddable badges, download analytics.

---

## 4. Growth Model

### 4.1 Primary Growth Loop: Author Virality

```
+------------------+
|  Author creates  |
|  quality skill   |
+--------+---------+
         |
         v
+------------------+
| Skill indexed in |
|  Discovery Hub   |
+--------+---------+
         |
         v
+------------------+
|  Author embeds   |
|  badge in README |
+--------+---------+
         |
         v
+------------------+
|  Viewers click   |
|  badge, discover |
|  Discovery Hub   |
+--------+---------+
         |
         v
+------------------+
| New users explore|
| find more skills |
+--------+---------+
         |
         v
+------------------+
|  Some become     |
|  authors         |
+--------+---------+
         |
         +---------> Back to top
```

**Why this works:**
- Authors have intrinsic motivation (recognition, downloads)
- Badges are passive (embedded once, work forever)
- Each skill repo is a potential acquisition channel
- Compounds over time

### 4.2 Secondary Growth Loop: SEO + Content

```
Developer searches
"Claude skills for React"
         |
         v
+------------------+
|  Skill browser   |
|  ranks in Google |
+--------+---------+
         |
         v
+------------------+
|  User browses    |
|  skill catalog   |
+--------+---------+
         |
         v
+------------------+
|  User installs   |
|  Claude Code +   |
|  Discovery Hub   |
+--------+---------+
         |
         v
+------------------+
|  User returns    |
|  for more skills |
+------------------+
```

**Why this works:**
- "Claude skills for X" searches are happening
- No competitor is optimizing for these terms
- Long-tail SEO compounds over time
- Web presence also enables social sharing

### 4.3 Tertiary Growth Loop: Team Spread

```
+------------------+
|  Power user      |
|  standardizes    |
|  team setup      |
+--------+---------+
         |
         v
+------------------+
|  Creates shared  |
|  skill list or   |
|  CLAUDE.md       |
+--------+---------+
         |
         v
+------------------+
|  Team members    |
|  adopt same      |
|  Discovery Hub   |
+--------+---------+
         |
         v
+------------------+
|  Team members    |
|  spread to other |
|  projects/teams  |
+--------+---------+
```

**Why this is tertiary:**
- Requires enterprise features (team registries)
- Longer sales cycle
- Happens after Phase 4

---

## 5. Phasing Alignment

### 5.1 GTM Phases Mapped to PRD v3

| PRD Phase | GTM Phase | Primary GTM Activity | Key Metric |
|-----------|-----------|---------------------|------------|
| Phase 0: Validation | Pre-launch | User research, beta recruitment | 70%+ interest |
| Phase 1: Foundation | Soft launch | Awesome lists, Discord, minimal web | 100+ users |
| Phase 2: Recommendations | Growth launch | Full web, VS Code, author tools | 500+ WAU |
| Phase 3: Activation Auditor | Differentiation | Content marketing, reliability positioning | 25%+ improvement |
| Phase 4: Learning + Scale | Community | User-generated content, sustainability | 5,000+ WAU |

### 5.2 Entry Points by Phase

| Entry Point | Phase Introduced | Effort | Expected Impact |
|-------------|-----------------|--------|-----------------|
| Terminal (Claude Code) | Phase 1 | Core | Primary interface |
| Awesome lists | Phase 1 | Low | ~100 installs/6mo |
| GitHub Pages skill browser | Phase 1 | Low | SEO foundation |
| Full web skill browser | Phase 2 | Medium | 5,000+ monthly visitors |
| VS Code extension | Phase 2 | Medium | 1,000+ installs |
| Embeddable badges | Phase 2 | Low | Viral mechanics |
| Author dashboards | Phase 2 | Medium | Author engagement |
| Public skill profiles | Phase 3 | Low | Social proof |
| GitHub Action | Phase 3 | Low | Workflow integration |
| Standalone CLI | Phase 4 | Medium | Skeptic entry point |

---

## 6. Resource Requirements

### 6.1 Minimum Viable Team

Based on Growth Engineer feedback, reduced scope approach:

| Role | Hours/Week | Focus |
|------|------------|-------|
| Product/GTM Lead | 15 | Strategy, metrics, partnerships |
| Developer | 15 | Web, VS Code, author tools |
| Community | 5 | Discord, Reddit, content |
| **Total** | **35** | |

### 6.2 Sustainability Model

**Phase 1-3:** Side project pace (sustainable at 35 hrs/week total)

**Phase 4+:** Decision point:
- If <2,000 WAU: Reduce to maintenance mode (10 hrs/week)
- If 2,000-5,000 WAU: Maintain current pace
- If >5,000 WAU: Seek funding or partnership to scale

### 6.3 Automation Requirements

To stay sustainable, automate:
- Skill index updates (GitHub Actions)
- Quality scoring (pipeline)
- Stale skill detection (automated alerts)
- Badge generation (serverless function)
- Author dashboard data (aggregation pipeline)

---

## 7. Success Criteria

### 7.1 Validated Assumptions (Must Prove in Phase 0)

| Assumption | Validation Method | Proceed If |
|------------|-------------------|------------|
| Users want codebase-aware recommendations | User interviews | 70%+ express interest |
| 15-minute activation is achievable | Stopwatch testing | Median <15 min |
| Manual recommendations provide value | Expert comparison | 60%+ match |
| Beta users will participate | Recruitment | 50+ committed |

### 7.2 Growth Milestones

| Milestone | Target | Timeline |
|-----------|--------|----------|
| First 100 users | 100 | Week 8 |
| First 500 WAU | 500 | Week 12 |
| First 1,000 WAU | 1,000 | Week 16 |
| First 5,000 WAU | 5,000 | Week 20 |

### 7.3 Anti-Goals

What we are NOT optimizing for:

- **Vanity metrics:** Total installs, GitHub stars
- **Unsustainable growth:** Paid acquisition without retention
- **Feature completeness:** Launching all features before validation
- **Anthropic dependency:** Building solely for acquisition

---

## Related Documents

- [Launch Channels](./channels/launch-channels.md) - Initial distribution
- [Sustainable Channels](./channels/sustainable-channels.md) - Long-term growth
- [Metrics](./metrics.md) - Detailed metrics framework

---

**Next:** [Launch Channels](./channels/launch-channels.md)
