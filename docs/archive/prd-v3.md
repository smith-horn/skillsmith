# Claude Discovery Hub - Product Requirements Document v3

**Version:** 3.0
**Last Updated:** December 26, 2025
**Status:** Draft - Pending Validation
**Owner:** Product Team
**Document Type:** Source of Truth for WHAT we are building

---

## Related Documents

| Document | Purpose | Status |
|----------|---------|--------|
| [Design](./design/index.md) | Personas, journeys, emotional design, UI/UX specifications | Complete |
| [Technical](./technical/index.md) | Architecture, MCP servers, security implementation, performance | Complete |
| [GTM Strategy](./gtm/index.md) | Distribution channels, growth mechanics, launch plan | Complete |
| [Research: Skill Activation Failures](./research/skill-activation-failure-rca.md) | Root cause analysis of 50% skill activation failure rate | Complete |
| [Research: Security & Conflicts](./research/skill-conflicts-security.md) | Threat model, conflict detection strategies | Complete |
| [Research: Design Entry Points](./research/design-entry-points.md) | Multi-channel entry points, emotional depth design | Complete |
| [Product Review Summary](./reviews/product_review.md) | 4-person expert review convergence | Complete |
| [Layer 1-3 Research](./research/layers/index.md) | Customer mental models, ecosystem, behavioral dynamics | Complete |
| [Cross-Layer Insights](./research/layers/cross-layer-insights.md) | Strategic synthesis from 150+ sources | Complete |

---

## 1. Executive Summary

### Vision

Claude Discovery Hub is a Git-native skill discovery and activation system that helps Claude Code users find, evaluate, and successfully use skills that improve their development workflow. The system operates entirely within the developer's existing environment, using Claude Code as the interface, MCP servers as the API layer, and Git repositories as storage.

### Updated Value Proposition

**Before Research:** "Help developers discover skills they don't know exist."

**After Research:** "Help developers discover skills and ensure they actually work."

Our research revealed that **discovery is the tip of the iceberg**. The deeper pain point is that approximately 50% of installed skills fail to activate reliably. Users will blame Discovery Hub when recommended skills don't work, even if the failure is external. Therefore, our scope must extend beyond discovery to include:
- Quality validation before recommendation
- Safety verification before installation
- Activation diagnostics after installation

### Key Pivot from PRD v2

The original PRD focused heavily on a learning platform (78 exercises, 40+ test repos). Based on expert review, this is scope creep that dilutes the core value proposition. This PRD:
- **Adds** Phase 0 Validation Sprint
- **Adds** Phase 3 Activation Auditor
- **Reduces** learning platform to minimal viable scope
- **Defers** advanced multi-repo swarm capabilities
- **Requires** go/no-go gates between all phases

---

## 1.5 Research Foundation (NEW)

### Layer 1-3 Research Summary

Comprehensive research across 150+ sources (Reddit, HN, Twitter/X, LinkedIn, blogs, Substack, academic papers) reveals that **the Claude Skill Discovery problem is fundamentally behavioral, not technical**.

#### Core Discovery

> "Users with efficient Claude Code workflows actively resist discovering skills that could improve those workflows, because the current design makes capabilities invisible, the ecosystem is fragmented, and behavioral economics favor the status quo over exploration."

#### Five Convergence Points

| Convergence | Layer 1 + 2 + 3 Finding | Implication |
|-------------|-------------------------|-------------|
| **The Invisibility Problem** | Auto-invocation (feature) creates invisibility (bug for discovery). Skills work but users never see them working. | Must make the invisible visible without disrupting auto-invocation benefit |
| **The "Good Enough" Trap** | Users operate at 20% of tool potential (Layer 1) + 95% keep defaults (Layer 3) = stable sub-optimal equilibrium | Must disrupt equilibrium by quantifying the gap between current and potential |
| **The Context Paradox** | Users optimize for context preservation, but that optimization blocks discovery of skills that could reduce context needs | Must frame discovery as context efficiency improvement, not consumption |
| **The Trust Calibration Crisis** | Only 43% trust AI accuracy, yet 76% use AI tools. Both overtrust and undertrust exist. | Must provide calibrated trust signals - neither overselling nor underselling |
| **The 11-Week Reality** | Adoption pattern: 4% → 83% → 60% (month 1 → peak → stable). Teams need 11 weeks to realize benefits. | Must support full adoption journey, not just initial discovery |

#### Key Customer Mental Models (Layer 1)

Users describe Claude Code as:
- **"Junior developer with amnesia"** - powerful but requiring constant supervision
- **"Black box"** - hidden capabilities, opaque extensibility
- **Token-consuming resource** - anxiety about context window usage

**Top 5 User Pain Points (Research-Backed):**

