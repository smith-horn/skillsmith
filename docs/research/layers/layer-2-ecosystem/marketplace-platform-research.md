# Layer 2: Ecosystem View - Marketplace & Platform Research

**Research Date:** December 26, 2025
**Framework:** Jobs-to-be-Done Layer 2 (Ecosystem Actors)
**Focus Question:** "How do other actors in the customer's environment interpret or feel the impact of skill discovery problems?"

---

## Executive Summary

The Claude ecosystem is experiencing rapid evolution with significant fragmentation in skill and plugin discovery. The research reveals a multi-layered ecosystem with distinct actor categories: Anthropic as the platform owner, community-driven marketplaces, awesome-list curators, and emerging standards bodies.

### Key Findings

1. **Ecosystem Growth**: Over 25,000+ skills indexed across platforms, 8,400+ plugins on claude-plugins.dev, 97M+ monthly MCP SDK downloads
2. **Fragmentation Challenge**: Multiple competing registries, no unified discovery, format incompatibility between Claude and other AI platforms
3. **Governance Shift**: MCP donated to Linux Foundation's Agentic AI Foundation (December 2025), signaling commitment to open standards
4. **Strategic Gap**: No official Anthropic skill marketplace exists, creating opportunity for community-driven solutions
5. **Cross-Platform Portability**: Agent Skills published as open standard (December 18, 2025), enabling ecosystem interoperability

---

## 1. Platform/Marketplace Comparison Matrix

| Platform | Type | Skills/Servers | Business Model | Discovery Features | Official Status |
|----------|------|----------------|----------------|-------------------|-----------------|
| **Anthropic** | Platform Owner | Partner skills | Enterprise API | Partner directory | Official |
| **claude-plugins.dev** | Community Registry | 8,412+ | Open Source | CLI installation, search | Community |
| **SkillsMP.com** | Aggregator | 25,000+ | Free (ads?) | Smart search, categories | Independent |
| **MCP Registry** | Official Registry | 10,000+ servers | Open Source | API access, .well-known | Linux Foundation |
| **mcpservers.org** | Curated Directory | Varies | Community | Category browsing | Community |
| **mcp.so** | Aggregator | 17,237+ | Unknown | GitHub-based submission | Community |
| **Smithery** | Commercial Marketplace | 3,363+ | Freemium | Cloud integration | Commercial |
| **GitHub MCP Registry** | Discovery Platform | Growing | Free | Copilot integration | GitHub/Microsoft |
| **Cline Marketplace** | Tool-Specific | Curated | Free | One-click install | Cline Project |

### Comparison: Claude Skills vs OpenAI GPTs

| Aspect | Claude Skills | OpenAI GPTs |
|--------|---------------|-------------|
| **Discovery Model** | Fragmented community registries | Centralized GPT Store |
| **Distribution** | Enterprise/API focused | Consumer-focused, viral |
| **Customization** | SKILL.md folders + code | No-code builder |
| **Marketplace** | No official public store | Official GPT Store |
| **Portability** | Open standard (AAIF) | Proprietary format |
| **Monetization** | None for skill creators | Revenue sharing available |

---

## 2. Detailed Platform Analysis

### 2.1 Anthropic (Official Platform Owner)

**Role:** Protocol owner, standard setter, enterprise partner

**Official Skills Strategy:**
- Skills are "specialized folders containing instructions, scripts, and resources"
- Four key properties: Composable, Portable, Efficient, Powerful
- Progressive disclosure architecture (metadata ~100 tokens, full instructions <5k tokens)
- December 2025: Organization-wide skill management + partner directory launched

**Enterprise Integrations:**
- Box: File transformation workflows
- Canva: Agent customization
- Figma: Design-to-code translation
- Vercel: Deploy Skill for production workflows

**Revenue Impact:**
- Claude Code revenue jumped 5.5x in 2025
- User base grew 300%
- Enterprise deals drive 70-75% of revenue
- 35% of US startups launched in 2024 integrated Claude API

