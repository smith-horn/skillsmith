# Technical Architecture Implementation Plan

**Project:** Skillsmith
**Domain:** Technical Architecture
**Owner:** Engineering Lead
**Date:** December 26, 2025
**Status:** Planned

---

## Executive Summary

This document provides the comprehensive implementation plan for the Skillsmith technical architecture, covering the MCP server layer, service architecture, and system configuration for Phases 0-2.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| MCP Server Count | 3 servers | Balance startup overhead vs separation of concerns |
| Runtime | Node.js 18+ | MCP SDK requirement, TypeScript support |
| Inter-Service Comm | Shared filesystem | No IPC complexity, SQLite handles concurrency |
| Startup Target | < 5 seconds | Acceptable CLI latency for dev tools |
| Memory Budget | 300MB idle / 500MB active | Reasonable for dev machine |
| Package Distribution | Single npm package | Simple installation, all components bundled |

### Architecture Overview

```
Claude Code Terminal
        |
        v
+------------------+
|  MCP Runtime     |
+------------------+
| discovery-core   | --> 12 tools, 150MB, 1.5s startup
| learning         | --> 6 tools, 50MB, 0.5s startup
| sync             | --> 5 tools, 100MB, 0.5s startup
+------------------+
        |
        v
+------------------+
| Shared Storage   |
| ~/.claude-       |
| discovery/       |
+------------------+
```

---

## Phase 0: Foundation Sprint (Weeks 1-8)

### Epic TA-001: MCP Server Foundation

**Description:** Establish the base MCP server infrastructure with discovery-core as the primary server, implementing core lifecycle management and tool registration.

**Business Value:** Enables all Claude Code integration, blocking all discovery features.

**Dependencies:** DA-001 (Database Foundation)

**Definition of Done:**
- [ ] discovery-core MCP server starts within 1.5 seconds
- [ ] All 12 tools registered and responding
- [ ] Graceful shutdown with request completion
- [ ] Health check endpoint operational
- [ ] Configuration loaded from settings.json

---

#### Story TA-001-01: MCP Server Bootstrap

**As a** Claude Code user
**I want** the MCP server to start quickly
**So that** I don't experience delays when using Claude Code

**Acceptance Criteria:**
- [ ] Server starts in < 1.5 seconds cold start
- [ ] MCP protocol handshake completes successfully
- [ ] Tool manifest returned to Claude Code
- [ ] Error on startup logged clearly

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| TA-001-01-T1 | Create MCP server entry point with @anthropic-ai/mcp | 4h | P0 |
| TA-001-01-T2 | Implement lazy loading for heavy components | 4h | P0 |
| TA-001-01-T3 | Add startup timing instrumentation | 2h | P1 |
| TA-001-01-T4 | Create configuration loader | 3h | P0 |
| TA-001-01-T5 | Implement graceful shutdown handler | 2h | P0 |

**Code Pattern - MCP Server Bootstrap:**

```typescript
// src/mcp/discovery-core/server.ts
import { MCPServer } from '@anthropic-ai/mcp';
import { registerTools } from './tools';
import { initializeDatabase } from '../data/database';
import { loadConfig } from '../config/loader';

export async function startServer(): Promise<MCPServer> {
  const startTime = Date.now();

  // Load config first (fast)
  const config = await loadConfig();

  // Initialize database connection
  const db = await initializeDatabase(config.database);

  // Create MCP server
  const server = new MCPServer({
    name: 'skillsmith',
    version: '1.0.0',
  });

  // Register all tools
  await registerTools(server, { db, config });

  // Log startup time
  const elapsed = Date.now() - startTime;
  console.log(`discovery-core started in ${elapsed}ms`);

  return server;
}
```

**Failure Pattern - Blocking Startup:**

```typescript
// WRONG: Loading embeddings blocks startup
const embeddings = await loadAllEmbeddings(); // Takes 2+ seconds!
const server = new MCPServer({ ... });

// RIGHT: Lazy load embeddings on first semantic search
let embeddingsCache: EmbeddingStore | null = null;
async function getEmbeddings(): Promise<EmbeddingStore> {
  if (!embeddingsCache) {
    embeddingsCache = await loadEmbeddings();
  }
  return embeddingsCache;
}
```

