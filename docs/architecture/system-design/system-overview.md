# System Overview - Architecture Source of Truth

> **Navigation**: [Index](./index.md) | [PRD v3](../prd-v3.md) | [Technical Design](../technical-design.md)

**Version:** 1.0
**Date:** December 26, 2025
**Author:** Senior Architect (Synthesis of 5 Specialist Architects)
**Status:** Source of Truth Document

---

## Executive Summary

Claude Discovery Hub is a **Git-native skill discovery, recommendation, and learning system** for Claude Code users. This document synthesizes the architectural decisions from five specialist architects into a unified source of truth.

### System Mission

> Enable developers to discover, evaluate, install, and effectively use Claude Code skills through a terminal-first experience that respects privacy and works offline.

### Key Metrics

| Metric | Target | Rationale |
|--------|--------|-----------|
| Skill Index Size | 50,000+ | Coverage across all fragmented sources |
| Search Latency | < 2 seconds | Research: 23-min context switch recovery |
| Startup Time | < 5 seconds | CLI tool acceptable latency |
| Memory Usage | < 500 MB | Reasonable for dev machine |
| Offline Capability | 100% core features | Local-first architecture |

---

## 1. Architecture Principles

### 1.1 Foundational Principles

These principles guide all architectural decisions and must be maintained across all components:

| Principle | Description | Enforced By |
|-----------|-------------|-------------|
| **Git-Native** | All persistent state in Git repositories; no external databases for core | Data Architect |
| **Local-First** | Full offline operation with cached data; network only for sync | Infrastructure Architect |
| **MCP as API** | Model Context Protocol is the primary interface layer | Backend Architect |
| **Privacy by Design** | Opt-out telemetry, data minimization, user control | Security Architect |
| **Behavioral Focus** | Architecture supports skill attribution, social proof, progressive disclosure | Integration Architect |
| **Graceful Degradation** | System works with partial data; external services will fail | All Architects |

### 1.2 Design Constraints

| Constraint | Limit | Impact |
|------------|-------|--------|
| No always-on servers | Serverless/edge only | Cost sustainability |
| Single npm package | All components bundled | Simple distribution |
| SQLite only | No external databases | Portability |
| Node.js 18+ | Runtime requirement | MCP SDK compatibility |

---

## 2. C4 Architecture Diagrams

### 2.1 System Context (Level 1)

```
+============================================================================+
|                           SYSTEM CONTEXT                                     |
+============================================================================+

                    +---------------------------+
                    |       Developer           |
                    |    (Claude Code User)     |
                    +-------------+-------------+
                                  |
                                  | Uses
                                  v
+------------------+    +-------------------+    +------------------+
|   Claude Code    |<-->| Claude Discovery  |<-->|   Web Browser    |
|   Terminal       |    |      Hub          |    | (discoveries.dev)|
+------------------+    +-------------------+    +------------------+
                                  |
              +-------------------+-------------------+
              |                   |                   |
              v                   v                   v
    +------------------+ +------------------+ +------------------+
    |     GitHub       | |   Aggregators    | |   npm Registry   |
    |      API         | | (SkillsMP, etc.) | |                  |
    +------------------+ +------------------+ +------------------+

```

### 2.2 Container Diagram (Level 2)

```
+============================================================================+
|                         CONTAINER DIAGRAM                                    |
+============================================================================+

    +---------------------------------------------------------------------------+
    |                          User's Local Machine                              |
    |                                                                            |
    |  +------------------------+         +--------------------------------+     |
    |  |     Claude Code CLI    |         |    VS Code Extension           |     |
    |  |    (Primary Interface) |         |    (IDE Integration)           |     |
    |  +-----------+------------+         +---------------+----------------+     |
    |              |                                      |                      |
    |              v                                      v                      |
    |  +---------------------------------------------------------------------+  |
    |  |                     MCP Server Runtime                               |  |
    |  |  +------------------+ +------------------+ +------------------+      |  |
    |  |  | discovery-core   | |    learning      | |      sync        |      |  |
    |  |  | (150MB, 1.5s)    | |  (50MB, 0.5s)    | |  (100MB, 0.5s)   |      |  |
    |  |  +------------------+ +------------------+ +------------------+      |  |
    |  +---------------------------------------------------------------------+  |
    |              |                                                            |
    |              v                                                            |
    |  +---------------------------------------------------------------------+  |
    |  |                    ~/.claude-discovery/                              |  |
    |  |  +---------------+ +---------------+ +---------------+ +----------+ |  |
    |  |  | index/        | | user/         | | cache/        | | config/  | |  |
    |  |  | - skills.db   | | - profile.json| | - github/     | | - *.json | |  |
    |  |  | - embeddings  | | - progress.db | | - search/     | | - *.yaml | |  |
    |  |  +---------------+ +---------------+ +---------------+ +----------+ |  |
    |  +---------------------------------------------------------------------+  |
    |                                                                            |
    +---------------------------------------------------------------------------+
                  |                                    ^
                  v                                    |
    +---------------------------------------------------------------------------+
    |                       External Services (Optional)                         |
    |  +----------------+ +------------------+ +------------------+              |
    |  |  GitHub CDN    | | discoveries.dev  | |   GitHub API     |              |
    |  | (Index Bundle) | | (Web Browser)    | | (Incremental)    |              |
    |  +----------------+ +------------------+ +------------------+              |
    +---------------------------------------------------------------------------+
```

