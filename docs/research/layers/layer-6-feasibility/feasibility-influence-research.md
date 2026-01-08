# Layer 6: Feasible Influence & Needed Capabilities Research

**Research Date:** December 26, 2025
**Framework:** Teresa Torres Layer 6 - "What can we feasibly influence?"
**Sources Analyzed:** 30+

---

## Research Question

> "What can Discovery Hub realistically change vs. accept? Which ecosystem actors can be influenced? What partnerships are necessary? What capabilities must be built vs. acquired?"

---

## Section 1: The Agentic AI Foundation Opportunity

### Major Ecosystem Development

**What Happened (December 9, 2025):**
> "The Linux Foundation announced the formation of the Agentic AI Foundation (AAIF), with founding contributions from Anthropic's Model Context Protocol (MCP), Block's goose, and OpenAI's AGENTS.md."

**Founding Members:**
| Company | Contribution | Implication |
|---------|--------------|-------------|
| Anthropic | MCP protocol | Standard foundation |
| OpenAI | AGENTS.md | Cross-platform adoption |
| Block | Goose framework | Agent orchestration |
| Microsoft | AAIF support | VS Code/GitHub integration |
| Google | AAIF support | Gemini compatibility |
| AWS, Cloudflare, Bloomberg | Infrastructure | Enterprise backing |

**Cross-Company Adoption:**
> "OpenAI has been an early adopter and core contributor to Anthropic's Model Context Protocol (MCP), incorporating it as the foundation for apps in ChatGPT."

> "Since its release in August 2025, AGENTS.md has been adopted by more than 60,000 open-source projects and agent frameworks."

### Strategic Implication

**What This Changes:**
- MCP is now industry-wide standard, not just Anthropic's protocol
- Agent Skills specification has cross-platform adoption
- Governance structure exists under Linux Foundation
- Neutral development possible

**Feasibility Assessment:**
Discovery Hub built on MCP + Agent Skills can potentially reach all AAIF-compatible platforms, not just Claude Code.

---

## Section 2: What We Can Influence

### Influence Area 1: Claude Skill Discovery Experience

**Feasibility: HIGH**

**Why:**
- Direct integration with Claude Code via MCP
- Anthropic's stated commitment to skills ecosystem
- Agent Skills now open standard with governance

**Evidence:**
> "The decision to release Skills as an open standard is a calculated strategic choice. By making skills portable across AI platforms, Anthropic is betting that ecosystem growth will benefit the company more than proprietary lock-in."

**What We Can Do:**
- Build best-in-class discovery experience for Claude
- Establish quality standards for Claude skills
- Create reference implementation for AAIF skill discovery

---

### Influence Area 2: Skill Quality Standards

**Feasibility: MEDIUM-HIGH**

**Why:**
- No official quality scoring exists
- Existing marketplaces use minimal filters (2+ stars)
- Open opportunity to define standards

**Evidence:**
> "Skill registries will be needed to manage the discovery and distribution of skills, and policy engines to control which agents can use which skills in which contexts."

**What We Can Do:**
- Propose quality scoring formula to AAIF
- Implement scoring in Discovery Hub as reference
- Share scoring methodology openly
- Invite community feedback on standards

---

### Influence Area 3: Author Success Metrics

**Feasibility: HIGH**

**Why:**
- Authors currently have no visibility into skill usage
- Distribution is #1 author pain point (Layer 2)
- Discovery Hub uniquely positioned to provide analytics

**What We Can Do:**
- Provide authors with discovery metrics
- Show installation and usage data
- Create feedback loop for description improvement
- Highlight what successful skills have in common

---

### Influence Area 4: Community Curation Standards

**Feasibility: MEDIUM**

**Why:**
- Multiple awesome-lists exist without coordination
- Maintainer burnout is universal problem
- Opportunity to provide tooling that reduces burden

**What We Can Do:**
- Provide automated quality signals to curators
- Create submission API for awesome-list maintainers
- Offer verification badges that curators can trust
- Reduce manual review burden

---

## Section 3: What We Cannot Influence (Constraints)

### Constraint 1: Ecosystem Fragmentation

**Feasibility to Change: LOW**

**Reality:**
- 17+ MCP registries already exist
- Each serves different community needs
- Consolidation requires buy-in from competitors

**Evidence:**
> "MCP Marketplace remains a proposed or emerging idea... As of September 2025, there is no official, MCP-governed marketplace."

**Acceptance Strategy:**
- Build federation capability, not replacement
- Index from multiple sources
- Don't require exclusive registration
- Complement, don't compete with, existing registries

---

### Constraint 2: Vendor Tool Lock-In

**Feasibility to Change: LOW (SHORT-TERM)**

**Reality:**
- Each vendor has own configuration format
- CLAUDE.md, .cursorrules, .junie/guidelines.md
- AGENTS.md is emerging but adoption varies

**Evidence:**
> "There's an initiative to create a universal standard called AGENT.md. For now, you can create a symlink to share the same configuration."

**Acceptance Strategy:**
- Focus on Claude ecosystem first
- Support AGENTS.md as secondary
- Wait for AAIF to drive cross-platform standards
- Don't try to solve all tools at once

