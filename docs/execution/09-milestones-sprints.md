# Milestones & Sprint Structure

**Document Type:** Implementation Plan
**Version:** 1.0
**Date:** December 26, 2025
**Owner:** Development Manager
**Status:** Ready for Linear Import

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Team Structure](#2-team-structure)
3. [Sprint Cadence](#3-sprint-cadence)
4. [Phase 0: Validation (Weeks 1-8)](#4-phase-0-validation-weeks-1-8)
5. [Phase 1: Foundation (Weeks 9-12)](#5-phase-1-foundation-weeks-9-12)
6. [Phase 2: Recommendations (Weeks 13-16)](#6-phase-2-recommendations-weeks-13-16)
7. [Dependency Graph](#7-dependency-graph)
8. [Definition of Done Template](#8-definition-of-done-template)
9. [Risk Register](#9-risk-register)
10. [Appendix: Linear Import Guide](#10-appendix-linear-import-guide)

---

## 1. Executive Summary

### Delivery Approach

Skillsmith follows a **phased delivery model** designed to validate product-market fit before significant investment:

| Phase | Duration | Focus | Success Criteria |
|-------|----------|-------|------------------|
| **Phase 0** | Weeks 1-8 | POC/Validation | 50 beta users, 80% satisfaction |
| **Phase 1** | Weeks 9-12 | Foundation + Safety | Full index, trust tiers, web MVP |
| **Phase 2** | Weeks 13-16 | Recommendations + UX | Codebase scanner, VS Code extension |

### Key Metrics

| Metric | Phase 0 Target | Phase 1 Target | Phase 2 Target |
|--------|----------------|----------------|----------------|
| Skills Indexed | 1,000 | 50,000+ | 50,000+ |
| Search Latency (p50) | < 500ms | < 200ms | < 200ms |
| Daily Active Users | 50 beta | 500 | 2,000 |
| Installation Success Rate | > 80% | > 95% | > 98% |
| NPS Score | > 30 | > 50 | > 60 |

### Milestone Overview

```
Phase 0 (Weeks 1-8)
================================================================================
  W1    W2    W3    W4    W5    W6    W7    W8
  |-----|-----|-----|-----|-----|-----|-----|-----|
  [M0.1 ][M0.2 ][M0.3      ][M0.4      ][M0.5][M0.6]
  Setup  Data   MCP POC     Search      Install Validate
         POC                MVP         MVP

Phase 1 (Weeks 9-12)
================================================================================
  W9    W10   W11   W12
  |-----|-----|-----|-----|
  [M1.1      ][M1.2      ]
        [M1.3           ]
              [M1.4      ]
  Full   Static Trust    Web
  Index  Analysis Tiers  Browser

Phase 2 (Weeks 13-16)
================================================================================
  W13   W14   W15   W16
  |-----|-----|-----|-----|
  [M2.1      ][M2.2      ]
        [M2.3           ]
              [M2.4      ]
  Scanner  Recommend Conflict VS Code
                     Detect   Ext
```

---

## 2. Team Structure

### Core Roles

| Role | Responsibility | FTE | Phases |
|------|---------------|-----|--------|
| **Engineering Lead** | Architecture decisions, code review, technical direction | 1.0 | 0-2 |
| **Backend Specialist** | MCP servers, SQLite, sync pipeline | 1.0 | 0-2 |
| **Frontend Specialist** | Web UI, VS Code extension | 0.5 -> 1.0 | 0-2 |
| **Security Specialist** | Trust model, static analysis, scanning | 0.5 | 1-2 |
| **DevOps Specialist** | CI/CD, infrastructure, monitoring | 0.5 | 0-2 |
| **Product Manager** | Requirements, user research, prioritization | 0.5 | 0-2 |
| **QA Specialist** | Test strategy, automation, quality | 0.5 | 1-2 |

### Phase-Specific Staffing

```
Phase 0 (Validation):
  Engineering Lead ........ [====================================]
  Backend Specialist ...... [====================================]
  Frontend Specialist ..... [=================                   ]
  DevOps Specialist ....... [========         ========           ]
  Product Manager ......... [====================================]

Phase 1 (Foundation):
  Engineering Lead ........ [====================================]
  Backend Specialist ...... [====================================]
  Frontend Specialist ..... [=================   =================]
  Security Specialist ..... [====================================]
  DevOps Specialist ....... [====================================]
  QA Specialist ........... [====================================]

Phase 2 (Recommendations):
  Engineering Lead ........ [====================================]
  Backend Specialist ...... [====================================]
  Frontend Specialist ..... [====================================]
  Security Specialist ..... [=================   =================]
  DevOps Specialist ....... [========         ========           ]
  QA Specialist ........... [====================================]
```

### RACI Matrix

| Decision Area | Eng Lead | PM | Backend | Frontend | Security | DevOps |
|--------------|----------|-----|---------|----------|----------|--------|
| Architecture | A | C | R | C | C | C |
| API Design | A | I | R | C | C | - |
| UX/UI | C | A | I | R | I | - |
| Security Model | C | I | C | I | A/R | C |
| Infrastructure | C | I | C | - | C | A/R |
| Release Decisions | A | R | C | C | C | C |

*A=Accountable, R=Responsible, C=Consulted, I=Informed*

---

## 3. Sprint Cadence

### Sprint Structure (2-Week Sprints)

```
WEEK 1                                    WEEK 2
Mon   Tue   Wed   Thu   Fri   Mon   Tue   Wed   Thu   Fri
|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|
Sprint   Daily Standups (15 min async)                Sprint
Planning                                              Review
(2 hr)                                                (1 hr)
                                                      Retro
                                                      (1 hr)
                              Backlog
                              Refinement
                              (1 hr)
```

### Sprint Ceremonies

| Ceremony | Duration | Participants | Cadence |
|----------|----------|--------------|---------|
| **Sprint Planning** | 2 hours | All team | Start of sprint |
| **Daily Standup** | 15 min (async) | All team | Daily |
| **Backlog Refinement** | 1 hour | PM, Eng Lead, 1 dev | Mid-sprint |
| **Sprint Review** | 1 hour | All team + stakeholders | End of sprint |
| **Retrospective** | 1 hour | All team | End of sprint |
| **Architecture Review** | 1 hour | Eng Lead + specialists | Weekly |

### Sprint Velocity Targets

| Phase | Sprint | Velocity (Story Points) | Focus |
|-------|--------|------------------------|-------|
| Phase 0 | Sprint 1 | 20 | Setup, exploration |
| Phase 0 | Sprint 2-3 | 30 | POC development |
| Phase 0 | Sprint 4 | 25 | MVP refinement |
| Phase 1 | Sprint 5-6 | 35 | Foundation build |
| Phase 2 | Sprint 7-8 | 35 | Feature expansion |

---

## 4. Phase 0: Validation (Weeks 1-8)

### Phase 0 Goals

1. **Validate product-market fit** with 50 beta users
2. **Prove technical feasibility** of Git-native architecture
3. **Establish development patterns** for MCP server development
4. **Gather user feedback** on core discovery experience

---

### M0.1: Project Setup

**Milestone ID:** M0.1
**Name:** Project Setup & Development Environment
**Target Week:** Week 1-2
**Sprint:** Sprint 1
**Owner:** Engineering Lead

#### Definition of Done

- [ ] Monorepo structure created with npm workspaces
- [ ] TypeScript 5.x configured with strict mode
- [ ] ESLint + Prettier configured with pre-commit hooks
- [ ] Vitest testing framework configured
- [ ] GitHub Actions CI pipeline running (lint, typecheck, test)
- [ ] Development documentation in place (CONTRIBUTING.md)
- [ ] MCP SDK (@anthropic-ai/mcp) integrated
- [ ] better-sqlite3 native bindings working on macOS/Linux
- [ ] Local development workflow documented and tested

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Repository | Monorepo with packages/ structure | `npm install && npm run build` succeeds |
| CI Pipeline | GitHub Actions workflow | All checks pass on PR |
| Dev Docs | Setup instructions | New dev productive in < 30 min |
| MCP Skeleton | Empty MCP server that connects | Claude Code recognizes server |

#### Dependencies

- None (first milestone)

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| SQLite native build issues on Windows | Medium | Medium | Prioritize macOS/Linux, document Windows workarounds |
| MCP SDK breaking changes | Low | High | Pin version, document upgrade path |

---

### M0.2: Data Layer POC

**Milestone ID:** M0.2
**Name:** Data Layer Proof of Concept
**Target Week:** Week 2-3
**Sprint:** Sprint 1-2
**Owner:** Backend Specialist

#### Definition of Done

- [ ] SQLite database schema implemented with all core tables
- [ ] FTS5 virtual table working with tokenizer configuration
- [ ] CRUD operations for skills working via repository layer
- [ ] WAL mode enabled with performance tuning
- [ ] Sample data import script (1,000 skills from GitHub)
- [ ] Basic search query working with FTS5 (< 100ms)
- [ ] Unit tests for repository layer (> 80% coverage)
- [ ] Database migration system in place

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Schema | Full SQLite schema with indexes | All tables created, FKs enforced |
| Repositories | SkillRepository, CacheRepository | CRUD ops with tests |
| FTS5 Search | Full-text search implementation | "react testing" returns results < 100ms |
| GitHub Sync | Initial data population script | 1,000 skills imported successfully |

#### Dependencies

- **M0.1:** Project structure and dependencies

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| FTS5 performance issues at scale | Low | Medium | Benchmark early, have index optimization plan |
| GitHub API rate limits during initial sync | Medium | Low | Use authenticated requests, implement backoff |

---

### M0.3: MCP Server POC

**Milestone ID:** M0.3
**Name:** MCP Server Proof of Concept
**Target Week:** Week 3-5
**Sprint:** Sprint 2-3
**Owner:** Engineering Lead

#### Definition of Done

- [ ] discovery-core MCP server starts and registers with Claude Code
- [ ] `search` tool implemented and callable from Claude
- [ ] `get_skill` tool returns skill details
- [ ] Server startup time < 2 seconds (cold start)
- [ ] Memory usage < 200MB at idle
- [ ] Error handling returns structured error responses
- [ ] Integration tests with MCP test client
- [ ] Basic logging to `~/.skillsmith/logs/`

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| MCP Server | discovery-core server binary | `npx @skillsmith/hub mcp-server` runs |
| Search Tool | MCP tool implementation | `/discover search react` returns results |
| Get Skill Tool | MCP tool implementation | `/discover get skill-id` returns details |
| Integration | Claude Code connection | Server visible in `/mcp` output |

#### Dependencies

- **M0.1:** Project setup
- **M0.2:** Data layer with searchable skills

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| MCP protocol changes | Low | High | Track MCP SDK releases, abstraction layer |
| Claude Code integration issues | Medium | High | Early testing with real Claude Code |
| Startup time exceeds budget | Medium | Medium | Lazy loading, profiling |

---

### M0.4: Search MVP

**Milestone ID:** M0.4
**Name:** Search MVP (Minimum Viable Product)
**Target Week:** Week 5-6
**Sprint:** Sprint 3
**Owner:** Backend Specialist

#### Definition of Done

- [ ] Hybrid search (FTS5 + semantic) implemented
- [ ] Search latency < 500ms (p50), < 800ms (p95)
- [ ] Filters working: category, trust_tier, min_score
- [ ] Sorting: relevance, quality, stars, updated
- [ ] Pagination with offset/limit
- [ ] Search result caching (L1 memory, L2 SQLite)
- [ ] Query intent detection (basic keyword extraction)
- [ ] Result formatting with trust tier badges
- [ ] 10 beta users testing search experience

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Hybrid Search | FTS5 + embedding fusion | Query "react testing" returns relevant results |
| Filtering | Category, tier, score filters | Filters correctly narrow results |
| Caching | Multi-tier cache implementation | Second search for same query < 100ms |
| Beta Test | User feedback collection | 10 users complete test tasks |

#### Dependencies

- **M0.3:** MCP server with search tool
- **M0.2:** Data layer with FTS5 index

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Embedding generation slow | Medium | Medium | Batch pre-generation, lazy load |
| Search relevance poor | Medium | High | Tune BM25 weights, add user feedback |
| Beta user recruitment | Low | Medium | Use Claude Code community channels |

---

### M0.5: Install MVP

**Milestone ID:** M0.5
**Name:** Installation MVP
**Target Week:** Week 6-7
**Sprint:** Sprint 3-4
**Owner:** Backend Specialist

#### Definition of Done

- [ ] `install_skill` tool implemented
- [ ] Skill files downloaded from GitHub to ~/.claude/skills/
- [ ] Basic security scan (URL patterns, blocklist check)
- [ ] Installation recorded in local manifest
- [ ] Uninstall functionality working
- [ ] Installation success notification with tips
- [ ] Error handling for network failures, invalid skills
- [ ] 10 beta users successfully install skills

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Install Tool | MCP install implementation | `/discover install skill-id` works |
| Security Scan | Basic pattern detection | External URLs trigger warning |
| Manifest | Installed skills tracking | `installed.json` updated correctly |
| Beta Test | Real user installations | 10 users install 2+ skills each |

#### Dependencies

- **M0.4:** Search MVP (users need to find skills to install)
- **M0.3:** MCP server infrastructure

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Permission issues writing to ~/.claude/ | Medium | Medium | Document required permissions, fallback paths |
| Malicious skill in beta | Low | High | Manual review of beta skill set |

---

### M0.6: POC Validation

**Milestone ID:** M0.6
**Name:** POC Validation & Gate Decision
**Target Week:** Week 7-8
**Sprint:** Sprint 4
**Owner:** Product Manager

#### Definition of Done

- [ ] 50 beta users onboarded
- [ ] User satisfaction survey completed (target: 80% satisfaction)
- [ ] NPS score measured (target: > 30)
- [ ] Core workflow success rate > 80% (search -> install -> activate)
- [ ] Performance metrics documented
- [ ] User feedback synthesized into Phase 1 priorities
- [ ] Phase 0 retrospective completed
- [ ] Go/No-Go decision documented
- [ ] Phase 1 sprint planning completed (if Go)

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Beta Report | User research synthesis | 50 user sessions analyzed |
| Metrics Report | Performance and usage data | All target metrics measured |
| Decision Doc | Phase 1 go/no-go recommendation | Leadership sign-off |
| Phase 1 Plan | Updated backlog and estimates | Sprint 5 planning complete |

#### Dependencies

- **M0.5:** Install MVP (complete product to evaluate)
- All prior Phase 0 milestones

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Beta user engagement low | Medium | High | Active community management, incentives |
| Negative feedback on core concept | Low | Critical | Early user interviews, pivot options |
| Performance doesn't meet targets | Medium | Medium | Optimization sprint buffer |

---

## 5. Phase 1: Foundation (Weeks 9-12)

### Phase 1 Goals

1. **Scale to 50,000+ skills** with full index generation
2. **Implement trust tier system** for security signals
3. **Deploy static analysis pipeline** for skill scanning
4. **Launch web browser MVP** at skillsmith.app

---

### M1.1: Full Index Generation

**Milestone ID:** M1.1
**Name:** Full Index Generation Pipeline
**Target Week:** Week 9-10
**Sprint:** Sprint 5
**Owner:** Backend Specialist

#### Definition of Done

- [ ] GitHub sync adapter fetching all topic:claude-skill repos
- [ ] Scraper adapters for claude-plugins.dev, skillsmp.com, mcp.so
- [ ] Deduplication by repo_url working correctly
- [ ] Quality scoring algorithm implemented
- [ ] 50,000+ skills indexed with complete metadata
- [ ] Incremental sync working (delta updates)
- [ ] GitHub Actions workflow for daily index generation
- [ ] Index published to GitHub Releases + jsDelivr CDN
- [ ] Bootstrap index bundled with npm package (~25MB)

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Source Adapters | GitHub, scrapers for 3 aggregators | All sources returning data |
| Pipeline | Daily index generation workflow | GitHub Actions runs successfully |
| Quality Scoring | Scoring algorithm implementation | Scores correlate with quality |
| CDN Distribution | Index on jsDelivr | Download < 5 seconds globally |

#### Dependencies

- **M0.6:** Validation gate passed

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Scraper breakage | High | Medium | Multiple sources, graceful degradation |
| GitHub API exhaustion | Medium | High | Token rotation, Events API |
| Index size too large | Low | Medium | Compression, delta patches |

---

### M1.2: Static Analysis Pipeline

**Milestone ID:** M1.2
**Name:** Static Analysis Pipeline
**Target Week:** Week 10-11
**Sprint:** Sprint 5-6
**Owner:** Security Specialist

#### Definition of Done

- [ ] Jailbreak pattern detection (10+ patterns)
- [ ] URL allowlist enforcement
- [ ] Sensitive file path detection
- [ ] Obfuscation detection (entropy analysis)
- [ ] Typosquatting detection (Levenshtein + character substitution)
- [ ] All skills in index scanned
- [ ] Security findings stored in database
- [ ] Scan results included in skill display
- [ ] Blocked skills excluded from search results

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Pattern Scanner | Regex-based detection | Known patterns detected, < 100ms per skill |
| Typosquat Detector | Name similarity check | "anthroplc" flagged for "anthropic" |
| Scan Integration | Pipeline integration | All skills have scan_status |
| Blocklist | Initial blocklist file | Format defined, signed |

#### Dependencies

- **M1.1:** Full index (skills to scan)
- **M0.5:** Install workflow (scan on install)

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| False positives blocking good skills | Medium | High | Tunable thresholds, appeal process |
| Novel attack patterns bypassing scan | Medium | Medium | Regular pattern updates, ML future |

---

### M1.3: Trust Tier System

**Milestone ID:** M1.3
**Name:** Trust Tier System
**Target Week:** Week 10-12
**Sprint:** Sprint 5-6
**Owner:** Security Specialist

#### Definition of Done

- [ ] Four-tier model implemented (Official, Verified, Community, Unverified)
- [ ] Trust score calculation algorithm
- [ ] Publisher verification data from GitHub API
- [ ] Trust tier displayed in search results and skill details
- [ ] Installation warnings for low-trust skills
- [ ] User setting for minimum trust tier
- [ ] Documentation for skill authors on verification
- [ ] anthropic/* namespace marked as Official

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Trust Algorithm | Score -> Tier computation | Scores match expected tiers |
| Publisher Verification | GitHub identity checks | Verified orgs get "verified" tier |
| UI Integration | Trust badges in results | Visual distinction clear |
| Author Docs | Verification guide | Path to verification documented |

#### Dependencies

- **M1.1:** Full index (author data)
- **M1.2:** Static analysis (scan results in score)

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Gaming the trust system | Low | Medium | Monitor, manual review capability |
| Official tier criteria unclear | Medium | Low | Clear Anthropic partnership path |

---

### M1.4: Web Browser MVP

**Milestone ID:** M1.4
**Name:** Web Browser MVP (skillsmith.app)
**Target Week:** Week 11-12
**Sprint:** Sprint 6
**Owner:** Frontend Specialist

#### Definition of Done

- [ ] Astro static site generator configured
- [ ] Skill search page with filters
- [ ] Skill detail pages for all indexed skills
- [ ] Category browsing pages
- [ ] Responsive design (mobile-friendly)
- [ ] SEO optimized (JSON-LD, OG tags, sitemap)
- [ ] Client-side search with sql.js (SQLite in browser)
- [ ] Deployed to GitHub Pages
- [ ] Custom domain (skillsmith.app) configured
- [ ] Analytics (Plausible/PostHog) integrated

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Search Page | /search with filters | Query returns results < 2s |
| Skill Pages | /skill/{id} detail pages | All skills have pages |
| Category Pages | /category/{name} browse | 12 main categories |
| Deployment | Live on skillsmith.app | Site loads globally |

#### Dependencies

- **M1.1:** Full index (data to display)
- **M1.3:** Trust tiers (badges in UI)

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| sql.js bundle too large | Medium | Low | Lazy loading, code splitting |
| SEO not indexed by Google | Medium | Medium | Submit sitemap, wait period |

---

## 6. Phase 2: Recommendations (Weeks 13-16)

### Phase 2 Goals

1. **Launch codebase scanner** for automatic stack detection
2. **Build recommendation engine** with personalized suggestions
3. **Implement conflict detection** to prevent skill interference
4. **Release VS Code extension** for IDE integration

---

### M2.1: Codebase Scanner

**Milestone ID:** M2.1
**Name:** Codebase Scanner
**Target Week:** Week 13-14
**Sprint:** Sprint 7
**Owner:** Backend Specialist

#### Definition of Done

- [ ] `analyze_codebase` MCP tool implemented
- [ ] Package file detection (package.json, requirements.txt, Cargo.toml, go.mod)
- [ ] Language/framework detection from file extensions
- [ ] Dependency extraction from manifest files
- [ ] Tech stack confidence scoring
- [ ] Scan caching with file hash invalidation
- [ ] Performance: < 5s for 1K files, < 15s for 10K files
- [ ] Privacy: No codebase content transmitted

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Scanner Tool | MCP analyze_codebase impl | `/discover scan` returns stack |
| Detectors | Language/framework detection | React, Vue, Django, Rails detected |
| Performance | Efficient scanning | 1K files < 5 seconds |
| Cache | Incremental re-scan | Unchanged files skipped |

#### Dependencies

- **M1.1:** Full index (skills to match against)
- **M0.3:** MCP server infrastructure

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Detection accuracy poor | Medium | Medium | Tune heuristics, add explicit config |
| Large monorepos slow | Medium | Low | Depth limits, sampling |

---

### M2.2: Recommendation Engine

**Milestone ID:** M2.2
**Name:** Recommendation Engine
**Target Week:** Week 14-15
**Sprint:** Sprint 7-8
**Owner:** Backend Specialist

#### Definition of Done

- [ ] `recommend_skills` MCP tool implemented
- [ ] Gap analysis: detected stack vs installed skills
- [ ] Relevance scoring: tech overlap + quality
- [ ] Explanation generation ("Recommended because...")
- [ ] Filtering: exclude installed, respect trust tier minimum
- [ ] Discovery modes: conservative vs exploratory
- [ ] Recommendation caching with TTL
- [ ] Telemetry: track acceptance/dismissal rates

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Recommend Tool | MCP recommend_skills impl | Returns 5-10 relevant skills |
| Gap Analysis | Stack coverage calculation | Missing areas identified |
| Explanations | "Why this skill" text | Each recommendation explained |
| Telemetry | Acceptance tracking | Data flowing to analytics |

#### Dependencies

- **M2.1:** Codebase scanner (stack detection)
- **M1.1:** Full index (skills to recommend)
- **M1.3:** Trust tiers (filter by trust)

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Recommendations not relevant | Medium | High | User feedback loop, tuning |
| Cold start (no installed skills) | Medium | Low | Popular skills fallback |

---

### M2.3: Conflict Detection

**Milestone ID:** M2.3
**Name:** Conflict Detection System
**Target Week:** Week 14-16
**Sprint:** Sprint 7-8
**Owner:** Security Specialist

#### Definition of Done

- [ ] Trigger overlap detection (keyword + semantic similarity)
- [ ] Output collision detection (file path analysis)
- [ ] Convention conflict detection (tabs vs spaces, etc.)
- [ ] Conflict warning on install
- [ ] Priority resolution system (priorities.yaml)
- [ ] `check_conflicts` MCP tool
- [ ] User prompts for conflict resolution
- [ ] Conflict data stored for future installs

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Overlap Detector | Trigger similarity analysis | 85%+ overlap flagged as HIGH |
| Collision Detector | Output path analysis | Same output path detected |
| Priority System | User priority configuration | Higher priority wins |
| Conflict Tool | MCP check_conflicts impl | Pre-install conflict check |

#### Dependencies

- **M0.5:** Install workflow (conflict check point)
- **M1.2:** Static analysis (content parsing)

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| False conflict warnings | Medium | Medium | Tunable thresholds |
| Complex behavioral conflicts | High | Low | Defer to Phase 3 |

---

### M2.4: VS Code Extension

**Milestone ID:** M2.4
**Name:** VS Code Extension
**Target Week:** Week 15-16
**Sprint:** Sprint 8
**Owner:** Frontend Specialist

#### Definition of Done

- [ ] Extension published to VS Code Marketplace
- [ ] Skill search sidebar panel
- [ ] Skill detail webview
- [ ] One-click installation (invokes Claude Code)
- [ ] Recommendation notifications
- [ ] Trust tier badges in UI
- [ ] Extension icon and branding
- [ ] README with screenshots

#### Key Deliverables

| Deliverable | Description | Acceptance Criteria |
|-------------|-------------|---------------------|
| Extension | VS Code extension package | Installs from marketplace |
| Search Panel | Sidebar search UI | Query returns results |
| Install Action | One-click install | Skill installs successfully |
| Notifications | Recommendation popups | Non-intrusive suggestions |

#### Dependencies

- **M2.2:** Recommendation engine (notifications)
- **M1.4:** Web browser (shared components)

#### Risk Factors

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Claude Code integration complexity | Medium | Medium | Simple command invocation |
| Marketplace approval delay | Low | Medium | Submit early, follow guidelines |

---

## 7. Dependency Graph

### Visual Dependency Map

```
                                M0.1 Project Setup
                                       |
                        +-------------+-------------+
                        |                           |
                   M0.2 Data Layer              (independent)
                        |
                        +-------------+
                        |             |
                   M0.3 MCP POC       |
                        |             |
                   M0.4 Search MVP    |
                        |             |
                   M0.5 Install MVP ---+
                        |
                   M0.6 POC Validation
                        |
        ================|================ GATE DECISION
                        |
                   M1.1 Full Index
                        |
           +------------+------------+
           |            |            |
      M1.2 Static   M1.3 Trust   M1.4 Web Browser
       Analysis      Tiers           |
           |            |            |
           +------------+------------+
                        |
           +------------+------------+
           |            |            |
      M2.1 Codebase    M2.3 Conflict   (parallel)
       Scanner         Detection
           |
      M2.2 Recommend
       Engine
           |
      M2.4 VS Code
       Extension
```

### Critical Path

The critical path determines the minimum project duration:

```
M0.1 -> M0.2 -> M0.3 -> M0.4 -> M0.5 -> M0.6 -> M1.1 -> M2.1 -> M2.2 -> M2.4
(2w)    (1w)    (2w)    (1.5w)  (1w)    (1.5w)  (2w)    (2w)    (1.5w)  (2w)
                                                                        = 15.5 weeks
```

### Dependency Matrix

| Milestone | Depends On | Blocks |
|-----------|------------|--------|
| M0.1 | - | M0.2, M0.3 |
| M0.2 | M0.1 | M0.3, M0.4 |
| M0.3 | M0.1, M0.2 | M0.4, M0.5 |
| M0.4 | M0.3, M0.2 | M0.5 |
| M0.5 | M0.4, M0.3 | M0.6 |
| M0.6 | M0.5 | M1.1 (gate) |
| M1.1 | M0.6 | M1.2, M1.3, M1.4, M2.1 |
| M1.2 | M1.1 | M1.3 |
| M1.3 | M1.1, M1.2 | M2.2 |
| M1.4 | M1.1, M1.3 | M2.4 |
| M2.1 | M1.1 | M2.2 |
| M2.2 | M2.1, M1.3 | M2.4 |
| M2.3 | M1.2 | - |
| M2.4 | M2.2, M1.4 | - |

---

## 8. Definition of Done Template

### Milestone DoD Template

Copy this template for each milestone in Linear:

```markdown
## Definition of Done: [Milestone ID] - [Milestone Name]

### Functional Criteria
- [ ] All acceptance criteria in milestone spec met
- [ ] All user-facing features demo-ready
- [ ] Edge cases handled with appropriate error messages

### Quality Criteria
- [ ] Unit test coverage > 80% for new code
- [ ] Integration tests pass
- [ ] No critical or high-severity bugs
- [ ] Code reviewed and approved by 2+ team members

### Performance Criteria
- [ ] Latency targets met (see milestone spec)
- [ ] Memory usage within budget
- [ ] No performance regressions from previous milestone

### Security Criteria (Phase 1+)
- [ ] Security scan passed
- [ ] No new vulnerabilities introduced
- [ ] Sensitive data handling reviewed

### Documentation Criteria
- [ ] README updated for new features
- [ ] API documentation updated
- [ ] Architecture decisions recorded (if applicable)
- [ ] Changelog entry added

### Deployment Criteria
- [ ] CI/CD pipeline passing
- [ ] Staging deployment successful
- [ ] Rollback procedure documented
- [ ] Monitoring/alerting configured
```

### Story DoD Template

```markdown
## Definition of Done: Story

- [ ] Acceptance criteria met
- [ ] Unit tests written and passing
- [ ] Code reviewed
- [ ] Documentation updated
- [ ] No regressions in existing tests
- [ ] Manual QA passed (if applicable)
```

---

## 9. Risk Register

### Phase 0 Risks

| ID | Risk | Probability | Impact | Score | Mitigation | Owner |
|----|------|-------------|--------|-------|------------|-------|
| R0.1 | MCP SDK breaking changes | Low | High | 6 | Pin version, abstraction layer | Eng Lead |
| R0.2 | Beta user recruitment fails | Medium | High | 9 | Claude Code community, incentives | PM |
| R0.3 | SQLite performance issues | Low | Medium | 3 | Benchmarking, optimization plan | Backend |
| R0.4 | Negative beta feedback | Low | Critical | 8 | Early user interviews, pivot options | PM |
| R0.5 | Native module build failures | Medium | Low | 4 | Pure JS fallback, Docker builds | DevOps |

### Phase 1 Risks

| ID | Risk | Probability | Impact | Score | Mitigation | Owner |
|----|------|-------------|--------|-------|------------|-------|
| R1.1 | Scraper breakage | High | Medium | 9 | Multiple sources, graceful degradation | Backend |
| R1.2 | GitHub API rate limits | Medium | High | 8 | Token rotation, Events API, caching | Backend |
| R1.3 | False positive security blocks | Medium | High | 8 | Tunable thresholds, appeal process | Security |
| R1.4 | Index size > 50MB | Low | Medium | 3 | Compression, delta patches | Backend |
| R1.5 | Web SEO not indexed | Medium | Medium | 6 | Sitemap, wait period, content quality | Frontend |

### Phase 2 Risks

| ID | Risk | Probability | Impact | Score | Mitigation | Owner |
|----|------|-------------|--------|-------|------------|-------|
| R2.1 | Recommendations not relevant | Medium | High | 8 | User feedback loop, A/B testing | Backend |
| R2.2 | False conflict warnings | Medium | Medium | 6 | Tunable thresholds, user override | Security |
| R2.3 | VS Code marketplace rejection | Low | Medium | 3 | Follow guidelines, submit early | Frontend |
| R2.4 | Codebase scan privacy concerns | Low | High | 4 | Clear messaging, local-only | PM |
| R2.5 | Performance regression at scale | Medium | Medium | 6 | Load testing, profiling | Backend |

### Risk Scoring Matrix

```
Impact      |  Low (1)  | Medium (2) | High (3)  | Critical (4)
------------|-----------|------------|-----------|-------------
High (3)    |    3      |     6      |     9     |     12
Medium (2)  |    2      |     4      |     6     |      8
Low (1)     |    1      |     2      |     3     |      4

Score 1-3: Monitor
Score 4-6: Active mitigation plan
Score 7-9: Weekly review, dedicated mitigation
Score 10+: Escalate to leadership, consider scope change
```

---

## 10. Appendix: Linear Import Guide

### Project Structure in Linear

```
Skillsmith (Workspace)
├── Phase 0: Validation (Project)
│   ├── M0.1: Project Setup (Milestone)
│   │   ├── Setup monorepo structure (Issue)
│   │   ├── Configure TypeScript (Issue)
│   │   └── ... (Sub-issues as needed)
│   ├── M0.2: Data Layer POC (Milestone)
│   ├── M0.3: MCP Server POC (Milestone)
│   ├── M0.4: Search MVP (Milestone)
│   ├── M0.5: Install MVP (Milestone)
│   └── M0.6: POC Validation (Milestone)
├── Phase 1: Foundation (Project)
│   ├── M1.1: Full Index Generation (Milestone)
│   ├── M1.2: Static Analysis Pipeline (Milestone)
│   ├── M1.3: Trust Tier System (Milestone)
│   └── M1.4: Web Browser MVP (Milestone)
└── Phase 2: Recommendations (Project)
    ├── M2.1: Codebase Scanner (Milestone)
    ├── M2.2: Recommendation Engine (Milestone)
    ├── M2.3: Conflict Detection (Milestone)
    └── M2.4: VS Code Extension (Milestone)
```

### Labels

| Label | Color | Purpose |
|-------|-------|---------|
| `backend` | Blue | Backend/MCP work |
| `frontend` | Green | Web/Extension work |
| `security` | Red | Security work |
| `devops` | Purple | Infrastructure work |
| `p0-critical` | Red | Must have for milestone |
| `p1-high` | Orange | Should have |
| `p2-medium` | Yellow | Nice to have |
| `blocked` | Gray | Waiting on dependency |
| `needs-design` | Pink | Requires design input |

### Sprint Setup

1. Create Cycle for each 2-week sprint
2. Use target dates from milestone specs
3. Set sprint goals aligned with milestone DoD
4. Review velocity after each sprint to calibrate

### Issue Template

```markdown
## Summary
[Brief description of the work item]

## Acceptance Criteria
- [ ] [Specific, testable criterion]
- [ ] [Another criterion]

## Technical Notes
[Implementation hints, related files, API specs]

## Dependencies
- Blocked by: [Link to blocking issue]
- Blocks: [Link to dependent issues]

## Estimate
Story Points: [1, 2, 3, 5, 8, 13]

## Labels
[backend/frontend/security/devops] [priority]
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | Development Manager | Initial milestone and sprint structure |

---

*Next Review: After Phase 0 Gate Decision (Week 8)*
*Document Update Frequency: After each phase gate*