| Rank | Pain Point | Research Evidence |
|------|------------|-------------------|
| 1 | **Black Box / Opacity** | "99% of Claude 4 Users Don't Know This Feature Exists" |
| 2 | **Configuration Fatigue** | "MCP is the worst documented technology I have ever encountered" |
| 3 | **Context Amnesia** | "Every morning, you essentially onboard a new team member from scratch" |
| 4 | **Token Anxiety** | "66,000+ tokens of context before even starting a conversation" |
| 5 | **Activation Uncertainty** | "Claude just wouldn't use the skills automatically" |

#### Ecosystem Statistics (Layer 2)

| Metric | Value | Source |
|--------|-------|--------|
| Skills indexed (SkillsMP) | 25,000+ | SkillsMP.com |
| Plugins indexed (claude-plugins.dev) | 8,412+ | claude-plugins.dev |
| MCP servers indexed (mcp.so) | 17,237+ | mcp.so |
| Monthly MCP SDK downloads | 97M+ | Anthropic |
| Developers using AI tools | 84% | Stack Overflow 2025 |
| Trust in AI accuracy | 43% | Stack Overflow 2025 |
| Enterprises achieving majority adoption | ~33% | Industry research |

**Key Ecosystem Finding:** The #1 pain point for skill authors is **discoverability**. There is no centralized, authoritative marketplace.

#### Behavioral Blockers (Layer 3)

| Blocker | Severity | Key Evidence |
|---------|----------|--------------|
| **Cognitive Load / Context Switching** | Critical | 23 minutes to regain focus after interruption |
| **Status Quo Bias** | High | 95% of users never change default settings |
| **Tool Fatigue** | High | Workers switch between apps 33+ times daily |
| **Identity / Craft Protection** | High | 48% uncomfortable admitting AI use to managers |
| **Trust Deficit** | Critical | Only 43% trust AI coding assistant accuracy |

#### The "70% Problem" Framework

> "Non-engineers using AI coding tools can rapidly reach 70% completion, but struggle dramatically with the final 30%."
> — Addy Osmani, Substack

**Implication:** Skills that help bridge the 70% → 100% gap are highest value. Discovery Hub must identify and recommend these skills.

#### Research-Derived Design Requirements

1. **Make the Invisible Visible** - Show skills in action without disruption
2. **Disrupt "Good Enough"** - Quantify gap between current and potential
3. **Preserve Context Efficiency** - Frame discovery as efficiency gain
4. **Build Calibrated Trust** - Transparent quality signals, honest limitations
5. **Support 11-Week Journey** - Quick wins → sustained engagement → mastery

---

## 2. Problem Statement

### Primary Problem

Claude Code users cannot efficiently discover which skills would benefit their specific project context.

**Evidence (Research-Updated):**
- 50,000+ skills/MCPs exist across fragmented sources (SkillsMP: 25K, claude-plugins.dev: 8.4K, mcp.so: 17K)
- No unified search across Anthropic official, community repositories, and aggregators
- No codebase-aware recommendations
- Users rely on word-of-mouth, Twitter/X, and manual GitHub browsing
- **90% of features users request already exist** (Microsoft 2006 survey, still applicable)
- **Users operating at 20% of tool potential** (Layer 1 research)

### The Behavioral Root Cause (NEW)

The problem is not primarily technical—it's behavioral. Research reveals:

> "The very habits that make users productive (context preservation, task focus, workflow automation) create barriers to discovering new capabilities."

**Competing Behaviors That Block Discovery:**

| Competing Behavior | Why It Wins | Friction to Switch |
|--------------------|-------------|-------------------|
| Manual Coding | Predictable, familiar, satisfying craft work | High identity investment |
| Stack Overflow | Known resource, community validated | Decades of habit |
| GitHub Copilot | Already integrated in IDE | Context switching cost |
| ChatGPT Web | Familiar interface, "good enough" | Brand awareness |
| Ask a Colleague | Trust, context understanding | Social capital invested |

### Secondary Problem (Critical)

Even after discovery, **25-35% of skills fail due to addressable causes**, and **another 40% fail due to model behavior issues** we cannot solve.

**Failure Distribution (from [Skill Activation Failure RCA](./research/skill-activation-failure-rca.md)):**

| Failure Category | Prevalence | Addressable |
|-----------------|------------|-------------|
| Non-deterministic model invocation | 40% | No (Anthropic) |
| Character budget exhaustion | 20% | Partial |
| YAML/frontmatter formatting errors | 15% | Yes |
| Directory discovery failures | 10% | Partial |
| MCP connection issues | 10% | No (Anthropic) |
| Plan mode restrictions | 5% | No (Anthropic) |

**Implication:** Discovery Hub must either address the 25-35% we can influence, or clearly communicate limitations so users don't blame us for the 65-75% we cannot solve.

### Tertiary Problem

Users lack confidence in skill quality and safety.

**Evidence:**
- No standardized quality metrics
- No supply chain security verification
- Skills can contain arbitrary instructions with no sandboxing
- Typosquatting and impersonation risks exist

### What We Are NOT Solving

