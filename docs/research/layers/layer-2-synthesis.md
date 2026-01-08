# Layer 2: Ecosystem View Synthesis

**Research Sources:** GitHub Author Research, Professional Perspectives Research, Marketplace/Platform Research, Substack Newsletter Research
**Synthesis Date:** December 26, 2025
**Framework:** Teresa Torres Continuous Discovery - Layer 2

---

## Executive Summary

Layer 2 research examines how other actors in the customer's environment (skill authors, platform operators, enterprise stakeholders, competitors) interpret and feel the impact of skill discovery problems. The ecosystem is characterized by **rapid growth, significant fragmentation, and emerging standardization efforts**.

### Key Ecosystem Finding

> The #1 pain point for skill authors is **discoverability**. There is no centralized, authoritative marketplace. Skills are scattered across GitHub repositories, making it hard for users to find quality skills.

---

## Ecosystem Statistics Overview

| Metric | Value | Source |
|--------|-------|--------|
| SkillsMP indexed skills | 25,000+ | SkillsMP.com |
| claude-plugins.dev plugins | 8,412+ | claude-plugins.dev |
| MCP servers (mcp.so) | 17,237+ | mcp.so |
| Anthropic skills repo stars | 20,000+ | GitHub |
| Monthly MCP SDK downloads | 97M+ | Anthropic |
| Claude Code revenue growth | 5.5x | Industry reports |
| Plugins with Agent Skills | 92% | claude-plugins.dev |

---

## Stakeholder Perspectives Map

### 1. Skill Authors (Supply Side)

**Primary Motivation:** Solving their own productivity problems, then sharing with community.

**Author Journey Stages:**
```
TRIGGER → BUILD → PUBLISH → FEEDBACK → MAINTAIN → ABANDON/THRIVE
(Medium)   (HIGH)   (HIGH)   (Variable)  (MEDIUM)   (Variable)
```

**Critical Pain Points:**
- **Discoverability** - No central marketplace (Critical)
- **Skill Activation Instability** - Skills don't reliably activate (Critical)
- **YAML/Formatting Sensitivity** - Prettier breaks skills (High)
- **Breaking Version Changes** - Claude updates break existing skills (Medium)
- **Feedback Void** - Authors rarely hear from users (Medium)

**Key Author Quotes:**
- "Skills are the highest leverage AI breakthrough of the year" - Corey Ganim
- "I expect a Cambrian explosion in Skills" - Simon Willison
- "Distribution is the #1 pain point for authors"
- "Starring the repository helps others discover these utilities and motivates continued development"

### 2. Enterprise Stakeholders

**Adoption Statistics:**
- 84% of developers use or plan to use AI tools
- Only ~33% of enterprises achieve majority developer adoption
- 68% report data leak incidents from AI tools
- 62% of AI-generated code is insecure by default

**Stakeholder Matrix:**

| Role | Primary Concern | Adoption Stance |
|------|-----------------|-----------------|
| **Engineering Managers** | Proving ROI, code quality | Cautiously optimistic |
| **Senior Engineers** | Skill atrophy, craft identity | Mixed (appreciation + concern) |
| **Junior Engineers** | Learning fundamentals, imposter syndrome | Enthusiastic |
| **DevOps** | Production access controls, CI/CD integration | Cautiously enthusiastic |
| **Enterprise Architects** | Architectural consistency, pattern enforcement | Skeptical until proven |
| **CISOs** | Security vulnerabilities, data leakage | Highly cautious |
| **CTOs** | Competitive positioning, talent strategy | Strategically interested |

**Key Enterprise Quote:**
> "It's turned me from a programmer into an engineering manager overnight, running a team of AI developers who never sleep, never complain about my nitpicks, and occasionally outsmart me."

### 3. Platform Operators

**Ecosystem Fragmentation:**

| Platform | Type | Focus |
|----------|------|-------|
| **Anthropic** | Platform Owner | Partner skills, enterprise |
| **claude-plugins.dev** | Community Registry | Open source discovery |
| **SkillsMP.com** | Aggregator | Cross-platform search |
| **MCP Registry** | Official Registry | Standard compliance |
| **Smithery** | Commercial | Cloud execution |
| **GitHub MCP Registry** | Discovery Platform | Copilot integration |

**Key Gap:** No official Anthropic skill marketplace exists, creating opportunity for community-driven solutions.