---

### Constraint 3: Security Trust Deficit

**Feasibility to Change: LOW-MEDIUM**

**Reality:**
- Past incidents (Amazon Q, npm attacks) created lasting distrust
- 48% of AI-generated code has vulnerabilities
- Trust requires sustained evidence, not just claims

**Evidence:**
> "16 of 18 CTOs reported 'production disasters directly caused by AI-generated code'"

**Acceptance Strategy:**
- Accept that trust builds slowly
- Implement trust tiers with verification
- Be transparent about what verification covers
- Don't overclaim security guarantees

---

### Constraint 4: Author Description Quality

**Feasibility to Change: MEDIUM**

**Reality:**
- Authors write vague descriptions
- Learning curve exists
- No feedback loop in current tools

**Evidence:**
> "Writing good descriptions takes practice. The first few skills people create tend to be too broad."

**Mitigation Strategy:**
- Provide description quality scoring
- Show examples of good descriptions
- Offer automated improvement suggestions
- Create feedback loop from discovery failures

---

## Section 4: Required Partnerships

### Essential Partnership 1: Anthropic

**Why Needed:**
- Claude Code integration
- Skills specification evolution
- AAIF participation influence

**What to Seek:**
- Official MCP server listing
- Skills specification input
- Early access to API changes
- Co-marketing of Discovery Hub

**Feasibility:** High - aligns with Anthropic's ecosystem growth strategy

---

### Essential Partnership 2: Existing Registries

**Why Needed:**
- Bootstrap initial skill catalog
- Avoid fragmentation contribution
- Leverage existing curation work

**Key Partners:**
| Registry | Value | Approach |
|----------|-------|----------|
| MCP.so | 17,247 servers indexed | Federation API |
| SkillsMP | Quality indicators | Data sharing |
| Cline Marketplace | IDE integration | Cross-listing |
| LobeHub | Community ratings | Signal aggregation |

**What to Seek:**
- Data sharing agreements
- Federation protocol adoption
- Mutual quality signal sharing
- Attribution and traffic sharing

---

### Essential Partnership 3: GitHub

**Why Needed:**
- Skills hosted on GitHub
- API access for indexing
- Code Quality signals

**What to Seek:**
- API rate limit accommodation
- Code Quality API access
- GitHub Copilot compatibility signals
- Skills topic/tag standards

---

### Beneficial Partnership 4: Awesome List Maintainers

**Why Needed:**
- Curated high-quality lists
- Community trust
- Distribution channels

**Key Lists:**
- awesome-claude-skills
- awesome-claude-code
- awesome-mcp-servers

**What to Seek:**
- Quality signal sharing
- Automated submission API
- Verification badge adoption

---

## Section 5: Cold Start Solution

### The Challenge

**Classic Marketplace Problem:**
> "The biggest initial hurdle to getting your online marketplace running is creating that initial supply or demand."

### Recommended Strategy: Supply-First with Atomic Network

**Approach:**
> "Build the smallest functioning network you can create, the atomic network... Once you have your first successful atomic network you can scale."

### Phase 1: Bootstrap Supply

**Strategy: Index existing high-quality skills**

| Source | Count | Quality Level |
|--------|-------|---------------|
| Anthropic official | ~20 | Verified |
| awesome-claude-skills | ~100 | Curated |
| MCP.so (filtered) | ~500 | Mixed |

**Target: 500 searchable skills at launch**

### Phase 2: Tool-First Value

**Strategy:** "Come for the tool, stay for the network"

> "Offer a tool that solves a critical problem for the supply side."

**Tool Value:**
- Codebase scanner provides immediate value
- Author analytics attract creators
- Quality scoring helps authors improve
- No discovery needed to be useful

### Phase 3: Demand Activation

**Strategy: Contextual recommendations**

Once users scan codebases:
- Recommendations become relevant
- Discovery becomes valuable
- Network effects begin

### Phase 4: Network Growth

**Strategy: Social proof and team adoption**

- "Developers like you use..."
- Team skill sharing
- Organization discovery pages

---

## Section 6: Governance Requirements

### Quality Standards Governance

**Challenge:**
> "The open standard approach introduces governance questions. While Anthropic has published the specification... the long-term stewardship of the standard remains undefined."

**Recommended Approach:**
- Publish scoring methodology openly
- Accept community proposals for changes
- Run scoring on public data for transparency
- Regular community review of standards

### Security Policy Governance

**Challenge:**
> "The power of skills—especially their ability to execute code—introduces new governance challenges. Organizations will need to establish clear processes for auditing, testing, and deploying skills."

**Recommended Approach:**
- Define trust tiers with clear criteria
- Document verification processes
- Publish security scan results
- Enable enterprise-specific policies

### Community Governance

**Reference Model:**
> "AAIF operates as a directed fund under the Linux Foundation, which brings proven expertise in neutral governance, community building, and maintaining long-term sustainability."

**Recommended Approach:**
- Establish advisory group for Discovery Hub
- Include authors, users, and maintainers
- Public roadmap and decision log
- Regular community feedback cycles

---

## Section 7: Capability Requirements

### Must Build