---

#### Story TA-001-02: Tool Registration Framework

**As a** developer
**I want** a clean tool registration pattern
**So that** adding new MCP tools is straightforward

**Acceptance Criteria:**
- [ ] Each tool defined in separate file
- [ ] Tools auto-discovered from tools/ directory
- [ ] Input validation via JSON Schema
- [ ] Consistent error response format

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| TA-001-02-T1 | Create tool interface and base class | 3h | P0 |
| TA-001-02-T2 | Implement tool discovery/registration | 3h | P0 |
| TA-001-02-T3 | Add JSON Schema validation middleware | 4h | P0 |
| TA-001-02-T4 | Create error response formatter | 2h | P0 |
| TA-001-02-T5 | Write tool registration tests | 3h | P1 |

**Code Pattern - Tool Definition:**

```typescript
// src/mcp/discovery-core/tools/search.ts
import { Tool, ToolInput, ToolOutput } from '../framework';
import { SearchService } from '../../services/search';

export const searchTool: Tool = {
  name: 'search',
  description: 'Search for Claude Code skills by keyword or semantic query',

  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      filters: {
        type: 'object',
        properties: {
          categories: { type: 'array', items: { type: 'string' } },
          trust_tier: { type: 'array', items: { type: 'string', enum: ['official', 'verified', 'community', 'unverified'] } },
          min_score: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    },
    required: ['query'],
  },

  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolOutput> {
    const searchService = ctx.container.get(SearchService);

    const results = await searchService.search({
      query: input.query,
      filters: input.filters,
      limit: input.limit ?? 10,
    });

    return {
      success: true,
      data: {
        results: results.skills,
        total: results.total,
        has_more: results.hasMore,
      },
      metadata: {
        cached: results.fromCache,
        execution_time_ms: results.executionTime,
      },
    };
  },
};
```

---

#### Story TA-001-03: Configuration Management

**As a** user
**I want** to configure Discovery Hub behavior
**So that** I can customize telemetry, sync frequency, and trust preferences

**Acceptance Criteria:**
- [ ] Config loaded from ~/.skillsmith/config/settings.json
- [ ] Defaults applied for missing values
- [ ] Config changes detected on next startup
- [ ] Validation errors reported clearly

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| TA-001-03-T1 | Define configuration schema | 2h | P0 |
| TA-001-03-T2 | Implement config file loader with defaults | 3h | P0 |
| TA-001-03-T3 | Add config validation | 2h | P0 |
| TA-001-03-T4 | Create config CLI commands (get, set) | 3h | P1 |
| TA-001-03-T5 | Document configuration options | 2h | P2 |

**Code Pattern - Configuration Schema:**

```typescript
// src/config/schema.ts
export interface DiscoveryConfig {
  telemetry: {
    enabled: boolean;           // Default: true (opt-out)
    level: 'basic' | 'standard' | 'full';
  };
  sync: {
    frequency: 'hourly' | 'daily' | 'weekly' | 'manual';
    background: boolean;
  };
  discovery: {
    trust_tier_minimum: 'official' | 'verified' | 'community' | 'unverified';
    show_unverified: boolean;
  };
  performance: {
    cache_size_mb: number;
    embedding_preload: boolean;
  };
}

export const DEFAULT_CONFIG: DiscoveryConfig = {
  telemetry: { enabled: true, level: 'standard' },
  sync: { frequency: 'daily', background: true },
  discovery: { trust_tier_minimum: 'community', show_unverified: true },
  performance: { cache_size_mb: 100, embedding_preload: false },
};
```

---

### Epic TA-002: Service Layer Architecture

**Description:** Implement the service layer with dependency injection, providing clean separation between MCP tools and business logic.

**Business Value:** Enables testable, maintainable code with clear boundaries.

**Dependencies:** TA-001 (MCP Server Foundation), DA-001 (Database Foundation)

**Definition of Done:**
- [ ] All services use constructor injection
- [ ] Services testable with mock dependencies
- [ ] Clear service boundaries documented
- [ ] No circular dependencies

