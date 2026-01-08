# Claude Discovery Hub
## Go-to-Market & Growth Strategy

**Version:** 1.0  
**Date:** December 24, 2025  
**Author:** Smith Horn Group Ltd  
**Status:** Strategy Draft  
**Related:** claude-discovery-hub-v2-architecture.md

---

## Strategic Context

### The Distribution Challenge

A Git-native, terminal-first tool has no traditional discovery surface:
- No website = no SEO
- No app store = no browse/search
- No SaaS dashboard = no viral loops

Traditional B2D (business-to-developer) playbooks don't apply. This requires a distribution strategy native to how developers actually discover and adopt tools.

### Core Insight

> **The product is invisible until it's indispensable.**

Developers don't search for "skill discovery hub." They search for solutions to immediate problems. The GTM strategy must intercept users at moments of need, not moments of browse.

---

## Target User Segments

### Segment 1: New Claude Code Users (Highest Intent)
- **Who:** Developers installing Claude Code for the first time
- **Moment:** Initial setup, configuring CLAUDE.md, choosing first skills
- **Need:** "What should I install? How do I set this up properly?"
- **Size:** ~10,000/month (estimated from npm downloads growth)

### Segment 2: Stuck Developers (Highest Pain)
- **Who:** Claude Code users hitting limitations
- **Moment:** Task fails, need capability Claude doesn't have
- **Need:** "Is there a skill for X? Why can't Claude do Y?"
- **Size:** Unknown, but high frequency per user

### Segment 3: Skill Creators (Force Multipliers)
- **Who:** Developers building and sharing skills/plugins
- **Moment:** Publishing, seeking distribution for their work
- **Need:** "How do people find my skill?"
- **Size:** ~500 active creators (based on GitHub repos)

### Segment 4: Team Leads (Budget Holders)
- **Who:** Engineering managers standardizing team tooling
- **Moment:** Onboarding, productivity initiatives
- **Need:** "What should our team's Claude setup look like?"
- **Size:** Unknown, enterprise opportunity

---

## Growth Model

```
                    AWARENESS
                        │
        ┌───────────────┼───────────────┐
        │               │               │
        ▼               ▼               ▼
   ┌─────────┐    ┌─────────┐    ┌─────────┐
   │ Content │    │ Embed   │    │ Partner │
   │ (Pull)  │    │ (Push)  │    │ (Lever) │
   └────┬────┘    └────┬────┘    └────┬────┘
        │               │               │
        └───────────────┼───────────────┘
                        │
                        ▼
                   ACTIVATION
                   (First Value)
                        │
                        ▼
                   RETENTION
                   (Recurring Value)
                        │
                        ▼
                   REFERRAL
                   (Viral Loops)
```

---

## Channel Strategy

### Channel 1: Learning Content (Pull)

**Thesis:** Developers share learning achievements. Exercises are more viral than tools.

**Tactics:**

| Asset | Format | Distribution | Effort |
|-------|--------|--------------|--------|
| "Claude Code Challenges" repo | GitHub repo with 10 exercises | GitHub, HN, Reddit, Twitter | High |
| Exercise completion threads | Twitter/LinkedIn posts | User-generated after completion | Low |
| "I learned X" blog posts | Template for users to customize | Dev.to, Medium, personal blogs | Medium |
| Video walkthroughs | YouTube/Loom tutorials | YouTube SEO, embeds | High |

**Metrics:**
- Repo stars/forks
- Exercise completion rate
- Social shares with #ClaudeCodeChallenge

**First Move:** Create 3 standalone exercises that can be completed in 30 minutes, require no prior setup, and produce a shareable artifact (working skill, fixed bug, etc.)

---

### Channel 2: Workflow Embedding (Push)

**Thesis:** The best distribution is being part of something already distributed.

**Tactics:**

| Integration Point | Mechanism | Owner |
|-------------------|-----------|-------|
| Popular skill READMEs | "Works well with Discovery Hub" | Skill authors |
| CLAUDE.md templates | Include discovery skill by default | Template repos |
| Onboarding guides | "Step 3: Set up skill discovery" | Tutorial authors |
| IDE extensions | Prompt to install on first use | Extension maintainers |

