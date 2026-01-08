# Architecture Overview

> **Navigation**: [Technical Index](./index.md) | [Components](./components/index.md) | [Security](./security/index.md)

**Version:** 1.1
**Last Updated:** December 26, 2025

---

## Research-Informed Technical Strategy (NEW)

### Layer 1-3 Research Implications

The technical architecture must address five convergence points identified in the cross-layer research synthesis:

| Convergence Point | Technical Implication |
|-------------------|----------------------|
| **The Invisibility Problem** | Implement skill attribution system ("Using: X Skill") |
| **The "Good Enough" Trap** | Add telemetry for "potential value gap" calculations |
| **The Context Paradox** | Optimize for context efficiency; token budget monitoring |
| **The Trust Calibration Crisis** | Build transparent quality scoring with explanations |
| **The 11-Week Reality** | Support progressive engagement, not just initial discovery |

### Key Behavioral Metrics to Instrument

Based on Layer 3 research:

| Metric | Technical Requirement |
|--------|----------------------|
| Time to skill awareness | Track first skill visibility event |
| Context switching interruptions | Measure workflow integration points |
| Skill activation visibility | Implement activation notification system |
| Discovery funnel | Awareness → Trial → Adoption tracking |

### Research-Derived Performance Targets

| Metric | Target | Research Basis |
|--------|--------|----------------|
| Discovery latency | < 2 seconds | 23-min context switch recovery |
| Token overhead per skill | < 500 tokens | "66,000+ tokens before conversation" |
| Activation visibility latency | < 100ms | Immediate feedback requirement |
| Offline capability | 100% search, 80% features | "Good enough" offline behavior |

---

## Core Architecture Principles

The Claude Discovery Hub is built on four foundational principles:

| Principle | Description | Rationale |
|-----------|-------------|-----------|
| **Git-Native** | Git as the database for all persistent state | Auditability, offline operation, user ownership, no vendor lock-in |
| **MCP as API** | Model Context Protocol servers as the interface layer | Native Claude Code integration, protocol alignment |
| **Claude as Interface** | Claude Code terminal as the sole user interface | Zero adoption friction, meets developers where they work |
| **Local-First** | All data stored locally with optional sync | Privacy, offline capability, user control |

---

## High-Level Architecture Diagram

```
+===========================================================================+
|  CLAUDE DISCOVERY HUB - SYSTEM ARCHITECTURE                               |
+===========================================================================+

                              +-------------------+
                              |      HUMAN        |
                              +-------------------+
                                       |
                          +------------------------+
                          |  Claude Code Terminal  |
                          |   (Primary Interface)  |
                          +------------------------+
                                       |
+===========================================================================+
|  MCP LAYER (3 Consolidated Servers)                                       |
+---------------------------------------------------------------------------+
|                                                                           |
|  +---------------------------+  +---------------------------+             |
|  | discovery-core            |  | learning                  |             |
|  |                           |  |                           |             |
|  | - search(query, filters)  |  | - get_path(name)          |             |
|  | - get_skill(id)           |  | - next_exercise()         |             |
|  | - analyze_codebase(path)  |  | - submit_solution()       |             |
|  | - recommend_skills()      |  | - get_progress()          |             |
|  | - install_skill(id)       |  | - validate_exercise()     |             |
|  | - check_conflicts()       |  +---------------------------+             |
|  | - audit_activation()      |                                            |
|  +---------------------------+  +---------------------------+             |
|                                 | sync                      |             |
|                                 |                           |             |
|                                 | - refresh_index()         |             |
|                                 | - fetch_updates()         |             |
|                                 | - export_recommendations()|             |
|                                 +---------------------------+             |
|                                                                           |
+===========================================================================+
                                       |
+===========================================================================+
|  STORAGE LAYER                                                            |
+---------------------------------------------------------------------------+
|                                                                           |
|  ~/.claude-discovery/                                                     |
|  +-- index/                                                               |
|  |   +-- skills.db           # SQLite: 50K+ skills indexed                |
|  |   +-- embeddings.bin      # Vector embeddings for similarity           |
|  |   +-- cache/              # API response cache                         |
|  |                                                                        |
|  +-- docs/                                                                |
|  |   +-- learning/                                                        |
|  |   |   +-- paths/          # Learning curricula                         |
|  |   |   +-- exercises/      # Hands-on challenges                        |
|  |   |   +-- progress.md     # User progress tracking                     |
|  |   |                                                                    |
|  |   +-- recommendations/    # Version-controlled suggestions             |
|  |       +-- 2025-12-26-project-a.md                                      |
|  |                                                                        |
|  +-- config/                                                              |
|      +-- settings.json       # User preferences                           |
|      +-- blocklist.json      # Blocked skills                             |
|      +-- priorities.yaml     # Skill priority configuration               |
|                                                                           |
+===========================================================================+
                                       |
+===========================================================================+
|  EXTERNAL SERVICES                                                        |
+---------------------------------------------------------------------------+
|                                                                           |
|  +----------------+  +----------------+  +----------------+               |
|  | GitHub API     |  | claude-plugins |  | npm Registry   |               |
|  | (Primary)      |  | .dev (Scrape)  |  | (If npm pkg)   |               |
|  +----------------+  +----------------+  +----------------+               |
|                                                                           |
+===========================================================================+
```