---

#### Story TA-002-01: Dependency Injection Container

**As a** developer
**I want** a DI container for service management
**So that** services are decoupled and testable

**Acceptance Criteria:**
- [ ] Container registers all services at startup
- [ ] Services resolved with dependencies
- [ ] Singleton scope for shared services
- [ ] Easy mocking for tests

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| TA-002-01-T1 | Implement lightweight DI container | 4h | P0 |
| TA-002-01-T2 | Register all core services | 3h | P0 |
| TA-002-01-T3 | Add scope management (singleton/transient) | 2h | P1 |
| TA-002-01-T4 | Create test utilities for mocking | 3h | P1 |
| TA-002-01-T5 | Document service registration | 1h | P2 |

**Code Pattern - DI Container:**

```typescript
// src/container/container.ts
export class Container {
  private instances = new Map<symbol, any>();
  private factories = new Map<symbol, () => any>();

  register<T>(token: symbol, factory: () => T, singleton = true): void {
    if (singleton) {
      this.factories.set(token, () => {
        if (!this.instances.has(token)) {
          this.instances.set(token, factory());
        }
        return this.instances.get(token);
      });
    } else {
      this.factories.set(token, factory);
    }
  }

  get<T>(token: symbol): T {
    const factory = this.factories.get(token);
    if (!factory) {
      throw new Error(`No registration for ${token.description}`);
    }
    return factory();
  }
}

// Usage
const TOKENS = {
  Database: Symbol('Database'),
  SkillRepository: Symbol('SkillRepository'),
  SearchService: Symbol('SearchService'),
};

container.register(TOKENS.SearchService, () =>
  new SearchService(
    container.get(TOKENS.SkillRepository),
    container.get(TOKENS.EmbeddingStore),
    container.get(TOKENS.CacheManager)
  )
);
```

---

#### Story TA-002-02: SearchService Implementation

**As a** user
**I want** fast, relevant search results
**So that** I can find skills matching my needs

**Acceptance Criteria:**
- [ ] FTS5 search returns results in < 50ms (cached)
- [ ] Semantic search available via embeddings
- [ ] Results ranked by relevance + quality score
- [ ] Filters applied efficiently

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| TA-002-02-T1 | Implement FTS5 query builder | 4h | P0 |
| TA-002-02-T2 | Add embedding similarity search | 6h | P0 |
| TA-002-02-T3 | Implement hybrid ranking algorithm | 4h | P0 |
| TA-002-02-T4 | Add filter processing | 3h | P0 |
| TA-002-02-T5 | Implement result caching | 3h | P1 |
| TA-002-02-T6 | Add query intent detection | 4h | P2 |

**Code Pattern - Search Service:**

```typescript
// src/services/search/SearchService.ts
export class SearchService {
  constructor(
    private skillRepo: SkillRepository,
    private embeddings: EmbeddingStore,
    private cache: CacheManager
  ) {}

  async search(params: SearchParams): Promise<SearchResult> {
    const cacheKey = this.buildCacheKey(params);
    const cached = await this.cache.get<SearchResult>(cacheKey);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    const startTime = Date.now();

    // FTS5 keyword search
    const ftsResults = await this.skillRepo.searchFTS(params.query, {
      limit: params.limit * 2, // Over-fetch for re-ranking
      filters: params.filters,
    });

    // Semantic search if query is natural language
    let semanticResults: Skill[] = [];
    if (this.isSemanticQuery(params.query)) {
      const queryEmbedding = await this.embeddings.embed(params.query);
      semanticResults = await this.embeddings.similarSkills(queryEmbedding, {
        limit: params.limit,
        minSimilarity: 0.7,
      });
    }

    // Merge and rank
    const merged = this.mergeAndRank(ftsResults, semanticResults, params);
    const limited = merged.slice(0, params.limit);

    const result: SearchResult = {
      skills: limited,
      total: merged.length,
      hasMore: merged.length > params.limit,
      executionTime: Date.now() - startTime,
      fromCache: false,
    };

    await this.cache.set(cacheKey, result, { ttl: 300 }); // 5 min cache
    return result;
  }
}
```