### 2.3 Component Diagram - MCP Servers (Level 3)

```
+============================================================================+
|                    MCP SERVER COMPONENT DIAGRAM                              |
+============================================================================+

+-----------------------------------------------------------------------------------+
|  discovery-core MCP Server (150MB, 1.5s startup)                                   |
|                                                                                    |
|  +-------------------+                                                             |
|  |   MCP Interface   |  Tools: search, get_skill, recommend_skills,               |
|  |   (12 tools)      |         install_skill, audit_activation, check_conflicts   |
|  +-------------------+                                                             |
|           |                                                                        |
|  +--------+---------+---------+---------+                                          |
|  |        |         |         |         |                                          |
|  v        v         v         v         v                                          |
| +------+ +-------+ +-------+ +-------+ +--------+                                  |
| |Search| |Analyze| |Recom- | |Install| |Audit   |                                  |
| |Svc   | |Svc    | |mendSvc| |Svc    | |Svc     |                                  |
| +------+ +-------+ +-------+ +-------+ +--------+                                  |
|  |        |         |         |         |                                          |
|  +--------+---------+---------+---------+                                          |
|           |                                                                        |
|  +-------------------+                                                             |
|  | Data Access Layer |                                                             |
|  | (SQLite + FTS5)   |                                                             |
|  +-------------------+                                                             |
|           |                                                                        |
|  +--------+---------+                                                              |
|  |        |         |                                                              |
|  v        v         v                                                              |
| +------+ +-------+ +-------+                                                       |
| |skills| |embed- | |cache  |                                                       |
| |.db   | |dings  | |manager|                                                       |
| +------+ +-------+ +-------+                                                       |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
|  learning MCP Server (50MB, 0.5s startup)                                          |
|                                                                                    |
|  +-------------------+                                                             |
|  |   MCP Interface   |  Tools: get_path, next_exercise, submit_solution,           |
|  |   (6 tools)       |         get_progress, validate_solution                     |
|  +-------------------+                                                             |
|           |                                                                        |
|  +--------+---------+                                                              |
|  |                  |                                                              |
|  v                  v                                                              |
| +---------------+ +---------------+                                                |
| |Content Service| |Progress Svc   |                                                |
| +---------------+ +---------------+                                                |
|           |                                                                        |
|  +-------------------+                                                             |
|  |  File System Store|                                                             |
|  |  (Markdown-based) |                                                             |
|  +-------------------+                                                             |
+-----------------------------------------------------------------------------------+

+-----------------------------------------------------------------------------------+
|  sync MCP Server (100MB, 0.5s startup)                                             |
|                                                                                    |
|  +-------------------+                                                             |
|  |   MCP Interface   |  Tools: refresh_index, get_sync_status, force_full_sync,    |
|  |   (5 tools)       |         get_source_health, update_blocklist                 |
|  +-------------------+                                                             |
|           |                                                                        |
|  +--------+---------+---------+                                                    |
|  |        |         |         |                                                    |
|  v        v         v         v                                                    |
| +-------+ +-------+ +-------+ +-------+                                            |
| |GitHub | |Aggre- | |Block- | |Index  |                                            |
| |Sync   | |gator  | |list   | |Writer |                                            |
| +-------+ +-------+ +-------+ +-------+                                            |
+-----------------------------------------------------------------------------------+
```

---

## 3. Technology Stack

### 3.1 Core Technologies