**Metrics:**
- Referral installs from partner skills
- CLAUDE.md template adoption
- IDE extension installs

**First Move:** Create a PR to 5 popular skill repos (obra/superpowers, anthropics/skills, etc.) adding a "Discover Related Skills" section that references the hub.

---

### Channel 3: Anthropic Partnership (Leverage)

**Thesis:** Anthropic has the distribution. Official endorsement is the unlock.

**Tactics:**

| Approach | Pitch | Ask |
|----------|-------|-----|
| Documentation inclusion | "Community-maintained discovery solution" | Link in Claude Code docs |
| Default skill | Ship discovery as opt-in default | Include in claude-plugins-official |
| Co-marketing | "Ecosystem spotlight" blog post | Anthropic blog feature |
| Enterprise offering | Team skill management solution | Sales partnership |

**Metrics:**
- Docs referral traffic
- Official repo inclusion
- Enterprise pilot conversations

**First Move:** 
1. Build a polished MVP
2. Document it thoroughly
3. Email devrel@anthropic.com with a concise pitch:
   - Problem: Ecosystem fragmentation
   - Solution: Community-maintained discovery
   - Ask: Link in docs or include in official plugins

---

### Channel 4: Community Seeding (Grassroots)

**Thesis:** Power users in the right communities have outsized influence.

**Target Communities:**

| Community | Platform | Approach |
|-----------|----------|----------|
| Claude Code Discord | Discord | Active participation, helpful answers |
| r/ClaudeAI | Reddit | Share exercises, answer questions |
| AI Twitter | Twitter/X | Build in public, share progress |
| Hacker News | HN | Launch post when MVP ready |
| Dev.to | Blog | Tutorial series |
| Awesome lists | GitHub | Submit to awesome-claude-code, etc. |

**Metrics:**
- Community mentions
- Inbound questions/issues
- Awesome list inclusions

**First Move:** Get listed on 3 "awesome" repos within 30 days of launch:
- github.com/hesreallyhim/awesome-claude-code
- github.com/travisvn/awesome-claude-skills
- github.com/VoltAgent/awesome-claude-skills

---

## Activation Strategy

### First-Value Moment

Users must experience value within 5 minutes of installation. The critical path:

```
Install MCP server (2 min)
        │
        ▼
First search returns useful skill (1 min)
        │
        ▼
Install recommended skill (1 min)
        │
        ▼
Skill improves their work (1 min)
        │
        ▼
    ✓ ACTIVATED
```

**Failure Modes to Prevent:**
- Search returns nothing useful → Ensure index has 1,000+ quality skills at launch
- Installation fails → Bulletproof install docs, error handling
- Recommended skill doesn't work → Verification tier, compatibility checks
- User doesn't know what to search → Codebase scan as default first action

### Activation Tactics

| Tactic | Implementation |
|--------|----------------|
| Zero-config start | `claude mcp add discovery` works immediately |
| Smart defaults | First action is `analyze .` not `search` |
| Quick wins | Surface "instant value" skills (formatters, linters) |
| Guided tour | `/discover tour` walks through features |

---

## Retention Strategy

### Recurring Value Loops

| Loop | Frequency | Trigger | Value |
|------|-----------|---------|-------|
| Weekly recommendations | Weekly | CLAUDE.md scheduled task | New relevant skills |
| Skill updates | As needed | Installed skill changes | Stay current |
| Learning progress | On completion | Exercise finished | Achievement, next step |
| Stack comparison | Monthly | New data in index | "Projects like yours" |

### CLAUDE.md Integration

The key retention mechanism is embedding into the user's CLAUDE.md:

```markdown
## Discovery (add to CLAUDE.md)

Run weekly skill analysis on Mondays:
- Scan this codebase for capability gaps
- Check for updates to installed skills  
- Save recommendations to docs/recommendations/
- Suggest one relevant exercise based on gaps
```

