# Data Architecture Implementation Plan

**Project:** Skillsmith
**Domain:** Data Architecture
**Owner:** Data Architect
**Date:** December 26, 2025
**Status:** Planned

---

## Executive Summary

This document provides the comprehensive implementation plan for the Skillsmith data layer, covering Phases 0-2. The data architecture is designed to support:

- **50,000+ skills** indexed from fragmented sources
- **Local-first operation** with offline capability
- **Sub-2-second search latency** for discovery UX
- **Privacy-preserving telemetry** with clear opt-out
- **Incremental sync** to minimize bandwidth and API costs

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary Database | SQLite 3.45+ | FTS5 + WAL, zero dependencies, local-first |
| Node.js Driver | better-sqlite3 | Synchronous API, better performance than sqlite3 |
| Full-Text Search | FTS5 with porter tokenizer | Built-in, fast, good relevance |
| Embedding Model | all-MiniLM-L6-v2 | 384 dimensions, fast, good quality, local inference |
| Embedding Runtime | @xenova/transformers | WASM-based, no Python dependencies |
| Caching Strategy | SQLite-based + Memory LRU | Single database, simple operations |
| Sync Queue | SQLite-based queue | No Redis dependency, persistent |

### Storage Architecture Overview

```
~/.skillsmith/
|
+-- index/
|   +-- skills.db              # SQLite database (FTS5 enabled)
|   +-- embeddings/
|       +-- embeddings.bin     # Vector embeddings (memory-mapped)
|       +-- embeddings.meta.json
|
+-- user/
|   +-- profile.json           # User preferences
|   +-- installed.json         # Installed skills manifest
|   +-- history.db             # Interaction history
|
+-- telemetry/
|   +-- queue.db               # Pending telemetry events
|   +-- config.json            # Telemetry configuration
|
+-- config/
    +-- settings.json          # Global settings
    +-- blocklist.json         # Custom blocklist additions
```

---

## Phase 0: Foundation Sprint (Weeks 1-8)

### Epic DA-001: Database Foundation

**Description:** Establish SQLite database with core schema, FTS5 full-text search, and basic CRUD operations for the POC.

**Business Value:** Enables skill discovery with fast search, blocking all other features.

**Dependencies:** None (foundational)

**Definition of Done:**
- [ ] SQLite database initializes on first run
- [ ] All core tables created with proper constraints
- [ ] FTS5 search returns results in <50ms for 1K skills
- [ ] Basic CRUD operations work via repository pattern
- [ ] Schema migrations framework in place

---

#### Story DA-001-01: Database Initialization

**As a** Skillsmith system
**I want** to initialize the database on first run
**So that** all data operations have a proper storage layer

**Acceptance Criteria:**
- [ ] Database created at `~/.skillsmith/index/skills.db`
- [ ] Directory structure created if not exists
- [ ] PRAGMA configurations applied (WAL, foreign keys, etc.)
- [ ] Seed data inserted (sources, categories, technologies)
- [ ] Idempotent initialization (safe to run multiple times)

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-001-01-T1 | Create database initialization module | 4h | P0 |
| DA-001-01-T2 | Implement directory structure creation | 2h | P0 |
| DA-001-01-T3 | Write PRAGMA configuration function | 1h | P0 |
| DA-001-01-T4 | Create schema migration runner | 4h | P0 |
| DA-001-01-T5 | Write initial migration (V001) | 4h | P0 |
| DA-001-01-T6 | Implement seed data insertion | 2h | P1 |

**Code Pattern - Database Initialization:**

```typescript
// src/data/database.ts
import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

export interface DatabaseConfig {
  path?: string;
  readonly?: boolean;
  verbose?: boolean;
}

export function initializeDatabase(config: DatabaseConfig = {}): Database.Database {
  const dbPath = config.path ?? join(homedir(), '.skillsmith', 'index', 'skills.db');

  // Ensure directory exists
  const dbDir = join(dbPath, '..');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath, {
    readonly: config.readonly ?? false,
    verbose: config.verbose ? console.log : undefined,
  });

  // Apply PRAGMAs
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');      // 64MB cache
  db.pragma('mmap_size = 268435456');    // 256MB memory-mapped I/O
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');

  return db;
}
```

**Failure Pattern - Missing Directory:**

```typescript
// WRONG: Don't assume directory exists
const db = new Database('~/.skillsmith/index/skills.db');
// SQLITE_CANTOPEN: unable to open database file

// CORRECT: Create directory structure first
const dbDir = join(homedir(), '.skillsmith', 'index');
mkdirSync(dbDir, { recursive: true });
const db = new Database(join(dbDir, 'skills.db'));
```

---

#### Story DA-001-02: Core Schema Implementation

**As a** data system
**I want** all core tables created with proper constraints
**So that** data integrity is maintained at the database level

**Acceptance Criteria:**
- [ ] All tables from schema specification created
- [ ] Foreign key constraints enforced
- [ ] CHECK constraints validate enums
- [ ] Indexes created for common query patterns
- [ ] Soft delete pattern implemented (deleted_at)

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-001-02-T1 | Create sources table and indexes | 2h | P0 |
| DA-001-02-T2 | Create authors table and indexes | 2h | P0 |
| DA-001-02-T3 | Create skills table and indexes | 4h | P0 |
| DA-001-02-T4 | Create categories and skill_categories tables | 2h | P0 |
| DA-001-02-T5 | Create technologies and skill_technologies tables | 2h | P0 |
| DA-001-02-T6 | Create security tables (blocked_skills, security_findings) | 2h | P1 |
| DA-001-02-T7 | Create cache and sync_state tables | 2h | P1 |

**Code Pattern - Migration File:**