**Source:** [Anthropic Agent Skills Announcement](https://claude.com/blog/skills)

---

### 2.2 claude-plugins.dev

**Role:** Community registry for Claude Code plugins and skills

**Technical Architecture:**
- Built with Bun and Astro
- Hosted on Val Town
- Distributed via npm/npx CLI
- Vercel Web Analytics integration

**Installation Process:**
```bash
npx claude-plugins install <plugin-identifier>
npx claude-plugins list
npx claude-plugins enable/disable <plugin-name>
```

**Statistics:**
- 8,412+ plugins indexed
- 244 plugins (92%) include Agent Skills
- Categories: Frontend, Backend, Code review, Security, Documentation

**Governance:** Community-maintained, main repository by Kamalnrf on GitHub

**Source:** [claude-plugins.dev](https://claude-plugins.dev/)

---

### 2.3 SkillsMP.com

**Role:** Aggregator marketplace for agent skills

**Value Proposition:** "AI tools are everywhere, but professional expertise shared by those who truly know their craft remains scarce."

**Key Features:**
- 25,000+ skills aggregated from GitHub
- Smart search and category filtering
- Quality filters (minimum 2 stars)
- Cross-platform: Claude Code, Codex CLI, ChatGPT

**Business Model:** Free discovery platform, no explicit monetization

**Operator:** Independent community project by @God_I_13 (not affiliated with Anthropic)

**Future Plans:**
- Community ratings and usage statistics
- Quality curation systems
- Expert verification for domain skills

**Source:** [SkillsMP About Page](https://skillsmp.com/about)

---

### 2.4 Awesome-Lists (Community Curators)

**Primary Lists:**

| Repository | Stars | Focus | Maintainer |
|------------|-------|-------|------------|
| travisvn/awesome-claude-skills | 3.7k | Claude Skills curation | Travis Van |
| ComposioHQ/awesome-claude-skills | Varies | Developer skills | Composio team |
| punkpeye/awesome-mcp-servers | Growing | MCP servers | punkpeye |
| hesreallyhim/awesome-claude-code | Active | Workflows & commands | hesreallyhim |

**Curation Process (travisvn/awesome-claude-skills):**
- CONTRIBUTING.md with submission guidelines
- PRs welcome for new skills
- Security review emphasis
- Selective but open curation
- Categories: Official, Community, Documentation

**Source:** [travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills)

---

### 2.5 MCP Registry (Official)

**Status:** Launched preview September 8, 2025, approaching GA

**Technical Details:**
- URL: https://registry.modelcontextprotocol.io
- API freeze (v0.1) since October 24, 2025
- Endpoints: GET /v0/servers with pagination
- Discovery via .well-known URLs

**Design Principles:**
- Single Source of Truth
- Vendor Neutrality
- Industry Security Standards
- Reusability (supports private registries)
- Progressive Enhancement

**Integration Partners:**
- GitHub MCP Registry (automatic sync planned)
- Azure API Center integration
- Self-publish to OSS MCP Community Registry

**Source:** [MCP Registry Announcement](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/)

---

### 2.6 Smithery

**Role:** Commercial MCP marketplace with cloud execution

**Value Proposition:** "Turn scattered context into skills for AI"

**Offerings:**
- 3,363+ community-built MCP integrations
- Skills organized by domain (Research, Coding, Writing, etc.)
- Cloud computer for agent tool execution
- Real-time information access

**Business Model:** Freemium ("Get started - it's free")

**Differentiator:** Cloud-based execution keeps context windows efficient

**Source:** [Smithery.ai](https://smithery.ai/)

---

## 3. Anthropic Official Position Summary

### MCP Strategy

**Original Launch (November 2024):**
- Open-sourced Model Context Protocol
- Pre-built servers for GitHub, Slack, Google Drive, Postgres
- Early adopters: Block, Apollo, Zed, Replit, Codeium, Sourcegraph

**December 2025 Evolution:**
- Donated MCP to Linux Foundation's Agentic AI Foundation
- Co-founded with Block and OpenAI
- Platinum members: AWS, Bloomberg, Cloudflare, Google, Microsoft
- Gold members: Shopify, Salesforce, JetBrains, Docker, and more

**Current Adoption:**
- Used in ChatGPT, Cursor, Gemini, Microsoft Copilot, VS Code
- 10,000+ published MCP servers
- 97M+ monthly SDK downloads (Python + TypeScript)

### Skills Strategy

**Core Philosophy:**
- Skills as "custom onboarding materials that package expertise"
- Model-invoked (automatic) vs. user-invoked (slash commands)
- Progressive disclosure for efficiency
- Open standard for cross-platform portability

**API Integration:**
- Messages API + new /v1/skills endpoint
- Requires Code Execution Tool beta
- Anthropic-created skills for Office documents + fillable PDFs

**Source:** [Anthropic MCP Announcement](https://www.anthropic.com/news/model-context-protocol)

---

## 4. Ecosystem Gap Analysis

### Current Gaps Identified

| Gap | Description | Impact | Opportunity |
|-----|-------------|--------|-------------|
| **Unified Discovery** | No single source for skill discovery | User friction, hidden gems | Central discovery hub |
| **Quality Signals** | No standardized rating/review system | Difficulty choosing skills | Community rating system |
| **Cross-Platform Portability** | Claude skills != Gemini extensions | Developer burden | Universal skill format |
| **Semantic Search** | Keyword-only search in registries | Poor discovery for novel needs | AI-powered matching |
| **Skill Composition** | Limited tools for combining skills | Complex workflow friction | Composition framework |
| **Version Management** | No skill dependency tracking | Breaking changes | Versioning standard |
| **Trust/Security** | Inconsistent code review | Security risks | Verification badges |

### Fragmentation Analysis

**Problem Statement:** "The format was proprietary, the marketplace was closed, and the ecosystem was fragmented."

**Current Solutions Emerging:**
1. **OpenSkills:** Universal skill management across Cursor, Claude Code, Windsurf
2. **Universal Skills:** MCP-native skill integration

**Community Sentiment:** "Claude Skills are awesome, maybe a bigger deal than MCP" - Simon Willison

---

## 5. Future Trajectory Predictions

### Short-Term (2025 Q1-Q2)

| Prediction | Confidence | Rationale |
|------------|------------|-----------|
| MCP Registry GA launch | High | Already in v0.1 API freeze |
| Increased skill standardization | High | AAIF governance in place |
| Partner skill directory expansion | Medium | Anthropic actively recruiting |
| More awesome-list consolidation | Medium | Community recognizing fragmentation |

### Medium-Term (2025 H2)

| Prediction | Confidence | Rationale |
|------------|------------|-----------|
| Official Anthropic skill marketplace | Medium | Following GPT Store model |
| Cross-platform skill portability | High | Open standard published |
| Skill monetization options | Low-Medium | Enterprise focus may delay |
| AI-powered skill discovery | Medium | Natural evolution of search |

### Long-Term (2026+)

| Prediction | Confidence | Rationale |
|------------|------------|-----------|
| Converged MCP + Skills ecosystem | Medium | AAIF pushing standards |
| Enterprise skill certification | High | Security/compliance needs |
| Skill composition frameworks | Medium | Complexity growth inevitable |
| Agent-to-agent skill markets | Low | Speculative but emerging |

### MCP Roadmap Priorities (from official roadmap)

1. **Asynchronous Operations** - Non-blocking long-running tasks
2. **Statelessness and Scalability** - Enterprise-scale horizontal scaling
3. **Server Identity** - .well-known discovery standard
4. **Official Extensions** - Domain-specific protocols (healthcare, finance, education)
5. **SDK Support Standardization** - Clear tiering system

**Source:** [MCP Roadmap](https://modelcontextprotocol.io/development/roadmap)

---

## 6. Partnership Opportunity Assessment

### Where Discovery Hub Fits

**Positioning Options:**

| Position | Description | Competitive Advantage | Risk Level |
|----------|-------------|----------------------|------------|
| **Aggregator+** | Unite fragmented registries | First mover with AI discovery | Medium |
| **Quality Layer** | Add ratings/reviews on top of registries | Trust & curation | Low |
| **Semantic Search** | AI-powered skill matching | Better discovery UX | Medium |
| **Composition Tool** | Help users combine skills | Workflow enablement | High |
| **Enterprise Gateway** | Secure skill approval workflows | B2B opportunity | Medium-High |

### Partnership Matrix

| Partner | Relationship Type | Value Exchange | Priority |
|---------|-------------------|----------------|----------|
| **Anthropic** | Platform alignment | Distribution + legitimacy | Critical |
| **claude-plugins.dev** | Data integration | Index access + user flow | High |
| **SkillsMP** | Co-opetition | Avoid duplication | Medium |
| **awesome-list maintainers** | Community building | Curation expertise | High |
| **MCP Registry** | Official integration | Authoritative data | High |
| **Smithery** | Commercial alignment | Learn from freemium | Low |

### Recommended Strategy

1. **Differentiate on Discovery UX** - AI-powered semantic matching vs keyword search
2. **Aggregate, Don't Compete** - Pull from all registries rather than building catalog
3. **Focus on Quality Signals** - Ratings, reviews, security verification
4. **Enable Skill Composition** - Help users combine multiple skills
5. **Build Community Trust** - Partner with awesome-list maintainers

---

## 7. Source Citations

### Official Anthropic Sources
- [Anthropic MCP Announcement](https://www.anthropic.com/news/model-context-protocol)
- [Agent Skills Blog Post](https://claude.com/blog/skills)
- [Skills Explained](https://claude.com/blog/skills-explained)
- [Organization Skills & Directory](https://claude.com/blog/organization-skills-and-directory)
- [Donating MCP to AAIF](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)

### Ecosystem Platforms
- [claude-plugins.dev](https://claude-plugins.dev/)
- [SkillsMP.com](https://skillsmp.com)
- [SkillsMP About](https://skillsmp.com/about)
- [Smithery.ai](https://smithery.ai/)
- [mcpservers.org](https://mcpservers.org/)
- [mcp.so](https://mcp.so)

### MCP Registry & Standards
- [Official MCP Registry](https://registry.modelcontextprotocol.io/)
- [MCP Roadmap](https://modelcontextprotocol.io/development/roadmap)
- [MCP Registry Preview Announcement](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/)
- [GitHub MCP Registry](https://github.blog/ai-and-ml/github-copilot/meet-the-github-mcp-registry-the-fastest-way-to-discover-mcp-servers/)
- [MCP Joins Agentic AI Foundation](https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/)

### Community & Analysis
- [travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills)
- [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)
- [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
- [Simon Willison on Claude Skills](https://simonwillison.net/2025/Oct/16/claude-skills/)
- [Claude Skills vs GPTs Analysis](https://sider.ai/blog/ai-tools/claude-skills-vs-gpts-two-platform-strategies-for-the-ai-agent-era)

### Industry/News
- [Linux Foundation AAIF Announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [TechCrunch AAIF Coverage](https://techcrunch.com/2025/12/09/openai-anthropic-and-block-join-new-linux-foundation-effort-to-standardize-the-ai-agent-era/)
- [O'Reilly: What MCP and Claude Skills Teach Us](https://www.oreilly.com/radar/what-mcp-and-claude-skills-teach-us-about-open-source-for-ai/)
- [OpenSkills vs Universal Skills](https://vibecodingconsultant.com/blog/openskills-universal-skills-open-ecosystem/)
- [17+ Top MCP Registries](https://medium.com/demohub-tutorials/17-top-mcp-registries-and-directories-explore-the-best-sources-for-server-discovery-integration-0f748c72c34a)
- [Claude AI Statistics 2025](https://sqmagazine.co.uk/claude-ai-statistics/)

---

## Appendix A: Ecosystem Architecture Diagram

```
                              ECOSYSTEM STRUCTURE

    ┌─────────────────────────────────────────────────────────────────┐
    │                    GOVERNANCE LAYER                              │
    │  ┌─────────────────────────────────────────────────────────┐    │
    │  │         Agentic AI Foundation (Linux Foundation)         │    │
    │  │   MCP Standard  │  goose (Block)  │  AGENTS.md (OpenAI)  │    │
    │  └─────────────────────────────────────────────────────────┘    │
    └─────────────────────────────────────────────────────────────────┘
                                    │
    ┌─────────────────────────────────────────────────────────────────┐
    │                   PLATFORM OWNER LAYER                           │
    │  ┌──────────────────────────────────────────────────────────┐   │
    │  │                    ANTHROPIC                              │   │
    │  │  Claude Apps │ Claude Code │ API │ Partner Skills │ Docs  │   │
    │  └──────────────────────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────────────────────┘
                                    │
    ┌─────────────────────────────────────────────────────────────────┐
    │                   REGISTRY/DISCOVERY LAYER                       │
    │                                                                  │
    │  Official              Commercial           Community            │
    │  ┌──────────┐         ┌──────────┐         ┌─────────────────┐  │
    │  │ MCP      │         │Smithery  │         │claude-plugins   │  │
    │  │ Registry │         │          │         │.dev             │  │
    │  └──────────┘         └──────────┘         └─────────────────┘  │
    │  ┌──────────┐         ┌──────────┐         ┌─────────────────┐  │
    │  │ GitHub   │         │ Cline    │         │ SkillsMP        │  │
    │  │ MCP Reg  │         │Marketplace│        │                 │  │
    │  └──────────┘         └──────────┘         └─────────────────┘  │
    │                                            ┌─────────────────┐  │
    │                                            │ mcpservers.org  │  │
    │                                            │ mcp.so          │  │
    │                                            └─────────────────┘  │
    └─────────────────────────────────────────────────────────────────┘
                                    │
    ┌─────────────────────────────────────────────────────────────────┐
    │                   CURATION LAYER                                 │
    │                                                                  │
    │  ┌────────────────────────────────────────────────────────────┐ │
    │  │                  Awesome Lists                              │ │
    │  │  travisvn/  │  ComposioHQ/  │  punkpeye/  │  VoltAgent/    │ │
    │  │  awesome-   │  awesome-     │  awesome-   │  awesome-      │ │
    │  │  claude-    │  claude-      │  mcp-       │  claude-       │ │
    │  │  skills     │  skills       │  servers    │  skills        │ │
    │  └────────────────────────────────────────────────────────────┘ │
    └─────────────────────────────────────────────────────────────────┘
                                    │
    ┌─────────────────────────────────────────────────────────────────┐
    │                   SKILL/MCP CREATORS                             │
    │  ┌────────────────────────────────────────────────────────────┐ │
    │  │   Enterprise Partners  │  Community Developers  │  Indie    │ │
    │  │   (Figma, Vercel,     │  (GitHub contributors) │  Makers   │ │
    │  │    Box, Canva)        │                        │           │ │
    │  └────────────────────────────────────────────────────────────┘ │
    └─────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
    ┌─────────────────────────────────────────────────────────────────┐
    │                   END USERS                                      │
    │  ┌────────────────────────────────────────────────────────────┐ │
    │  │   Enterprise Teams  │  Developers  │  Power Users  │ Indie  │ │
    │  └────────────────────────────────────────────────────────────┘ │
    └─────────────────────────────────────────────────────────────────┘


                    ┌──────────────────────────┐
                    │   DISCOVERY HUB          │
                    │   OPPORTUNITY ZONE       │
                    │                          │
                    │ • Unified search across  │
                    │   all registries         │
                    │ • AI-powered matching    │
                    │ • Quality/trust signals  │
                    │ • Skill composition      │
                    │ • Cross-platform support │
                    └──────────────────────────┘
```

---

## Appendix B: Key Statistics Summary

| Metric | Value | Source |
|--------|-------|--------|
| SkillsMP indexed skills | 25,000+ | SkillsMP.com |
| claude-plugins.dev plugins | 8,412+ | claude-plugins.dev |
| MCP servers on mcp.so | 17,237+ | mcp.so |
| Smithery MCP integrations | 3,363+ | Smithery.ai |
| Published MCP servers total | 10,000+ | Anthropic |
| Monthly MCP SDK downloads | 97M+ | Anthropic |
| Claude Code revenue growth | 5.5x | Industry reports |
| Claude user base growth | 300% | Industry reports |
| Plugins with Agent Skills | 92% (244) | claude-plugins.dev |
| US startups using Claude API | 35% | Industry reports |
| Certified plugins ecosystem | 50+ | Anthropic |

---

*Research conducted December 26, 2025 for Claude Discovery Hub Layer 2 Ecosystem Analysis*