- Model-level skill invocation behavior (requires Anthropic)
- MCP connection/registration bugs (requires Anthropic)
- Runtime sandboxing for skill execution (requires platform changes)
- Plan mode tool restrictions (architectural)

---

## 3. Goals and Success Metrics

### Primary Goal

Enable Claude Code users to discover and successfully activate skills that provide measurable value within a single session.

### Success Metrics by Phase

#### Phase 0: Validation Sprint

| Metric | Target | Measurement |
|--------|--------|-------------|
| User interviews completed | 15+ | Count |
| Activation time validated | <15 min median | Stopwatch testing with 10 users |
| Recommendation quality baseline | Established | Expert review comparison |
| Go/no-go decision | Clear data | Gate criteria evaluation |

#### Phase 1: Foundation + Safety

| Metric | Target | Measurement |
|--------|--------|-------------|
| Skills indexed | 25,000+ | Database count |
| Search success rate | 80%+ find relevant results | User testing |
| Quality score accuracy | 75%+ match expert assessment | Calibration study |
| Safety scan coverage | 100% of indexed skills | Pipeline completion |
| Time to first search | <2 minutes from install | Onboarding testing |

#### Phase 2: Recommendations + Entry Points

| Metric | Target | Measurement |
|--------|--------|-------------|
| Stack detection accuracy | 85%+ on common frameworks | Test project validation |
| Recommendation install rate | 30%+ | Telemetry (with consent) |
| Time to first useful recommendation | <10 minutes | User testing |
| Web browser monthly visitors | 5,000+ | Analytics |
| VS Code extension installs | 1,000+ | Marketplace stats |

#### Phase 3: Activation Auditor

| Metric | Target | Measurement |
|--------|--------|-------------|
| Activation issues detected | 80%+ of addressable failures | Test suite |
| Users completing audit | 50%+ of installers | Telemetry |
| Perceived failure reduction | 25%+ improvement | User surveys |
| Auto-fix success rate | 70%+ for YAML issues | Automated testing |

#### Phase 4: Learning + Scale

| Metric | Target | Measurement |
|--------|--------|-------------|
| Learning path completion | 30%+ start, 50%+ of starters complete | Progress tracking |
| Weekly active users | 5,000+ | Telemetry |
| NPS | >40 | Survey |
| Community skill submissions | 25+/month | Contribution tracking |

### Revised Success Criteria (Per Growth Engineer Feedback)

**Old Target:** 5 minutes to value
**New Target:** 15 minutes to first meaningful value (validated)

**Old Target:** 70% recommendation accuracy
**New Target:** 30% recommendation install rate (actual behavior, not stated preference)

**Added Metric:** Cumulative drop-off rate at each onboarding step (target: <50% by value moment)

### Research-Derived Behavioral Metrics (NEW)

Based on Layer 3 behavioral research, add these metrics:

| Metric | Target | Research Basis |
|--------|--------|----------------|
| **Time to skill awareness** | < 5 minutes | Address "black box" problem |
| **Skill activation visibility** | 100% (users see skills working) | Make invisible visible |
| **Context switching interruptions** | 0 per discovery session | 23-min recovery cost |
| **Discovery without workflow disruption** | > 80% | Behavioral research on flow state |
| **Skill adoption funnel** | Awareness 80% → Trial 30% → Adoption 20% | Fogg Behavior Model |

### Behavioral Intervention Requirements (NEW)

Based on academic research (Fogg Behavior Model, TAM), Discovery Hub must implement:

| Intervention | Target Behavior | Research Basis |
|--------------|-----------------|----------------|
| **Passive Discovery** | Surfacing skills at moment of need | "Discovery must not require proactive action" |
| **Contextual Prompts** | Non-intrusive skill suggestions | 23-min context switch recovery |
| **Social Proof** | Team/community adoption signals | 63% of decisions influenced by peers |
| **One-Click Adoption** | Zero-config skill activation | Reduce friction to near-zero |
| **Quick Wins** | Value within first session | Front-load benefits to sustain 11-week journey |
| **Skill Attribution** | "Using: TDD Skill" indicators | Make invisible capabilities visible |

---

## 4. Scope

### 4.1 In Scope

**Phase 0-1 (MVP):**
- Unified skill search across 3+ sources
- Quality scoring with transparent methodology
- Safety scanning (static analysis, blocklist integration)
- Basic CLI interface within Claude Code
- Installation command generation

**Phase 2:**
- Codebase-aware recommendations
- Stack detection for major frameworks
- Web skill browser (static site)
- VS Code extension (sidebar)
- Designed failure states and recovery

**Phase 3:**
- Skill activation auditor (pre/post install diagnostics)
- YAML validation and auto-fix
- Character budget monitoring
- Directory discovery verification

**Phase 4:**
- Single learning path with 5 exercises
- 2 test repositories with challenges
- Public skill profiles
- Author dashboard basics

### 4.2 Out of Scope

