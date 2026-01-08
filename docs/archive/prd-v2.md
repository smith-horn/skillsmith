# Product Requirements Document
## Claude Discovery Hub v2: Git-Native Skills & Learning System

**Version:** 2.0  
**Date:** December 24, 2025  
**Author:** Smith Horn Group Ltd  
**Status:** Draft for Validation  
**Architecture:** Inferal-inspired Git-native workspace

---

## Executive Summary

The Claude Code ecosystem lacks unified skill/plugin discovery and structured learning resources. Rather than building another web platform that fragments the developer experience, this PRD proposes a **Git-native workspace architecture** where Claude Code itself is the interface, MCP servers provide the API layer, and Git repositories serve as the database. Skills, recommendations, and learning progress live as version-controlled markdown—accessible, auditable, and native to how developers already work.

---

## Architectural Philosophy

### First Principles

Traditional approach builds platforms that sit between developers and their tools. This creates friction, context-switching, and another silo to maintain.

**Inferal-inspired inversion:**
- **Git is the database** — skill index, recommendations, learning progress are all markdown in repos
- **MCP servers are the API** — codebase analysis, skill search, learning validation happen through Model Context Protocol
- **Claude Code is the only interface** — no web UI, no separate app, no context switching
- **Recommendations are commits** — version-controlled, diffable, reviewable suggestions

### Why This Works

1. **Zero adoption friction** — developers already use Claude Code and Git
2. **Continuous integration** — skill discovery happens where code happens
3. **Audit trail** — every recommendation, every learning milestone is a commit
4. **Ownership** — users own their data, can fork, can contribute back
5. **AI-native** — Claude operates directly on the workspace, not through a web API

---

## Architecture

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║  CLAUDE DISCOVERY WORKSPACE                                                   ║
║  Your skills, plugins & learning as a Git-native system                       ║
╚═══════════════════════════════════════════════════════════════════════════════╝

                                    ╭──────────────╮
                                    │  DEVELOPER   │
                                    ╰──────────────╯
                                           │
                    ╭──────────────────────┼──────────────────────╮
                    │                      │                      │
               ╭────────────╮        ╭────────────╮        ╭────────────╮
               │ Claude Code│        │ CLI        │        │ Git/Editor │
               │ (primary)  │        │ (optional) │        │ (direct)   │
               ╰────────────╯        ╰────────────╯        ╰────────────╯
                                           │
╔══════════════════════════════ STORAGE LAYER ══════════════════════════════════╗
║                                                                               ║
║  ~/.claude-discovery/              ~/projects/your-project/                   ║
║  ├─ skill-index/                   ├─ .claude/                                ║
║  │  ├─ skills.json                 │  └─ discovery-config.yaml                ║
║  │  ├─ plugins.json                ├─ CLAUDE.md (includes discovery skill)    ║
║  │  └─ sources/                    └─ docs/                                   ║
║  │     ├─ anthropic.json              └─ discovery/                           ║
║  │     ├─ skillsmp.json                  ├─ recommendations/                  ║
║  │     └─ community.json                 │  └─ 2025-12-24.md                  ║
║  ├─ learning/                            └─ learning-log.md                   ║
║  │  ├─ paths/                                                                 ║
║  │  │  ├─ fundamentals.md                                                     ║
║  │  │  ├─ extension-dev.md                                                    ║
║  │  │  └─ workflow-optimization.md                                            ║
║  │  ├─ exercises/                                                             ║
║  │  │  ├─ beginner/                                                           ║
║  │  │  ├─ intermediate/                                                       ║
║  │  │  └─ advanced/                                                           ║
║  │  └─ progress.md                                                            ║
║  └─ test-repos/                                                               ║
║     ├─ bugfix-challenge-01/                                                   ║
║     ├─ feature-challenge-01/                                                  ║
║     └─ refactor-challenge-01/                                                 ║
║                                                                               ║
╚════════════════════════════════════ Git ══════════════════════════════════════╝
                                           │
