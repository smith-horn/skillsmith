# Backend/API Architecture

> **Navigation**: [Technical Overview](../technical/overview.md) | [MCP Servers](../technical/components/mcp-servers.md) | [API Design](../technical/api/index.md)

**Version:** 1.0
**Last Updated:** December 26, 2025
**Author:** Backend/API Architect
**Status:** Design Document (No Implementation)

---

## Executive Summary

This document defines the Backend/API architecture for Claude Discovery Hub, a Git-native skill discovery system. The architecture is designed around three core principles derived from research:

1. **Sub-2-second discovery latency** (behavioral research: 23-min context switch recovery)
2. **Local-first with optional sync** (privacy, offline capability, user control)
3. **MCP Protocol as the API layer** (native Claude Code integration)

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| API Protocol | MCP (Model Context Protocol) | Native Claude Code integration |
| Primary Storage | SQLite with FTS5 | Portable, offline-capable, no dependencies |
| Server Count | 3 consolidated MCP servers | Balance between separation and overhead |
| Inter-Service Communication | Shared filesystem | Simple, no IPC complexity |
| Caching | Multi-tier (memory + SQLite + file) | Meet <200ms cached latency target |

---

## 1. MCP Server Architecture

### 1.1 Server Topology

The system uses 3 MCP servers, consolidated from an original 6-server design based on VP Engineering feedback to reduce startup overhead and memory footprint.

```
+===========================================================================+
|                        MCP SERVER TOPOLOGY                                 |
+===========================================================================+

    +------------------+     +------------------+     +------------------+
    |  discovery-core  |     |     learning     |     |      sync        |
    |                  |     |                  |     |                  |
    |  Port: Dynamic   |     |  Port: Dynamic   |     |  Port: Dynamic   |
    |  Memory: <150MB  |     |  Memory: <50MB   |     |  Memory: <100MB  |
    |  Startup: <1.5s  |     |  Startup: <0.5s  |     |  Startup: <0.5s  |
    +------------------+     +------------------+     +------------------+
           |                        |                        |
           |                        |                        |
           v                        v                        v
    +==================================================================+
    |                    SHARED STORAGE LAYER                          |
    |   ~/.claude-discovery/                                           |
    |   +-- index/skills.db (SQLite WAL mode)                          |
    |   +-- index/embeddings.bin (memory-mapped)                       |
    |   +-- cache/ (file-level locking)                                |
    |   +-- config/ (user preferences)                                 |
    +==================================================================+
```

### 1.2 Server Responsibilities

#### discovery-core (Primary Server)

**Purpose:** All skill discovery, analysis, installation, and auditing operations.

**Bounded Context:**
- Skill search and retrieval
- Codebase analysis and stack detection
- Recommendation generation
- Installation orchestration
- Conflict detection
- Activation auditing

**Tool Count:** 12 tools
**Startup Budget:** 1.5 seconds
**Memory Budget:** 150MB

```
+------------------------------------------------------------------------+
|                    DISCOVERY-CORE INTERNAL ARCHITECTURE                 |
+------------------------------------------------------------------------+

                          +-------------------+
                          |   MCP Interface   |
                          | (Tool Handlers)   |
                          +-------------------+
                                   |
         +-------------------------+-------------------------+
         |                         |                         |
         v                         v                         v
+----------------+      +-------------------+      +------------------+
| Search Service |      | Analysis Service  |      | Install Service  |
+----------------+      +-------------------+      +------------------+
| - FTS5 queries |      | - Stack detection |      | - Conflict check |
| - Embedding    |      | - Gap analysis    |      | - Security scan  |
|   similarity   |      | - Recommendations |      | - File copy      |
| - Result rank  |      |                   |      | - Post-install   |
+----------------+      +-------------------+      +------------------+
         |                         |                         |
         +-------------------------+-------------------------+
                                   |
                          +-------------------+
                          |   Data Access     |
                          |   Layer (DAL)     |
                          +-------------------+
                                   |
                    +--------------+--------------+
                    |              |              |
                    v              v              v
              +----------+   +----------+   +----------+
              | SQLite   |   | Embed-   |   | Cache    |
              | skills.db|   | dings    |   | Manager  |
              +----------+   +----------+   +----------+
```

**Internal Service Boundaries:**

| Service | Responsibility | Dependencies |
|---------|---------------|--------------|
| SearchService | FTS5 queries, embedding similarity, ranking | DAL, EmbeddingStore |
| AnalysisService | Codebase scanning, stack detection, recommendations | DAL, SearchService |
| InstallService | Conflict check, security scan, file operations | DAL, SecurityScanner |
| AuditService | Frontmatter validation, budget estimation, diagnostics | DAL, InstalledSkillsManager |
| ConflictService | Trigger overlap, behavioral conflict detection | DAL, InstalledSkillsManager |

#### learning (Secondary Server)

**Purpose:** Educational content, exercises, and progress tracking.

**Bounded Context:**
- Learning path management
- Exercise delivery
- Solution validation
- Progress persistence

**Tool Count:** 6 tools
**Startup Budget:** 0.5 seconds
**Memory Budget:** 50MB

```
+------------------------------------------------------------------------+
|                    LEARNING SERVER ARCHITECTURE                         |
+------------------------------------------------------------------------+

                          +-------------------+
                          |   MCP Interface   |
                          +-------------------+
                                   |
                    +--------------+--------------+
                    |                             |
                    v                             v
           +----------------+            +------------------+
           | Content Service|            | Progress Service |
           +----------------+            +------------------+
           | - Path loading |            | - State tracking |
           | - Exercise mgmt|            | - Validation     |
           | - Hint system  |            | - Achievements   |
           +----------------+            +------------------+
                    |                             |
                    +--------------+--------------+
                                   |
                          +-------------------+
                          | File System Store |
                          | (Markdown-based)  |
                          +-------------------+
```

#### sync (Background Server)

**Purpose:** Background synchronization and index updates.

**Bounded Context:**
- Index refresh orchestration
- External API integration
- Blocklist management
- Update detection

**Tool Count:** 5 tools
**Startup Budget:** 0.5 seconds
**Memory Budget:** 100MB