| Item | Reason | Alternative |
|------|--------|-------------|
| Fixing model invocation behavior | Requires Anthropic platform changes | Document limitations; provide hooks workaround |
| Runtime skill sandboxing | Requires Claude Code architecture changes | Advocate to Anthropic |
| MCP connection debugging | Platform responsibility | Provide diagnostic commands only |
| Full learning curriculum (78 exercises) | Scope creep; separate product | Defer to Phase 5+ or spin off |
| Multi-repo swarm analysis | Premature optimization | Defer to Phase 5+ |
| Team/organization features | Enterprise motion; different GTM | Defer; evaluate as separate product |

### 4.3 Deferred (Post-Phase 4)

- JetBrains plugin
- Cursor IDE integration
- Slack/Discord bot
- GitHub Action for PR recommendations
- Team skill registries
- Enterprise SSO integration
- Skill certification authority
- Full 3 learning paths with 15+ exercises

---

## 5. Phased Roadmap

### Phase 0: Build-to-Learn Sprint (6-8 weeks) — CEO APPROVED

**Purpose:** Build POC with behavioral instrumentation to observe actual user behavior.

**Approach:** Embedded research (Teresa Torres-style story interviews) throughout POC usage.

**Week 1-2: POC Foundation**
- Build core discovery functionality with behavioral instrumentation
- Implement skill attribution workaround ("Using: X Skill" post-response)
- Set up opt-out telemetry with clear value proposition
- Begin author recruitment (10+ skill authors)

**Week 3-4: User Recruitment + Observation**
- Recruit 50+ beta users
- Begin Teresa Torres story-based interviews (10-15 planned)
- Observe behavioral funnel: Awareness → Trial → Adoption
- Track time to skill awareness, context switching patterns

**Week 5-6: Peak Adoption Observation**
- Continue interviews with users at Week 6 (peak adoption phase)
- Measure adoption curve against 4% → 83% research baseline
- Engage 2-3 thought leaders for early feedback

**Week 7-8: Synthesis + Gate Decision**
- Compile behavioral findings
- Compare observed adoption to research predictions
- Execute go/no-go decision

**Parallel Track: Anthropic Partnership**
- Pursue native skill attribution integration with Claude Code team
- Outcome: Partnership commitment or confirmation of independent path

---

### Phase 1: Foundation + Safety (Weeks 9-12)

**Purpose:** Deliver search and quality that users can trust.

**Deliverables:**
1. skill-index MCP server
   - Search across Anthropic, skillsmp, awesome-claude-skills
   - Filter by category, quality tier, last updated
   - 25,000+ skills indexed

2. Quality scoring system
   - Transparent methodology (documentation, stars, recency, maintainer)
   - Score displayed prominently
   - Exploration bonus for new skills

3. Safety layer
   - Static analysis for known bad patterns
   - Blocklist integration
   - Trust tier display (Official, Verified, Community, Unverified)
   - Typosquatting detection

4. Basic CLI
   - `/discover search <query>`
   - `/discover info <skill-id>`
   - `/discover install <skill-id>`

**NOT in Phase 1:**
- Codebase analysis
- Recommendations
- Learning platform
- Web interface

---

### Phase 2: Recommendations + Entry Points (Weeks 13-16)

**Purpose:** Deliver context-aware suggestions and meet users where they are.

**Deliverables:**
1. codebase-scan MCP server
   - Stack detection (TypeScript, React, Python, Node, etc.)
   - Gap analysis against skill index
   - Recommendation generation

2. Skill browsing website
   - Static site (Astro/Next.js)
   - Category browsing with visual cards
   - Quality scores and install commands
   - SEO-optimized for discovery

3. VS Code extension
   - Sidebar with skill browser
   - Context-aware suggestions based on open files
   - One-click install (generates terminal command)

4. Designed failure states
   - Search returns nothing: Show alternatives
   - Installation fails: Provide diagnostics
   - Skill doesn't activate: Explain why, offer fixes

**Entry Points Added (Per [Design Entry Points Research](./research/design-entry-points.md)):**

| Entry Point | Effort | Impact | Primary Persona |
|-------------|--------|--------|-----------------|
| Web skill browser | Medium | High | Explorer, Skeptic |
| VS Code extension | Medium | Very High | Optimizer, Overwhelmed |

---

### Phase 3: Activation Auditor (Weeks 17-20)

**Purpose:** Address the 25-35% of activation failures we can influence.

**Deliverables:**
1. Pre-installation audit
   - Validate YAML frontmatter against schema
   - Check description length limits
   - Verify required fields present
   - Score likelihood of activation success

2. Post-installation audit
   - Calculate total character budget usage
   - Warn users approaching 15K limit
   - Identify skills at risk of truncation
   - Verify directory discovery worked

3. Auto-fix capabilities
   - Repair common YAML formatting issues
   - Generate Prettier-ignore directives
   - Recommend description optimizations