| Capability | Why Must Build | Complexity |
|------------|----------------|------------|
| Skill indexing | Core product | Medium |
| Quality scoring | No standard exists | Medium |
| Codebase scanning | Unique value prop | High |
| MCP servers | Integration requirement | Medium |
| Federation protocol | Avoid fragmentation | Medium |

### Can Acquire/Partner

| Capability | Source | Approach |
|------------|--------|----------|
| Initial catalog | Existing registries | Federation |
| Security scanning | GitHub API, Snyk | API integration |
| Search infrastructure | Meilisearch, Elasticsearch | Open source |
| Community ratings | SkillsMP, LobeHub | Data sharing |

### Can Defer

| Capability | Why Defer | When Needed |
|------------|-----------|-------------|
| Cross-platform support | AAIF will standardize | Phase 2+ |
| Enterprise SSO | Enterprise phase | Phase 3 |
| Skill creation tools | Authors have tools | Phase 2 |

---

## Section 8: Risk Assessment

### Risk 1: Anthropic Builds Competing Feature

**Likelihood:** Medium
**Mitigation:**
- Position as community complement, not competitor
- Build features Anthropic wouldn't prioritize
- Focus on ecosystem growth that benefits Anthropic
- Seek partnership early

### Risk 2: AAIF Creates Official Registry

**Likelihood:** Medium-High
**Mitigation:**
- Build AAIF-compatible from start
- Contribute to AAIF standards
- Position for federation, not replacement
- Be ready to integrate or merge

### Risk 3: Cold Start Failure

**Likelihood:** Medium
**Mitigation:**
- Bootstrap with existing catalogs
- Offer tool value before network value
- Focus on atomic network first
- Don't scale prematurely

### Risk 4: Quality Standards Rejected

**Likelihood:** Low-Medium
**Mitigation:**
- Publish methodology openly
- Accept community feedback
- Start with conservative thresholds
- Iterate based on outcomes

---

## Section 9: Strategic Summary

### What We Can Change

| Area | Feasibility | Priority |
|------|-------------|----------|
| Claude discovery experience | High | P0 |
| Skill quality standards | Medium-High | P0 |
| Author success metrics | High | P1 |
| Community curation burden | Medium | P1 |
| Description quality feedback | Medium | P2 |

### What We Must Accept

| Constraint | Acceptance Strategy |
|------------|---------------------|
| Ecosystem fragmentation | Federation, not replacement |
| Vendor tool lock-in | Claude-first, AGENTS.md second |
| Security trust deficit | Gradual trust building |
| Cross-platform adoption | Wait for AAIF standards |

### Required Partnerships

| Partner | Priority | Why |
|---------|----------|-----|
| Anthropic | Essential | Integration, legitimacy |
| Existing registries | Essential | Bootstrap, federation |
| GitHub | Essential | Data, quality signals |
| Awesome list maintainers | Important | Curation, distribution |

### Cold Start Strategy

1. **Supply:** Index 500+ skills from existing sources
2. **Tool:** Codebase scanner provides standalone value
3. **Demand:** Contextual recommendations activate discovery
4. **Growth:** Team sharing and social proof expand network

---

## Sources

- [AAIF Announcement - Linux Foundation](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [OpenAI AAIF Co-Founding](https://openai.com/index/agentic-ai-foundation/)
- [TechCrunch AAIF Coverage](https://techcrunch.com/2025/12/09/openai-anthropic-and-block-join-new-linux-foundation-effort-to-standardize-the-ai-agent-era/)
- [Block AAIF Announcement](https://block.xyz/inside/block-anthropic-and-openai-launch-the-agentic-ai-foundation)
- [Anthropic Agent Skills Launch](https://venturebeat.com/ai/anthropic-launches-enterprise-agent-skills-and-opens-the-standard)
- [Agent Skills Enterprise Analysis](https://subramanya.ai/2025/12/18/agent-skills-the-missing-piece-of-the-enterprise-ai-puzzle/)
- [Claude Skills Substack Analysis](https://tylerfolkman.substack.com/p/the-complete-guide-to-claude-skills)
- [Simon Willison on Claude Skills](https://simonwillison.net/2025/Oct/16/claude-skills/)
- [Open Skills Network Transition](https://www.wgu.edu/newsroom/press-release/2025/02/osn-transition-rich-skills.html)
- [State of Open Source 2025](https://www.linuxfoundation.org/blog/the-state-of-open-source-software-in-2025)
- [Bootstrapping Marketplace](https://rangle.io/blog/bootstrapping-an-online-marketplace)
- [Cold Start Problem Solutions](https://gopractice.io/product/solving-the-cold-start-problem/)
- [Andrew Chen Cold Start](https://andrewchen.com/how-to-solve-the-cold-start-problem-for-social-products/)
- [AI Code Enterprise Adoption](https://getdx.com/blog/ai-code-enterprise-adoption/)
- [Accenture-Anthropic Partnership](https://newsroom.accenture.com/news/2025/accenture-and-anthropic-launch-multi-year-partnership-to-drive-enterprise-ai-innovation-and-value-across-industries)

---

*Layer 6 feasibility research completed December 26, 2025*