```
+------------------------------------------------------------------------+
|                    SYNC SERVER ARCHITECTURE                             |
+------------------------------------------------------------------------+

                          +-------------------+
                          |   MCP Interface   |
                          +-------------------+
                                   |
         +-------------------------+-------------------------+
         |                         |                         |
         v                         v                         v
+----------------+      +-------------------+      +------------------+
| GitHub Sync    |      | Aggregator Sync   |      | Blocklist Sync   |
+----------------+      +-------------------+      +------------------+
| - Rate limit   |      | - SkillsMP        |      | - Community      |
|   management   |      | - claude-plugins  |      |   blocklist      |
| - Incremental  |      | - mcp.so          |      | - Security feed  |
|   updates      |      |                   |      |                  |
+----------------+      +-------------------+      +------------------+
         |                         |                         |
         +-------------------------+-------------------------+
                                   |
                          +-------------------+
                          |    Index Writer   |
                          | (Exclusive Write) |
                          +-------------------+
                                   |
                          +-------------------+
                          |    skills.db      |
                          |   (WAL Mode)      |
                          +-------------------+
```

### 1.3 Server Lifecycle Management

```
+------------------------------------------------------------------------+
|                    SERVER LIFECYCLE                                     |
+------------------------------------------------------------------------+

  Claude Code Start
         |
         v
  +----------------+
  | Load settings  |
  | from config    |
  +----------------+
         |
         v
  +----------------+     +------------------+     +------------------+
  | Start          |     | Start            |     | Start            |
  | discovery-core |---->| learning         |---->| sync             |
  | (blocking)     |     | (async)          |     | (background)     |
  +----------------+     +------------------+     +------------------+
         |                        |                        |
         v                        v                        v
  +----------------+     +------------------+     +------------------+
  | Ready for      |     | Ready for        |     | Check for        |
  | discovery      |     | learning         |     | updates          |
  | requests       |     | requests         |     | (scheduled)      |
  +----------------+     +------------------+     +------------------+
```

**Startup Sequence:**

1. **discovery-core** starts first (blocking) - required for basic functionality
2. **learning** starts asynchronously - not needed immediately
3. **sync** starts in background - checks for updates after 30-second delay

**Shutdown Sequence:**

1. Complete in-flight requests (5-second timeout)
2. Flush any pending writes
3. Release file locks
4. Exit cleanly

### 1.4 Server Communication Patterns

Servers do NOT communicate directly. All coordination happens through shared storage:

```
+------------------------------------------------------------------------+
|                    INTER-SERVER COORDINATION                            |
+------------------------------------------------------------------------+

Pattern 1: Shared Data (Read After Write)
------------------------------------------

   sync                         discovery-core
     |                                |
     | [Write new skills to DB]       |
     v                                |
  +--------+                          |
  |skills.db                          |
  +--------+                          |
     |                                |
     | [WAL checkpoint]               |
     v                                |
     |<-------------------------------+
     |    [Read updated skills]       |


Pattern 2: Cache Invalidation
-----------------------------

   sync                         discovery-core
     |                                |
     | [Update index]                 |
     v                                |
  +--------+                          |
  |cache/  |  [Write invalidation     |
  |invalid |   marker file]           |
  +--------+                          |
     |                                |
     |<-------------------------------+
     |    [Check marker, clear cache] |


Pattern 3: Lock Coordination
----------------------------

   discovery-core               sync
     |                           |
     | [Read lock]               |
     v                           |
  +--------+                     |
  |skills.db                     |
  |[SHARED]|                     |
  +--------+                     |
     |                           |
     |                           | [Write lock request]
     |                           v
     |                     [Wait for read lock release]
     |                           |
     | [Release read lock]       |
     v                           v
  +--------+                     |
  |skills.db                     |
  |[EXCLUSIVE]|<-----------------+
  +--------+
```

---

## 2. API Design

### 2.1 Request/Response Patterns

All MCP tools follow a consistent request/response pattern:

```
+------------------------------------------------------------------------+
|                    MCP REQUEST/RESPONSE FLOW                            |
+------------------------------------------------------------------------+

  Claude Code                MCP Server              Backend Services
       |                          |                        |
       | [Tool Call]              |                        |
       | {                        |                        |
       |   name: "search",        |                        |
       |   parameters: {...}      |                        |
       | }                        |                        |
       |------------------------->|                        |
       |                          |                        |
       |                          | [Validate params]      |
       |                          |----------------------->|
       |                          |                        |
       |                          | [Execute query]        |
       |                          |<-----------------------|
       |                          |                        |
       |                          | [Format response]      |
       |                          |                        |
       | [Response]               |                        |
       | {                        |                        |
       |   success: true,         |                        |
       |   data: {...},           |                        |
       |   metadata: {...}        |                        |
       | }                        |                        |
       |<-------------------------|                        |
```

### 2.2 Tool Interface Contracts

#### Core Discovery Tools