4. Diagnostic commands
   - `/discover audit` - Check installed skills health
   - `/discover diagnose <skill-id>` - Deep dive on specific skill
   - `/discover budget` - Show character budget usage

**Addressable Failure Reduction Target:** 25% improvement in perceived activation success

---

### Phase 4: Learning + Scale (Weeks 21-24)

**Purpose:** Deepen engagement and build community.

**Deliverables (Reduced Scope):**
1. Single learning path: "Claude Code Fundamentals"
   - 5 exercises (not 78)
   - 2 test repositories (not 40+)
   - Automated validation

2. learning MCP server
   - `get_exercise()`
   - `validate_work()`
   - `get_progress()`

3. Public skill profiles
   - discoveries.dev/@username
   - Installed skills with usage frequency
   - "Clone this setup" functionality

4. Author dashboard basics
   - Download/install statistics
   - Quality score breakdown
   - Improvement suggestions

**NOT in Phase 4:**
- Multiple learning paths
- Advanced exercises
- Team features
- Swarm multi-repo analysis

---

## 6. Feature Requirements

### 6.1 Phase 1: Search + Quality + Safety

#### User Story 1.1: Basic Skill Search
**As a** Claude Code user
**I want to** search for skills by keyword
**So that** I can find skills relevant to my needs without leaving my terminal

**Acceptance Criteria:**
- [ ] `/discover search "testing react"` returns relevant results in <2 seconds
- [ ] Results show: name, description (truncated), quality score, source
- [ ] Results sorted by relevance (query match + quality score)
- [ ] Pagination for >10 results
- [ ] Works offline with cached index

#### User Story 1.2: Quality Transparency
**As a** developer evaluating skills
**I want to** understand why a skill has its quality score
**So that** I can make an informed decision about installing

**Acceptance Criteria:**
- [ ] `/discover info <skill-id>` shows score breakdown
- [ ] Components shown: documentation (0-25), stars (0-25), recency (0-25), maintainer (0-25)
- [ ] Explanation of each component calculation
- [ ] Clear indication of trust tier (Official/Verified/Community/Unverified)

#### User Story 1.3: Safety Visibility
**As a** security-conscious developer
**I want to** know if a skill has potential safety issues
**So that** I don't install something malicious

**Acceptance Criteria:**
- [ ] Blocklisted skills show warning before install
- [ ] Skills with external URLs flagged for review
- [ ] Typosquatting warnings for similar-named skills
- [ ] Trust tier clearly displayed
- [ ] No auto-install of Unverified tier without explicit confirmation

#### User Story 1.4: Installation Flow
**As a** developer who found a useful skill
**I want to** install it with minimal friction
**So that** I can start using it immediately

**Acceptance Criteria:**
- [ ] `/discover install <skill-id>` generates correct plugin command
- [ ] Command shown for copy-paste (not auto-executed for safety)
- [ ] Post-install verification offered
- [ ] Rollback instructions provided

---

### 6.2 Phase 2: Recommendations + Entry Points

#### User Story 2.1: Codebase Analysis
**As a** developer working on a project
**I want** Discovery Hub to analyze my codebase
**So that** I get personalized skill recommendations

**Acceptance Criteria:**
- [ ] `/discover recommend` analyzes current directory
- [ ] Stack detection identifies: languages, frameworks, tools
- [ ] Gap analysis compares against indexed skills
- [ ] Top 3 recommendations shown with rationale
- [ ] Analysis completes in <30 seconds for typical project

#### User Story 2.2: Web Browsing
**As a** developer exploring options
**I want to** browse skills visually in my web browser
**So that** I can compare options without terminal commands

**Acceptance Criteria:**
- [ ] discoveries.dev shows searchable skill catalog
- [ ] Category filters (testing, documentation, debugging, etc.)
- [ ] Side-by-side comparison of up to 3 skills
- [ ] Install command displayed with copy button
- [ ] Mobile-responsive design

#### User Story 2.3: IDE Integration
**As a** developer working in VS Code
**I want** skill suggestions based on what I'm coding
**So that** discovery happens naturally in my workflow

**Acceptance Criteria:**
- [ ] VS Code extension shows sidebar panel
- [ ] Context-aware suggestions based on open file type
- [ ] One-click to copy install command
- [ ] Notification for high-confidence recommendations (configurable)
- [ ] Settings to disable/customize suggestions

#### User Story 2.4: Graceful Failure Handling
**As a** user who encountered an error
**I want** helpful guidance on what went wrong
**So that** I'm not left stuck or frustrated

**Acceptance Criteria:**
- [ ] Zero results: Show search effort, alternatives, broader terms
- [ ] Install fails: Show diagnostics, suggest fixes
- [ ] Skill doesn't activate: Explain mechanism, offer workarounds
- [ ] All errors include: explanation, next steps, feedback option

---

### 6.3 Phase 3: Activation Auditor