| Layer | Technology | Version | Rationale |
|-------|------------|---------|-----------|
| **Runtime** | Node.js | 18+ LTS | MCP SDK requirement |
| **Database** | SQLite + FTS5 | 3.45+ | Portable, embedded, full-text search |
| **Embeddings** | all-MiniLM-L6-v2 | - | 384 dims, fast, local WASM |
| **Package** | npm | - | Standard Node.js distribution |
| **Protocol** | MCP | 1.0 | Native Claude Code integration |
| **Web Framework** | Astro | 4.x | Static-first, partial hydration |

### 3.2 Development Technologies

| Category | Technology | Purpose |
|----------|------------|---------|
| Language | TypeScript | Type safety, maintainability |
| Testing | Vitest | Fast, modern test runner |
| Linting | ESLint + Prettier | Code quality |
| CI/CD | GitHub Actions | Automation, free tier |
| Docs | Markdown | Git-native documentation |

### 3.3 Infrastructure Technologies

| Category | Technology | Purpose |
|----------|------------|---------|
| CDN | jsDelivr | Free, GitHub-native |
| Hosting | GitHub Pages → Vercel | Progressive complexity |
| DNS | Cloudflare | Free tier, performance |
| Analytics | PostHog/Plausible | Privacy-first (opt-in) |
| Errors | Sentry | Error tracking (opt-in) |

---

## 4. Data Architecture Summary

### 4.1 Core Entities

```
+------------------+      +------------------+      +------------------+
|     SOURCE       |      |      SKILL       |      |    CATEGORY      |
+------------------+      +------------------+      +------------------+
| id (PK)          |  1:N | id (PK)          |  N:M | id (PK)          |
| name             |<---->| name             |<---->| name             |
| base_url         |      | description      |      | display_name     |
| api_type         |      | quality_score    |      | skill_count      |
| rate_limit       |      | trust_tier       |      +------------------+
+------------------+      | embedding_id     |
                          +------------------+
                                  |
                                  | 1:N
                                  v
                          +------------------+
                          |      USER        |
                          +------------------+
                          | id (PK)          |
                          | anonymous_id     |
                          | preferences      |
                          | installed_skills |
                          +------------------+
```

### 4.2 Storage Layout

```
~/.claude-discovery/
├── index/
│   ├── skills.db              # SQLite (FTS5 enabled) - ~50MB at scale
│   ├── embeddings.bin         # Memory-mapped vectors - ~200MB at scale
│   └── sync_state.json        # Sync cursor tracking
├── user/
│   ├── profile.json           # User preferences
│   ├── installed.json         # Installed skills manifest
│   └── progress.db            # Learning progress
├── cache/
│   ├── github/                # API response cache
│   └── search/                # Query result cache
├── config/
│   ├── settings.json          # Global settings
│   └── priorities.yaml        # Skill priority overrides
└── logs/
    └── discovery.log          # Rotating logs (7 days)
```

### 4.3 Storage Projections

| Phase | Skills | Total Size | Notes |
|-------|--------|------------|-------|
| Phase 1 | 1,000 | ~36 MB | MVP |
| Phase 2 | 10,000 | ~142 MB | Growth |
| Phase 3 | 25,000 | ~225 MB | Scale |
| Phase 4 | 50,000+ | ~320 MB | Target |

---

## 5. Security Architecture Summary

### 5.1 Trust Tier Model

```
+------------------------------------------------------------------+
|  TIER 1: OFFICIAL     | anthropic/* namespace                     |
|  (Green checkmark)    | Full Anthropic security review            |
+------------------------------------------------------------------+
           |
           v
+------------------------------------------------------------------+
|  TIER 2: VERIFIED     | Verified identity (GitHub org)            |
|  (Blue checkmark)     | 10+ stars, 30+ days, scan passed          |
+------------------------------------------------------------------+
           |
           v
+------------------------------------------------------------------+
|  TIER 3: COMMUNITY    | Any GitHub user, automated scan           |
|  (Yellow indicator)   | License, README, SKILL.md present         |
+------------------------------------------------------------------+
           |
           v
+------------------------------------------------------------------+
|  TIER 4: UNVERIFIED   | Unknown or local                          |
|  (Red warning)        | Strong warning, explicit opt-in           |
+------------------------------------------------------------------+
```

### 5.2 Security Controls

| Control | Purpose | Phase |
|---------|---------|-------|
| Static Analysis | Detect malicious patterns | Phase 1 |
| Typosquatting Detection | Prevent name confusion | Phase 1 |
| Blocklist Integration | Block known-bad skills | Phase 1 |
| Trust Tier Display | Signal skill trustworthiness | Phase 1 |
| Publisher Verification | Verify author identity | Phase 2 |
| Conflict Detection | Prevent skill interference | Phase 2 |