```typescript
// src/data/migrations/V001_initial_schema.ts
import type Database from 'better-sqlite3';

export const version = 1;
export const description = 'Initial schema with core tables';

export function up(db: Database.Database): void {
  db.exec(`
    -- Sources table
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_type TEXT NOT NULL CHECK (api_type IN ('rest', 'graphql', 'scrape')),
      rate_limit_per_hour INTEGER,
      requires_auth INTEGER DEFAULT 0,
      last_full_sync TEXT,
      last_incremental_sync TEXT,
      sync_cursor TEXT,
      sync_etag TEXT,
      error_count INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Authors table
    CREATE TABLE IF NOT EXISTS authors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      github_username TEXT,
      email TEXT,
      avatar_url TEXT,
      profile_url TEXT,
      verified INTEGER DEFAULT 0,
      skill_count INTEGER DEFAULT 0,
      total_stars INTEGER DEFAULT 0,
      reputation_score REAL DEFAULT 0.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_authors_github ON authors(github_username);
    CREATE INDEX IF NOT EXISTS idx_authors_reputation ON authors(reputation_score DESC);
  `);
}

export function down(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS authors;
    DROP TABLE IF EXISTS sources;
  `);
}
```

---

#### Story DA-001-03: FTS5 Full-Text Search

**As a** user searching for skills
**I want** fast and relevant full-text search
**So that** I can find skills matching my query

**Acceptance Criteria:**
- [ ] FTS5 virtual table created for skills
- [ ] Triggers maintain FTS sync on INSERT/UPDATE/DELETE
- [ ] BM25 ranking returns relevant results
- [ ] Prefix matching works (test*)
- [ ] Search completes in <50ms for 1K skills

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-001-03-T1 | Create FTS5 virtual table | 2h | P0 |
| DA-001-03-T2 | Implement sync triggers | 2h | P0 |
| DA-001-03-T3 | Create search query builder | 4h | P0 |
| DA-001-03-T4 | Add BM25 ranking support | 2h | P0 |
| DA-001-03-T5 | Implement prefix matching | 1h | P1 |
| DA-001-03-T6 | Add search benchmarks | 2h | P1 |

**Code Pattern - FTS5 Search:**

```typescript
// src/data/repositories/skill-search.repository.ts
import type Database from 'better-sqlite3';

export interface SearchResult {
  id: string;
  name: string;
  description: string;
  score: number;
}

export class SkillSearchRepository {
  constructor(private db: Database.Database) {}

  search(query: string, options: { limit?: number; offset?: number } = {}): SearchResult[] {
    const { limit = 20, offset = 0 } = options;

    // Escape special FTS5 characters
    const sanitizedQuery = this.sanitizeQuery(query);

    const stmt = this.db.prepare(`
      SELECT
        s.id,
        s.name,
        s.description,
        bm25(skills_fts, 10.0, 5.0, 1.0) as score
      FROM skills_fts
      JOIN skills s ON skills_fts.rowid = s.rowid
      WHERE skills_fts MATCH ?
        AND s.deleted_at IS NULL
      ORDER BY score
      LIMIT ? OFFSET ?
    `);

    return stmt.all(sanitizedQuery, limit, offset) as SearchResult[];
  }

