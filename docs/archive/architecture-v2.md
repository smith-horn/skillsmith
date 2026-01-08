# Claude Discovery Hub v2
## Git-Native Architecture for Skills, Plugins & Learning

**Version:** 2.0  
**Date:** December 24, 2025  
**Author:** Smith Horn Group Ltd  
**Status:** Architecture Draft  
**Inspiration:** [Inferal Workspace Architecture](https://gist.github.com/yrashk/59b1cd144864bc3320a0ac0c766d4f55)

---

## Architecture Principle

> **Data should summon agents—not the other way around.**

The Discovery Hub is not a platform users visit. It's a workspace that lives inside their existing Claude Code environment. Git is the database. MCP servers are the API. Claude operates directly on the workspace. No context switching. No separate tools.

---

## Architecture Diagram

```
╔═══════════════════════════════════════════════════════════════════════════════════════╗
║  CLAUDE DISCOVERY WORKSPACE                                                           ║
║  Skills, plugins & learning as a Git-native system                                    ║
╚═══════════════════════════════════════════════════════════════════════════════════════╝

                                     ╭─────────────╮
                                     │   HUMAN     │
                                     ╰─────────────╯
                                            │
                          ╭──────────────────────────────╮
                          │  Claude Code Terminal        │
                          │  (the only interface)        │
                          ╰──────────────────────────────╯
                                            │
╔════════════════════════════════════ STORAGE LAYER ════════════════════════════════════╗
║                                                                                        ║
║  ~/.claude-discovery/                                                                  ║
║  ├── docs/                                                                             ║
║  │   ├── learning/                                                                     ║
║  │   │   ├── paths/                    # Structured learning curricula                 ║
║  │   │   │   ├── fundamentals.md                                                       ║
║  │   │   │   ├── extension-dev.md                                                      ║
║  │   │   │   └── workflow-optimization.md                                              ║
║  │   │   ├── exercises/                # Hands-on challenges                           ║
║  │   │   │   ├── beginner/                                                             ║
║  │   │   │   ├── intermediate/                                                         ║
║  │   │   │   └── advanced/                                                             ║
║  │   │   └── progress.md               # Personal learning state                       ║
║  │   │                                                                                 ║
║  │   └── recommendations/              # Version-controlled suggestions                ║
║  │       ├── 2025-12-24-project-a.md                                                   ║
║  │       └── 2025-12-20-project-b.md                                                   ║
║  │                                                                                     ║
║  └── repos/                                                                            ║
║      ├── skill-index/                  # Aggregated skill metadata (50K+)              ║
║      │   ├── index.json                # Search index                                  ║
║      │   ├── embeddings.bin            # Vector embeddings for similarity              ║
║      │   └── sources/                  # Raw metadata by source                        ║
║      │       ├── anthropics-skills/                                                    ║
║      │       ├── anthropics-plugins-official/                                          ║
║      │       ├── skillsmp/                                                             ║
║      │       └── github-scan/                                                          ║
║      │                                                                                 ║
║      ├── test-repos/                   # Practice challenges                           ║
║      │   ├── bug-hunt-react/                                                           ║
║      │   ├── refactor-python-api/                                                      ║
║      │   └── add-feature-node/                                                         ║
║      │                                                                                 ║
║      └── my-skills/                    # Personal skill development                    ║
║                                                                                        ║
╚═══════════════════════════════════════ Git ═══════════════════════════════════════════╝
                                            │
                                     ╭─────────────╮
                                     │   CLAUDE    │
                                     ╰─────────────╯
                                            │
╔═══════════════════════════════════════ MCP LAYER ═════════════════════════════════════╗
║                                                                                        ║
║  ╭────────────────────────╮  ╭────────────────────────╮  ╭────────────────────────╮   ║
║  │ skill-index            │  │ codebase-scan          │  │ learning               │   ║
║  │                        │  │                        │  │                        │   ║
║  │ • search(query, filters)  │ • analyze(path)        │  │ • get_path(name)       │   ║
║  │ • get_skill(id)        │  │ • detect_stack()       │  │ • next_exercise()      │   ║
║  │ • list_categories()    │  │ • recommend_skills()   │  │ • submit_solution()    │   ║
║  │ • get_similar(skill_id)│  │ • find_gaps()          │  │ • get_progress()       │   ║
║  │ • refresh_index()      │  │ • compare_to_similar() │  │ • log_completion()     │   ║
║  ╰────────────────────────╯  ╰────────────────────────╯  ╰────────────────────────╯   ║
║                                                                                        ║
║  ╭────────────────────────╮  ╭────────────────────────╮  ╭────────────────────────╮   ║
║  │ skill-install          │  │ swarm                  │  │ recommendations        │   ║
║  │                        │  │                        │  │                        │   ║
║  │ • install(skill_id)    │  │ • parallel_scan(repos) │  │ • generate(project)    │   ║
║  │ • uninstall(skill_id)  │  │ • batch_analyze()      │  │ • history(project)     │   ║
║  │ • update(skill_id)     │  │ • aggregate_recs()     │  │ • accept(rec_id)       │   ║
║  │ • list_installed()     │  │ • compare_projects()   │  │ • dismiss(rec_id)      │   ║
║  │ • check_compatibility()│  │                        │  │ • schedule(cron)       │   ║
║  ╰────────────────────────╯  ╰────────────────────────╯  ╰────────────────────────╯   ║
║                                                                                        ║
╚═══════════════════════════════════════════════════════════════════════════════════════╝
                                            │
                    ╔══════════════ EXTERNAL SERVICES ══════════════╗
                    ║  ╭────────────╮  ╭────────────╮               ║
                    ║  │ GitHub API │  │ Aggregator │               ║
                    ║  │            │  │ APIs       │               ║
                    ║  ╰────────────╯  ╰────────────╯               ║
                    ╚═══════════════════════════════════════════════╝
```

---

## Key Design Decisions

### 1. Claude Code IS the Interface

No web UI. No dashboard. No mobile app. Users interact entirely through Claude Code terminal sessions. This eliminates context switching and meets developers where they already work.

**Implications:**
- All discovery happens via natural language or slash commands
- Results are displayed in terminal or saved to markdown files
- Installation is `claude mcp add` not visiting a website

### 2. Git IS the Database

All state lives in Git repositories:
- **Skill index:** JSON + embeddings, version-controlled
- **Learning progress:** Markdown file tracking completions
- **Recommendations:** Dated markdown files, reviewable history
- **Test repos:** Git submodules or worktrees for exercises

**Implications:**
- Full audit trail of every recommendation and decision
- Offline-capable after initial clone
- Forkable, customizable, ownable by user
- No vendor lock-in, no SaaS dependency

### 3. MCP Servers ARE the API

Six focused MCP servers expose all functionality to Claude:

| Server | Purpose | Key Tools |
|--------|---------|-----------|
| `skill-index` | Search and browse 50K+ skills | search, get_skill, list_categories |
| `codebase-scan` | Analyze projects for recommendations | analyze, detect_stack, find_gaps |
| `learning` | Structured education and exercises | get_path, next_exercise, submit_solution |
| `skill-install` | Manage installed skills | install, uninstall, update |
| `swarm` | Parallel operations across repos | parallel_scan, batch_analyze |
| `recommendations` | Persistent suggestion management | generate, history, accept, schedule |

### 4. Recommendations as Markdown Artifacts

Every recommendation is saved as a dated markdown file:

```markdown
# Skill Recommendations for project-a
**Generated:** 2025-12-24T14:30:00Z
**Codebase:** ~/projects/project-a

## Stack Detected
- React 19 + TypeScript
- Next.js 15
- Tailwind CSS
- Jest + React Testing Library

## Recommended Skills

### High Priority
1. **frontend-design** (anthropics/claude-code-plugins)
   - Match: React + Tailwind detected
   - Reason: Provides design system guidance, avoids generic AI aesthetics
   - Install: `/plugin install frontend-design@claude-code-plugins`

2. **test-fixing** (community)
   - Match: Jest config found, 47 test files
   - Reason: Automated test repair and TDD workflows
   - Install: `/plugin install test-fixing@obra/superpowers`

### Medium Priority
...

## Actions Taken
- [ ] Installed frontend-design
- [ ] Dismissed test-fixing (already have custom solution)
```

This creates a reviewable, version-controlled history of all AI suggestions.

### 5. Continuous Learning Pipeline

A skill in the user's CLAUDE.md triggers periodic analysis:

```markdown
## Discovery & Learning (CLAUDE.md)

Use the discovery skill for continuous improvement:

### Weekly Analysis
- Analyze this codebase for skill gaps every Monday
- Log recommendations to ~/.claude-discovery/docs/recommendations/
- Compare my setup to similar projects in the index

### Learning Integration
- Track my progress in ~/.claude-discovery/docs/learning/progress.md
- Suggest relevant exercises when I complete a task
- Recommend learning paths based on my skill gaps

### Quality Signals
- Flag skills I install that have been updated
- Warn about deprecated skills in my setup
- Suggest replacements when better alternatives emerge
```

---

## User Flows

### Flow 1: Skill Discovery

```
User: "Find skills for working with PostgreSQL"

Claude: [Uses skill-index MCP]
        → search("postgresql", {categories: ["database", "backend"]})
        → Returns top 10 matches with install commands

User: "Install the first one"

Claude: [Uses skill-install MCP]
        → install("postgres-skill@sanjay3290")
        → Verifies compatibility
        → Adds to ~/.claude/skills/
        → Confirms installation
```

### Flow 2: Codebase Recommendations

```
User: "Analyze my project and suggest skills"

Claude: [Uses codebase-scan MCP]
        → analyze(".")
        → detect_stack()
        → recommend_skills()
        
        [Uses recommendations MCP]
        → generate(".", analysis_result)
        → Saves to ~/.claude-discovery/docs/recommendations/2025-12-24.md
        
Claude: "I found 6 skills that could help. 3 are high priority based on 
        your React + TypeScript stack. I've saved the full analysis to 
        your recommendations folder. Want me to install the top pick?"
```

### Flow 3: Learning Exercise

```
User: "I want to practice Claude Code skills"

Claude: [Uses learning MCP]
        → get_progress()
        → next_exercise({difficulty: "intermediate", focus: "skills"})
        
Claude: "Based on your progress, I recommend the 'Create a Custom Skill' 
        exercise. It'll take about 30 minutes. I've cloned the test repo 
        to ~/.claude-discovery/repos/test-repos/create-skill-exercise/
        
        Your goal: Create a skill that formats markdown tables.
        Validation: The included test suite must pass.
        
        Ready to start?"

User: [Works on exercise]

User: "I think I'm done, check my work"

Claude: [Uses learning MCP]
        → submit_solution("create-skill-exercise")
        → Runs validation suite
        → log_completion() if passed
        
Claude: "All tests pass! You've completed the 'Create a Custom Skill' 
        exercise. I've updated your progress. Next recommended: 
        'Skill with External Dependencies' or 'MCP Server Basics'."
```

### Flow 4: Weekly Analysis (Automated)

```
[Monday 9:00 AM - triggered by CLAUDE.md instruction]

Claude: [Uses codebase-scan MCP]
        → analyze("/path/to/active/projects")
        
        [Uses swarm MCP]
        → parallel_scan([project_a, project_b, project_c])
        
        [Uses recommendations MCP]
        → generate() for each project
        
        [Uses skill-install MCP]
        → check_updates() for installed skills
        
[Saves weekly summary to docs/recommendations/weekly-2025-12-24.md]
[Notifies user on next Claude Code session]
```

---

## Data Model

### Skill Index Entry (index.json)

```json
{
  "id": "anthropics/claude-code-plugins/frontend-design",
  "name": "frontend-design",
  "description": "Create distinctive, production-grade frontend interfaces...",
  "source": "anthropics/claude-code-plugins",
  "version": "1.2.0",
  "last_updated": "2025-12-20T10:00:00Z",
  "categories": ["frontend", "design", "react"],
  "technologies": ["react", "tailwind", "typescript"],
  "install_command": "/plugin install frontend-design@claude-code-plugins",
  "github_stars": 1240,
  "downloads_30d": 8500,
  "verification_tier": "official",
  "embedding_id": 4521
}
```

### Learning Progress (progress.md)

```markdown
# Learning Progress

## Completed Paths
- [x] Claude Code Fundamentals (2025-12-15)

## Current Path
- Extension Development
  - [x] Creating Your First Skill
  - [ ] Advanced Skill Patterns
  - [ ] Plugin Architecture
  - [ ] MCP Server Development

## Completed Exercises
| Date | Exercise | Difficulty | Time |
|------|----------|------------|------|
| 2025-12-20 | Format Markdown Tables | Intermediate | 25m |
| 2025-12-18 | Basic Skill Structure | Beginner | 15m |

## Stats
- Total exercises: 12
- Current streak: 3 days
- Focus areas: Skills (60%), Plugins (40%)
```

---

## Implementation Phases

### Phase 1: Foundation (4 weeks)
- [ ] skill-index MCP server with GitHub scraping
- [ ] Basic search and filtering
- [ ] skill-install MCP server
- [ ] Initial index build (anthropics repos + top 1000 GitHub skills)

### Phase 2: Intelligence (4 weeks)
- [ ] codebase-scan MCP server
- [ ] Technology detection (package.json, requirements.txt, etc.)
- [ ] recommendations MCP server
- [ ] Embedding generation for similarity matching

### Phase 3: Learning (4 weeks)
- [ ] learning MCP server
- [ ] 3 learning paths with content
- [ ] 10 test repositories with validation
- [ ] Progress tracking

### Phase 4: Scale (4 weeks)
- [ ] swarm MCP server for parallel operations
- [ ] Full index (50K+ skills)
- [ ] Weekly analysis automation
- [ ] Community contribution workflow

---

## Success Metrics

| Metric | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|--------|---------|---------|---------|---------|
| Skills indexed | 1,000 | 10,000 | 25,000 | 50,000+ |
| Daily active users | 50 | 500 | 2,000 | 10,000 |
| Recommendation accuracy | - | 50% | 65% | 75% |
| Exercises completed/week | - | - | 100 | 1,000 |
| Avg skills installed/user | 2 | 5 | 8 | 12 |

---

## Open Questions

1. **Index hosting:** Self-hosted Git repo vs. dedicated CDN for large embeddings?
2. **Authentication:** Needed for usage tracking? Or fully anonymous?
3. **Community contributions:** How to accept new exercises and learning content?
4. **Monetization:** Stays open-source? Premium tier for enterprise features?
5. **Anthropic relationship:** Seek partnership or stay independent community project?

---

## Comparison: v1 vs v2 Architecture

| Aspect | PRD v1 (Platform) | PRD v2 (Git-Native) |
|--------|-------------------|---------------------|
| Interface | Web app + API + CLI | Claude Code only |
| Backend | PostgreSQL + Elasticsearch + Redis | Git repositories |
| API | REST/GraphQL | MCP servers |
| Hosting | Cloud infrastructure | Local + GitHub |
| Cost | $500-2000/month | ~$0 (GitHub free tier) |
| User data | Centralized database | User-owned Git repos |
| Offline | No | Yes (after initial clone) |
| Lock-in | Platform-dependent | None (pure Git + Markdown) |
| Scalability | Vertical (more servers) | Horizontal (user-distributed) |

---

## Sources

Inferal. "Inferal Workspace Architecture." *GitHub Gist*, 24 Dec. 2025, https://gist.github.com/yrashk/59b1cd144864bc3320a0ac0c766d4f55.

[All sources from PRD v1 remain applicable for ecosystem research]