---

## Data Flow

```
User Request                MCP Server              Storage/External
     |                          |                        |
     |  "Find React skills"     |                        |
     |------------------------->|                        |
     |                          |  Query SQLite index    |
     |                          |----------------------->|
     |                          |<-----------------------|
     |                          |                        |
     |                          |  Fetch GitHub metadata |
     |                          |----------------------->| GitHub API
     |                          |<-----------------------|
     |                          |                        |
     |                          |  Compute quality scores|
     |                          |  (local)               |
     |                          |                        |
     |  Ranked results          |                        |
     |<-------------------------|                        |
     |                          |                        |
```

---

## Key Design Decisions

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Storage | SQLite + Git | PostgreSQL, Elasticsearch | Portable, no dependencies, works offline |
| API Layer | MCP Protocol | REST API, GraphQL | Native Claude Code integration |
| Index Format | SQLite with FTS5 | Elasticsearch, Meilisearch | Embedded, fast, zero-config |
| Embeddings | Local file | Vector DB (Qdrant, Pinecone) | Simpler deployment, privacy |
| Sync | Pull-based with caching | Push notifications | Simpler architecture, GitHub rate limits |

> **See Also**: [Decision Log](./decisions.md) for complete decision history

---

## Component Summary

| Component | Description | Documentation |
|-----------|-------------|---------------|
| **discovery-core** | Search, analysis, installation, auditing | [MCP Servers](./components/mcp-servers.md) |
| **learning** | Educational content and progress | [MCP Servers](./components/mcp-servers.md) |
| **sync** | Background synchronization | [MCP Servers](./components/mcp-servers.md) |
| **Skill Index** | SQLite-based skill database | [Skill Index](./components/skill-index.md) |
| **Codebase Scanner** | Technology stack detection | [Codebase Scanner](./components/codebase-scanner.md) |
| **Recommendation Engine** | Skill matching algorithm | [Recommendation Engine](./components/recommendation-engine.md) |
| **Activation Auditor** | Skill activation diagnostics | [Activation Auditor](./components/activation-auditor.md) |

---

## Research-Derived Technical Requirements

### Behavioral Intervention Implementation

Based on Layer 3 research, implement these behavioral interventions:

| Intervention | Technical Component | Priority |
|--------------|---------------------|----------|
| **Skill Attribution** | Activation notification in terminal output | Phase 1 |
| **Contextual Discovery** | Task detection → skill matching pipeline | Phase 2 |
| **Social Proof** | Anonymous usage statistics aggregation | Phase 2 |
| **Progressive Disclosure** | Tiered feature revelation based on usage | Phase 2 |
| **Token Budget Visibility** | Real-time context consumption monitoring | Phase 3 |

### Ecosystem Integration Points

Based on Layer 2 ecosystem research:

| Data Source | Integration Method | Update Frequency |
|-------------|-------------------|------------------|
| SkillsMP (25K+ skills) | API/Scrape | Daily |
| claude-plugins.dev (8.4K) | Scrape | Daily |
| mcp.so (17K+ MCPs) | API | Hourly |
| GitHub API | REST | Rate-limited |
| npm Registry | API | Weekly |

### Trust Architecture Requirements

Based on the trust calibration crisis finding (43% trust, 76% usage):

1. **Quality Score Transparency:** Every score must include breakdown and explanation
2. **Calibrated Expectations:** Neither oversell nor undersell skill capabilities
3. **Negative Signals:** Surface known issues, conflicts, and limitations
4. **Verification Badges:** Clear trust tier visual indicators

### Adoption Journey Support

Based on 11-week adoption curve (4% → 83% → 60%):

| Week Range | Technical Support Required |
|------------|---------------------------|
| Weeks 1-2 | Quick wins tracking, onboarding progress |
| Weeks 3-6 | Usage depth metrics, feature discovery prompts |
| Weeks 7-11 | Habit formation tracking, mastery indicators |
| Week 11+ | Retention signals, churn prediction |

---

*Next: [Component Design](./components/index.md)*