```typescript
// ============================================================
// SEARCH TOOL
// ============================================================
interface SearchTool {
  name: 'search';

  input: {
    query: string;                    // Required: search query
    filters?: {
      categories?: string[];          // e.g., ["testing", "documentation"]
      technologies?: string[];        // e.g., ["react", "typescript"]
      trust_tier?: TrustTier[];       // ["official", "verified", "community"]
      min_score?: number;             // 0.0 - 1.0
      source?: string[];              // ["github", "skillsmp", "mcp.so"]
      updated_after?: string;         // ISO date
    };
    sort?: {
      field: 'relevance' | 'score' | 'stars' | 'updated';
      direction: 'asc' | 'desc';
    };
    limit?: number;                   // Default: 10, Max: 50
    offset?: number;                  // For pagination
  };

  output: {
    success: true;
    data: {
      results: SkillSummary[];
      total: number;
      has_more: boolean;
      query_analysis: {
        interpreted_query: string;
        detected_intent: string;
        suggested_refinements: string[];
      };
    };
    metadata: {
      cached: boolean;
      cache_age_seconds?: number;
      execution_time_ms: number;
      index_version: string;
    };
  };
}

// ============================================================
// ANALYZE CODEBASE TOOL
// ============================================================
interface AnalyzeCodebaseTool {
  name: 'analyze_codebase';

  input: {
    path?: string;                    // Default: current directory
    depth?: number;                   // Default: 3, Max: 10
    include_dependencies?: boolean;   // Analyze package.json, etc.
    quick_mode?: boolean;             // Faster but less accurate
  };

  output: {
    success: true;
    data: {
      path: string;
      scanned_at: string;
      stack: TechStackItem[];
      project_info: ProjectInfo;
      stats: ScanStats;
      confidence_level: 'high' | 'medium' | 'low';
    };
    metadata: {
      execution_time_ms: number;
      files_analyzed: number;
    };
  };
}

// ============================================================
// RECOMMEND SKILLS TOOL
// ============================================================
interface RecommendSkillsTool {
  name: 'recommend_skills';

  input: {
    path?: string;                    // Default: current directory
    max_results?: number;             // Default: 10
    include_reasons?: boolean;        // Default: true
    exclude_installed?: boolean;      // Default: true
    discovery_mode?: 'conservative' | 'exploratory';
  };

  output: {
    success: true;
    data: {
      recommendations: Recommendation[];
      analysis_summary: string;
      gaps_identified: SkillGap[];
      installed_coverage: number;      // 0.0 - 1.0
    };
    metadata: {
      cached: boolean;
      execution_time_ms: number;
    };
  };
}

// ============================================================
// INSTALL SKILL TOOL
// ============================================================
interface InstallSkillTool {
  name: 'install_skill';

  input: {
    skill_id: string;
    skip_conflict_check?: boolean;    // Default: false
    skip_security_scan?: boolean;     // Default: false
    force?: boolean;                  // Override warnings
    target_directory?: string;        // Custom install location
  };

  output: {
    success: boolean;
    data: {
      skill_id: string;
      installed_path: string;
      install_method: 'copy' | 'symlink' | 'plugin';

      // Pre-install checks
      conflicts?: Conflict[];
      security_warnings?: SecurityWarning[];
      budget_impact?: BudgetImpact;

      // Post-install guidance
      activation_tips: string[];
      suggested_hooks?: HookConfig;
    };
    metadata: {
      execution_time_ms: number;
    };
  };
}

// ============================================================
// AUDIT ACTIVATION TOOL
// ============================================================
interface AuditActivationTool {
  name: 'audit_activation';

  input: {
    skill_id?: string;                // Specific skill or all if omitted
    generate_hooks?: boolean;         // Generate activation hooks
    include_recommendations?: boolean;// Include fix recommendations
  };

  output: {
    success: true;
    data: {
      summary: AuditSummary;
      issues: AuditIssue[];
      warnings: AuditWarning[];
      recommendations: string[];
      generated_hooks?: HookConfig;
      budget_report: BudgetReport;
    };
    metadata: {
      execution_time_ms: number;
      skills_audited: number;
    };
  };
}
```

### 2.3 Internal API Boundaries

```
+------------------------------------------------------------------------+
|                    INTERNAL API LAYER DIAGRAM                           |
+------------------------------------------------------------------------+

    +------------------------------------------------------------------+
    |                      MCP TOOL LAYER                               |
    |  (Public Interface - Exposed to Claude Code)                      |
    +------------------------------------------------------------------+
                                    |
                                    v
    +------------------------------------------------------------------+
    |                      SERVICE LAYER                                |
    |  (Business Logic - Internal Only)                                 |
    +------------------------------------------------------------------+
    |                                                                   |
    |  +---------------+  +---------------+  +---------------+          |
    |  | SearchService |  | InstallService|  | AuditService  |          |
    |  +---------------+  +---------------+  +---------------+          |
    |         |                  |                  |                   |
    |         v                  v                  v                   |
    |  +----------------------------------------------------------+    |
    |  |                    DOMAIN LAYER                          |    |
    |  |  (Core Business Objects)                                 |    |
    |  +----------------------------------------------------------+    |
    |  | Skill | Recommendation | Conflict | AuditResult | Budget |    |
    |  +----------------------------------------------------------+    |
    |                                                                   |
    +------------------------------------------------------------------+
                                    |
                                    v
    +------------------------------------------------------------------+
    |                    DATA ACCESS LAYER                              |
    |  (Database & External APIs)                                       |
    +------------------------------------------------------------------+
    |                                                                   |
    |  +---------------+  +---------------+  +---------------+          |
    |  | SkillRepo     |  | CacheRepo     |  | GitHubClient  |          |
    |  +---------------+  +---------------+  +---------------+          |
    |                                                                   |
    +------------------------------------------------------------------+
                                    |
                                    v
    +------------------------------------------------------------------+
    |                    INFRASTRUCTURE LAYER                           |
    |  (SQLite, File System, HTTP)                                      |
    +------------------------------------------------------------------+
```

### 2.4 External API Contracts

The system integrates with external services through adapters:

```typescript
// ============================================================
// GITHUB API ADAPTER
// ============================================================
interface GitHubApiAdapter {
  // Repository metadata
  getRepository(owner: string, repo: string): Promise<RepoInfo>;

  // Search repositories
  searchRepositories(query: string, options: SearchOptions): Promise<RepoSearchResult>;

  // Rate limit awareness
  getRateLimitStatus(): Promise<RateLimitInfo>;

  // Webhook for real-time updates (future)
  // subscribeToUpdates(repos: string[], callback: UpdateCallback): Subscription;
}

// Rate limiting configuration
interface RateLimitConfig {
  requests_per_hour: 5000;            // Authenticated limit
  min_remaining_buffer: 100;          // Don't exhaust completely
  backoff_strategy: ExponentialBackoff;
}

// ============================================================
// AGGREGATOR ADAPTERS
// ============================================================
interface SkillsMPAdapter {
  search(query: string): Promise<SkillsMPResult[]>;
  getSkill(id: string): Promise<SkillsMPDetail>;
  getUpdatedSince(timestamp: string): Promise<SkillsMPResult[]>;
}

interface ClaudePluginsAdapter {
  scrapeIndex(): Promise<PluginInfo[]>;
  scrapeDetail(url: string): Promise<PluginDetail>;
  getLastScrapedAt(): Promise<string>;
}

interface McpSoAdapter {
  listServers(page: number): Promise<McpServer[]>;
  getServer(id: string): Promise<McpServerDetail>;
  getCategories(): Promise<Category[]>;
}
```

### 2.5 Error Handling Architecture