╔═══════════════════════════════ MCP LAYER ═════════════════════════════════════╗
║                                                                               ║
║  ╭───────────────────────╮  ╭───────────────────────╮  ╭───────────────────╮  ║
║  │ skill-index           │  │ codebase-scan         │  │ learning          │  ║
║  │                       │  │                       │  │                   │  ║
║  │ • search(query)       │  │ • analyze(path)       │  │ • get_path(name)  │  ║
║  │ • filter(criteria)    │  │ • detect_stack()      │  │ • next_exercise() │  ║
║  │ • get_detail(id)      │  │ • find_gaps()         │  │ • validate(work)  │  ║
║  │ • list_categories()   │  │ • recommend()         │  │ • log_progress()  │  ║
║  │ • check_updates()     │  │ • compare_similar()   │  │ • get_stats()     │  ║
║  ╰───────────────────────╯  ╰───────────────────────╯  ╰───────────────────╯  ║
║                                                                               ║
║  ╭───────────────────────╮  ╭───────────────────────╮  ╭───────────────────╮  ║
║  │ skill-manage          │  │ index-sync            │  │ swarm             │  ║
║  │                       │  │                       │  │                   │  ║
║  │ • install(skill)      │  │ • sync_sources()      │  │ • parallel_scan() │  ║
║  │ • uninstall(skill)    │  │ • add_source(url)     │  │ • batch_analyze() │  ║
║  │ • update(skill)       │  │ • refresh()           │  │ • multi_repo()    │  ║
║  │ • list_installed()    │  │ • get_stats()         │  │                   │  ║
║  │ • verify_compat()     │  │                       │  │                   │  ║
║  ╰───────────────────────╯  ╰───────────────────────╯  ╰───────────────────╯  ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
                                           │
                    ╔═════════════ EXTERNAL SOURCES ════════════════╗
                    ║  GitHub API   │  skillsmp.com  │  Anthropic   ║
                    ║  (skills)     │  (aggregator)  │  (official)  ║
                    ╚═══════════════════════════════════════════════╝
```

---

## Core Components

### 1. Storage Layer (Git Repositories)

#### Global Discovery Workspace (`~/.claude-discovery/`)

A Git repository storing the aggregated skill index and learning materials.

**skill-index/**
```yaml
# skills.json - normalized skill metadata
{
  "skills": [
    {
      "id": "anthropic/docx",
      "name": "docx",
      "description": "Comprehensive document creation...",
      "source": "anthropic",
      "category": "document",
      "tags": ["word", "office", "documents"],
      "install_cmd": "/plugin install document-skills@anthropic-agent-skills",
      "stars": null,
      "last_updated": "2025-12-20",
      "verified": "official"
    }
  ],
  "last_sync": "2025-12-24T10:30:00Z",
  "total_count": 52847
}
```

**learning/**
```markdown
# paths/fundamentals.md
---
name: Claude Code Fundamentals
difficulty: beginner
estimated_hours: 4
prerequisites: []
---

## Module 1: Installation & Basic Commands
- Exercise: Install Claude Code and run first query
- Checkpoint: Complete 3 file operations

## Module 2: CLAUDE.md Configuration
- Exercise: Create project-specific CLAUDE.md
- Checkpoint: Configure custom slash command

## Module 3: Permission Modes
- Exercise: Compare auto-accept vs interactive modes
- Checkpoint: Set up secure workflow for production repo
```

**test-repos/**

Curated repositories with intentional challenges:
```
bugfix-challenge-01/
├── README.md           # Challenge description
├── .claude/
│   └── expected.md     # Success criteria
├── src/
│   └── broken-code.js  # Code with seeded bugs
└── tests/
    └── validation.js   # Automated validation
```

#### Project-Level Integration (`your-project/`)

```yaml
# .claude/discovery-config.yaml
discovery:
  enabled: true
  auto_recommend: weekly
  log_recommendations: true
  recommendation_path: docs/discovery/recommendations/