This creates a persistent, automated relationship—not a tool they have to remember to use.

### Churn Prevention

| Risk Signal | Detection | Intervention |
|-------------|-----------|--------------|
| No searches in 14 days | Usage tracking | "New skills for your stack" notification |
| Recommendations ignored | Accept rate < 10% | Improve recommendation relevance |
| Exercise abandoned | Started but not completed | Simplify, offer help |
| Uninstall | MCP server removed | Exit survey, win-back content |

---

## Referral Strategy

### Natural Share Moments

| Moment | What They Share | How to Enable |
|--------|-----------------|---------------|
| Found perfect skill | The skill itself | "Share this skill" with attribution |
| Completed exercise | Achievement | Shareable badge/image |
| Great recommendation | The rec artifact | Public gist from markdown |
| Team setup | Full config | `export_setup()` command |

### Referral Mechanics

**1. Recommendation Artifacts**

Every recommendation saved to `docs/recommendations/` includes:
```markdown
---
Generated by Claude Discovery Hub
Share: https://discoveries.dev/rec/abc123
---
```

Link goes to a minimal web page showing the recommendation (only web presence needed).

**2. Setup Export**

```
/discover export-setup

→ Creates shareable CLAUDE.md snippet
→ Lists installed skills with install commands
→ Includes "Get this setup" link
```

**3. Learning Badges**

On exercise/path completion:
```
🎓 Completed: Claude Code Fundamentals
   Exercises: 12 | Time: 4.5 hours
   
   Share: [Twitter] [LinkedIn] [Copy Badge]
```

**4. Comparison Stats**

```
/discover compare

→ "Your setup vs similar projects"
→ "You're in the top 15% for skill utilization"
→ "3 skills you're missing that peers use"

Share this comparison? [Y/n]
```

---

## Launch Plan

### Pre-Launch (Weeks 1-4)

| Week | Focus | Deliverables |
|------|-------|--------------|
| 1 | Core MCP servers | skill-index, skill-install working |
| 2 | Index population | 1,000+ skills indexed, searchable |
| 3 | Codebase scanning | codebase-scan, recommendations working |
| 4 | Documentation | README, install guide, first 3 exercises |

### Soft Launch (Weeks 5-6)

| Action | Target | Goal |
|--------|--------|------|
| Submit to awesome lists | 5 repos | 3 acceptances |
| Share in Claude Discord | 1 post | 50 installs |
| Post on Twitter | Build-in-public thread | 100 impressions |
| Email 10 skill authors | Personal outreach | 3 integrations |

**Success Criteria:** 100 installs, 20 DAU, 5 GitHub stars

### Public Launch (Week 7)

| Channel | Content | Goal |
|---------|---------|------|
| Hacker News | "Show HN: Git-native skill discovery for Claude Code" | Front page |
| Reddit r/ClaudeAI | Launch post with demo GIF | 50 upvotes |
| Twitter/X | Thread: "I built X because Y" | 500 impressions |
| Dev.to | Tutorial: "Set up Claude Code like a pro" | 1,000 views |

**Success Criteria:** 500 installs, 100 DAU, 50 GitHub stars

### Post-Launch (Weeks 8-12)

| Focus | Actions |
|-------|---------|
| Learning content | Release 7 more exercises, 2 full paths |
| Anthropic outreach | Formal partnership pitch |
| Community building | Weekly "Skill of the Week" posts |
| Iteration | Ship based on user feedback |

---

## Metrics & Goals

### North Star Metric

**Weekly Active Discoverers (WAD):** Users who search, scan, or complete an exercise in a 7-day period.

### Supporting Metrics

| Metric | Week 8 | Month 3 | Month 6 | Month 12 |
|--------|--------|---------|---------|----------|
| Total installs | 500 | 2,000 | 8,000 | 25,000 |
| WAD | 100 | 500 | 2,000 | 8,000 |
| Skills indexed | 1,000 | 10,000 | 30,000 | 50,000 |
| Exercises completed | 50 | 500 | 3,000 | 15,000 |
| Recommendation accept rate | 30% | 45% | 55% | 65% |
| Referral rate | 5% | 10% | 15% | 20% |