```
+------------------------------------------------------------------------+
|                    ERROR HANDLING FLOW                                  |
+------------------------------------------------------------------------+

  Error Occurs
       |
       v
  +----------------+
  | Classify Error |
  +----------------+
       |
       +---> Retriable?
       |        |
       |        +---> Yes: Apply retry policy
       |        |          |
       |        |          +---> Success: Return result
       |        |          |
       |        |          +---> Exhausted: Continue to fallback
       |        |
       |        +---> No: Continue to fallback
       |
       v
  +----------------+
  | Apply Fallback |
  +----------------+
       |
       +---> Cache available?
       |        |
       |        +---> Yes: Return cached (with stale warning)
       |        |
       |        +---> No: Continue
       |
       +---> Degraded mode available?
       |        |
       |        +---> Yes: Return partial result
       |        |
       |        +---> No: Return error
       |
       v
  +----------------+
  | Format Error   |
  | Response       |
  +----------------+
       |
       v
  +----------------------------------+
  | {                                |
  |   success: false,                |
  |   error: {                       |
  |     code: "SPECIFIC_ERROR_CODE", |
  |     message: "Human readable",   |
  |     details: {...},              |
  |     recovery_suggestions: [...]  |
  |   }                              |
  | }                                |
  +----------------------------------+
```

**Error Classification Matrix:**

| Error Type | Retriable | Fallback | User Action |
|------------|-----------|----------|-------------|
| Network timeout | Yes (3x) | Cache | Wait and retry |
| Rate limit | Yes (delay) | Cache | Wait for reset |
| Database locked | Yes (3x) | None | Auto-recovers |
| Invalid parameter | No | None | Fix parameter |
| Skill not found | No | Suggestions | Search again |
| Security blocked | No | None | Choose different |
| Internal error | No | None | Report bug |

---

## 3. Service Layer Architecture

### 3.1 Service Boundaries

```
+------------------------------------------------------------------------+
|                    SERVICE BOUNDARY DIAGRAM                             |
+------------------------------------------------------------------------+

+---------------------------+     +---------------------------+
|    DISCOVERY CONTEXT      |     |     LEARNING CONTEXT      |
+---------------------------+     +---------------------------+
|                           |     |                           |
|  +-------------------+    |     |  +-------------------+    |
|  | SearchService     |    |     |  | PathService       |    |
|  +-------------------+    |     |  +-------------------+    |
|  | - Query parsing   |    |     |  | - Path loading    |    |
|  | - FTS5 execution  |    |     |  | - Progress calc   |    |
|  | - Ranking         |    |     |  +-------------------+    |
|  +-------------------+    |     |                           |
|           |               |     |  +-------------------+    |
|           v               |     |  | ExerciseService   |    |
|  +-------------------+    |     |  +-------------------+    |
|  | RecommendService  |    |     |  | - Content serve   |    |
|  +-------------------+    |     |  | - Validation      |    |
|  | - Gap analysis    |    |     |  | - Hints           |    |
|  | - Scoring         |    |     |  +-------------------+    |
|  | - Ranking         |    |     |                           |
|  +-------------------+    |     +---------------------------+
|           |               |
|           v               |     +---------------------------+
|  +-------------------+    |     |      SYNC CONTEXT         |
|  | InstallService    |    |     +---------------------------+
|  +-------------------+    |     |                           |
|  | - Conflict check  |    |     |  +-------------------+    |
|  | - Security scan   |    |     |  | IndexSyncService  |    |
|  | - File operations |    |     |  +-------------------+    |
|  +-------------------+    |     |  | - Source adapters |    |
|           |               |     |  | - Delta detection |    |
|           v               |     |  | - Merge strategy  |    |
|  +-------------------+    |     |  +-------------------+    |
|  | AuditService      |    |     |           |               |
|  +-------------------+    |     |           v               |
|  | - YAML validation |    |     |  +-------------------+    |
|  | - Budget calc     |    |     |  | BlocklistService  |    |
|  | - Hook generation |    |     |  +-------------------+    |
|  +-------------------+    |     |  | - Security feed   |    |
|                           |     |  | - Community list  |    |
+---------------------------+     |  +-------------------+    |
                                  |                           |
                                  +---------------------------+
```

### 3.2 Service Dependencies

```typescript
// ============================================================
// DEPENDENCY INJECTION STRUCTURE
// ============================================================

interface ServiceContainer {
  // Core repositories
  skillRepo: SkillRepository;
  cacheRepo: CacheRepository;
  configRepo: ConfigRepository;

  // External adapters
  githubClient: GitHubApiAdapter;
  skillsMPAdapter: SkillsMPAdapter;
  claudePluginsAdapter: ClaudePluginsAdapter;

  // Core services
  searchService: SearchService;
  recommendService: RecommendService;
  installService: InstallService;
  auditService: AuditService;

  // Sync services
  indexSyncService: IndexSyncService;
  blocklistService: BlocklistService;
}

// ============================================================
// SERVICE DEPENDENCY GRAPH
// ============================================================

class SearchService {
  constructor(
    private skillRepo: SkillRepository,
    private embeddingStore: EmbeddingStore,
    private cacheRepo: CacheRepository
  ) {}
}

class RecommendService {
  constructor(
    private searchService: SearchService,      // Depends on SearchService
    private skillRepo: SkillRepository,
    private codebaseScanner: CodebaseScanner
  ) {}
}

class InstallService {
  constructor(
    private skillRepo: SkillRepository,
    private conflictDetector: ConflictDetector,
    private securityScanner: SecurityScanner,
    private fileSystem: FileSystemAdapter
  ) {}
}

class AuditService {
  constructor(
    private skillRepo: SkillRepository,
    private frontmatterValidator: FrontmatterValidator,
    private budgetCalculator: BudgetCalculator,
    private hookGenerator: HookGenerator
  ) {}
}
```

### 3.3 Business Logic Organization