### 4. Thought Leaders

**Dominant Voices:**

| Leader | Perspective | Key Contribution |
|--------|-------------|------------------|
| **Addy Osmani** | Workflow best practices | "70% Problem" framework |
| **Simon Willison** | Skills development | Cambrian explosion prediction |
| **Kent Beck** | Junior developer impact | "The bet on juniors just got better" |
| **Gergely Orosz** | Engineering practices | Claude Code internal processes |
| **Gary Marcus** | Skepticism | "Nobody's going to make much money" |
| **Ethan Mollick** | Academic exploration | Empirical vibecoding research |

---

## Competitive Landscape

### Claude Code vs. Alternatives

| Tool | User Sentiment | Positioning |
|------|----------------|-------------|
| **GitHub Copilot** | "Hallucinates so much" | IDE-native, widespread |
| **Cursor** | "Feels better in Claude Code" | IDE, post-trained |
| **OpenAI Codex** | "Better with minimum code" | Emerging competitor |
| **Gemini CLI** | Price-performance appeal | Google ecosystem |

### Claude Skills vs OpenAI GPTs

| Aspect | Claude Skills | OpenAI GPTs |
|--------|---------------|-------------|
| **Discovery Model** | Fragmented community | Centralized GPT Store |
| **Distribution** | Enterprise/API focused | Consumer-focused, viral |
| **Customization** | SKILL.md folders + code | No-code builder |
| **Marketplace** | No official public store | Official GPT Store |
| **Portability** | Open standard (AAIF) | Proprietary format |
| **Monetization** | None for skill creators | Revenue sharing |

---

## Governance Evolution

### MCP Standards Movement

**Timeline:**
- November 2024: MCP open-sourced by Anthropic
- December 2025: MCP donated to Linux Foundation's Agentic AI Foundation
- Co-founded with Block and OpenAI
- Platinum members: AWS, Bloomberg, Cloudflare, Google, Microsoft

**Agent Skills Open Standard (December 18, 2025):**
- Skills published as open standard
- Cross-platform adopters: Microsoft, Cursor, Goose, Amp, OpenCode
- Enables ecosystem interoperability

### Implications for Discovery Hub

The governance shift toward open standards creates:
1. **Opportunity:** Cross-platform skill discovery becomes viable
2. **Challenge:** Must track evolving standards
3. **Positioning:** Discovery Hub can be platform-agnostic

---

## Enterprise Adoption Barriers

### Tier 1: Foundational Barriers

| Barrier | Impact | Mitigation |
|---------|--------|------------|
| **Security Concerns** | Critical | Security verification badges |
| **Trust Gap** | High | Transparent quality signals |
| **Skill Gap** | High | Training integration |
| **Governance Vacuum** | High | Policy templates |

### Tier 2: Organizational Barriers

| Barrier | Impact | Mitigation |
|---------|--------|------------|
| **Shadow IT** | Medium-High | Approved skill lists |
| **Shallow Adoption** | Medium | Champion programs |
| **Measurement Gaps** | Medium | ROI metrics |

### Tier 3: Cultural Barriers

| Barrier | Impact | Mitigation |
|---------|--------|------------|
| **Fear of Replacement** | Medium | Expertise amplification framing |
| **Craft Identity** | Medium | Expert mode features |
| **Overconfidence** | Medium | Verification workflows |

---

## Champion Persona Characteristics

Research identifies key traits of successful internal AI adoption champions:

**Demographics:**
- Experience: 5-15 years (enough to validate, not so senior as to resist)
- Role: Senior IC, Tech Lead, or Staff Engineer
- Mindset: Growth-oriented, willing to experiment publicly

**Key Traits:**
1. **Technical Credibility** - Respected for deep knowledge
2. **Communication Skills** - Translates benefits for stakeholders
3. **Risk Tolerance** - Comfortable with public experimentation
4. **Organizational Savvy** - Works proactively with security teams

**Champion Activities:**

| Activity | Purpose | Frequency |
|----------|---------|-----------|
| Demo Sessions | Show productivity gains | Weekly |
| Office Hours | Help teammates | Weekly |
| Documentation | Create best practices | Ongoing |
| Metric Tracking | Quantify value | Monthly |

---

## Productivity Reality Check

### Claimed vs. Actual Gains