#### User Story 3.1: Pre-Install Validation
**As a** developer about to install a skill
**I want** to know if it will likely activate correctly
**So that** I don't waste time on broken skills

**Acceptance Criteria:**
- [ ] `/discover audit <skill-id>` runs before install
- [ ] Checks: YAML syntax, description length, required fields
- [ ] Activation probability score (high/medium/low)
- [ ] Specific issues listed with fix suggestions
- [ ] Can proceed with warning if issues found

#### User Story 3.2: Budget Monitoring
**As a** user with multiple skills installed
**I want** to know if I'm approaching the character budget limit
**So that** my skills don't silently stop working

**Acceptance Criteria:**
- [ ] `/discover budget` shows current usage vs 15K limit
- [ ] Skills ranked by description length
- [ ] Warning at 80% budget used
- [ ] Recommendations for optimization (shorter descriptions, consolidation)
- [ ] Guidance on increasing budget via environment variable

#### User Story 3.3: Post-Install Health Check
**As a** user who just installed a skill
**I want** to verify it's properly set up
**So that** I catch issues before they cause problems

**Acceptance Criteria:**
- [ ] Automatic check after install (opt-in)
- [ ] Verifies: file exists, directory discovered, YAML valid
- [ ] Reports: discovered vs expected skills count
- [ ] Auto-fix offered for common issues
- [ ] Clear success/failure indication

#### User Story 3.4: Diagnostic Deep Dive
**As a** user whose skill isn't working
**I want** detailed diagnostics
**So that** I can understand and fix the issue

**Acceptance Criteria:**
- [ ] `/discover diagnose <skill-id>` provides comprehensive report
- [ ] Checks all 6 failure categories from RCA
- [ ] Indicates which issues are addressable vs platform-level
- [ ] Provides specific remediation steps for addressable issues
- [ ] Links to relevant GitHub issues for platform-level problems

---

### 6.4 Phase 4: Learning + Scale

#### User Story 4.1: Structured Learning
**As a** Claude Code user wanting to improve
**I want** a guided learning path
**So that** I systematically build my skills

**Acceptance Criteria:**
- [ ] "Claude Code Fundamentals" path with 5 exercises
- [ ] Clear prerequisites and estimated time
- [ ] `/learn next` provides next appropriate exercise
- [ ] Progress tracked in markdown file
- [ ] Exercises have automated validation

#### User Story 4.2: Hands-on Practice
**As a** learner
**I want** realistic coding challenges
**So that** I practice with real scenarios

**Acceptance Criteria:**
- [ ] 2 test repositories with seeded challenges
- [ ] Clear success criteria for each challenge
- [ ] `/learn validate` checks work automatically
- [ ] Hints available for stuck users
- [ ] Solution explanation after completion

#### User Story 4.3: Public Profile
**As a** skilled Claude Code user
**I want** to share my setup publicly
**So that** others can learn from my configuration

**Acceptance Criteria:**
- [ ] Profile at discoveries.dev/@username
- [ ] Shows installed skills with usage stats
- [ ] Optional "recommended stack" curation
- [ ] "Clone this setup" generates install commands
- [ ] Privacy controls for what's shared

#### User Story 4.4: Author Visibility
**As a** skill author
**I want** to see how my skill is being used
**So that** I can improve it and feel motivated

**Acceptance Criteria:**
- [ ] Author dashboard at discoveries.dev/author
- [ ] Download/install counts
- [ ] Quality score breakdown with improvement suggestions
- [ ] Version adoption curve
- [ ] Feedback collection (opt-in from users)

---

## 7. Go/No-Go Gates

### Gate 0: End of Build-to-Learn Sprint (Week 8) — CEO APPROVED

**Decision:** Proceed to Phase 1 / Pivot / Stop

**Proceed Criteria (all must pass):**
- [ ] Behavioral funnel observed: 80%+ awareness, 30%+ trial, 20%+ adoption
- [ ] Peak adoption (Week 6) aligns with 83% research baseline (±20%)
- [ ] 10+ Teresa Torres interviews completed with actionable insights
- [ ] Skill attribution workaround validated as useful
- [ ] 3+ thought leaders engaged with positive feedback
- [ ] No critical technical blockers identified

**Pivot Triggers:**
- Adoption curve significantly below research baseline → Investigate behavioral blockers
- Skill attribution not valued by users → Focus on other visibility mechanisms
- Thought leaders unresponsive → Adjust GTM channel strategy

**Stop Triggers:**
- <10% adoption rate by Week 6
- Critical platform dependency discovered (Anthropic announces competing solution)
- Team consensus against viability

---

### Gate 1: End of Phase 1 (Week 12)

**Decision:** Proceed to Phase 2 / Extend Phase 1 / Stop

**Proceed Criteria (all must pass):**
- [ ] 100+ users completed successful search and install
- [ ] Search returns useful results 80%+ of the time (user testing)
- [ ] Quality scores correlate with user satisfaction (r > 0.5)
- [ ] Zero critical security incidents
- [ ] Infrastructure costs within budget