```
+------------------------------------------------------------------------+
|                    BUSINESS LOGIC MODULES                               |
+------------------------------------------------------------------------+

src/
+-- domain/
|   +-- skill/
|   |   +-- Skill.ts                 # Skill entity
|   |   +-- SkillScore.ts            # Score value object
|   |   +-- TrustTier.ts             # Trust level enum
|   |   +-- SkillCategory.ts         # Category classification
|   |
|   +-- recommendation/
|   |   +-- Recommendation.ts        # Recommendation entity
|   |   +-- MatchScore.ts            # Relevance scoring
|   |   +-- Gap.ts                   # Skill gap entity
|   |
|   +-- conflict/
|   |   +-- Conflict.ts              # Conflict entity
|   |   +-- TriggerOverlap.ts        # Trigger analysis
|   |   +-- ConflictResolution.ts    # Resolution options
|   |
|   +-- audit/
|       +-- AuditResult.ts           # Audit findings
|       +-- BudgetReport.ts          # Budget analysis
|       +-- ValidationError.ts       # YAML validation
|
+-- services/
|   +-- search/
|   |   +-- SearchService.ts         # Main search logic
|   |   +-- QueryParser.ts           # Query interpretation
|   |   +-- ResultRanker.ts          # Result ordering
|   |   +-- SearchCache.ts           # Search-specific caching
|   |
|   +-- recommend/
|   |   +-- RecommendService.ts      # Recommendation logic
|   |   +-- CodebaseScanner.ts       # Stack detection
|   |   +-- GapAnalyzer.ts           # Gap identification
|   |   +-- RecommendationRanker.ts  # Ranking algorithm
|   |
|   +-- install/
|   |   +-- InstallService.ts        # Installation orchestration
|   |   +-- ConflictDetector.ts      # Conflict analysis
|   |   +-- SecurityScanner.ts       # Security checks
|   |   +-- SkillInstaller.ts        # File operations
|   |
|   +-- audit/
|       +-- AuditService.ts          # Audit orchestration
|       +-- FrontmatterValidator.ts  # YAML validation
|       +-- BudgetCalculator.ts      # Character budget
|       +-- HookGenerator.ts         # Activation hooks
|
+-- repositories/
|   +-- SkillRepository.ts           # Skill data access
|   +-- CacheRepository.ts           # Cache management
|   +-- ConfigRepository.ts          # User preferences
|   +-- InteractionRepository.ts     # Usage tracking
|
+-- adapters/
    +-- github/
    |   +-- GitHubApiAdapter.ts      # GitHub REST API
    |   +-- RateLimiter.ts           # Rate limit handling
    |
    +-- aggregators/
        +-- SkillsMPAdapter.ts       # SkillsMP integration
        +-- ClaudePluginsAdapter.ts  # claude-plugins.dev
        +-- McpSoAdapter.ts          # mcp.so integration
```

### 3.4 Transaction Boundaries

```
+------------------------------------------------------------------------+
|                    TRANSACTION PATTERNS                                 |
+------------------------------------------------------------------------+

Pattern 1: Read-Only Operations (Search, Get)
---------------------------------------------

  SearchService.search(query)
       |
       v
  +------------------+
  | BEGIN (implicit) |
  +------------------+
       |
       v
  +------------------+
  | SELECT skills    |
  | FROM skills      |
  | WHERE ...        |
  +------------------+
       |
       v
  +------------------+
  | COMMIT (auto)    |
  +------------------+


Pattern 2: Write Operations (Install, Sync)
------------------------------------------

  InstallService.install(skill)
       |
       v
  +------------------+
  | BEGIN IMMEDIATE  |  <-- Acquire write lock early
  +------------------+
       |
       +---> [Conflict check] (read)
       |
       +---> [Security scan] (read external)
       |
       +---> [Copy files] (filesystem)
       |
       +---> [Record installation]
       |           |
       |           v
       |     +------------------+
       |     | INSERT INTO      |
       |     | skill_interactions|
       |     +------------------+
       |
       v
  +------------------+
  | COMMIT           |
  +------------------+
       |
       | On failure:
       +---> ROLLBACK + cleanup files


Pattern 3: Long-Running Operations (Sync)
-----------------------------------------

  IndexSyncService.fullSync()
       |
       v
  +---------------------------+
  | Fetch from sources        |  <-- No transaction (external calls)
  +---------------------------+
       |
       v
  +---------------------------+
  | BEGIN EXCLUSIVE           |  <-- Block all readers temporarily
  +---------------------------+
       |
       v
  +---------------------------+
  | Batch INSERT/UPDATE       |
  | (1000 rows per batch)     |
  +---------------------------+
       |
       v
  +---------------------------+
  | COMMIT                    |
  +---------------------------+
       |
       v
  +---------------------------+
  | Repeat for next batch     |
  +---------------------------+
```

---

## 4. Performance Requirements

### 4.1 Latency Targets

| Operation | Target (p50) | Target (p99) | Max Acceptable |
|-----------|--------------|--------------|----------------|
| Search (cached) | 50ms | 150ms | 200ms |
| Search (uncached) | 200ms | 400ms | 500ms |
| Get skill detail | 30ms | 100ms | 150ms |
| Analyze codebase | 500ms | 2s | 5s |
| Recommend skills | 300ms | 1s | 2s |
| Install skill | 1s | 3s | 5s |
| Audit activation | 200ms | 500ms | 1s |
| Index sync (incr.) | 30s | 60s | 120s |
| Index sync (full) | 5min | 8min | 10min |

### 4.2 Throughput Requirements

```
+------------------------------------------------------------------------+
|                    THROUGHPUT ANALYSIS                                  |
+------------------------------------------------------------------------+

Expected Usage Patterns:
------------------------

  Active Session (1 developer):
  +-- 5-10 search queries per session
  +-- 2-3 get_skill calls per search
  +-- 1-2 analyze_codebase per project
  +-- 1-5 install_skill per week
  +-- 1 audit per install

  Concurrent Users (single machine):
  +-- Typically 1 (single developer)
  +-- Edge case: 2-3 terminal windows

  Required Throughput:
  +-- 10 searches/second (burst)
  +-- 50 get_skill/second (burst)
  +-- 1 analyze_codebase/second (sustained)


SQLite Performance Budget:
-------------------------

  Operation          | Rows/sec | Notes
  -------------------|----------|---------------------------
  FTS5 search        | 1000+    | With proper indexing
  Single row fetch   | 10000+   | By primary key
  Batch insert       | 5000+    | WAL mode, prepared stmt
  Full table scan    | 100+     | 50K rows, avoid in hot path
```

### 4.3 Caching Architecture