learning:
  track_progress: true
  suggest_exercises: between_tasks
  log_path: docs/discovery/learning-log.md

preferences:
  categories:
    - development
    - testing
    - documentation
  exclude_tags:
    - windows-only
  min_quality: community_curated
```

```markdown
# CLAUDE.md (excerpt)

## Discovery & Learning

Use the discovery skill for this project:
- Run weekly codebase analysis to identify skill gaps
- Log recommendations to docs/discovery/recommendations/
- Track learning progress in docs/discovery/learning-log.md
- Suggest relevant exercises when between tasks
- Prefer skills matching our stack: TypeScript, React, Node.js
```

---

### 2. MCP Server Layer

Six MCP servers expose workspace capabilities to Claude:

#### skill-index
Search and browse the aggregated skill database.

```typescript
// Tools exposed
search(query: string, filters?: FilterCriteria): SkillResult[]
filter(criteria: FilterCriteria): SkillResult[]
get_detail(skill_id: string): SkillDetail
list_categories(): Category[]
check_updates(installed: string[]): UpdateInfo[]
```

#### codebase-scan
Analyze projects and generate recommendations.

```typescript
// Tools exposed
analyze(path: string): CodebaseProfile
detect_stack(): TechStack
find_gaps(profile: CodebaseProfile): SkillGap[]
recommend(gaps: SkillGap[]): Recommendation[]
compare_similar(profile: CodebaseProfile): SimilarProjects[]
```

**Example output:**
```markdown
# docs/discovery/recommendations/2025-12-24.md
---
generated: 2025-12-24T14:30:00Z
codebase: /home/user/projects/my-app
stack_detected:
  - TypeScript
  - React
  - Node.js
  - PostgreSQL
---

## Recommended Skills

### High Priority

1. **systematic-debugging** by obra/superpowers
   - Gap: No debugging methodology in CLAUDE.md
   - Match: 94% based on similar TypeScript projects
   - Install: `/plugin install systematic-debugging@superpowers`

2. **test-fixing** by anthropic
   - Gap: 23 test files, no test-fixing skill
   - Match: 89% 
   - Install: `/plugin install test-fixing@anthropic-agent-skills`

### Medium Priority

3. **frontend-design** by anthropic
   - Gap: React components lack design system integration
   - Match: 78%
   - Install: `/plugin install frontend-design@claude-plugins-official`

## Skills Already Optimal
- docx (installed, actively used)
- pdf (installed, used 3x this week)
```

#### learning
Manage learning paths, exercises, and progress.

```typescript
// Tools exposed
get_path(name: string): LearningPath
next_exercise(path?: string): Exercise
validate(exercise_id: string, work_path: string): ValidationResult
log_progress(exercise_id: string, status: Status): void
get_stats(): LearningStats
```

#### skill-manage
Install, update, and manage skills.

```typescript
// Tools exposed
install(skill_id: string): InstallResult
uninstall(skill_id: string): void
update(skill_id: string): UpdateResult
list_installed(): InstalledSkill[]
verify_compat(skill_id: string): CompatibilityReport
```

#### index-sync
Synchronize skill index from sources.

```typescript
// Tools exposed
sync_sources(): SyncResult
add_source(url: string, type: SourceType): void
refresh(): void
get_stats(): IndexStats
```

#### swarm
Parallel operations across multiple repositories.

```typescript
// Tools exposed
parallel_scan(paths: string[]): CodebaseProfile[]
batch_analyze(profiles: CodebaseProfile[]): Recommendation[]
multi_repo(operation: Operation, repos: string[]): Result[]
```

---

### 3. Interface Layer (Claude Code)

No separate UI. All interaction through Claude Code:

**Discovery commands (via skill in CLAUDE.md):**
```
"Search for skills related to testing React components"
"Analyze this codebase and recommend skills"
"What skills are similar projects using?"
"Install the systematic-debugging skill"
"Show me skills I should update"
```

**Learning commands:**
```
"What's my learning progress?"
"Give me the next exercise in the fundamentals path"
"I finished the CLAUDE.md exercise, validate my work"
"Suggest something to learn while I wait for CI"
```

**Slash commands (optional plugin):**
```
/discover search <query>
/discover recommend
/discover install <skill>
/learn next
/learn validate
/learn stats
```

---

## Data Flows

### Weekly Recommendation Cycle

```
1. Cron/hook triggers codebase-scan.analyze()
2. detect_stack() identifies technologies
3. find_gaps() compares to skill index
4. recommend() generates prioritized list
5. Writes markdown to docs/discovery/recommendations/
6. Commits with message: "discovery: weekly recommendations 2025-12-24"
7. Claude mentions new recommendations in next session
```

### Skill Installation Flow

```
1. User: "Install systematic-debugging"
2. skill-index.get_detail() fetches metadata
3. skill-manage.verify_compat() checks Claude Code version
4. skill-manage.install() runs plugin command
5. Updates installed skills list
6. Logs to learning progress if part of path
```

### Learning Progress Flow

```
1. User: "Give me an exercise"
2. learning.next_exercise() selects based on progress
3. User works on exercise in test repo
4. User: "Validate my work"
5. learning.validate() runs automated checks
6. learning.log_progress() commits result
7. Updates progress.md with completion status
```

---

## Skill in CLAUDE.md

The discovery system activates through a skill block in CLAUDE.md:

```markdown
## Discovery & Continuous Learning