### 5.3 Privacy Model

| Data Type | Collection | Transmission | User Control |
|-----------|------------|--------------|--------------|
| Search queries | Anonymized | Opt-out | Disable telemetry |
| Install events | Skill ID only | Opt-out | Disable telemetry |
| Codebase content | Never | Never | N/A |
| Credentials | Never | Never | N/A |
| File paths | Never | Never | N/A |

---

## 6. Performance Requirements

### 6.1 Latency Targets

| Operation | Target (p50) | Target (p95) | Max |
|-----------|--------------|--------------|-----|
| Search (cached) | 50ms | 150ms | 200ms |
| Search (uncached) | 200ms | 400ms | 500ms |
| Codebase scan (1K files) | 5s | 15s | 30s |
| Recommend skills | 300ms | 1s | 2s |
| Install skill | 1s | 3s | 5s |
| Index sync (incremental) | 30s | 60s | 120s |

### 6.2 Resource Budgets

| Component | Memory (Idle) | Memory (Active) | Startup |
|-----------|---------------|-----------------|---------|
| discovery-core | 150MB | 250MB | 1.5s |
| learning | 50MB | 100MB | 0.5s |
| sync | 100MB | 150MB | 0.5s |
| **TOTAL** | **300MB** | **500MB** | **2.5s** |

### 6.3 Caching Strategy

```
+-------------------+
|   L1: Memory      | ← Hot data (LRU, 100MB max, 5min TTL)
|   (in-process)    |
+-------------------+
         |
         v
+-------------------+
|   L2: SQLite      | ← Warm data (24h TTL for most)
|   (disk, WAL)     |
+-------------------+
         |
         v
+-------------------+
|   L3: HTTP        | ← Cold data (ETag, If-Modified-Since)
|   (CDN/GitHub)    |
+-------------------+
```

---

## 7. Integration Points

### 7.1 External Data Sources

| Source | Method | Rate Limit | Refresh |
|--------|--------|------------|---------|
| GitHub | REST + GraphQL | 5K/hr (with PAT) | Hourly (incremental) |
| SkillsMP | Web scraping | 10 req/min | Daily |
| claude-plugins.dev | Scraping/RSS | 10 req/min | 6 hours |
| mcp.so | REST API | 100 req/hr | 2 hours |
| npm Registry | REST API | 60 req/min | Weekly |

### 7.2 Claude Code Integration

- **Protocol**: MCP (Model Context Protocol) over stdio
- **Registration**: `~/.config/claude/mcp_settings.json`
- **Tools Exposed**: 12 (discovery-core), 6 (learning), 5 (sync)

### 7.3 Web Integration

- **Framework**: Astro (static-first)
- **Hosting**: GitHub Pages (MVP) → Vercel (Growth)
- **Search**: Client-side SQLite via sql.js
- **SEO**: JSON-LD structured data, OG tags

---

## 8. Deployment Architecture

### 8.1 Distribution Strategy

```
+------------------+     +------------------+     +------------------+
|  npm Package     |     | GitHub Releases  |     | jsDelivr CDN     |
| @claude-discovery|     | (Index builds)   |     | (Fast delivery)  |
|     /hub         |     |                  |     |                  |
+------------------+     +------------------+     +------------------+
         |                        |                        |
         v                        v                        v
+------------------------------------------------------------------+
|                    User Installation                              |
|  npm install -g @claude-discovery/hub                             |
|  (Downloads package + bootstrap index ~25MB)                      |
+------------------------------------------------------------------+
```

### 8.2 Update Mechanisms

| Update Type | Frequency | Mechanism | Size |
|-------------|-----------|-----------|------|
| Index (incremental) | Daily | Background sync | 100KB-5MB |
| Index (full) | Weekly fallback | CDN download | ~25MB |
| Package | Monthly | npm update | ~10MB |

### 8.3 Infrastructure Costs

| Phase | Monthly Cost | Notes |
|-------|--------------|-------|
| Phase 1 (MVP) | ~$1 | GitHub Pages, free tiers |
| Phase 2 (Growth) | ~$50-150 | Vercel Pro, analytics |
| Scale (5K+ WAU) | ~$200-500 | Usage overage, monitoring |

---

## 9. Phased Implementation Roadmap

### Phase 0: Validation (Weeks 1-8)
- POC MCP server with 1,000 skills
- Basic search and install
- Validate product-market fit