```
+------------------------------------------------------------------------+
|                    MULTI-TIER CACHING                                   |
+------------------------------------------------------------------------+

                    +-------------------+
                    |   Request         |
                    +-------------------+
                            |
                            v
                    +-------------------+
                    | L1: Memory Cache  |
                    | (Hot data, 10MB)  |
                    +-------------------+
                            |
                       Hit? |
                     +------+------+
                     |             |
                   Yes            No
                     |             |
                     v             v
               [Return]    +-------------------+
                           | L2: SQLite Cache  |
                           | (Warm, 100MB)     |
                           +-------------------+
                                   |
                              Hit? |
                            +------+------+
                            |             |
                          Yes            No
                            |             |
                            v             v
                      [Return]    +-------------------+
                                  | L3: External API  |
                                  | (Cold, rate limit)|
                                  +-------------------+
                                          |
                                          v
                                  [Fetch & Cache]
```

**Cache Configuration:**

```typescript
interface CacheConfiguration {
  // L1: In-memory cache
  memory: {
    max_size_mb: 10;
    ttl_seconds: 300;              // 5 minutes
    eviction_policy: 'lru';

    // Pre-loaded on startup
    preload: [
      'popular_skills_top_100',
      'category_list',
      'trust_tier_counts',
    ];
  };

  // L2: SQLite-based cache
  sqlite: {
    max_size_mb: 100;
    ttl_hours: {
      search_results: 0.5;         // 30 minutes
      skill_details: 24;           // 1 day
      github_metadata: 1;          // 1 hour
      embeddings: 168;             // 1 week
    };
  };

  // Cache invalidation triggers
  invalidation: {
    on_sync_complete: ['search_results'];
    on_skill_install: ['recommendations'];
    on_config_change: ['all'];
  };
}
```

### 4.4 Performance Optimization Strategies

```
+------------------------------------------------------------------------+
|                    OPTIMIZATION STRATEGIES                              |
+------------------------------------------------------------------------+

1. QUERY OPTIMIZATION
---------------------

  Before: Full-text search with ranking
  +---------------------------------------+
  | SELECT * FROM skills_fts              |
  | WHERE skills_fts MATCH 'react testing'|
  | ORDER BY rank                         |
  +---------------------------------------+
  Time: ~50ms for 50K skills

  After: Hybrid FTS + pre-computed scores
  +---------------------------------------+
  | SELECT s.*, bm25(skills_fts) as rank  |
  | FROM skills_fts                       |
  | JOIN skills s ON s.rowid = skills_fts.rowid |
  | WHERE skills_fts MATCH 'react testing'|
  | ORDER BY (rank * 0.5) + (s.final_score * 0.5) |
  | LIMIT 20                              |
  +---------------------------------------+
  Time: ~30ms (40% improvement)


2. EMBEDDING OPTIMIZATION
-------------------------

  Strategy: Memory-mapped file for embeddings

  +-- Load embeddings.bin as mmap
  +-- Access embeddings by index (O(1))
  +-- No serialization overhead
  +-- OS handles paging

  Memory usage: 200MB virtual, ~50MB resident


3. STARTUP OPTIMIZATION
-----------------------

  Cold start sequence:

  T+0ms:    [Load config]
  T+50ms:   [Open SQLite connection]
  T+100ms:  [Register MCP tools]
  T+150ms:  [Ready for requests]
  T+500ms:  [Background: load embeddings]
  T+1000ms: [Background: cache warm-up]

  Total cold start: 150ms to first request
  Full warm-up: 1000ms


4. BATCH PROCESSING
-------------------

  Sync operation batching:

  Single insert:  5ms per skill
  Batch of 100:   50ms (10x faster)
  Batch of 1000:  200ms (25x faster)

  Max batch size: 1000 (balance memory vs speed)
```

### 4.5 Resource Budgets

```
+------------------------------------------------------------------------+
|                    RESOURCE BUDGET ALLOCATION                           |
+------------------------------------------------------------------------+

MEMORY BUDGET (Total: 300MB)
----------------------------

  Component                    | Budget | Notes
  -----------------------------|--------|---------------------------
  discovery-core server        | 150MB  | Includes FTS5 cache
    +-- SQLite connection      |  20MB  | Page cache
    +-- Memory cache (L1)      |  10MB  | Hot data
    +-- Embeddings             |  50MB  | Resident portion
    +-- Application heap       |  70MB  | Services, buffers
                               |        |
  learning server              |  50MB  |
    +-- Content cache          |  30MB  | Exercise content
    +-- Application heap       |  20MB  |
                               |        |
  sync server                  | 100MB  |
    +-- HTTP client buffers    |  30MB  | Parallel fetches
    +-- Batch processing       |  50MB  | Skill batches
    +-- Application heap       |  20MB  |


CPU BUDGET
----------

  Baseline (idle):     < 1% CPU
  Search query:        < 5% CPU (spike)
  Codebase analysis:   < 20% CPU (sustained, 5s max)
  Index sync:          < 30% CPU (background, throttled)


DISK I/O BUDGET
---------------

  SQLite reads:  < 10 MB/s (typical)
  SQLite writes: < 1 MB/s (during sync)
  Cache writes:  < 5 MB/s (burst)


NETWORK BUDGET
--------------

  GitHub API:     < 5000 requests/hour
  Aggregator APIs: < 100 requests/hour each
  Total bandwidth: < 10 MB/hour (typical)
```

---

## 5. Data Flow Diagrams

### 5.1 Search Request Flow

```
+------------------------------------------------------------------------+
|                    SEARCH REQUEST DATA FLOW                             |
+------------------------------------------------------------------------+

  User: "search react testing"
         |
         v
  +----------------+
  | Claude Code    |
  +----------------+
         |
         | [MCP Tool Call]
         v
  +----------------+
  | discovery-core |
  | MCP Server     |
  +----------------+
         |
         | [Parse request]
         v
  +----------------+
  | QueryParser    |
  | - Extract terms|
  | - Detect intent|
  +----------------+
         |
         v
  +----------------+     +----------------+
  | CacheCheck     |---->| Memory Cache   |
  | (L1)           |     | Hit? Return    |
  +----------------+     +----------------+
         |
         | [Cache miss]
         v
  +----------------+     +----------------+
  | CacheCheck     |---->| SQLite Cache   |
  | (L2)           |     | Hit? Return    |
  +----------------+     +----------------+
         |
         | [Cache miss]
         v
  +----------------+
  | FTS5 Query     |
  | skills_fts     |
  +----------------+
         |
         v
  +----------------+
  | Join with      |
  | skills table   |
  +----------------+
         |
         v
  +----------------+
  | Apply filters  |
  | - trust_tier   |
  | - categories   |
  | - min_score    |
  +----------------+
         |
         v
  +----------------+
  | Rank results   |
  | - FTS score    |
  | - Quality      |
  | - Recency      |
  +----------------+
         |
         v
  +----------------+
  | Cache result   |
  | (L1 + L2)      |
  +----------------+
         |
         v
  +----------------+
  | Format response|
  +----------------+
         |
         v
  [Return to Claude Code]
```