### Tracking Implementation

Minimal, privacy-respecting analytics:
- Install count (npm download stats)
- Command usage (opt-in, anonymized)
- Exercise completions (local + optional report)
- GitHub stars/forks

No user accounts required. No personal data collected.

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Anthropic builds competing solution | Medium | High | Move fast, build community, position for acquisition/partnership |
| Low adoption despite quality | Medium | High | Double down on learning content (proven viral) |
| Index quality issues | High | Medium | Verification tiers, user flagging, automated checks |
| Maintainer burnout | Medium | High | Build contributor community early, document everything |
| MCP ecosystem changes | Low | High | Abstract MCP layer, stay close to Anthropic updates |

---

## Resource Requirements

### Minimum Viable Team

| Role | Time | Notes |
|------|------|-------|
| Lead developer | 20 hrs/week | MCP servers, core infrastructure |
| Content creator | 10 hrs/week | Exercises, documentation, social |
| Community manager | 5 hrs/week | Discord, Reddit, GitHub issues |

### Budget (Optional)

| Item | Cost | Priority |
|------|------|----------|
| Domain (discoveries.dev) | $50/year | Nice-to-have |
| Minimal landing page | $0 (GitHub Pages) | Nice-to-have |
| Video production | $0-500 | Medium |
| Promotional giveaways | $0-200 | Low |

**Total:** $0-750 for year one. This can be a zero-cost project.

---

## Decision Points

### Gate 1: Soft Launch (Week 6)
- **Continue if:** 100+ installs, positive feedback, no critical bugs
- **Pivot if:** <50 installs, negative feedback, fundamental issues
- **Pivot options:** Focus only on learning content, seek Anthropic partnership earlier

### Gate 2: Public Launch (Week 8)
- **Continue if:** HN/Reddit traction, 500+ installs, contributor interest
- **Pivot if:** Launch fizzles, <200 installs, no community engagement
- **Pivot options:** Narrow to single feature (learning OR discovery), open-source and archive

### Gate 3: Month 3 Review
- **Continue if:** 2,000+ installs, growing WAD, Anthropic conversation started
- **Pivot if:** Flat growth, declining engagement, no partnership path
- **Pivot options:** Sell/transfer to interested party, merge with existing aggregator

---

## The Honest Odds

| Outcome | Probability | Scenario |
|---------|-------------|----------|
| Anthropic partnership/acquisition | 15% | They see value, integrate officially |
| Sustainable community project | 25% | 5,000+ users, active contributors |
| Niche tool for power users | 40% | 500-2,000 users, maintainer-driven |
| Archive after 6 months | 20% | Insufficient traction, maintainer burnout |

**Expected value is positive** if:
1. Learning content has standalone value (reusable regardless of hub adoption)
2. Experience building MCP servers is valuable (transferable skill)
3. Anthropic relationship opens other doors (consulting, partnerships)

The downside is capped at time invested. The upside is becoming the default discovery layer for a rapidly growing ecosystem.

---

## Next Actions

1. **This week:** Finalize architecture decisions, set up repo structure
2. **Week 2:** Build skill-index MCP server, populate initial index
3. **Week 3:** Build codebase-scan MCP server, first recommendation
4. **Week 4:** Write documentation, create 3 exercises
5. **Week 5:** Submit to awesome lists, soft launch in Discord
6. **Week 6:** Evaluate Gate 1, decide on public launch

---

## Sources

Reforge. "Growth Loops." *Reforge Growth Series*, 2023.

Lenny Rachitsky. "How the Biggest Consumer Apps Got Their First 1,000 Users." *Lenny's Newsletter*, 2022.

First Round Review. "What I Learned From Developing Branding for Airbnb, Dropbox and Thumbtack." *First Round Review*, 2018.

Y Combinator. "How to Get Your First Customers." *Startup School*, 2024.

[Primary research from ecosystem analysis in PRD v1]
