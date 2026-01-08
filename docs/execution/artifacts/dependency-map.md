# Dependency Map

**Document Type:** Implementation Artifact
**Version:** 1.0
**Date:** December 26, 2025
**Owner:** Systems Architect
**Status:** Ready for Review

---

## Table of Contents

1. [Overview](#1-overview)
2. [Component Dependency Graph](#2-component-dependency-graph)
3. [Epic Dependency Matrix](#3-epic-dependency-matrix)
4. [Story Dependencies](#4-story-dependencies)
5. [Cross-Domain Dependencies](#5-cross-domain-dependencies)
6. [External Dependencies](#6-external-dependencies)
7. [Implementation Sequence Diagram](#7-implementation-sequence-diagram)
8. [Risk Dependencies](#8-risk-dependencies)
9. [Quick Reference](#9-quick-reference)

---

## 1. Overview

### Purpose

This dependency map provides a comprehensive view of relationships between all components, epics, stories, and external services in Skillsmith. Use this document to:

- **Plan sprint work** by understanding prerequisite tasks
- **Identify blockers** before they impact delivery
- **Coordinate parallel work** across team members
- **Assess risk** from component dependencies
- **Prioritize features** based on dependency chains

### Dependency Types

| Type | Symbol | Description |
|------|--------|-------------|
| **Blocks** | `-->` | A must complete before B can start |
| **Informs** | `-.->` | A provides design/data input to B |
| **Integrates** | `<-->` | A and B must work together |
| **Tests** | `--T-->` | A requires B for testing |

### Reading This Document

- **Mermaid diagrams** visualize dependencies - render in a Mermaid-compatible viewer
- **Tables** provide quick lookup of dependencies by ID
- **Critical paths** are highlighted with thick arrows in diagrams
- **Phase boundaries** are marked with horizontal dividers

---

## 2. Component Dependency Graph

### 2.1 MCP Server Dependencies

```mermaid
graph TB
    subgraph Servers[MCP Servers]
        DC[discovery-core<br/>150MB, 1.5s]
        LS[learning<br/>50MB, 0.5s]
        SS[sync<br/>100MB, 0.5s]
    end

    subgraph Services[Service Layer]
        SRC[SearchService]
        ANA[AnalysisService]
        REC[RecommendService]
        INS[InstallService]
        AUD[AuditService]
        CON[ConflictService]
        SEC[SecurityScanner]
    end

    subgraph Data[Data Layer]
        DAL[Data Access Layer]
        SKR[SkillRepository]
        CAC[CacheRepository]
        CFR[ConfigRepository]
    end

    subgraph Storage[Storage Layer]
        SQL[(skills.db<br/>SQLite + FTS5)]
        EMB[(embeddings.bin)]
        USR[(user/profile.json)]
        CFG[(config/settings.json)]
    end

    DC --> SRC
    DC --> ANA
    DC --> REC
    DC --> INS
    DC --> AUD
    DC --> CON

    SRC --> DAL
    ANA --> DAL
    ANA --> SRC
    REC --> SRC
    REC --> ANA
    INS --> SEC
    INS --> CON
    INS --> DAL
    AUD --> DAL
    CON --> DAL

    DAL --> SKR
    DAL --> CAC
    DAL --> CFR

    SKR --> SQL
    SKR --> EMB
    CAC --> SQL
    CFR --> USR
    CFR --> CFG

    LS -.-> SQL
    SS --> SQL
    SS --> EMB
```

### 2.2 Service Layer Internal Dependencies

```mermaid
graph LR
    subgraph Core[Core Services]
        Search[SearchService]
        Analysis[AnalysisService]
        Recommend[RecommendService]
    end

    subgraph Install[Installation Services]
        Install[InstallService]
        Conflict[ConflictService]
        Security[SecurityScanner]
        Audit[AuditService]
    end

    subgraph Support[Support Services]
        Cache[CacheManager]
        Embed[EmbeddingStore]
        Budget[BudgetCalculator]
        Hook[HookGenerator]
    end

    Search --> Cache
    Search --> Embed
    Analysis --> Search
    Recommend --> Analysis
    Recommend --> Search

    Install --> Conflict
    Install --> Security
    Install --> Budget
    Audit --> Budget
    Audit --> Hook

    Conflict --> Search
    Security --> Cache
```

### 2.3 Data Layer Dependencies

```mermaid
graph TB
    subgraph Repositories[Repository Layer]
        SkillRepo[SkillRepository]
        AuthorRepo[AuthorRepository]
        SourceRepo[SourceRepository]
        CacheRepo[CacheRepository]
        InteractionRepo[InteractionRepository]
    end

    subgraph Database[SQLite Database]
        Skills[skills table]
        FTS[skills_fts<br/>FTS5 virtual table]
        Authors[authors table]
        Sources[sources table]
        Cache[cache table]
        Interactions[skill_interactions table]
        Categories[categories +<br/>skill_categories]
        Technologies[technologies +<br/>skill_technologies]
        Security[blocked_skills +<br/>security_findings]
    end

    subgraph External[External Storage]
        Embeddings[embeddings.bin]
        UserProfile[profile.json]
        Installed[installed.json]
    end

    SkillRepo --> Skills
    SkillRepo --> FTS
    SkillRepo --> Categories
    SkillRepo --> Technologies
    SkillRepo --> Security

    AuthorRepo --> Authors
    SourceRepo --> Sources
    CacheRepo --> Cache
    InteractionRepo --> Interactions

    Skills -.-> Authors
    Skills -.-> Sources
    Skills <-.-> FTS

    SkillRepo --> Embeddings
    InteractionRepo --> UserProfile
    InteractionRepo --> Installed
```

---

## 3. Epic Dependency Matrix

### 3.1 Phase 0 Epics

| Epic ID | Epic Name | Domain | Depends On | Blocks | Phase |
|---------|-----------|--------|------------|--------|-------|
| **DA-001** | Database Foundation | Data | - | DA-002, DA-003, TA-001, TA-002 | 0 |
| **DA-002** | Caching Layer | Data | DA-001 | DA-003, TA-002 | 0 |
| **TA-001** | MCP Server Foundation | Technical | DA-001 | TA-002, PROD-001 | 0 |
| **TA-002** | Search Service POC | Technical | DA-001, DA-002, TA-001 | PROD-001, PROD-002 | 0 |
| **PROD-001** | Basic Skill Search | Product | TA-002 | PROD-002, PROD-003 | 0 |
| **PROD-002** | Skill Detail View | Product | PROD-001 | PROD-003 | 0 |
| **PROD-003** | Install Command Generation | Product | PROD-002 | M0.5 | 0 |
| **PROD-004** | Basic Quality Score | Product | PROD-001 | PROD-104 | 0 |
| **PROD-005** | Curated Skill Index | Product | DA-001 | PROD-101 | 0 |
| **PROD-006** | MCP Server Foundation | Product | TA-001 | PROD-007, PROD-008, PROD-110 | 0 |
| **PROD-007** | Opt-Out Telemetry | Product | PROD-006 | SEC-001 | 0 |
| **SEC-001** | Opt-Out Telemetry Infrastructure | Security | - | SEC-002, SEC-004 | 0 |
| **SEC-002** | Privacy Notice Display | Security | SEC-001 | - | 0 |
| **SEC-003** | Basic Trust Tier Display | Security | - | SEC-107 | 0 |
| **SEC-004** | Codebase Privacy Guarantee | Security | SEC-001, SEC-002 | - | 0 |

### 3.2 Phase 1 Epics

| Epic ID | Epic Name | Domain | Depends On | Blocks | Phase |
|---------|-----------|--------|------------|--------|-------|
| **DA-003** | Sync Infrastructure | Data | DA-001, DA-002 | DA-004, PROD-101 | 1 |
| **DA-004** | Quality Scoring | Data | DA-003 | PROD-104 | 1 |
| **PROD-101** | 50K+ Skill Index | Product | PROD-005, DA-003 | PROD-102, PROD-103, M1.4, M2.1 | 1 |
| **PROD-102** | Search Filtering | Product | PROD-101 | PROD-210 | 1 |
| **PROD-103** | Category Taxonomy | Product | PROD-101 | - | 1 |
| **PROD-104** | Transparent Quality Methodology | Product | PROD-004, DA-004 | PROD-105 | 1 |
| **PROD-105** | Exploration Bonus | Product | PROD-104 | - | 1 |
| **PROD-106** | Trust Tier System | Product | SEC-107 | PROD-203, M2.2 | 1 |
| **PROD-107** | Static Analysis Pipeline | Product | SEC-101, SEC-102, SEC-103 | PROD-108 | 1 |
| **PROD-108** | Blocklist Integration | Product | PROD-107, SEC-106 | - | 1 |
| **PROD-109** | Typosquatting Detection | Product | SEC-105 | - | 1 |
| **PROD-110** | Core CLI Commands | Product | PROD-006 | PROD-111 | 1 |
| **PROD-111** | Offline Mode | Product | PROD-101, PROD-110 | - | 1 |
| **SEC-101** | Jailbreak Pattern Detection | Security | - | SEC-107, PROD-107 | 1 |
| **SEC-102** | URL and Domain Analysis | Security | - | SEC-107, PROD-107 | 1 |
| **SEC-103** | Sensitive File Access Detection | Security | - | SEC-107, PROD-107 | 1 |
| **SEC-104** | Obfuscation Detection | Security | - | SEC-107 | 1 |
| **SEC-105** | Typosquatting Detection Engine | Security | - | PROD-109 | 1 |
| **SEC-106** | Blocklist Infrastructure | Security | - | PROD-108 | 1 |
| **SEC-107** | Trust Tier Computation Engine | Security | SEC-101, SEC-102, SEC-103, SEC-104 | PROD-106 | 1 |

### 3.3 Phase 2 Epics

| Epic ID | Epic Name | Domain | Depends On | Blocks | Phase |
|---------|-----------|--------|------------|--------|-------|
| **DA-005** | Semantic Search with Embeddings | Data | DA-001, DA-003 | PROD-203 | 2 |
| **DA-006** | Telemetry Data Layer | Data | DA-001 | SEC-204 | 2 |
| **PROD-201** | Codebase Scanner | Product | PROD-101 | PROD-202, PROD-208 | 2 |
| **PROD-202** | Technology Detection | Product | PROD-201 | PROD-203 | 2 |
| **PROD-203** | Skill Recommendations | Product | PROD-202, PROD-106, DA-005 | M2.4 | 2 |
| **PROD-204** | Trigger Overlap Detection | Product | SEC-201 | PROD-205 | 2 |
| **PROD-205** | Priority Configuration | Product | PROD-204, SEC-203 | - | 2 |
| **PROD-206** | Static Skill Browser Website | Product | PROD-101 | PROD-207 | 2 |
| **PROD-207** | Skill Comparison | Product | PROD-206 | - | 2 |
| **PROD-208** | VS Code Extension Sidebar | Product | PROD-201 | PROD-209 | 2 |
| **PROD-209** | Context-Aware IDE Suggestions | Product | PROD-208 | - | 2 |
| **PROD-210** | Search Failure States | Product | PROD-102 | - | 2 |
| **PROD-211** | Installation Failure Diagnostics | Product | PROD-003 | - | 2 |
| **PROD-212** | Activation Troubleshooting | Product | PROD-003 | - | 2 |
| **SEC-201** | Trigger Overlap Detection | Security | - | SEC-203, PROD-204 | 2 |
| **SEC-202** | Output Collision Detection | Security | - | SEC-203 | 2 |
| **SEC-203** | Priority Configuration System | Security | SEC-201, SEC-202 | PROD-205 | 2 |
| **SEC-204** | Granular Telemetry Consent | Security | SEC-001, DA-006 | SEC-205 | 2 |
| **SEC-205** | Data Deletion Request | Security | SEC-204 | - | 2 |

### 3.4 Epic Dependency Visualization

```mermaid
graph TB
    subgraph Phase0[Phase 0: POC/Validation]
        DA001[DA-001: Database Foundation]
        DA002[DA-002: Caching Layer]
        TA001[TA-001: MCP Server Foundation]
        TA002[TA-002: Search Service POC]
        PROD001[PROD-001: Basic Search]
        PROD002[PROD-002: Skill Detail]
        PROD003[PROD-003: Install Command]
        PROD004[PROD-004: Quality Score]
        PROD005[PROD-005: Curated Index]
        PROD006[PROD-006: MCP Foundation]
        SEC001[SEC-001: Telemetry]
        SEC003[SEC-003: Trust Display]
    end

    subgraph Phase1[Phase 1: Foundation + Safety]
        DA003[DA-003: Sync Infrastructure]
        DA004[DA-004: Quality Scoring]
        PROD101[PROD-101: 50K Index]
        PROD106[PROD-106: Trust Tiers]
        PROD107[PROD-107: Static Analysis]
        SEC101[SEC-101: Jailbreak Detection]
        SEC102[SEC-102: URL Analysis]
        SEC107[SEC-107: Trust Computation]
    end

    subgraph Phase2[Phase 2: Recommendations]
        DA005[DA-005: Semantic Search]
        PROD201[PROD-201: Codebase Scanner]
        PROD202[PROD-202: Tech Detection]
        PROD203[PROD-203: Recommendations]
        PROD208[PROD-208: VS Code Extension]
        SEC201[SEC-201: Conflict Detection]
    end

    %% Phase 0 Dependencies
    DA001 --> DA002
    DA001 --> TA001
    DA002 --> TA002
    TA001 --> TA002
    TA002 --> PROD001
    PROD001 --> PROD002
    PROD002 --> PROD003
    PROD001 --> PROD004
    DA001 --> PROD005
    TA001 --> PROD006
    SEC001 -.-> SEC003

    %% Phase 0 to Phase 1
    DA002 --> DA003
    PROD005 --> PROD101
    DA003 --> DA004
    SEC003 --> SEC107

    %% Phase 1 Internal
    DA003 --> PROD101
    SEC101 --> SEC107
    SEC102 --> SEC107
    SEC107 --> PROD106
    DA004 --> PROD107

    %% Phase 1 to Phase 2
    PROD101 --> DA005
    PROD101 --> PROD201
    PROD106 --> PROD203

    %% Phase 2 Internal
    DA005 --> PROD203
    PROD201 --> PROD202
    PROD202 --> PROD203
    PROD201 --> PROD208
    SEC201 -.-> PROD203

    linkStyle 0,1,2,3,4,5,6,7,8,9,14,15,16,17,18,19,20,21,22,23,24,25 stroke:#333,stroke-width:2px
```

---

## 4. Story Dependencies

### 4.1 Critical Path Stories

These stories form the critical path and must be completed in sequence:

```mermaid
graph LR
    subgraph Critical[Critical Path - 15.5 Weeks]
        DA001_01[DA-001-01<br/>DB Init]
        DA001_02[DA-001-02<br/>Core Schema]
        DA001_03[DA-001-03<br/>FTS5 Search]
        DA003_01[DA-003-01<br/>Sync State]
        DA003_02[DA-003-02<br/>GitHub Sync]
        DA005_01[DA-005-01<br/>Embeddings]
        DA005_02[DA-005-02<br/>Hybrid Search]
        PROD201_S1[PROD-201<br/>Scanner]
        PROD202_S1[PROD-202<br/>Tech Detect]
        PROD203_S1[PROD-203<br/>Recommend]
    end

    DA001_01 --> DA001_02
    DA001_02 --> DA001_03
    DA001_03 --> DA003_01
    DA003_01 --> DA003_02
    DA003_02 --> DA005_01
    DA005_01 --> DA005_02
    DA005_02 --> PROD201_S1
    PROD201_S1 --> PROD202_S1
    PROD202_S1 --> PROD203_S1

    linkStyle 0,1,2,3,4,5,6,7,8 stroke:#ff0000,stroke-width:3px
```

### 4.2 Data Architecture Story Dependencies

| Story ID | Story Name | Depends On | Blocks | Est. |
|----------|------------|------------|--------|------|
| DA-001-01 | Database Initialization | - | DA-001-02, DA-001-03, DA-001-04 | 17h |
| DA-001-02 | Core Schema Implementation | DA-001-01 | DA-001-03 | 16h |
| DA-001-03 | FTS5 Full-Text Search | DA-001-01, DA-001-02 | DA-002-01, TA-002 | 13h |
| DA-001-04 | Repository Pattern | DA-001-01 | DA-002-01, DA-003-01 | 13h |
| DA-002-01 | Cache Table and Operations | DA-001-03, DA-001-04 | DA-003-01 | 11h |
| DA-003-01 | Sync State Machine | DA-001-04, DA-002-01 | DA-003-02, DA-003-03 | 14h |
| DA-003-02 | GitHub Sync Adapter | DA-003-01 | DA-003-03 | 18h |
| DA-003-03 | Deduplication Engine | DA-003-01, DA-003-02 | DA-004-01 | 10h |
| DA-004-01 | Scoring Algorithm | DA-003-03 | PROD-104 | 16h |
| DA-005-01 | Embedding Generation Pipeline | DA-001-01 | DA-005-02 | 20h |
| DA-005-02 | Hybrid Search Implementation | DA-005-01, DA-001-03 | PROD-203 | 8h |
| DA-006-01 | Telemetry Queue | DA-001-01 | SEC-204 | 10h |

### 4.3 Security Story Dependencies

| Story ID | Story Name | Depends On | Blocks | Est. | Priority |
|----------|------------|------------|--------|------|----------|
| SEC-001 | Opt-Out Telemetry | - | SEC-002, SEC-004, SEC-204 | 22h | P0 |
| SEC-002 | Privacy Notice Display | SEC-001 | SEC-004 | 5h | P0 |
| SEC-003 | Basic Trust Tier Display | - | SEC-107 | 5h | P0 |
| SEC-004 | Codebase Privacy Guarantee | SEC-001, SEC-002 | - | 8h | P0 |
| SEC-101 | Jailbreak Pattern Detection | - | SEC-107, PROD-107 | 19h | P0 |
| SEC-102 | URL and Domain Analysis | - | SEC-107, PROD-107 | 13h | P0 |
| SEC-103 | Sensitive File Access Detection | - | SEC-107, PROD-107 | 7h | P0 |
| SEC-104 | Obfuscation Detection | - | SEC-107 | 12h | P1 |
| SEC-105 | Typosquatting Detection Engine | - | PROD-109 | 16h | P0 |
| SEC-106 | Blocklist Infrastructure | - | PROD-108 | 17h | P0 |
| SEC-107 | Trust Tier Computation Engine | SEC-101, SEC-102, SEC-103, SEC-104 | PROD-106 | 15h | P0 |
| SEC-201 | Trigger Overlap Detection | - | SEC-203, PROD-204 | 16h | P0 |
| SEC-202 | Output Collision Detection | - | SEC-203 | 8h | P0 |
| SEC-203 | Priority Configuration System | SEC-201, SEC-202 | PROD-205 | 12h | P1 |
| SEC-204 | Granular Telemetry Consent | SEC-001 | SEC-205 | 13h | P1 |
| SEC-205 | Data Deletion Request | SEC-204 | - | 7h | P2 |

### 4.4 Product Story Dependencies

| Story ID | Story Name | Depends On | Blocks | Est. | Priority |
|----------|------------|------------|--------|------|----------|
| PROD-001 | Basic Skill Search | TA-002 | PROD-002, PROD-004 | 5 SP | P0 |
| PROD-002 | Skill Detail View | PROD-001 | PROD-003 | 3 SP | P0 |
| PROD-003 | Install Command Generation | PROD-002 | PROD-211, PROD-212 | 3 SP | P0 |
| PROD-004 | Basic Quality Score Display | PROD-001 | PROD-104 | 5 SP | P0 |
| PROD-005 | Curated Skill Index | - | PROD-101 | 8 SP | P0 |
| PROD-006 | MCP Server Foundation | TA-001 | PROD-007, PROD-008, PROD-110 | 8 SP | P0 |
| PROD-007 | Opt-Out Telemetry Foundation | PROD-006 | - | 5 SP | P0 |
| PROD-101 | 50K+ Skill Index | PROD-005, DA-003 | PROD-102, PROD-103, PROD-111, PROD-201, PROD-206 | 13 SP | P0 |
| PROD-102 | Search Filtering | PROD-101 | PROD-210 | 5 SP | P0 |
| PROD-106 | Trust Tier System | SEC-107 | PROD-203 | 5 SP | P0 |
| PROD-107 | Static Analysis Pipeline | SEC-101, SEC-102, SEC-103 | PROD-108 | 8 SP | P0 |
| PROD-201 | Codebase Scanner | PROD-101 | PROD-202, PROD-208 | 8 SP | P0 |
| PROD-202 | Technology Detection | PROD-201 | PROD-203 | 8 SP | P0 |
| PROD-203 | Skill Recommendations | PROD-202, PROD-106, DA-005 | - | 8 SP | P0 |
| PROD-206 | Static Skill Browser | PROD-101, PROD-106 | PROD-207, M2.4 | 13 SP | P1 |
| PROD-208 | VS Code Extension | PROD-201, PROD-206 | PROD-209 | 13 SP | P1 |

---

## 5. Cross-Domain Dependencies

### 5.1 Data to Backend Dependencies

```mermaid
graph LR
    subgraph Data[Data Architecture]
        DA001[DA-001: Database]
        DA002[DA-002: Cache]
        DA003[DA-003: Sync]
        DA004[DA-004: Quality]
        DA005[DA-005: Embeddings]
    end

    subgraph Backend[Backend/MCP]
        TA001[TA-001: MCP Server]
        TA002[TA-002: Search POC]
        SRC[SearchService]
        REC[RecommendService]
        INS[InstallService]
    end

    DA001 -->|Schema required| TA001
    DA001 -->|Repository pattern| SRC
    DA002 -->|Cache access| SRC
    DA003 -->|Sync data| SRC
    DA004 -->|Quality scores| SRC
    DA004 -->|Score ranking| REC
    DA005 -->|Semantic search| SRC
    DA005 -->|Similarity matching| REC
    DA001 -->|Install tracking| INS
```

### 5.2 Backend to Frontend Dependencies

```mermaid
graph LR
    subgraph Backend[Backend/MCP Servers]
        DC[discovery-core]
        Tools[12 MCP Tools]
        API[Tool Responses]
    end

    subgraph Frontend[Frontend/IDE]
        CLI[CLI Commands]
        WEB[Web Browser]
        VSC[VS Code Ext]
    end

    DC -->|MCP Protocol| CLI
    Tools -->|search, get_skill| WEB
    Tools -->|recommend, install| VSC
    API -->|JSON responses| WEB
    API -->|JSON responses| VSC

    WEB -.->|sql.js client| Backend
    VSC -.->|MCP client| DC
```

### 5.3 Security to All Domains Dependencies

```mermaid
graph TB
    subgraph Security[Security Domain]
        Trust[SEC-107: Trust Tiers]
        Scan[SEC-101-104: Static Analysis]
        Block[SEC-106: Blocklist]
        Conflict[SEC-201-203: Conflicts]
        Privacy[SEC-001-004: Privacy]
    end

    subgraph Data[Data Domain]
        Schema[skills.db schema]
        Scoring[Quality Scoring]
        Telemetry[Telemetry Queue]
    end

    subgraph Backend[Backend Domain]
        Search[SearchService]
        Install[InstallService]
        Audit[AuditService]
    end

    subgraph Product[Product Domain]
        Display[Trust Display]
        Warnings[Security Warnings]
        Diagnostics[Failure Diagnostics]
    end

    Trust -->|trust_tier column| Schema
    Scan -->|security_findings table| Schema
    Block -->|blocked_skills table| Schema
    Privacy -->|telemetry config| Telemetry

    Trust -->|Filter by tier| Search
    Scan -->|Pre-install check| Install
    Block -->|Block installation| Install
    Conflict -->|Conflict detection| Install
    Privacy -->|Anonymization| Audit

    Trust -->|Badge display| Display
    Scan -->|Warning display| Warnings
    Conflict -->|Conflict UI| Diagnostics
```

### 5.4 Infrastructure to All Domains Dependencies

```mermaid
graph TB
    subgraph Infra[Infrastructure]
        CI[CI/CD Pipeline]
        Deploy[Deployment]
        Monitor[Monitoring]
        CDN[jsDelivr CDN]
    end

    subgraph Data[Data Domain]
        DB[SQLite Database]
        Index[Skill Index]
        Sync[Sync Pipeline]
    end

    subgraph Backend[Backend Domain]
        MCP[MCP Servers]
        npm[npm Package]
    end

    subgraph Frontend[Frontend Domain]
        Web[Web Browser]
        VSCode[VS Code Ext]
    end

    CI -->|Build & Test| DB
    CI -->|Build & Test| MCP
    CI -->|Build & Test| Web
    CI -->|Build & Test| VSCode

    Deploy -->|Package publish| npm
    Deploy -->|Static deploy| Web
    Deploy -->|Marketplace| VSCode

    CDN -->|Index distribution| Index
    CDN -->|Static assets| Web

    Monitor -->|Error tracking| MCP
    Monitor -->|Analytics| Web
```

---

## 6. External Dependencies

### 6.1 External Services Matrix

| Service | Used By | Dependency Type | Failure Impact | Fallback |
|---------|---------|-----------------|----------------|----------|
| **GitHub API** | DA-003, sync server | Data source | High - Primary source | Cached data |
| **npm Registry** | DA-003, PROD-005 | Data source | Medium | Cached data |
| **SkillsMP** | DA-003 | Data source | Low | Other sources |
| **claude-plugins.dev** | DA-003 | Data source | Low | Other sources |
| **mcp.so** | DA-003 | Data source | Low | Other sources |
| **jsDelivr CDN** | PROD-101, M1.4 | Distribution | Medium | npm fallback |
| **GitHub Pages** | M1.4 | Hosting | Medium | Local cache |
| **VS Code Marketplace** | M2.4 | Distribution | Medium | Direct install |

### 6.2 External Service Dependency Diagram

```mermaid
graph TB
    subgraph External[External Services]
        GH[GitHub API]
        npm[npm Registry]
        SMP[SkillsMP]
        CPD[claude-plugins.dev]
        MCP[mcp.so]
        CDN[jsDelivr CDN]
        GHP[GitHub Pages]
        VSM[VS Code Marketplace]
    end

    subgraph Internal[Internal Components]
        Sync[Sync Pipeline]
        Index[Skill Index]
        Web[Web Browser]
        VSC[VS Code Ext]
        Package[npm Package]
    end

    GH -->|5K req/hr| Sync
    npm -->|60 req/min| Sync
    SMP -->|10 req/min| Sync
    CPD -->|10 req/min| Sync
    MCP -->|100 req/hr| Sync

    Sync --> Index
    Index --> CDN
    CDN --> Package
    CDN --> Web

    Package --> npm
    Web --> GHP
    VSC --> VSM
```

### 6.3 Rate Limit Dependencies

| Source | Rate Limit | Token Rotation | Backoff Strategy |
|--------|-----------|----------------|------------------|
| GitHub REST API | 5,000/hr (authenticated) | Yes (3 tokens) | Exponential |
| GitHub Events API | 300/hr | No | Linear |
| npm Registry | 60/min | No | Linear |
| SkillsMP | ~10/min (estimated) | No | Exponential |
| claude-plugins.dev | ~10/min (estimated) | No | Exponential |
| mcp.so | 100/hr | No | Linear |

---

## 7. Implementation Sequence Diagram

### 7.1 Recommended Implementation Order

```mermaid
gantt
    title Implementation Sequence
    dateFormat  YYYY-MM-DD
    axisFormat  %m/%d

    section Phase 0: Data
    DA-001: Database Foundation    :da001, 2026-01-01, 2w
    DA-002: Caching Layer          :da002, after da001, 1w

    section Phase 0: Backend
    TA-001: MCP Server Foundation  :ta001, after da001, 1w
    TA-002: Search Service POC     :ta002, after da002, 1w

    section Phase 0: Product
    PROD-001: Basic Search         :prod001, after ta002, 1w
    PROD-002: Skill Detail         :prod002, after prod001, 3d
    PROD-003: Install Command      :prod003, after prod002, 3d

    section Phase 0: Security
    SEC-001: Telemetry             :sec001, 2026-01-01, 1w
    SEC-003: Trust Display         :sec003, 2026-01-01, 3d

    section Phase 1: Data
    DA-003: Sync Infrastructure    :da003, after da002, 2w
    DA-004: Quality Scoring        :da004, after da003, 1w

    section Phase 1: Security
    SEC-101: Jailbreak Detection   :sec101, 2026-01-29, 1w
    SEC-102: URL Analysis          :sec102, 2026-01-29, 1w
    SEC-107: Trust Computation     :sec107, after sec101, 1w

    section Phase 1: Product
    PROD-101: 50K Index            :prod101, after da003, 2w
    PROD-106: Trust Tiers          :prod106, after sec107, 1w
    M1.4: Web Browser              :m14, after prod101, 2w

    section Phase 2: Data
    DA-005: Semantic Search        :da005, after da003, 2w

    section Phase 2: Product
    PROD-201: Codebase Scanner     :prod201, after prod101, 2w
    PROD-202: Tech Detection       :prod202, after prod201, 1w
    PROD-203: Recommendations      :prod203, after prod202, 1w
    M2.4: VS Code Extension        :m24, after m14, 2w
```

### 7.2 Parallel Work Streams

```mermaid
graph TB
    subgraph Stream1[Stream 1: Data Foundation]
        S1A[DA-001: Database]
        S1B[DA-002: Caching]
        S1C[DA-003: Sync]
        S1D[DA-004: Scoring]
        S1E[DA-005: Embeddings]
    end

    subgraph Stream2[Stream 2: Security]
        S2A[SEC-001: Telemetry]
        S2B[SEC-101-104: Static Analysis]
        S2C[SEC-107: Trust Computation]
        S2D[SEC-201-203: Conflicts]
    end

    subgraph Stream3[Stream 3: Backend/MCP]
        S3A[TA-001: MCP Foundation]
        S3B[TA-002: Search POC]
        S3C[PROD-110: CLI]
    end

    subgraph Stream4[Stream 4: Product/UX]
        S4A[PROD-001-003: Basic Discovery]
        S4B[PROD-101: Full Index]
        S4C[M1.4: Web Browser]
        S4D[M2.4: VS Code]
    end

    S1A --> S1B --> S1C --> S1D --> S1E
    S2A --> S2B --> S2C --> S2D
    S3A --> S3B --> S3C
    S4A --> S4B --> S4C --> S4D

    S1A -.-> S3A
    S1B -.-> S3B
    S2C -.-> S4B
    S1E -.-> S4B
```

### 7.3 Milestone Dependencies

```mermaid
graph LR
    subgraph Phase0[Phase 0]
        M01[M0.1: Setup]
        M02[M0.2: Data POC]
        M03[M0.3: MCP POC]
        M04[M0.4: Search MVP]
        M05[M0.5: Install MVP]
        M06[M0.6: Validation]
    end

    subgraph Phase1[Phase 1]
        M11[M1.1: Full Index]
        M12[M1.2: Static Analysis]
        M13[M1.3: Trust Tiers]
        M14[M1.4: Web Browser]
    end

    subgraph Phase2[Phase 2]
        M21[M2.1: Scanner]
        M22[M2.2: Recommend]
        M23[M2.3: Conflicts]
        M24[M2.4: VS Code]
    end

    M01 --> M02 --> M03 --> M04 --> M05 --> M06
    M06 --> M11
    M11 --> M12
    M11 --> M13
    M11 --> M14
    M12 --> M13

    M11 --> M21
    M21 --> M22
    M22 --> M24
    M13 --> M22
    M14 --> M24

    linkStyle 0,1,2,3,4,5 stroke:#ff0000,stroke-width:3px
```

---

## 8. Risk Dependencies

### 8.1 Components Where Delays Cascade

| Component | Downstream Impact | Cascade Severity | Mitigation |
|-----------|------------------|------------------|------------|
| **DA-001: Database Foundation** | Blocks all data operations, MCP servers, search, sync | Critical | Prioritize first, allocate senior dev |
| **DA-003: Sync Infrastructure** | Blocks full index, quality scores, recommendations | High | Start early, parallel source adapters |
| **SEC-107: Trust Computation** | Blocks trust tier display, install warnings | High | Can use mock tiers initially |
| **PROD-101: 50K Index** | Blocks web browser, VS Code, recommendations | High | MVP with 10K first |
| **PROD-201: Codebase Scanner** | Blocks recommendations, VS Code suggestions | Medium | Stub recommendations initially |

### 8.2 Risk Dependency Diagram

```mermaid
graph TB
    subgraph HighRisk[High Cascade Risk]
        DA001[DA-001: Database<br/>CRITICAL]
        DA003[DA-003: Sync<br/>HIGH]
        SEC107[SEC-107: Trust<br/>HIGH]
        PROD101[PROD-101: Index<br/>HIGH]
    end

    subgraph MediumRisk[Medium Cascade Risk]
        PROD201[PROD-201: Scanner<br/>MEDIUM]
        SEC105[SEC-105: Typosquat<br/>MEDIUM]
        M14[M1.4: Web<br/>MEDIUM]
    end

    subgraph Downstream[Downstream Components]
        MCP[MCP Servers]
        Search[Search Service]
        Recommend[Recommendations]
        VSCode[VS Code Ext]
        Trust[Trust Display]
    end

    DA001 ==>|Critical| MCP
    DA001 ==>|Critical| Search
    DA003 ==>|High| PROD101
    DA003 ==>|High| Recommend
    SEC107 ==>|High| Trust
    PROD101 ==>|High| M14
    PROD101 ==>|High| Recommend
    PROD201 -->|Medium| Recommend
    PROD201 -->|Medium| VSCode
    M14 -->|Medium| VSCode

    style DA001 fill:#ff6b6b
    style DA003 fill:#ffa94d
    style SEC107 fill:#ffa94d
    style PROD101 fill:#ffa94d
    style PROD201 fill:#ffe066
```

### 8.3 External Service Risk Dependencies

| External Service | Risk Level | Components Affected | Mitigation Strategy |
|-----------------|------------|---------------------|---------------------|
| GitHub API | High | Sync, Index, Quality Scores | Token rotation, caching, Events API |
| GitHub Pages | Medium | Web Browser | Vercel fallback ready |
| npm Registry | Medium | Package distribution | GitHub Releases backup |
| jsDelivr CDN | Low | Index distribution | Multiple CDN fallbacks |
| VS Code Marketplace | Low | Extension distribution | Direct download option |
| Aggregators (3) | Low | Skill coverage | Multiple sources, graceful degradation |

---

## 9. Quick Reference

### 9.1 Phase 0 Critical Dependencies

```
DA-001 --> DA-002 --> TA-002 --> PROD-001 --> PROD-002 --> PROD-003
   |
   +--> TA-001 --> PROD-006 --> PROD-007
   |
   +--> PROD-005

SEC-001 --> SEC-002 --> SEC-004
SEC-003 (independent)
```

### 9.2 Phase 1 Critical Dependencies

```
DA-003 --> DA-004 --> PROD-104
   |
   +--> PROD-101 --> PROD-102, PROD-103, PROD-111

SEC-101 --|
SEC-102 --+--> SEC-107 --> PROD-106
SEC-103 --|

SEC-105 --> PROD-109
SEC-106 --> PROD-108
```

### 9.3 Phase 2 Critical Dependencies

```
DA-005 --> PROD-203
PROD-101 --> PROD-201 --> PROD-202 --> PROD-203
                |
                +--> PROD-208 --> PROD-209

PROD-101 --> PROD-206 --> PROD-207

SEC-201 --|
SEC-202 --+--> SEC-203 --> PROD-205

SEC-204 --> SEC-205
```

### 9.4 Team Assignment by Dependency Chain

| Chain | Primary Owner | Support |
|-------|---------------|---------|
| Data Pipeline: DA-001 to DA-005 | Data Architect | Backend Specialist |
| MCP/Backend: TA-001, TA-002, Services | Backend Specialist | Eng Lead |
| Security: SEC-101 to SEC-205 | Security Specialist | Eng Lead |
| Product Search: PROD-001 to PROD-111 | Backend Specialist | Frontend |
| Product UX: PROD-201 to PROD-212 | Frontend Specialist | PM |
| Web/IDE: M1.4, M2.4 | Frontend Specialist | Backend |

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [System Overview](/docs/architecture/system-overview.md) | Architecture source of truth |
| [Data Architecture](/docs/implementation/02-data-architecture.md) | Data layer epics and stories |
| [Security Implementation](/docs/implementation/06-security.md) | Security epics and stories |
| [Product Requirements](/docs/implementation/08-product-requirements.md) | Product epics and stories |
| [Milestones & Sprints](/docs/implementation/09-milestones-sprints.md) | Sprint structure and milestones |
| [MCP Tool Specs](/docs/implementation/artifacts/mcp-tool-specs.md) | Tool interface definitions |
| [Data Schema](/docs/implementation/artifacts/data-schema.md) | Database schema reference |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | Systems Architect | Initial dependency map |

---

*This document should be updated when:*
- *New epics or stories are added*
- *Dependencies change during implementation*
- *External service integrations change*
- *Phase boundaries are adjusted*

*Next Review: After Phase 0 Gate Decision (Week 8)*