### 5.2 Recommendation Flow

```
+------------------------------------------------------------------------+
|                    RECOMMENDATION DATA FLOW                             |
+------------------------------------------------------------------------+

  User: "recommend skills for this project"
         |
         v
  +------------------+
  | Codebase Scanner |
  +------------------+
         |
         | [Scan project files]
         v
  +------------------+
  | Detect Stack     |
  | - package.json   |
  | - requirements   |
  | - go.mod         |
  | - Cargo.toml     |
  +------------------+
         |
         v
  +------------------+
  | Extract Tech     |
  | - Languages      |
  | - Frameworks     |
  | - Libraries      |
  +------------------+
         |
         v
  +------------------+     +------------------+
  | Gap Analysis     |<--->| Installed Skills |
  | - What's missing |     | - Already have   |
  +------------------+     +------------------+
         |
         v
  +------------------+
  | Search by Tech   |
  | (Multiple queries|
  |  in parallel)    |
  +------------------+
         |
         v
  +------------------+
  | Score Relevance  |
  | - Tech overlap   |
  | - Gap coverage   |
  | - Quality score  |
  +------------------+
         |
         v
  +------------------+
  | Rank & Dedupe    |
  +------------------+
         |
         v
  +------------------+
  | Add Explanations |
  | - Why recommended|
  | - What it adds   |
  +------------------+
         |
         v
  [Return top N recommendations]
```

### 5.3 Installation Flow

```
+------------------------------------------------------------------------+
|                    INSTALLATION DATA FLOW                               |
+------------------------------------------------------------------------+

  User: "install skill-id"
         |
         v
  +------------------+
  | Validate skill_id|
  +------------------+
         |
         | [Skill exists?]
         +---> No: Return SKILL_NOT_FOUND
         |
         v
  +------------------+
  | Check blocklist  |
  +------------------+
         |
         | [Blocked?]
         +---> Yes: Return BLOCKED_SKILL
         |
         v
  +------------------+
  | Security scan    |
  | - URL patterns   |
  | - Suspicious code|
  +------------------+
         |
         | [Issues found?]
         +---> Yes + !force: Return SECURITY_RISK_DETECTED
         |
         v
  +------------------+
  | Conflict check   |
  | - Trigger overlap|
  | - Behavioral     |
  +------------------+
         |
         | [Conflicts?]
         +---> Yes + !skip: Return CONFLICT_DETECTED
         |
         v
  +------------------+
  | Budget check     |
  | - Character limit|
  | - Existing skills|
  +------------------+
         |
         | [Over budget?]
         +---> Yes: Add warning
         |
         v
  +------------------+
  | BEGIN TRANSACTION|
  +------------------+
         |
         v
  +------------------+
  | Download/Copy    |
  | skill files      |
  +------------------+
         |
         | [Success?]
         +---> No: ROLLBACK, cleanup, return error
         |
         v
  +------------------+
  | Record install   |
  | in interactions  |
  +------------------+
         |
         v
  +------------------+
  | COMMIT           |
  +------------------+
         |
         v
  +------------------+
  | Generate tips    |
  | - Activation     |
  | - Suggested hooks|
  +------------------+
         |
         v
  [Return InstallResult]
```

### 5.4 Index Sync Flow

```
+------------------------------------------------------------------------+
|                    INDEX SYNC DATA FLOW                                 |
+------------------------------------------------------------------------+

  Trigger: Scheduled / Manual
         |
         v
  +------------------+
  | Check sync lock  |
  +------------------+
         |
         | [Lock held?]
         +---> Yes: Return SYNC_IN_PROGRESS
         |
         v
  +------------------+
  | Acquire sync lock|
  +------------------+
         |
         v
  +==================+
  |  PARALLEL FETCH  |
  +==================+
         |
  +------+------+------+
  |      |      |      |
  v      v      v      v

+--------+ +--------+ +--------+ +--------+
| GitHub | |SkillsMP| |claude- | | mcp.so |
| API    | |  API   | |plugins | |  API   |
+--------+ +--------+ +--------+ +--------+
  |           |           |           |
  v           v           v           v
[Delta]    [Delta]    [Delta]    [Delta]
  |           |           |           |
  +-----+-----+-----+-----+
        |
        v
  +------------------+
  | Merge & Dedupe   |
  | - By repo_url    |
  | - Latest wins    |
  +------------------+
        |
        v
  +------------------+
  | Compute scores   |
  | - Quality        |
  | - Popularity     |
  | - Maintenance    |
  +------------------+
        |
        v
  +------------------+
  | BEGIN EXCLUSIVE  |
  +------------------+
        |
        v
  +------------------+
  | Batch upsert     |
  | (1000 per batch) |
  +------------------+
        |
        v
  +------------------+
  | Update FTS index |
  +------------------+
        |
        v
  +------------------+
  | COMMIT           |
  +------------------+
        |
        v
  +------------------+
  | Invalidate caches|
  +------------------+
        |
        v
  +------------------+
  | Release sync lock|
  +------------------+
        |
        v
  [Return SyncResult]
```

---

## 6. Security Considerations

### 6.1 Trust Model