### Phase 1: Foundation (Weeks 9-12)
- Full 50K+ skill index
- Static analysis pipeline
- Trust tier system
- Web skill browser

### Phase 2: Recommendations (Weeks 13-16)
- Codebase scanner
- Recommendation engine
- Conflict detection
- VS Code extension

### Phase 3: Activation (Weeks 17-20)
- Activation auditor
- Learning paths
- Budget calculator
- Hook generator

### Phase 4+: Scale (Weeks 21+)
- Author dashboard
- Community features
- Enterprise features
- Anthropic partnership integration

---

## 10. Risk Mitigation

### 10.1 Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| GitHub API rate limits | Medium | High | Token rotation, caching, Events API |
| Scraper breakage | High | Medium | Multiple sources, graceful degradation |
| SQLite performance | Low | Medium | WAL mode, indexes, memory-mapping |
| MCP SDK changes | Low | High | Version pinning, abstraction layer |

### 10.2 Security Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Malicious skill distribution | Medium | Critical | Static analysis, blocklist, trust tiers |
| Typosquatting | Medium | High | Levenshtein detection, warnings |
| Supply chain attack | Low | Critical | npm provenance, signed releases |

### 10.3 Business Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Anthropic partnership fails | Unknown | Medium | Independent workaround path documented |
| Low adoption | Medium | High | Progressive disclosure, community building |
| Source aggregators disappear | Low | Medium | Multi-source architecture |

---

## 11. Cross-Cutting Concerns

### 11.1 Observability

| Aspect | Local | Cloud (Opt-in) |
|--------|-------|----------------|
| Logging | Rotating files, structured JSON | N/A |
| Metrics | Health check CLI | PostHog (aggregated) |
| Errors | Console output | Sentry (anonymized) |
| Tracing | Request ID propagation | N/A |

### 11.2 Configuration

```yaml
# ~/.claude-discovery/config/settings.json
{
  "telemetry": {
    "enabled": true,          # Opt-out available
    "level": "standard"       # basic | standard | full
  },
  "sync": {
    "frequency": "daily",
    "background": true
  },
  "discovery": {
    "trust_tier_minimum": "community",
    "show_unverified": true
  },
  "performance": {
    "cache_size_mb": 100,
    "embedding_preload": false
  }
}
```

### 11.3 Error Handling

| Error Type | Strategy | User Experience |
|------------|----------|-----------------|
| Network timeout | Retry 3x, then cache | "Using cached results" |
| Rate limit | Delay, rotate tokens | "Syncing paused, will resume" |
| Invalid parameter | Immediate fail | Clear error message |
| Security blocked | Block with explanation | "Skill blocked: [reason]" |

---

## 12. Decision Log

Key architectural decisions made by the specialist architects:

| Decision | Choice | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Database | SQLite (embedded) | PostgreSQL, Redis | Zero dependencies, offline-first |
| API Protocol | MCP | REST, GraphQL | Native Claude Code integration |
| Server Count | 3 consolidated | 6 (original), 1 (monolith) | Balance startup vs separation |
| Embedding Model | all-MiniLM-L6-v2 | OpenAI API, mpnet | Local WASM, no external deps |
| Web Framework | Astro | Next.js, Remix | Static-first, SEO, partial hydration |
| Hosting (MVP) | GitHub Pages | Vercel, Netlify | Free, simple, sufficient |
| Telemetry | Opt-out | Opt-in, none | Social proof needs data, but respect privacy |

---

## 13. Related Documents

| Document | Purpose | Link |
|----------|---------|------|
| Backend/API Architecture | MCP servers, APIs, services | [backend-api.md](./backend-api.md) |
| Data Architecture | Schemas, storage, sync | [data.md](./data.md) |
| Security Architecture | Threats, trust, privacy | [security.md](./security.md) |
| Integration Architecture | External APIs, Claude Code | [integrations.md](./integrations.md) |
| Infrastructure Architecture | Deployment, CI/CD, monitoring | [infrastructure.md](./infrastructure.md) |
| PRD v3 | Product requirements | [prd-v3.md](../prd-v3.md) |
| Technical Design | Original technical design | [technical-design.md](../technical-design.md) |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | Senior Architect | Initial synthesis from 5 specialist documents |

---

*This document serves as the single source of truth for Claude Discovery Hub architecture. All implementation decisions should align with this document. Changes require an ADR (Architecture Decision Record) in `/docs/adr/`.*

*Next Review: After Phase 0 Gate Decision (Week 8)*