This project uses the Claude Discovery skill for:

### Automatic Recommendations
- Analyze codebase weekly (Sundays 9am)
- Compare against 50K+ indexed skills
- Log recommendations to `docs/discovery/recommendations/`
- Prioritize skills matching: TypeScript, React, Node, PostgreSQL

### Learning Integration  
- Track progress through fundamentals path
- Suggest exercises during idle time
- Validate completed work automatically
- Log milestones to `docs/discovery/learning-log.md`

### Preferences
- Minimum quality tier: community_curated
- Exclude categories: windows-only, deprecated
- Prefer skills with: >10 GitHub stars, updated within 90 days

### Commands
When I ask about skills or learning:
- Use skill-index MCP for searches
- Use codebase-scan MCP for recommendations
- Use learning MCP for exercises and progress
- Always check compatibility before suggesting installs
```

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-4)

**Deliverables:**
- skill-index MCP server with search/filter
- Index sync from 3 sources (Anthropic, skillsmp, awesome-claude-skills)
- Basic CLI for manual sync
- Initial skill database (~25K skills)

**Validation:**
- Can search skills from Claude Code
- Index updates successfully from sources

### Phase 2: Recommendations (Weeks 5-8)

**Deliverables:**
- codebase-scan MCP server
- Stack detection for major frameworks
- Gap analysis algorithm
- Recommendation markdown generation
- CLAUDE.md skill block

**Validation:**
- Accurate stack detection on 10 test projects
- Recommendations match manual expert review 70%+

### Phase 3: Learning Platform (Weeks 9-12)

**Deliverables:**
- learning MCP server
- 3 learning paths (fundamentals, extension-dev, workflow)
- 15 exercises with automated validation
- 5 test repositories with seeded challenges
- Progress tracking and stats

**Validation:**
- Complete fundamentals path end-to-end
- Automated validation catches 90%+ of incomplete work

### Phase 4: Polish & Scale (Weeks 13-16)

**Deliverables:**
- swarm MCP for multi-repo analysis
- skill-manage for installation workflow
- Quality scoring algorithm
- Community contribution workflow
- Documentation and onboarding

**Validation:**
- 100 beta users complete onboarding
- NPS > 40

---

## Success Metrics

### Adoption
- **Weekly active users:** 1K month 1 → 10K month 6
- **Skills indexed:** 50K+
- **Recommendations generated:** 500/week by month 3

### Quality
- **Recommendation accuracy:** 70%+ installed after suggestion
- **Stack detection accuracy:** 90%+ on common frameworks
- **Learning completion:** 40%+ finish at least one path

### Engagement
- **Return usage:** 60%+ use discovery weekly
- **Learning engagement:** 3+ exercises completed per active learner
- **Contribution rate:** 50+ community skills submitted monthly

---

## Technical Requirements

### MCP Server Implementation
- TypeScript with official MCP SDK
- SQLite for local index (portable, no dependencies)
- Git operations via simple-git or isomorphic-git

### Index Storage
- JSON for skill metadata (simple, diffable)
- Markdown for recommendations and progress (human-readable)
- Git for versioning and sync

### Sync Pipeline
- GitHub API for repository metadata
- Web scraping for aggregator sites (with rate limiting)
- Incremental updates to minimize bandwidth

### Compatibility
- Claude Code v2.0.12+
- macOS, Linux, Windows (WSL)
- No external services required (fully local operation)

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Anthropic launches official marketplace | Medium | High | Position as community layer that complements official; seek partnership |
| MCP API changes break servers | Medium | Medium | Pin to stable MCP versions; maintain compatibility layer |
| Index quality degrades | Medium | Medium | Multi-source validation; community flagging; quality tiers |
| Low adoption of Git-native approach | Medium | High | Provide escape hatch to simple CLI; emphasize zero-config start |
| Learning content becomes stale | High | Medium | Version learning paths; community contributions; quarterly review |

---

## Open Questions

1. **Hosting index repo:** GitHub (public) vs self-hosted vs distributed?
2. **Sync frequency:** Real-time webhooks vs daily batch vs on-demand?
3. **Quality algorithm:** Stars-based vs usage-based vs expert-curated?
4. **Test repo licensing:** Original content vs curated from SWE-Bench/similar?
5. **Monetization:** Open source vs freemium (advanced recommendations)?

---

## Sources

Anthropic. "Claude Code: Best Practices for Agentic Coding." *Anthropic Engineering*, 2025, https://www.anthropic.com/engineering/claude-code-best-practices.

Anthropic. "Create and Distribute a Plugin Marketplace." *Claude Code Docs*, 2025, https://code.claude.com/docs/en/plugin-marketplaces.

Anthropic. "Introducing Agent Skills." *Anthropic News*, 16 Oct. 2025, https://www.anthropic.com/news/skills.

Anthropic. "Public Repository for Agent Skills." *GitHub*, 2025, https://github.com/anthropics/skills.

Anthropic. "Anthropic-Managed Directory of High Quality Claude Code Plugins." *GitHub*, 2025, https://github.com/anthropics/claude-plugins-official.

Arize. "CLAUDE.md: Best Practices Learned from Optimizing Claude Code with Prompt Learning." *Arize Blog*, 20 Nov. 2025, https://arize.com/blog/claude-md-best-practices-learned-from-optimizing-claude-code-with-prompt-learning/.

Claude Plugins Dev. "Discover Claude Skills." 2025, https://claude-plugins.dev/skills.

Hesreallyhim. "Awesome Claude Code." *GitHub*, 2025, https://github.com/hesreallyhim/awesome-claude-code.

Lee, Han Chung. "Claude Agent Skills: A First Principles Deep Dive." 26 Oct. 2025, https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/.

Longshore, Jeremy. "Claude Code Plugins Plus Skills." *GitHub*, 2025, https://github.com/jeremylongshore/claude-code-plugins-plus-skills.

Rashk, Yurii. "Inferal Workspace Architecture." *GitHub Gist*, 24 Dec. 2025, https://gist.github.com/yrashk/59b1cd144864bc3320a0ac0c766d4f55.

SkillsMP. "Agent Skills Marketplace - Claude, Codex & ChatGPT Skills." 2025, https://skillsmp.com.

Travis VN. "Awesome Claude Skills." *GitHub*, 2025, https://github.com/travisvn/awesome-claude-skills.

VoltAgent. "Awesome Claude Skills." *GitHub*, 2025, https://github.com/VoltAgent/awesome-claude-skills.
