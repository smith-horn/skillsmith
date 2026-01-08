# Claude Skill Discovery: Product Research Document

> **Purpose**: Inform the development of an intelligent Claude plugin that recommends skills based on codebase analysis and user goals.
>
> **Research Date**: December 26, 2025
> **Author**: Product Research via Claude Code

---

## Executive Summary

The Claude skills ecosystem has grown to **46,000+ indexed skills** across multiple marketplaces, yet discovery remains fragmented and manual. Users navigate a two-step installation process, scattered documentation, and unreliable skill activation. This research identifies four user personas, maps their discovery journeys, and highlights key pain points that create opportunities for an intelligent recommendation system.

**Key Opportunity**: No existing solution analyzes a user's codebase and documentation to proactively recommend relevant skills. Current discovery is reactive (search-based) rather than proactive (context-aware).

---

## Table of Contents

1. [Market Context](#1-market-context)
2. [User Personas](#2-user-personas)
3. [Discovery Channels](#3-discovery-channels)
4. [User Journey Map](#4-user-journey-map)
5. [Quantitative Metrics](#5-quantitative-metrics)
6. [Pain Points Analysis](#6-pain-points-analysis)
7. [Opportunity Areas](#7-opportunity-areas)
8. [Competitive Landscape](#8-competitive-landscape)
9. [Recommendations for Plugin Development](#9-recommendations-for-plugin-development)
10. [Sources](#10-sources)

---

## 1. Market Context

### 1.1 Claude Code Adoption

| Metric | Value | Source |
|--------|-------|--------|
| Claude Monthly Active Users (Web) | 18.9M | Second Talent |
| Claude Code Market Share (Coding) | 50%+ | SQ Magazine |
| Enterprise AI Assistant Market Share | 29% (up from 18% in 2024) | AI Statistics 2025 |
| Fortune 500 Adoption | 60% | Views4You |

### 1.2 Skills Ecosystem Scale

| Marketplace | Skills Indexed | Key Feature |
|-------------|---------------|-------------|
| claude-plugins.dev | 46,100+ | Auto-indexing from GitHub |
| SkillsMP.com | 34,400+ | Semantic search |
| Official Anthropic | ~20 core skills | Quality-vetted |
| Community Awesome Lists | 200-500 curated | Manual curation |

### 1.3 Timeline

- **October 16, 2025**: Claude Skills officially announced
- **October 9, 2025**: Plugins enter public beta
- **December 2025**: Agent Skills specification released as open standard (adopted by OpenAI Codex CLI)

---

## 2. User Personas

### 2.1 Persona: The Explorer (Hobbyist/Learner)

**Demographics**
- Age: 18-24 (51.88% of Claude users)
- Experience: Junior developer or student
- Plan: Claude Pro ($20/month)

**Goals**
- Learn new technologies and best practices
- Experiment with AI-assisted coding
- Build side projects faster

**Behaviors**
- Browses "awesome" lists on GitHub
- Follows tech influencers on X/Twitter
- Reads blog posts and tutorials
- Installs skills based on popularity (stars)

**Quote** (from community):
> "The idea clicked immediately because everything I'd been building locally—custom commands, agents—was stuck in .claude/ folders per project."

---

### 2.2 Persona: The Optimizer (Indie Developer)

**Demographics**
- Age: 25-34
- Experience: 3-7 years professional
- Plan: Claude Pro or Max

**Goals**
- Ship faster with fewer context switches
- Automate repetitive workflows
- Reduce cognitive load from tooling setup

**Behaviors**
- Searches for specific capabilities (e.g., "playwright testing skill")
- Evaluates skills by reading SKILL.md before installing
- Creates custom skills for personal workflows
- Values reliability over novelty

**Quote** (from Scott Spence's blog):
> "Writing a good description makes the skill activate when relevant. Write a vague one and Claude never finds it."

---

### 2.3 Persona: The Standardizer (Team Lead/Enterprise)

**Demographics**
- Age: 30-45
- Experience: 8+ years, manages 3-10 developers
- Plan: Claude Team or Enterprise

**Goals**
- Maintain consistency across team workflows
- Reduce onboarding time for new developers
- Ensure security and code quality standards

**Behaviors**
- Curates approved skill sets for the team
- Uses project-scoped installations (.claude/settings.json)
- Reviews skill source code before approval
- Contributes to internal skill libraries

**Quote** (from Anthropic blog):
> "Engineering leaders can maintain consistency across their team. Open source maintainers can provide slash commands that help developers use their packages correctly."

---

### 2.4 Persona: The Creator (Skill Author)

**Demographics**
- Age: 25-40
- Experience: 5+ years, active in open source
- Plan: Claude Max

**Goals**
- Share expertise as reusable skills
- Build reputation in the community
- Solve problems for others (and themselves)

**Behaviors**
- Publishes skills to personal GitHub repos
- Submits to awesome lists and marketplaces
- Engages with user feedback and PRs
- Iterates on skill descriptions for better activation

**Quote** (from community testing):
> "I spent a weekend building a testing framework and ran 200+ tests to figure out what actually makes Claude activate skills reliably."

---

## 3. Discovery Channels

### 3.1 Channel Overview

| Channel | Monthly Traffic | Discovery Type | User Segment |
|---------|----------------|----------------|--------------|
| GitHub Topics (`claude-skills`) | High | Passive (search) | Explorers, Creators |
| Awesome Lists (GitHub) | Medium | Curated | All segments |
| claude-plugins.dev | Growing | Auto-indexed | Optimizers |
| SkillsMP.com | Growing | Semantic search | Enterprise |
| X/Twitter | High | Social proof | Explorers |
| Blog Posts/Tutorials | Medium | Educational | Explorers, Optimizers |
| `/plugin discover` (CLI) | High | Native | All segments |

### 3.2 Discovery Funnel

```
┌─────────────────────────────────────────────────────────────────┐
│  AWARENESS (How users learn skills exist)                       │
│  • Anthropic announcements (blog, changelog)                    │
│  • Tech influencer posts (Simon Willison, etc.)                 │
│  • Word of mouth / team recommendations                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  EXPLORATION (Where users browse options)                       │
│  • GitHub search (`claude-skills` topic)                        │
│  • Awesome lists (travisvn, VoltAgent, ComposioHQ)              │
│  • Marketplace sites (claude-plugins.dev, SkillsMP)             │
│  • Official docs (code.claude.com/docs/en/skills)               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  EVALUATION (How users decide to install)                       │
│  • GitHub stars / forks                                         │
│  • README quality and examples                                  │
│  • SKILL.md description clarity                                 │
│  • Author reputation                                            │
│  • License compatibility                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  INSTALLATION (Two-step process)                                │
│  1. Register marketplace: `/plugin marketplace add org/repo`    │
│  2. Install skill: `/plugin install skill-name@marketplace`     │
│  • OR: Manual copy to ~/.claude/skills/                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  ACTIVATION (Does it work?)                                     │
│  • Claude scans ~100 tokens of metadata                         │
│  • Matches skill description to current task                    │
│  • Loads full instructions (<5k tokens) when relevant           │
│  • Success rate: 50-84% depending on description quality        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  RETENTION (Does user keep using it?)                           │
│  • Depends on activation reliability                            │
│  • Value delivered vs. context overhead                         │
│  • Integration with existing workflow                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. User Journey Map

### 4.1 Journey: Explorer Discovers First Skill

| Stage | Action | Touchpoint | Emotion | Pain Point |
|-------|--------|------------|---------|------------|
| Trigger | Reads blog post about Claude Skills | Blog / X | Curious | None |
| Search | Googles "awesome claude skills" | Google | Hopeful | Multiple competing lists |
| Browse | Opens travisvn/awesome-claude-skills | GitHub | Interested | No way to filter by use case |
| Select | Clicks on "ios-simulator-skill" | GitHub repo | Excited | Unclear installation steps |
| Install | Copies to ~/.claude/skills/ | Terminal | Confused | Two-step process unclear |
| Test | Asks Claude to use the skill | Claude Code | Frustrated | Skill doesn't activate |
| Debug | Searches for activation issues | Google/Blog | Frustrated | Discovers description formatting matters |
| Success | Skill finally activates | Claude Code | Relieved | Took 30+ minutes |

**Evidence**: Scott Spence documented discovering that Prettier's multi-line YAML formatting broke skill recognition, requiring single-line descriptions.

---

### 4.2 Journey: Optimizer Finds Testing Workflow

| Stage | Action | Touchpoint | Emotion | Pain Point |
|-------|--------|------------|---------|------------|
| Trigger | Needs to add E2E tests to project | IDE | Motivated | None |
| Search | Searches "playwright claude skill" | GitHub | Hopeful | Multiple similar skills |
| Evaluate | Compares 3 playwright skills | GitHub | Analytical | No standardized quality metrics |
| Select | Picks lackeyjb/playwright-skill | GitHub | Confident | Based on stars + README quality |
| Install | Uses `/plugin marketplace add` | Claude Code | Neutral | Must remember two commands |
| Integrate | Configures for project | Claude Code | Focused | Project-specific setup needed |
| Use | Asks Claude to write tests | Claude Code | Productive | Works well |
| Recommend | Stars repo + tells teammates | GitHub / Slack | Satisfied | No formal review system |

**Evidence**: Playwright skill has 11,900+ downloads on claude-plugins.dev, indicating organic discovery and adoption.

---

### 4.3 Journey: Team Lead Standardizes Workflows

| Stage | Action | Touchpoint | Emotion | Pain Point |
|-------|--------|------------|---------|------------|
| Trigger | New hire asks "how do you have Claude do X?" | Slack | Frustrated | Can't easily share setup |
| Research | Evaluates plugin packaging options | Docs | Overwhelmed | Complex documentation |
| Decide | Chooses to create team marketplace | GitHub | Determined | No templates for teams |
| Build | Packages internal skills + MCP servers | IDE | Focused | Manual bundling process |
| Deploy | Adds to team's .claude/settings.json | Git | Relieved | Project scope helps |
| Onboard | Documents for team | Notion | Satisfied | Still requires manual setup |
| Maintain | Updates skills across projects | GitHub | Neutral | No centralized version management |

**Evidence**: Anthropic explicitly addresses this: "Plugins solve the 'how do I set up the same agentic workflow for my setup' problem."

---

## 5. Quantitative Metrics

### 5.1 Top Skills by Downloads (claude-plugins.dev)

| Rank | Skill | Downloads | Author | Category |
|------|-------|-----------|--------|----------|
| 1 | skill-writer | 96,100 | @pytorch | Meta/Creation |
| 2 | frontend-design | 45,100 | @anthropics | Development |
| 3 | prompt-engineering-patterns | 21,000 | @wshobson | Meta/Optimization |
| 4 | architecture-patterns | 21,000 | @wshobson | Development |
| 5 | brainstorming | 11,900 | @obra | Productivity |

**Insight**: Meta-skills (creating skills, optimizing prompts) outperform domain-specific skills, suggesting users want to become more effective with Claude overall.

### 5.2 Top Repositories by GitHub Stars

| Repository | Stars | Focus |
|------------|-------|-------|
| [Unnamed automation tool] | 23,500 | Multi-agent orchestration |
| travisvn/awesome-claude-skills | 7,400 | Curated list |
| obra/superpowers | ~5,000 | Core skills library |
| jeremylongshore/claude-code-plugins | ~2,500 | Plugin hub |

### 5.3 Skill Activation Success Rates

| Approach | Success Rate | Source |
|----------|--------------|--------|
| Default (poor description) | ~50% | Community testing |
| Optimized description | 80-84% | Scott Spence's 200+ tests |
| Forced eval hook | 84% | Community testing |
| LLM eval hook | 80% | Community testing |

**Insight**: Half of all skills fail to activate reliably, creating frustration and churn.

---

## 6. Pain Points Analysis

### 6.1 Discovery Pain Points

| Pain Point | Severity | Evidence |
|------------|----------|----------|
| **Fragmented marketplaces** | High | 5+ competing awesome lists, no single source of truth |
| **No context-aware recommendations** | Critical | Users must manually search; no analysis of their codebase |
| **Poor categorization** | Medium | Skills categorized by author, not by use case |
| **No quality signals beyond stars** | High | Stars don't indicate reliability or maintenance status |
| **Search is keyword-based** | Medium | Semantic search exists but isn't standard |

### 6.2 Installation Pain Points

| Pain Point | Severity | Evidence |
|------------|----------|----------|
| **Two-step process** | High | "Normally requires installing a marketplace, then installing plugins from it" |
| **Unclear scope options** | Medium | User vs. project vs. local scope confuses new users |
| **No dependency management** | Medium | Skills don't declare dependencies on other skills |

### 6.3 Activation Pain Points

| Pain Point | Severity | Evidence |
|------------|----------|----------|
| **Unreliable skill activation** | Critical | 50% baseline success rate |
| **Description formatting sensitivity** | High | Multi-line YAML breaks recognition |
| **No feedback on why skill didn't activate** | High | Users have no visibility into Claude's decision |
| **Silent failures** | Medium | Skill may not activate without any error |

### 6.4 Retention Pain Points

| Pain Point | Severity | Evidence |
|------------|----------|----------|
| **No usage analytics** | Medium | Users can't see which skills they actually use |
| **No update notifications** | Medium | Skills may become outdated without notice |
| **Context overhead** | Low | Each skill adds ~100 tokens to scanning |

---

## 7. Opportunity Areas

### 7.1 Opportunity Matrix

| Opportunity | Impact | Feasibility | Priority |
|-------------|--------|-------------|----------|
| Codebase-aware recommendations | Very High | Medium | **P0** |
| Intent-based skill matching | Very High | Medium | **P0** |
| Activation reliability improvement | High | Low (requires Anthropic) | P2 |
| One-click installation | High | High | **P1** |
| Skill quality scoring | High | Medium | **P1** |
| Usage analytics dashboard | Medium | High | P2 |
| Skill dependency graph | Medium | Medium | P3 |

### 7.2 Detailed Opportunities

#### 7.2.1 Codebase-Aware Recommendations (P0)

**Current State**: Users manually search for skills based on guesses about what exists.

**Opportunity**: Analyze user's codebase to detect:
- Languages and frameworks in use (React, Python, AWS, etc.)
- Common patterns (testing, CI/CD, documentation)
- Missing capabilities (no linting config, no test coverage)

**Recommendation Examples**:
- Detects `package.json` with React → Recommends `frontend-design` skill
- Detects `.github/workflows/` → Recommends CI/CD optimization skills
- Detects `playwright.config.ts` → Recommends `playwright-skill`
- Detects Linear MCP server → Recommends `linear-claude-skill`

**User Value**: "Claude just told me about a skill I didn't know existed, and it's exactly what I needed."

---

#### 7.2.2 Intent-Based Skill Matching (P0)

**Current State**: Skills have static descriptions; users must know what to search for.

**Opportunity**: When user expresses a goal, match to relevant skills:
- User says: "I want to improve my test coverage" → Recommends TDD skills
- User says: "Help me write API documentation" → Recommends documentation skills
- User asks: "How do I deploy to AWS?" → Recommends AWS skills

**Implementation**: Use the user's stated intent (from documentation, CLAUDE.md, or conversation) to semantically match against skill descriptions.

---

#### 7.2.3 Skill Quality Scoring (P1)

**Current State**: GitHub stars are the only quality signal.

**Opportunity**: Compute composite quality score based on:
- **Maintenance**: Last commit date, issue response time
- **Reliability**: Activation success rate (if collectible)
- **Popularity**: Stars, forks, downloads
- **Documentation**: README completeness, example count
- **Compatibility**: Tested on which Claude versions

**Display**: Show quality badge (A/B/C) alongside each skill recommendation.

---

#### 7.2.4 One-Click Installation (P1)

**Current State**: Two-step process (add marketplace → install skill).

**Opportunity**: Plugin analyzes codebase → recommends skills → user clicks "Install" → plugin handles marketplace registration + installation automatically.

**UX Flow**:
```
1. [Plugin scans codebase]
2. "I recommend these 3 skills for your React + Playwright project:"
   - frontend-design (★★★★★) [Install]
   - playwright-skill (★★★★☆) [Install]
   - test-driven-development (★★★★☆) [Install]
3. [User clicks Install]
4. "Installed successfully. These skills will activate when relevant."
```

---

## 8. Competitive Landscape

### 8.1 Current Solutions

| Solution | Strengths | Weaknesses | Gap for Your Plugin |
|----------|-----------|------------|---------------------|
| **claude-plugins.dev** | Large index (46k), CLI install | No codebase analysis, keyword search only | Context-aware recs |
| **SkillsMP.com** | Semantic search, quality filters | No IDE integration, manual discovery | Proactive suggestions |
| **Awesome Lists** | Curated quality, community trust | Static, requires manual browsing | Dynamic, personalized |
| **`/plugin discover`** | Native to Claude Code | Limited filtering, no recommendations | Intelligence layer |

### 8.2 Differentiation Opportunity

Your plugin would be the **first** to:
1. Analyze the user's actual codebase (not just keywords)
2. Read user documentation/CLAUDE.md for intent signals
3. Proactively recommend skills (push vs. pull)
4. Combine quality scoring with contextual relevance

---

## 9. Recommendations for Plugin Development

### 9.1 MVP Feature Set

| Feature | Description | Priority |
|---------|-------------|----------|
| **Codebase Scanner** | Detect languages, frameworks, tools in current project | P0 |
| **Intent Parser** | Extract goals from CLAUDE.md and user prompts | P0 |
| **Skill Matcher** | Match codebase + intent to skill database | P0 |
| **Quality Scorer** | Compute reliability score for each skill | P1 |
| **One-Click Install** | Handle marketplace registration automatically | P1 |

### 9.2 Data Sources to Integrate

| Source | Data Available | Integration Method |
|--------|----------------|-------------------|
| User's codebase | Languages, frameworks, configs | File system analysis |
| CLAUDE.md | Project context, user preferences | File read |
| GitHub API | Stars, forks, last commit, issues | REST API |
| claude-plugins.dev | Download counts, skill metadata | Scrape or API |
| SkillsMP.com | Semantic descriptions, categories | Scrape or API |

### 9.3 Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Recommendation relevance | >80% "useful" ratings | User feedback |
| Installation success rate | >95% | Error tracking |
| Skill activation rate (post-install) | >75% | User feedback |
| Time to first useful skill | <2 minutes | Session timing |

### 9.4 Technical Architecture Considerations

```
┌─────────────────────────────────────────────────────────────────┐
│                     YOUR PLUGIN                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │  Codebase    │    │   Intent     │    │   Quality    │       │
│  │  Analyzer    │    │   Parser     │    │   Scorer     │       │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘       │
│         │                   │                   │                │
│         └─────────────┬─────┴───────────────────┘                │
│                       │                                          │
│                       ▼                                          │
│              ┌────────────────┐                                  │
│              │  Skill Matcher │                                  │
│              │  (Semantic +   │                                  │
│              │   Rule-based)  │                                  │
│              └────────┬───────┘                                  │
│                       │                                          │
│                       ▼                                          │
│              ┌────────────────┐                                  │
│              │  Recommender   │                                  │
│              │  + Installer   │                                  │
│              └────────────────┘                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                        │
                        ▼
         ┌──────────────────────────────┐
         │  External Data Sources       │
         │  • GitHub API                │
         │  • claude-plugins.dev        │
         │  • SkillsMP.com              │
         │  • Awesome Lists (cached)    │
         └──────────────────────────────┘
```

---

## 10. Sources

### Official Documentation
- [Claude Skills Overview](https://claude.com/blog/skills) - Anthropic
- [Discover and Install Plugins](https://code.claude.com/docs/en/discover-plugins) - Claude Code Docs
- [Customize Claude Code with Plugins](https://claude.com/blog/claude-code-plugins) - Anthropic Blog

### Community Resources
- [travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills) - 7.4k stars
- [claude-plugins.dev](https://claude-plugins.dev/) - 46k+ skills indexed
- [SkillsMP.com](https://skillsmp.com) - Agent Skills Marketplace

### User Research & Blog Posts
- [How to Make Claude Code Skills Activate Reliably](https://scottspence.com/posts/how-to-make-claude-code-skills-activate-reliably) - Scott Spence
- [Claude Code Skills Not Recognised? Here's the Fix!](https://scottspence.com/posts/claude-code-skills-not-recognised) - Scott Spence
- [Building My First Claude Code Plugin](https://alexop.dev/posts/building-my-first-claude-code-plugin/) - Alex OP

### Statistics
- [Claude AI Statistics 2025](https://sqmagazine.co.uk/claude-ai-statistics/) - SQ Magazine
- [Claude Statistics 2025: Key User and Growth Data](https://aimojo.io/claude-statistics/) - AI Mojo
- [2025 AI Tools Usage Statistics](https://views4you.com/ai-tools-usage-statistics-report-2025/) - Views4You

---

## Appendix A: Skill Categories (from SkillsMP)

1. Tools
2. Development
3. Data & AI
4. Business
5. DevOps
6. Testing & Security
7. Documentation
8. Content & Media
9. Lifestyle
10. Research
11. Databases
12. Blockchain

---

## Appendix B: Skill Activation Checklist

Based on community research, skills activate reliably when:

- [ ] Description is a single line (no multi-line YAML)
- [ ] Description is written in third person
- [ ] Description specifies when the skill should apply
- [ ] Description includes trigger keywords
- [ ] SKILL.md follows exact frontmatter format
- [ ] Skill is placed in correct directory (~/.claude/skills/ or .claude/skills/)

---

*Document generated: December 26, 2025*
*Research conducted via web search, marketplace analysis, and community blog posts*