---

## Phase 1: Foundation + Safety (Weeks 9-12)

### Epic TA-003: Learning Server Implementation

**Description:** Implement the learning MCP server for educational content delivery and progress tracking.

**Business Value:** Enables skill activation learning paths, improving user success.

**Dependencies:** TA-001, DA-001

**Definition of Done:**
- [ ] Learning server starts in < 0.5 seconds
- [ ] 6 learning tools operational
- [ ] Progress persisted to user database
- [ ] Exercises loaded from content directory

---

#### Story TA-003-01: Learning Path Engine

**As a** user
**I want** guided learning paths for skills
**So that** I can effectively learn to use new skills

**Acceptance Criteria:**
- [ ] Paths loaded from markdown content
- [ ] Progress tracked per skill per user
- [ ] Exercises validated automatically
- [ ] Hints available for stuck users

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| TA-003-01-T1 | Create learning content schema | 3h | P0 |
| TA-003-01-T2 | Implement path loader | 4h | P0 |
| TA-003-01-T3 | Add progress tracking service | 4h | P0 |
| TA-003-01-T4 | Implement exercise validation | 5h | P0 |
| TA-003-01-T5 | Create hint system | 3h | P1 |

---

### Epic TA-004: Sync Server Implementation

**Description:** Implement the sync MCP server for background index updates and external source synchronization.

**Business Value:** Keeps skill index fresh without user intervention.

**Dependencies:** TA-001, DA-003 (Sync Infrastructure)

**Definition of Done:**
- [ ] Sync server starts in < 0.5 seconds
- [ ] Background sync runs after 30-second delay
- [ ] Incremental updates minimize bandwidth
- [ ] Source health monitoring

---

#### Story TA-004-01: Background Sync Orchestration

**As a** system
**I want** to sync skill index automatically
**So that** users always have current data

**Acceptance Criteria:**
- [ ] Sync starts 30 seconds after server start
- [ ] Runs daily by default (configurable)
- [ ] Incremental delta preferred over full sync
- [ ] Sync status exposed via tool

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| TA-004-01-T1 | Implement sync scheduler | 4h | P0 |
| TA-004-01-T2 | Create source orchestrator | 5h | P0 |
| TA-004-01-T3 | Add delta detection logic | 4h | P0 |
| TA-004-01-T4 | Implement sync status tracking | 3h | P1 |
| TA-004-01-T5 | Add health check for external sources | 3h | P1 |

---

## Phase 2: Recommendations + Entry Points (Weeks 13-16)

### Epic TA-005: Codebase Analysis Service

**Description:** Implement codebase scanning and analysis for technology detection and skill gap identification.

**Business Value:** Enables contextual skill recommendations based on user's actual project.

**Dependencies:** TA-002, PROD-101 (50K Index)

**Definition of Done:**
- [ ] Scan 1K files in < 5 seconds
- [ ] Detect major frameworks and languages
- [ ] Identify skill gaps based on stack
- [ ] Cache scan results per directory

---

#### Story TA-005-01: Technology Detection Engine

**As a** user
**I want** automatic detection of my project's tech stack
**So that** I get relevant skill recommendations

**Acceptance Criteria:**
- [ ] Detect languages from file extensions
- [ ] Parse package.json, requirements.txt, go.mod, Cargo.toml
- [ ] Identify frameworks from imports/dependencies
- [ ] Confidence score for each detection

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| TA-005-01-T1 | Create file scanner with depth limit | 4h | P0 |
| TA-005-01-T2 | Implement manifest parsers | 6h | P0 |
| TA-005-01-T3 | Add framework detection rules | 5h | P0 |
| TA-005-01-T4 | Create technology taxonomy | 3h | P0 |
| TA-005-01-T5 | Implement confidence scoring | 3h | P1 |
| TA-005-01-T6 | Add scan result caching | 2h | P1 |

**Code Pattern - Technology Detection:**