| Source | Claimed | Actual | Gap |
|--------|---------|--------|-----|
| Marketing | 50%+ | 10-15% (RCT studies) | Large |
| Power users | 10x | 2-10x (select cases) | Variable |
| Junior devs | 26% | 21-40% | Aligned |
| Senior devs | 26% | 7-16% | Large |

**The Expertise Paradox:**
- AI benefits experienced developers most
- But experienced developers resist adoption most
- Junior developers adopt quickly but need supervision

**Key Research Finding (METR Study):**
> Developers using AI tools were 19% slower to complete tasks than those without, yet predicted they would be 24% faster.

---

## Ecosystem Gap Analysis

| Gap | Description | Opportunity |
|-----|-------------|-------------|
| **Unified Discovery** | No single source | Central discovery hub |
| **Quality Signals** | No standardized ratings | Community rating system |
| **Cross-Platform Portability** | Format differences | Universal skill format |
| **Semantic Search** | Keyword-only | AI-powered matching |
| **Skill Composition** | Limited combining tools | Composition framework |
| **Version Management** | No dependency tracking | Versioning standard |
| **Trust/Security** | Inconsistent review | Verification badges |

---

## Strategic Positioning Options

Based on ecosystem analysis:

| Position | Description | Advantage | Risk |
|----------|-------------|-----------|------|
| **Aggregator+** | Unite fragmented registries | First mover with AI discovery | Medium |
| **Quality Layer** | Add ratings/reviews | Trust & curation | Low |
| **Semantic Search** | AI-powered matching | Better discovery UX | Medium |
| **Enterprise Gateway** | Secure approval workflows | B2B opportunity | Medium-High |

### Recommended Strategy

1. **Differentiate on Discovery UX** - AI-powered semantic matching
2. **Aggregate, Don't Compete** - Pull from all registries
3. **Focus on Quality Signals** - Ratings, reviews, security verification
4. **Enable Skill Composition** - Help users combine skills
5. **Build Community Trust** - Partner with awesome-list maintainers

---

## Key Quotes Collection (15 Ecosystem Quotes)

1. "Skills are the highest leverage AI breakthrough of the year" - Corey Ganim
2. "I expect a Cambrian explosion in Skills which will make this year's MCP rush look pedestrian by comparison" - Simon Willison
3. "The community response has exceeded expectations... Our skills repository already crossed 20k stars" - Mahesh Murag, Anthropic
4. "It's turned me from a programmer into an engineering manager overnight" - Developer testimonial
5. "Claude Code and Claude have accelerated Altana's development velocity by 2-10x" - Peter Swartz
6. "Earlier this year, only 20% of Treasure Data engineers had adopted agentic coding tools. Today, that number has increased to over 80%"
7. "AI tools are not designed to exercise judgment. They do not think about privilege escalation paths, secure architectural patterns, or compliance nuances"
8. "62% of AI-generated code is insecure by default"
9. "Teams without proper AI prompting training experience 60% lower productivity gains"
10. "Developers with 10+ years of experience often exhibit the strongest resistance to AI coding tools"
11. "Almost half of professionals (49%) fear that automation will replace their role in the next five years"
12. "Developers who used an AI assistant wrote significantly less secure code than those without access to an assistant"
13. "Building these MCP servers fundamentally changed how I work, consolidating what used to require switching between 10 different tools"
14. "While forking an existing MCP server has benefits, these 'augmented' MCP servers often result in unanticipated maintenance"
15. "Skills are conceptually extremely simple: a skill is a Markdown file telling the model how to do something" - Simon Willison

---

## Future Trajectory Predictions

### Near-Term (2025 Q1-Q2)

| Prediction | Confidence |
|------------|------------|
| MCP Registry GA launch | High |
| Increased skill standardization | High |
| Partner skill directory expansion | Medium |

### Medium-Term (2025 H2)

| Prediction | Confidence |
|------------|------------|
| Official Anthropic skill marketplace | Medium |
| Cross-platform skill portability | High |
| Skill monetization options | Low-Medium |

### Long-Term (2026+)

| Prediction | Confidence |
|------------|------------|
| Converged MCP + Skills ecosystem | Medium |
| Enterprise skill certification | High |
| Agent-to-agent skill markets | Low |

---

*Synthesis compiled from 4 Layer 2 research documents, December 26, 2025*