  private sanitizeQuery(query: string): string {
    // Remove special FTS5 operators for safety
    return query
      .replace(/[*"(){}[\]^~\\]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .join(' OR ');
  }
}
```

**Failure Pattern - Unsanitized Query:**

```typescript
// WRONG: Direct user input in FTS query
const results = db.prepare(`
  SELECT * FROM skills_fts WHERE skills_fts MATCH '${userQuery}'
`).all();
// FTS5 syntax error on special characters

// CORRECT: Sanitize and parameterize
const sanitized = userQuery.replace(/[*"(){}[\]^~\\]/g, ' ').trim();
const results = db.prepare(`
  SELECT * FROM skills_fts WHERE skills_fts MATCH ?
`).all(sanitized);
```

---

#### Story DA-001-04: Repository Pattern Implementation

**As a** developer
**I want** a clean repository pattern for data access
**So that** business logic is decoupled from database operations

**Acceptance Criteria:**
- [ ] Base repository interface defined
- [ ] Skill repository with CRUD operations
- [ ] Author repository with CRUD operations
- [ ] Source repository with CRUD operations
- [ ] Unit of work pattern for transactions

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-001-04-T1 | Define base repository interface | 2h | P0 |
| DA-001-04-T2 | Implement SkillRepository | 4h | P0 |
| DA-001-04-T3 | Implement AuthorRepository | 2h | P0 |
| DA-001-04-T4 | Implement SourceRepository | 2h | P0 |
| DA-001-04-T5 | Create UnitOfWork for transactions | 2h | P1 |
| DA-001-04-T6 | Add repository factory | 1h | P1 |

**Code Pattern - Repository Interface:**

```typescript
// src/data/repositories/base.repository.ts
export interface BaseRepository<T, ID = string> {
  findById(id: ID): T | undefined;
  findAll(options?: FindOptions): T[];
  create(entity: Omit<T, 'id' | 'created_at' | 'updated_at'>): T;
  update(id: ID, entity: Partial<T>): T | undefined;
  delete(id: ID): boolean;
  count(options?: CountOptions): number;
}

export interface FindOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: 'ASC' | 'DESC';
  where?: Record<string, unknown>;
}

// src/data/repositories/skill.repository.ts
import type Database from 'better-sqlite3';
import type { BaseRepository, FindOptions } from './base.repository';

export interface Skill {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  source_id: string;
  author_id: string | null;
  quality_score: number | null;
  trust_tier: 'official' | 'verified' | 'community' | 'unverified';
  repo_url: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export class SkillRepository implements BaseRepository<Skill> {
  private statements: {
    findById: Database.Statement;
    findAll: Database.Statement;
    create: Database.Statement;
    update: Database.Statement;
    delete: Database.Statement;
  };

  constructor(private db: Database.Database) {
    // Prepare statements once for performance
    this.statements = {
      findById: db.prepare(`
        SELECT * FROM skills WHERE id = ? AND deleted_at IS NULL
      `),
      findAll: db.prepare(`
        SELECT * FROM skills WHERE deleted_at IS NULL
        ORDER BY quality_score DESC LIMIT ? OFFSET ?
      `),
      create: db.prepare(`
        INSERT INTO skills (id, name, slug, description, source_id, author_id,
          quality_score, trust_tier, repo_url)
        VALUES (@id, @name, @slug, @description, @source_id, @author_id,
          @quality_score, @trust_tier, @repo_url)
        RETURNING *
      `),
      update: db.prepare(`
        UPDATE skills SET
          name = COALESCE(@name, name),
          description = COALESCE(@description, description),
          quality_score = COALESCE(@quality_score, quality_score),
          trust_tier = COALESCE(@trust_tier, trust_tier),
          updated_at = datetime('now')
        WHERE id = @id AND deleted_at IS NULL
        RETURNING *
      `),
      delete: db.prepare(`
        UPDATE skills SET deleted_at = datetime('now') WHERE id = ?
      `),
    };
  }

  findById(id: string): Skill | undefined {
    return this.statements.findById.get(id) as Skill | undefined;
  }

  findAll(options: FindOptions = {}): Skill[] {
    const { limit = 100, offset = 0 } = options;
    return this.statements.findAll.all(limit, offset) as Skill[];
  }

  create(skill: Omit<Skill, 'created_at' | 'updated_at' | 'deleted_at'>): Skill {
    return this.statements.create.get(skill) as Skill;
  }

  update(id: string, updates: Partial<Skill>): Skill | undefined {
    return this.statements.update.get({ ...updates, id }) as Skill | undefined;
  }

  delete(id: string): boolean {
    const result = this.statements.delete.run(id);
    return result.changes > 0;
  }

  count(): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count FROM skills WHERE deleted_at IS NULL
    `).get() as { count: number };
    return result.count;
  }
}
```

---

### Epic DA-002: Caching Layer

**Description:** Implement SQLite-based caching with TTL support for API responses and computed results.

**Business Value:** Reduces API calls, improves response times, enables offline operation.

**Dependencies:** DA-001 (Database Foundation)

**Definition of Done:**
- [ ] Cache table stores JSON with TTL
- [ ] Automatic expiration cleanup
- [ ] Cache hit/miss metrics tracked
- [ ] GitHub API responses cached for 1 hour
- [ ] Search results cached for 30 minutes

---

#### Story DA-002-01: Cache Table and Operations

**As a** system component
**I want** a reliable caching layer
**So that** repeated operations are fast and API-efficient

**Acceptance Criteria:**
- [ ] Cache entries stored with key, value, TTL
- [ ] Get/set/delete operations work correctly
- [ ] Expired entries not returned
- [ ] Cache cleanup runs periodically
- [ ] Hit count tracked for analytics

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-002-01-T1 | Create cache table in schema | 1h | P0 |
| DA-002-01-T2 | Implement CacheRepository | 4h | P0 |
| DA-002-01-T3 | Add TTL-based expiration | 2h | P0 |
| DA-002-01-T4 | Create background cleanup job | 2h | P1 |
| DA-002-01-T5 | Add cache decorator for functions | 2h | P1 |

**Code Pattern - Cache Repository:**

```typescript
// src/data/repositories/cache.repository.ts
import type Database from 'better-sqlite3';

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  content_type: string;
  expires_at: number;
  hit_count: number;
}

export class CacheRepository {
  constructor(private db: Database.Database) {}

  get<T>(key: string): T | undefined {
    const now = Math.floor(Date.now() / 1000);

    const entry = this.db.prepare(`
      SELECT value, content_type FROM cache
      WHERE key = ? AND expires_at > ?
    `).get(key, now) as { value: string; content_type: string } | undefined;

    if (!entry) return undefined;

    // Update hit count
    this.db.prepare(`
      UPDATE cache SET hit_count = hit_count + 1, last_hit_at = ?
      WHERE key = ?
    `).run(now, key);

    return JSON.parse(entry.value) as T;
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttlSeconds;
    const jsonValue = JSON.stringify(value);

    this.db.prepare(`
      INSERT OR REPLACE INTO cache (key, value, content_type, expires_at, created_at, hit_count)
      VALUES (?, ?, 'json', ?, ?, 0)
    `).run(key, jsonValue, expiresAt, now);
  }

  delete(key: string): boolean {
    const result = this.db.prepare(`DELETE FROM cache WHERE key = ?`).run(key);
    return result.changes > 0;
  }

  deletePattern(pattern: string): number {
    const result = this.db.prepare(`
      DELETE FROM cache WHERE key LIKE ?
    `).run(pattern.replace('*', '%'));
    return result.changes;
  }

  cleanup(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare(`
      DELETE FROM cache WHERE expires_at <= ?
    `).run(now);
    return result.changes;
  }
}
```

**Code Pattern - Cache Decorator:**

```typescript
// src/data/cache/cache-decorator.ts
import type { CacheRepository } from '../repositories/cache.repository';

export interface CacheConfig {
  ttlSeconds: number;
  keyPrefix: string;
}

export function withCache<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  cache: CacheRepository,
  config: CacheConfig
): T {
  return (async (...args: Parameters<T>) => {
    const cacheKey = `${config.keyPrefix}:${JSON.stringify(args)}`;

    // Try cache first
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Execute function
    const result = await fn(...args);

    // Store in cache
    cache.set(cacheKey, result, config.ttlSeconds);

    return result;
  }) as T;
}
```

---

## Phase 1: Foundation + Safety (Weeks 9-12)

### Epic DA-003: Sync Infrastructure

**Description:** Implement multi-source sync pipeline for indexing skills from GitHub, SkillsMP, claude-plugins.dev, and mcp.so.

**Business Value:** Populates the skill index from fragmented sources, enabling unified search.

**Dependencies:** DA-001 (Database Foundation), DA-002 (Caching)

**Definition of Done:**
- [ ] GitHub sync adapter fetches skills via API
- [ ] Scraping adapters work for 3 aggregator sources
- [ ] Deduplication prevents duplicate skills
- [ ] Rate limiting prevents API throttling
- [ ] 25,000+ skills indexed in <30 minutes (batch)
- [ ] Incremental sync completes in <2 minutes

---

#### Story DA-003-01: Sync State Machine

**As a** sync system
**I want** a robust state machine for sync operations
**So that** syncs can be resumed after failures

**Acceptance Criteria:**
- [ ] Sync state tracked per source
- [ ] States: IDLE, PREPARING, FETCHING, PROCESSING, STORING, SUCCESS, FAILURE
- [ ] Failed syncs can be retried
- [ ] Cursors/ETags preserved for incremental sync
- [ ] Error count tracked with backoff

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-003-01-T1 | Design sync state machine | 2h | P0 |
| DA-003-01-T2 | Create SyncStateRepository | 2h | P0 |
| DA-003-01-T3 | Implement state transitions | 4h | P0 |
| DA-003-01-T4 | Add retry with exponential backoff | 2h | P0 |
| DA-003-01-T5 | Create sync scheduler | 4h | P1 |

**Code Pattern - Sync State:**

```typescript
// src/sync/sync-state.ts
export type SyncState =
  | 'idle'
  | 'preparing'
  | 'fetching'
  | 'processing'
  | 'storing'
  | 'success'
  | 'failure';

export interface SyncStatus {
  source_id: string;
  state: SyncState;
  last_full_sync: string | null;
  last_incremental_sync: string | null;
  etag: string | null;
  cursor: string | null;
  skills_synced: number;
  skills_added: number;
  skills_updated: number;
  error_count: number;
  last_error: string | null;
}

export class SyncStateManager {
  constructor(private db: Database.Database) {}

  getState(sourceId: string): SyncStatus {
    const state = this.db.prepare(`
      SELECT * FROM sync_state WHERE source_id = ?
    `).get(sourceId) as SyncStatus | undefined;

    return state ?? {
      source_id: sourceId,
      state: 'idle',
      last_full_sync: null,
      last_incremental_sync: null,
      etag: null,
      cursor: null,
      skills_synced: 0,
      skills_added: 0,
      skills_updated: 0,
      error_count: 0,
      last_error: null,
    };
  }

  transition(sourceId: string, newState: SyncState, metadata: Partial<SyncStatus> = {}): void {
    const validTransitions: Record<SyncState, SyncState[]> = {
      idle: ['preparing'],
      preparing: ['fetching', 'failure'],
      fetching: ['processing', 'failure'],
      processing: ['storing', 'failure'],
      storing: ['success', 'failure'],
      success: ['idle'],
      failure: ['idle', 'preparing'],
    };

    const current = this.getState(sourceId);
    if (!validTransitions[current.state].includes(newState)) {
      throw new Error(`Invalid transition from ${current.state} to ${newState}`);
    }

    this.db.prepare(`
      INSERT INTO sync_state (source_id, state, ${Object.keys(metadata).join(', ')})
      VALUES (@source_id, @state, ${Object.keys(metadata).map(k => '@' + k).join(', ')})
      ON CONFLICT(source_id) DO UPDATE SET
        state = @state,
        ${Object.keys(metadata).map(k => `${k} = @${k}`).join(', ')}
    `).run({ source_id: sourceId, state: newState, ...metadata });
  }
}
```

---

#### Story DA-003-02: GitHub Sync Adapter

**As a** sync pipeline
**I want** to fetch skills from GitHub API
**So that** the primary source of skills is indexed

**Acceptance Criteria:**
- [ ] Fetch repositories with SKILL.md or claude.md patterns
- [ ] Extract metadata: stars, forks, license, topics
- [ ] Handle rate limiting with token rotation
- [ ] Support both full and incremental sync
- [ ] Process 5,000 repos per hour with rate limits

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-003-02-T1 | Create GitHub API client | 4h | P0 |
| DA-003-02-T2 | Implement repository search query | 2h | P0 |
| DA-003-02-T3 | Add rate limit handling | 2h | P0 |
| DA-003-02-T4 | Extract skill metadata from repos | 4h | P0 |
| DA-003-02-T5 | Implement incremental sync with events API | 4h | P1 |
| DA-003-02-T6 | Add token rotation support | 2h | P1 |

**Code Pattern - GitHub Adapter:**

```typescript
// src/sync/adapters/github.adapter.ts
import { Octokit } from '@octokit/rest';
import type { SkillDTO } from '../types';

export class GitHubSyncAdapter {
  private octokit: Octokit;
  private rateLimit: { remaining: number; reset: Date } | null = null;

  constructor(private token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async *searchSkillRepositories(query = 'path:SKILL.md OR path:.claude/commands'): AsyncGenerator<SkillDTO> {
    let page = 1;
    const perPage = 100;

    while (true) {
      await this.checkRateLimit();

      const response = await this.octokit.search.repos({
        q: query,
        sort: 'updated',
        order: 'desc',
        per_page: perPage,
        page,
      });

      this.updateRateLimit(response.headers);

      for (const repo of response.data.items) {
        yield this.mapToSkillDTO(repo);
      }

      if (response.data.items.length < perPage) break;
      page++;
    }
  }

  private async checkRateLimit(): Promise<void> {
    if (this.rateLimit && this.rateLimit.remaining < 10) {
      const waitMs = this.rateLimit.reset.getTime() - Date.now() + 1000;
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }

  private updateRateLimit(headers: Record<string, string>): void {
    this.rateLimit = {
      remaining: parseInt(headers['x-ratelimit-remaining'] ?? '5000', 10),
      reset: new Date(parseInt(headers['x-ratelimit-reset'] ?? '0', 10) * 1000),
    };
  }

  private mapToSkillDTO(repo: {
    full_name: string;
    description: string | null;
    html_url: string;
    stargazers_count: number;
    owner: { login: string };
  }): SkillDTO {
    return {
      id: `github:${repo.full_name}`,
      name: repo.full_name.split('/')[1],
      description: repo.description ?? '',
      source: 'github',
      repo_url: repo.html_url,
      author_id: `github:${repo.owner.login}`,
      github_stars: repo.stargazers_count,
    };
  }
}
```

---

#### Story DA-003-03: Deduplication Engine

**As a** sync pipeline
**I want** to detect and handle duplicate skills
**So that** the index contains unique entries

**Acceptance Criteria:**
- [ ] Dedup by repo_url (primary)
- [ ] Handle same skill from multiple aggregators
- [ ] Source priority determines canonical entry
- [ ] Merge metadata from multiple sources
- [ ] Track duplicates for analytics

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-003-03-T1 | Implement repo_url deduplication | 2h | P0 |
| DA-003-03-T2 | Create source priority resolver | 2h | P0 |
| DA-003-03-T3 | Build metadata merger | 4h | P0 |
| DA-003-03-T4 | Add duplicate tracking table | 2h | P1 |

**Code Pattern - Deduplication:**

```typescript
// src/sync/deduplication.ts
export interface SourcePriority {
  [source: string]: number;
}

const SOURCE_PRIORITY: SourcePriority = {
  'anthropic-official': 100,
  'github': 80,
  'mcp-so': 60,
  'claude-plugins': 40,
  'skillsmp': 20,
};

export class DeduplicationEngine {
  constructor(private db: Database.Database) {}

  processSkill(incoming: SkillDTO): { action: 'insert' | 'update' | 'skip'; skill: SkillDTO } {
    // Check for existing by repo_url
    const existing = this.db.prepare(`
      SELECT id, source_id FROM skills WHERE repo_url = ? AND deleted_at IS NULL
    `).get(incoming.repo_url) as { id: string; source_id: string } | undefined;

    if (!existing) {
      return { action: 'insert', skill: incoming };
    }

    // Compare source priorities
    const existingPriority = SOURCE_PRIORITY[existing.source_id] ?? 0;
    const incomingPriority = SOURCE_PRIORITY[incoming.source] ?? 0;

    if (incomingPriority > existingPriority) {
      // Higher priority source wins - update
      return { action: 'update', skill: { ...incoming, id: existing.id } };
    }

    if (incomingPriority === existingPriority) {
      // Same priority - merge metadata, prefer newer
      return { action: 'update', skill: this.mergeMetadata(existing.id, incoming) };
    }

    // Lower priority - skip
    return { action: 'skip', skill: incoming };
  }

  private mergeMetadata(existingId: string, incoming: SkillDTO): SkillDTO {
    const existing = this.db.prepare(`SELECT * FROM skills WHERE id = ?`).get(existingId) as Skill;

    return {
      ...incoming,
      id: existingId,
      // Prefer higher values for metrics
      github_stars: Math.max(existing.github_stars ?? 0, incoming.github_stars ?? 0),
      // Prefer non-null descriptions
      description: incoming.description || existing.description,
      // Merge categories (union)
      categories: [...new Set([...(existing.categories ?? []), ...(incoming.categories ?? [])])],
    };
  }
}
```

---

### Epic DA-004: Quality Scoring

**Description:** Implement skill quality scoring algorithm based on documentation, popularity, maintenance, and author reputation.

**Business Value:** Enables quality-based ranking and trust signals for users.

**Dependencies:** DA-003 (Sync Infrastructure)

**Definition of Done:**
- [ ] Quality score calculated for all skills (0.0 - 1.0)
- [ ] Four subscores: documentation, popularity, maintenance, author
- [ ] Scores correlate with expert assessment (r > 0.5)
- [ ] Scoring runs in batch and on-demand
- [ ] Score breakdown visible to users

---

#### Story DA-004-01: Scoring Algorithm Implementation

**As a** quality system
**I want** to calculate composite quality scores
**So that** users can identify high-quality skills

**Acceptance Criteria:**
- [ ] Documentation score based on README length, SKILL.md presence, examples
- [ ] Popularity score from stars, forks, downloads
- [ ] Maintenance score from recency, commit frequency, issue response
- [ ] Author score from verification, total stars, skill count
- [ ] Final score = weighted average (configurable)

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-004-01-T1 | Implement documentation scorer | 4h | P0 |
| DA-004-01-T2 | Implement popularity scorer | 2h | P0 |
| DA-004-01-T3 | Implement maintenance scorer | 4h | P0 |
| DA-004-01-T4 | Implement author reputation scorer | 2h | P0 |
| DA-004-01-T5 | Create weighted composite scorer | 2h | P0 |
| DA-004-01-T6 | Add batch scoring job | 2h | P1 |

**Code Pattern - Quality Scorer:**

```typescript
// src/scoring/quality-scorer.ts
export interface QualityBreakdown {
  documentation: number;  // 0.0 - 0.25
  popularity: number;     // 0.0 - 0.25
  maintenance: number;    // 0.0 - 0.25
  author: number;         // 0.0 - 0.25
  total: number;          // 0.0 - 1.0
}

export interface ScoringWeights {
  documentation: number;
  popularity: number;
  maintenance: number;
  author: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  documentation: 0.30,
  popularity: 0.25,
  maintenance: 0.25,
  author: 0.20,
};

export class QualityScorer {
  constructor(private weights: ScoringWeights = DEFAULT_WEIGHTS) {}

  score(skill: SkillWithMetrics): QualityBreakdown {
    const documentation = this.scoreDocumentation(skill);
    const popularity = this.scorePopularity(skill);
    const maintenance = this.scoreMaintenance(skill);
    const author = this.scoreAuthor(skill);

    const total =
      documentation * this.weights.documentation +
      popularity * this.weights.popularity +
      maintenance * this.weights.maintenance +
      author * this.weights.author;

    return {
      documentation: documentation * 0.25,
      popularity: popularity * 0.25,
      maintenance: maintenance * 0.25,
      author: author * 0.25,
      total: Math.min(1.0, total),
    };
  }

  private scoreDocumentation(skill: SkillWithMetrics): number {
    let score = 0;

    // README length (0-0.3)
    const readmeScore = Math.min(1, (skill.readme_length ?? 0) / 2000);
    score += readmeScore * 0.3;

    // SKILL.md presence (0-0.3)
    if (skill.has_skill_md) {
      score += 0.3;
    }

    // Examples (0-0.2)
    if (skill.has_examples) {
      score += 0.2;
    }

    // Tests (0-0.2)
    if (skill.has_tests) {
      score += 0.2;
    }

    return Math.min(1, score);
  }

  private scorePopularity(skill: SkillWithMetrics): number {
    const stars = skill.github_stars ?? 0;

    // Logarithmic scaling: 10 stars = 0.3, 100 = 0.6, 1000 = 0.9
    if (stars === 0) return 0;
    return Math.min(1, Math.log10(stars) / 3.5);
  }

  private scoreMaintenance(skill: SkillWithMetrics): number {
    let score = 0;

    // Recency (0-0.5)
    if (skill.github_pushed_at) {
      const daysSinceUpdate = (Date.now() - new Date(skill.github_pushed_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < 30) score += 0.5;
      else if (daysSinceUpdate < 90) score += 0.3;
      else if (daysSinceUpdate < 365) score += 0.15;
    }

    // License (0-0.25)
    if (skill.github_license) {
      score += 0.25;
    }

    // Low issue count relative to stars (0-0.25)
    const issueRatio = (skill.github_open_issues ?? 0) / Math.max(1, skill.github_stars ?? 1);
    if (issueRatio < 0.1) score += 0.25;
    else if (issueRatio < 0.2) score += 0.15;

    return Math.min(1, score);
  }

  private scoreAuthor(skill: SkillWithMetrics): number {
    let score = 0;

    // Verified author (0-0.4)
    if (skill.author?.verified) {
      score += 0.4;
    }

    // Author reputation (0-0.3)
    const reputation = skill.author?.reputation_score ?? 0;
    score += Math.min(0.3, reputation * 0.3);

    // Multiple skills (0-0.3)
    const skillCount = skill.author?.skill_count ?? 0;
    if (skillCount >= 5) score += 0.3;
    else if (skillCount >= 2) score += 0.15;

    return Math.min(1, score);
  }
}
```

---

## Phase 2: Recommendations + Entry Points (Weeks 13-16)

### Epic DA-005: Semantic Search with Embeddings

**Description:** Implement vector embeddings for semantic skill search beyond keyword matching.

**Business Value:** Enables natural language queries like "help me write better tests" to find relevant skills.

**Dependencies:** DA-001 (Database), DA-003 (Sync)

**Definition of Done:**
- [ ] Embeddings generated for all skill descriptions
- [ ] Memory-mapped embedding storage for performance
- [ ] Cosine similarity search in <200ms for 50K skills
- [ ] Hybrid search fuses FTS5 and semantic results
- [ ] RRF (Reciprocal Rank Fusion) for score combination

---

#### Story DA-005-01: Embedding Generation Pipeline

**As a** semantic search system
**I want** to generate embeddings for skill content
**So that** natural language queries work

**Acceptance Criteria:**
- [ ] Use all-MiniLM-L6-v2 model (384 dimensions)
- [ ] Batch processing for efficiency
- [ ] Incremental updates for new/changed skills
- [ ] Embeddings stored in binary format
- [ ] Memory-mapped access for search

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-005-01-T1 | Set up @xenova/transformers runtime | 4h | P0 |
| DA-005-01-T2 | Create embedding generation service | 4h | P0 |
| DA-005-01-T3 | Implement binary file format | 4h | P0 |
| DA-005-01-T4 | Build memory-mapped reader | 4h | P0 |
| DA-005-01-T5 | Add incremental update logic | 2h | P1 |
| DA-005-01-T6 | Create embedding queue for batch processing | 2h | P1 |

**Code Pattern - Embedding Service:**

```typescript
// src/embeddings/embedding-service.ts
import { pipeline, Pipeline } from '@xenova/transformers';

export class EmbeddingService {
  private model: Pipeline | null = null;
  private readonly modelId = 'Xenova/all-MiniLM-L6-v2';
  private readonly dimensions = 384;

  async initialize(): Promise<void> {
    if (this.model) return;
    this.model = await pipeline('feature-extraction', this.modelId);
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.model) {
      await this.initialize();
    }

    const output = await this.model!(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.model) {
      await this.initialize();
    }

    const results: Float32Array[] = [];

    // Process in chunks to manage memory
    const chunkSize = 32;
    for (let i = 0; i < texts.length; i += chunkSize) {
      const chunk = texts.slice(i, i + chunkSize);
      const outputs = await Promise.all(
        chunk.map(text => this.model!(text, { pooling: 'mean', normalize: true }))
      );
      results.push(...outputs.map(o => new Float32Array(o.data)));
    }

    return results;
  }
}
```

**Code Pattern - Embedding Storage:**

```typescript
// src/embeddings/embedding-store.ts
import { openSync, closeSync, writeSync, readSync, fstatSync } from 'fs';

const MAGIC = 'CDEMBED1';
const HEADER_SIZE = 144;

export class EmbeddingStore {
  private fd: number | null = null;
  private header: {
    version: number;
    dimensions: number;
    count: number;
    modelId: string;
  } | null = null;
  private index: Map<string, number> = new Map();

  constructor(private path: string) {}

  open(): void {
    this.fd = openSync(this.path, 'r');
    this.readHeader();
    this.readIndex();
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  getEmbedding(skillId: string): Float32Array | undefined {
    const offset = this.index.get(skillId);
    if (offset === undefined || this.fd === null || this.header === null) {
      return undefined;
    }

    const buffer = Buffer.alloc(this.header.dimensions * 4);
    readSync(this.fd, buffer, 0, buffer.length, offset);
    return new Float32Array(buffer.buffer);
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  searchSimilar(queryEmbedding: Float32Array, topK = 10): Array<{ id: string; score: number }> {
    const results: Array<{ id: string; score: number }> = [];

    for (const [id, offset] of this.index) {
      const embedding = this.getEmbedding(id);
      if (embedding) {
        const score = this.cosineSimilarity(queryEmbedding, embedding);
        results.push({ id, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private readHeader(): void {
    // Implementation reads fixed-size header
  }

  private readIndex(): void {
    // Implementation reads skill_id -> offset mapping
  }
}
```

---

#### Story DA-005-02: Hybrid Search Implementation

**As a** search system
**I want** to combine FTS5 and semantic search
**So that** both keyword and conceptual matches are found

**Acceptance Criteria:**
- [ ] Parallel execution of FTS5 and semantic search
- [ ] Reciprocal Rank Fusion (RRF) combines results
- [ ] Configurable weights for each method
- [ ] Total search time <300ms for 50K skills
- [ ] De-duplication of results

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-005-02-T1 | Implement parallel search execution | 2h | P0 |
| DA-005-02-T2 | Build RRF score combiner | 2h | P0 |
| DA-005-02-T3 | Add result deduplication | 1h | P0 |
| DA-005-02-T4 | Create configurable weights | 1h | P1 |
| DA-005-02-T5 | Add search benchmarks | 2h | P1 |

**Code Pattern - Hybrid Search:**

```typescript
// src/search/hybrid-search.ts
export interface HybridSearchResult {
  id: string;
  name: string;
  description: string;
  ftsScore: number | null;
  semanticScore: number | null;
  fusedScore: number;
}

export class HybridSearch {
  constructor(
    private ftsSearch: SkillSearchRepository,
    private embeddingStore: EmbeddingStore,
    private embeddingService: EmbeddingService,
    private rrfK = 60  // RRF constant
  ) {}

  async search(query: string, topK = 20): Promise<HybridSearchResult[]> {
    // Execute both searches in parallel
    const [ftsResults, semanticResults] = await Promise.all([
      this.ftsSearch.search(query, { limit: topK * 2 }),
      this.semanticSearch(query, topK * 2),
    ]);

    // Build rank maps
    const ftsRanks = new Map<string, number>();
    ftsResults.forEach((r, i) => ftsRanks.set(r.id, i + 1));

    const semanticRanks = new Map<string, number>();
    semanticResults.forEach((r, i) => semanticRanks.set(r.id, i + 1));

    // Collect all unique IDs
    const allIds = new Set([...ftsRanks.keys(), ...semanticRanks.keys()]);

    // Calculate RRF scores
    const results: HybridSearchResult[] = [];
    for (const id of allIds) {
      const ftsRank = ftsRanks.get(id);
      const semanticRank = semanticRanks.get(id);

      let fusedScore = 0;
      if (ftsRank) {
        fusedScore += 1 / (this.rrfK + ftsRank);
      }
      if (semanticRank) {
        fusedScore += 1 / (this.rrfK + semanticRank);
      }

      // Get full skill data
      const skill = this.getSkillData(id);

      results.push({
        id,
        name: skill.name,
        description: skill.description,
        ftsScore: ftsRank ? 1 / ftsRank : null,
        semanticScore: semanticRank ? 1 / semanticRank : null,
        fusedScore,
      });
    }

    return results
      .sort((a, b) => b.fusedScore - a.fusedScore)
      .slice(0, topK);
  }

  private async semanticSearch(query: string, topK: number): Promise<Array<{ id: string; score: number }>> {
    const queryEmbedding = await this.embeddingService.embed(query);
    return this.embeddingStore.searchSimilar(queryEmbedding, topK);
  }

  private getSkillData(id: string): { name: string; description: string } {
    // Fetch from skills table
    return { name: '', description: '' };
  }
}
```

---

### Epic DA-006: Telemetry Data Layer

**Description:** Implement privacy-preserving telemetry storage with local queue and optional transmission.

**Business Value:** Enables social proof features and product improvements while respecting privacy.

**Dependencies:** DA-001 (Database Foundation)

**Definition of Done:**
- [ ] Telemetry events stored locally in SQLite
- [ ] Events queued for batch transmission
- [ ] User can view pending events
- [ ] Opt-out completely disables collection
- [ ] No PII stored or transmitted

---

#### Story DA-006-01: Telemetry Queue Implementation

**As a** telemetry system
**I want** to queue events locally
**So that** they can be transmitted in batches

**Acceptance Criteria:**
- [ ] Events stored in SQLite queue table
- [ ] Events have unique IDs for deduplication
- [ ] Batch transmission with retry logic
- [ ] Queue cleanup after successful transmission
- [ ] Size limits to prevent unbounded growth

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| DA-006-01-T1 | Create telemetry queue table | 1h | P0 |
| DA-006-01-T2 | Implement TelemetryQueueRepository | 2h | P0 |
| DA-006-01-T3 | Build batch transmission service | 4h | P0 |
| DA-006-01-T4 | Add queue size monitoring | 2h | P1 |
| DA-006-01-T5 | Implement cleanup job | 1h | P1 |

**Code Pattern - Telemetry Queue:**

```typescript
// src/telemetry/telemetry-queue.ts
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

export interface TelemetryEvent {
  event_id: string;
  event_type: string;
  timestamp: string;
  anonymous_id: string;
  session_id: string;
  payload: Record<string, unknown>;
}

export class TelemetryQueue {
  private enabled: boolean = true;

  constructor(private db: Database.Database) {
    this.loadConfig();
  }

  private loadConfig(): void {
    // Load from user preferences
    const pref = this.db.prepare(`
      SELECT value FROM user_preferences WHERE key = 'telemetry_enabled'
    `).get() as { value: string } | undefined;
    this.enabled = pref?.value !== 'false';
  }

  enqueue(eventType: string, payload: Record<string, unknown>): void {
    if (!this.enabled) return;

    const event: TelemetryEvent = {
      event_id: randomUUID(),
      event_type: eventType,
      timestamp: new Date().toISOString(),
      anonymous_id: this.getAnonymousId(),
      session_id: this.getSessionId(),
      payload: this.sanitizePayload(payload),
    };

    this.db.prepare(`
      INSERT INTO telemetry_queue (event_id, event_type, timestamp, anonymous_id, session_id, payload, status)
      VALUES (@event_id, @event_type, @timestamp, @anonymous_id, @session_id, @payload, 'pending')
    `).run({
      ...event,
      payload: JSON.stringify(event.payload),
    });
  }

  getPendingEvents(limit = 100): TelemetryEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM telemetry_queue WHERE status = 'pending'
      ORDER BY timestamp ASC LIMIT ?
    `).all(limit) as Array<TelemetryEvent & { payload: string }>;

    return rows.map(r => ({
      ...r,
      payload: JSON.parse(r.payload),
    }));
  }

  markTransmitted(eventIds: string[]): void {
    if (eventIds.length === 0) return;

    const placeholders = eventIds.map(() => '?').join(',');
    this.db.prepare(`
      DELETE FROM telemetry_queue WHERE event_id IN (${placeholders})
    `).run(...eventIds);
  }

  private getAnonymousId(): string {
    // Hash of machine-specific identifier
    const machineId = process.env.HOME ?? process.env.USERPROFILE ?? 'unknown';
    return createHash('sha256').update(machineId + 'discovery-hub').digest('hex').slice(0, 16);
  }

  private getSessionId(): string {
    // Session ID stored in memory, regenerated on restart
    return process.env.DISCOVERY_SESSION_ID ?? randomUUID();
  }

  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    // Remove any potential PII
    const sanitized = { ...payload };
    delete sanitized['path'];
    delete sanitized['file'];
    delete sanitized['query'];  // Don't log search queries
    return sanitized;
  }
}
```

---

## Cross-Cutting Concerns

### Migration Strategy

All schema changes must go through the migration framework:

```typescript
// src/data/migrations/runner.ts
export async function runMigrations(db: Database.Database): Promise<void> {
  // Create migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get current version
  const current = db.prepare(`
    SELECT MAX(version) as version FROM schema_migrations
  `).get() as { version: number | null };
  const currentVersion = current.version ?? 0;

  // Run pending migrations
  const migrations = await loadMigrations();
  const pending = migrations.filter(m => m.version > currentVersion);

  for (const migration of pending) {
    db.exec('BEGIN TRANSACTION');
    try {
      migration.up(db);
      db.prepare(`
        INSERT INTO schema_migrations (version, description) VALUES (?, ?)
      `).run(migration.version, migration.description);
      db.exec('COMMIT');
      console.log(`Applied migration V${migration.version}: ${migration.description}`);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
```

### Performance Monitoring

Add query performance tracking:

```typescript
// src/data/performance.ts
export function wrapWithTiming<T>(
  name: string,
  fn: () => T,
  threshold = 100  // Log if >100ms
): T {
  const start = performance.now();
  const result = fn();
  const duration = performance.now() - start;

  if (duration > threshold) {
    console.warn(`Slow query: ${name} took ${duration.toFixed(2)}ms`);
  }

  return result;
}
```

### Backup Strategy

Local database backup before migrations:

```typescript
// src/data/backup.ts
import { copyFileSync } from 'fs';

export function backupDatabase(dbPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.backup.${timestamp}`;
  copyFileSync(dbPath, backupPath);
  return backupPath;
}
```

---

## Appendix

### A. Storage Size Projections

| Phase | Skills | SQLite | Embeddings | Cache | User Data | Total |
|-------|--------|--------|------------|-------|-----------|-------|
| Phase 0 | 1,000 | 5 MB | 20 MB | 10 MB | 1 MB | ~36 MB |
| Phase 1 | 10,000 | 15 MB | 100 MB | 25 MB | 2 MB | ~142 MB |
| Phase 2 | 25,000 | 30 MB | 150 MB | 40 MB | 5 MB | ~225 MB |

### B. Performance Targets

| Operation | Target | Strategy |
|-----------|--------|----------|
| FTS Search | <50ms | SQLite FTS5 + indexes |
| Semantic Search | <200ms | Memory-mapped embeddings |
| Hybrid Search | <300ms | Parallel + RRF fusion |
| Skill Detail | <100ms | Cache + prepared statements |
| Full Sync (50K) | <30min | Parallel + batching |
| Incremental Sync | <2min | Events API + deltas |

### C. Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Database | SQLite 3.45+ | FTS5 + WAL, zero dependencies |
| ORM | better-sqlite3 | Sync API, better performance |
| Embeddings | all-MiniLM-L6-v2 | 384 dims, fast, good quality |
| Embedding Runtime | @xenova/transformers | WASM, no Python deps |
| HTTP Client | undici | Modern, fast, built-in |

---

## References

- [Data Architecture Design](/docs/architecture/data.md)
- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [PRD v3](/docs/prd-v3.md)
- [Skill Activation Failure RCA](/docs/research/skill-activation-failure-rca.md)

---

*Document Version: 1.0*
*Last Updated: December 26, 2025*
*Next Review: After Phase 0 completion*