**Extend Phase 1 Triggers:**
- 50-100 users completed → 2 more weeks
- 60-80% search success → Focus on relevance improvements

**Stop Triggers:**
- <50 users despite marketing effort
- <60% search success rate
- Security incident with user data

---

### Gate 2: End of Phase 2 (Week 16)

**Decision:** Proceed to Phase 3 / Pivot to maintenance mode / Stop

**Proceed Criteria:**
- [ ] 500+ weekly active users
- [ ] 25%+ recommendation install rate
- [ ] Web browser has 1,000+ monthly visitors
- [ ] VS Code extension has 200+ installs
- [ ] User churn <20% month-over-month

**Maintenance Mode Triggers:**
- 200-500 WAU → Maintain Phase 2, don't expand
- 15-25% install rate → Focus on recommendation quality

**Stop Triggers:**
- <200 WAU
- <15% install rate
- Anthropic announces competing solution

---

### Gate 3: End of Phase 3 (Week 20)

**Decision:** Proceed to Phase 4 / Maintain current scope

**Proceed Criteria:**
- [ ] Activation auditor used by 50%+ of installers
- [ ] 25%+ improvement in user-reported activation success
- [ ] Auto-fix resolves 70%+ of YAML issues
- [ ] User satisfaction score >3.5/5 for diagnostic features

**Maintain Current Scope Triggers:**
- <40% auditor usage → Focus on adoption
- <15% perceived improvement → Iterate on diagnostics

---

### Gate 4: End of Phase 4 (Week 24)

**Decision:** Scale up / Maintain / Sunset

**Scale Up Criteria:**
- [ ] 5,000+ weekly active users
- [ ] 30%+ learning path completion rate
- [ ] NPS >40
- [ ] 10+ community skill submissions per month
- [ ] Clear path to sustainability (revenue or sponsorship)

**Maintain Criteria:**
- 2,000-5,000 WAU → Continue with current resources
- NPS 20-40 → Focus on user feedback improvements

**Sunset Triggers:**
- <1,000 WAU
- NPS <20
- No path to sustainability identified

---

## 8. Risks and Mitigations

### Critical Risks

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Anthropic launches official marketplace | Medium | Fatal | 1. Position as community complement 2. Seek partnership 3. Differentiate on quality/safety | Product |
| 50% skill activation failure blamed on us | High | High | 1. Clear messaging on limitations 2. Activation auditor 3. Transparent failure explanations | Product + Engineering |
| No demand exists | Medium | Fatal | Phase 0 validation before investment | Product |
| Supply chain security incident | Medium | High | 1. Static scanning 2. Blocklist 3. Trust tiers 4. No auto-install of unverified | Engineering |
| Skill conflicts cause user issues | Medium | Medium | 1. Conflict detection at install 2. Priority configuration 3. Clear warnings | Engineering |

### High Risks

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| 5-minute activation unrealistic | High | Medium | Revised target: 15 minutes; simplified onboarding | Product |
| No self-sustaining growth loop | High | Medium | 1. Author dashboard for viral 2. Public profiles 3. SEO-optimized web | Growth |
| Learning platform is scope creep | Medium | Medium | Reduced to 1 path, 5 exercises, 2 repos | Product |
| GitHub API rate limits hit | Medium | Medium | Incremental updates; caching; multiple tokens | Engineering |
| MCP performance overhead | Medium | Medium | Consolidate 6 servers to 3; optimize startup | Engineering |

### Medium Risks

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Claude Code API changes | Low | High | Abstraction layer; version pinning | Engineering |
| Quality scoring gamed | Medium | Low | Multi-signal approach; community flagging | Product |
| Low learning completion | Medium | Low | Shorter exercises; bite-sized progress | Product |

---

## 9. Open Questions

### Requiring Decision Before Phase 1

1. **Index hosting:** Public GitHub repo vs. private infrastructure?
   - Tradeoff: Transparency vs. control
   - Recommendation: Start with public, migrate if needed

2. **Telemetry approach:** Opt-in vs. opt-out vs. none?
   - Tradeoff: Data for improvement vs. privacy concerns
   - Recommendation: Opt-in with clear value proposition

3. **Monetization model:** Open source vs. freemium?
   - Tradeoff: Community growth vs. sustainability
   - Recommendation: Open source core; evaluate premium later

### Requiring Research Before Phase 2

4. **Trust verification:** How to verify publisher identity without central authority?
   - Options: GitHub identity, Sigstore signing, manual review
   - Recommendation: Research in Phase 1, implement in Phase 2

5. **Conflict detection:** Static analysis vs. runtime observation?
   - Options: Install-time warnings vs. usage pattern detection
   - Recommendation: Start static (Phase 2), add runtime (Phase 3+)

### Requiring Anthropic Input