```typescript
// src/services/analysis/TechnologyDetector.ts
export class TechnologyDetector {
  private parsers = new Map<string, ManifestParser>();

  constructor() {
    this.parsers.set('package.json', new NodePackageParser());
    this.parsers.set('requirements.txt', new PythonRequirementsParser());
    this.parsers.set('go.mod', new GoModParser());
    this.parsers.set('Cargo.toml', new CargoTomlParser());
  }

  async detect(projectPath: string): Promise<TechStackResult> {
    const files = await this.scanFiles(projectPath);
    const detections: TechDetection[] = [];

    // Parse manifests
    for (const [filename, parser] of this.parsers) {
      const manifestPath = path.join(projectPath, filename);
      if (files.includes(manifestPath)) {
        const techs = await parser.parse(manifestPath);
        detections.push(...techs);
      }
    }

    // Detect from file extensions
    const languages = this.detectLanguages(files);

    // Detect frameworks from imports
    const frameworks = await this.detectFrameworks(files);

    return {
      languages,
      frameworks,
      libraries: detections,
      confidence: this.calculateConfidence(detections),
    };
  }
}
```

---

### Epic TA-006: Recommendation Engine

**Description:** Implement the skill recommendation engine that combines codebase analysis with skill matching.

**Business Value:** Core feature that helps users discover relevant skills.

**Dependencies:** TA-005, DA-005 (Semantic Search)

**Definition of Done:**
- [ ] Recommendations generated in < 2 seconds
- [ ] Top 10 recommendations with explanations
- [ ] Filters out already-installed skills
- [ ] Considers trust tiers

---

#### Story TA-006-01: Gap Analysis and Matching

**As a** user
**I want** personalized skill recommendations
**So that** I discover skills that match my needs

**Acceptance Criteria:**
- [ ] Identify gaps between stack and installed skills
- [ ] Match gaps to available skills
- [ ] Rank by relevance and quality
- [ ] Provide explanation for each recommendation

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| TA-006-01-T1 | Implement gap identifier | 4h | P0 |
| TA-006-01-T2 | Create skill matcher with semantic search | 5h | P0 |
| TA-006-01-T3 | Implement ranking algorithm | 4h | P0 |
| TA-006-01-T4 | Generate recommendation explanations | 3h | P0 |
| TA-006-01-T5 | Add installed skill filtering | 2h | P0 |
| TA-006-01-T6 | Integrate trust tier preferences | 2h | P1 |

---

## Performance Budgets

### Startup Budgets

| Server | Cold Start Target | Max | Components |
|--------|------------------|-----|------------|
| discovery-core | 1.5s | 2.0s | DB init, tool registration, cache warm |
| learning | 0.5s | 1.0s | Content index, progress DB |
| sync | 0.5s | 1.0s | Config load, source registry |
| **TOTAL** | **2.5s** | **4.0s** | |

### Memory Budgets

| Server | Idle | Active | Notes |
|--------|------|--------|-------|
| discovery-core | 150MB | 250MB | Includes FTS5 cache, embeddings |
| learning | 50MB | 100MB | Content cache |
| sync | 100MB | 150MB | HTTP client buffers |
| **TOTAL** | **300MB** | **500MB** | |

### Latency Budgets

| Operation | p50 | p95 | p99 |
|-----------|-----|-----|-----|
| search (cached) | 50ms | 150ms | 200ms |
| search (uncached) | 200ms | 400ms | 500ms |
| get_skill | 30ms | 100ms | 150ms |
| recommend_skills | 500ms | 1.5s | 2s |
| install_skill | 1s | 3s | 5s |
| audit_activation | 200ms | 500ms | 1s |

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [System Overview](../architecture/system-overview.md) | Architecture source of truth |
| [Backend API](../architecture/backend-api.md) | MCP server specifications |
| [Data Architecture](./02-data-architecture.md) | Database and storage |
| [MCP Tool Specs](./artifacts/mcp-tool-specs.md) | Tool interfaces |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | Engineering Lead | Initial implementation plan |

---

*This document should be used to create Linear projects (Epics), issues (Stories), and sub-issues (Tasks). Definition of Done items become Milestone acceptance criteria.*