```
+------------------------------------------------------------------------+
|                    TRUST TIER ARCHITECTURE                              |
+------------------------------------------------------------------------+

  +----------------+     +----------------+     +----------------+
  |   OFFICIAL     |     |   VERIFIED     |     |   COMMUNITY    |
  +----------------+     +----------------+     +----------------+
  | Source:        |     | Source:        |     | Source:        |
  | - Anthropic    |     | - Known authors|     | - Public GitHub|
  | - Partners     |     | - Signed       |     | - Aggregators  |
  |                |     | - Reviewed     |     |                |
  +----------------+     +----------------+     +----------------+
  | Trust level:   |     | Trust level:   |     | Trust level:   |
  | HIGHEST        |     | HIGH           |     | MEDIUM         |
  +----------------+     +----------------+     +----------------+
  | Auto-install:  |     | Auto-install:  |     | Auto-install:  |
  | YES            |     | YES            |     | WITH WARNING   |
  +----------------+     +----------------+     +----------------+

  +----------------+
  |   UNVERIFIED   |
  +----------------+
  | Source:        |
  | - Unknown      |
  | - New          |
  |                |
  +----------------+
  | Trust level:   |
  | LOW            |
  +----------------+
  | Auto-install:  |
  | REQUIRE CONFIRM|
  +----------------+
```

### 6.2 Security Scanning Pipeline

```
+------------------------------------------------------------------------+
|                    SECURITY SCAN PIPELINE                               |
+------------------------------------------------------------------------+

  Skill to scan
       |
       v
  +------------------+
  | Stage 1: Static  |
  | Pattern Match    |
  +------------------+
  | - URL detection  |
  | - Exec patterns  |
  | - File access    |
  +------------------+
       |
       v
  +------------------+
  | Stage 2: Block-  |
  | list Check       |
  +------------------+
  | - Community list |
  | - Internal list  |
  | - CVE database   |
  +------------------+
       |
       v
  +------------------+
  | Stage 3: Typo-   |
  | squatting Check  |
  +------------------+
  | - Levenshtein    |
  | - Known popular  |
  +------------------+
       |
       v
  +------------------+
  | Stage 4: Score   |
  | Calculation      |
  +------------------+
  | Risk score: 0-100|
  +------------------+
       |
       +---> Score > 70: BLOCK
       |
       +---> Score 30-70: WARN
       |
       +---> Score < 30: ALLOW
```

---

## 7. Observability

### 7.1 Metrics to Track

```typescript
interface MetricsConfiguration {
  // Latency metrics (histograms)
  latency: {
    search_duration_ms: Histogram;
    recommend_duration_ms: Histogram;
    install_duration_ms: Histogram;
    audit_duration_ms: Histogram;
    sync_duration_ms: Histogram;
  };

  // Throughput metrics (counters)
  throughput: {
    search_requests_total: Counter;
    install_requests_total: Counter;
    cache_hits_total: Counter;
    cache_misses_total: Counter;
    errors_total: Counter;
  };

  // Resource metrics (gauges)
  resources: {
    memory_usage_bytes: Gauge;
    sqlite_connections_active: Gauge;
    cache_size_bytes: Gauge;
    index_skill_count: Gauge;
  };

  // Business metrics
  business: {
    recommendations_accepted: Counter;
    skills_installed: Counter;
    audit_issues_found: Counter;
    activation_success_rate: Gauge;
  };
}
```

### 7.2 Logging Strategy

```typescript
interface LogConfiguration {
  // Log levels per component
  levels: {
    'mcp.server': 'info';
    'service.search': 'info';
    'service.install': 'info';
    'service.sync': 'debug';      // More verbose for debugging
    'adapter.github': 'warn';     // Reduce noise
    'adapter.scraper': 'warn';
  };

  // Structured log format
  format: {
    timestamp: 'ISO8601';
    level: string;
    component: string;
    message: string;
    context: {
      request_id?: string;
      user_id?: string;
      duration_ms?: number;
      error?: Error;
    };
  };

  // Output destinations
  outputs: {
    console: true;
    file: '~/.claude-discovery/logs/discovery.log';
    rotation: {
      max_size_mb: 10;
      max_files: 5;
    };
  };
}
```

---

## 8. Recommendations Summary

### 8.1 Architecture Recommendations

| Category | Recommendation | Priority |
|----------|---------------|----------|
| **Server Design** | Keep 3-server architecture; avoid further consolidation | High |
| **Storage** | SQLite with WAL mode; consider read replicas if scaling needed | High |
| **Caching** | Implement multi-tier caching (memory + SQLite) | High |
| **Sync** | Background sync with 30-second startup delay | Medium |
| **Embeddings** | Memory-mapped file for fast similarity search | Medium |

### 8.2 Performance Recommendations

| Category | Recommendation | Expected Impact |
|----------|---------------|-----------------|
| **Startup** | Lazy-load embeddings after first request | 1s faster cold start |
| **Search** | Pre-compute popular query results | 50% cache hit rate |
| **Codebase Scan** | Incremental scanning with file hash cache | 80% faster re-scans |
| **Sync** | Parallel fetching from sources | 3x faster full sync |

### 8.3 Scalability Path

```
+------------------------------------------------------------------------+
|                    SCALABILITY ROADMAP                                  |
+------------------------------------------------------------------------+

Phase 1 (Current): Single Machine
---------------------------------
  +-- SQLite with WAL
  +-- Memory-mapped embeddings
  +-- File-based caching
  +-- Capacity: 50K skills, 1 user

Phase 2 (If Needed): Enhanced Single Machine
--------------------------------------------
  +-- SQLite read replicas (litestream)
  +-- Redis for shared cache
  +-- Capacity: 100K skills, 10 concurrent users

Phase 3 (If Needed): Distributed
--------------------------------
  +-- PostgreSQL with pg_vector
  +-- Dedicated search service (Meilisearch)
  +-- Kubernetes deployment
  +-- Capacity: 500K+ skills, 100+ concurrent users
```

---

## 9. Related Documentation

| Document | Purpose |
|----------|---------|
| [Technical Overview](../technical/overview.md) | High-level architecture |
| [MCP Servers](../technical/components/mcp-servers.md) | Server specifications |
| [API Design](../technical/api/index.md) | Tool definitions |
| [Error Handling](../technical/api/error-handling.md) | Error codes and recovery |
| [Skill Index](../technical/components/skill-index.md) | Data model |
| [Activation Auditor](../technical/components/activation-auditor.md) | Audit logic |

---

**Document History:**
- v1.0 (December 26, 2025): Initial Backend/API architecture design

**Next Review:** After Phase 0 validation sprint completion