6. **Platform roadmap:** Will Anthropic build official marketplace?
   - Impact: Fatal if yes; defines positioning if maybe
   - Action: Seek informal conversation with Anthropic team

7. **MCP stability:** What is the MCP API stability commitment?
   - Impact: Maintenance burden; architecture decisions
   - Action: Review MCP documentation; join community channels

---

## 10. Appendix

### A. Glossary

| Term | Definition |
|------|------------|
| **Skill** | A markdown file (SKILL.md) containing instructions that Claude uses to perform specific tasks |
| **MCP** | Model Context Protocol - Anthropic's standard for extending Claude's capabilities |
| **Activation** | The process by which Claude recognizes and uses a skill during a conversation |
| **Character budget** | The ~15,000 character limit for skill descriptions in Claude's context |
| **Trust tier** | Classification of skills by verification level (Official, Verified, Community, Unverified) |
| **Activation auditor** | Diagnostic tool to identify why skills fail to activate |

### B. Research Sources

**Official Anthropic Documentation:**
- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills)
- [MCP Protocol Reference](https://code.claude.com/docs/en/mcp)
- [Plugin Marketplace Guide](https://code.claude.com/docs/en/plugin-marketplaces)

**Key GitHub Issues (Skill Activation Failures):**
- #9716: Skills not discovered
- #11266: User skills not auto-discovered
- #14577: /skills shows no skills found
- #10766: Skills not triggered in plan mode

**Community Research:**
- [Scott Spence: Skills Don't Auto-Activate](https://scottspence.com/posts/claude-code-skills-dont-auto-activate)
- [Jesse Vincent: Skills Not Triggering](https://blog.fsck.com/2025/12/17/claude-code-skills-not-triggering/)
- [Han Chung Lee: Skills Deep Dive](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/)

### C. Competitor/Alternative Analysis

| Alternative | Strengths | Weaknesses | Our Differentiation |
|-------------|-----------|------------|---------------------|
| awesome-claude-skills repos | Community curated | No search, no quality scores | Unified search + quality |
| skillsmp.com | Aggregated index | Web-only, no recommendations | Terminal-native, codebase-aware |
| Claude Plugins Dev | Visual browsing | No codebase analysis | Context-aware + activation auditor |
| Manual GitHub browsing | Full control | Time-consuming, no personalization | Personalized recommendations |

### D. Phasing Summary (CEO APPROVED)

| Phase | Weeks | Focus | Key Deliverable | Gate Metric |
|-------|-------|-------|-----------------|-------------|
| 0 | 1-8 | Build-to-Learn | POC + Behavioral observation + Embedded research | 80% awareness, 20% adoption |
| 1 | 9-12 | Foundation | Search + Quality + Safety | 100+ successful users |
| 2 | 13-16 | Recommendations | Codebase-aware + Entry points | 500+ WAU |
| 3 | 17-20 | Activation | Auditor + Diagnostics | 25%+ improvement |
| 4 | 21-24 | Learning | 1 path + profiles | 5,000+ WAU, NPS>40 |

### E. CEO Decisions Applied (December 26, 2025)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Problem framing | Behavioral focus | Design for behavioral interventions, not just features |
| POC duration | 6-8 weeks | Capture peak adoption phase (Week 6) |
| Skill attribution | Both paths in parallel | Build workaround + pursue Anthropic partnership |
| Ecosystem aggregation | Scrape/API first, formalize later | Prove value before seeking partnerships |
| Telemetry approach | Opt-out with clear value | Enable social proof; transparency builds trust |
| Contrarian views | Move to appendix | Reference for calibration without prominent display |
| POC validation | Embedded research | Teresa Torres interviews throughout POC |

### F. Contrarian Perspectives (For Calibration)

The following perspectives from the research provide important counterbalance:

**Gary Marcus (AI Skeptic):**
> "Nobody's going to make much money off it because they're expensive to run, and everybody has the same product."

**METR Study Finding:**
> "Developers using AI tools were 19% slower to complete tasks than those without, yet predicted they would be 24% faster."

**Security Research:**
> "62% of AI-generated code is insecure by default."

**Enterprise Adoption Reality:**
> "16 of 18 CTOs reported 'production disasters directly caused by AI-generated code.'"

**Why This Matters:** These perspectives inform our honest positioning. We must avoid overpromising and build calibrated expectations with users.

---

**Document History:**
- v3.2 (December 26, 2025): CEO decisions applied - 6-8 week POC, embedded research, skill attribution both paths, opt-out telemetry, contrarian views to appendix
- v3.1 (December 26, 2025): Incorporated Layer 1-3 research findings (150+ sources), behavioral intervention requirements, research-derived metrics
- v3.0 (December 26, 2025): Major revision incorporating 4-person review, activation failure research, entry points research, security research
- v2.0 (December 24, 2025): Initial Git-native architecture proposal
- v1.0: Not documented

**Next Review:** After Phase 0 gate decision (Week 8)
