# Data Architecture

> **Navigation**: [Technical Overview](../technical/overview.md) | [PRD v3](../prd-v3.md) | [Schema](../technical/data/schema.md)

**Version:** 1.0
**Last Updated:** December 26, 2025
**Author:** Data Architect
**Status:** Design Complete - Pending Implementation

---

## Executive Summary

The Claude Discovery Hub requires a data architecture that supports:
- **50,000+ skills** indexed from fragmented sources
- **Local-first operation** with offline capability
- **Sub-2-second search latency** for discovery UX
- **Privacy-preserving telemetry** with clear opt-out
- **Incremental sync** to minimize bandwidth and API costs

This document defines the complete data architecture including entity models, storage strategy, sync mechanisms, data flow pipelines, and telemetry design.

---

## 1. Data Models

### 1.1 Core Entity Relationship Diagram

```
+=====================================================================+
|                      ENTITY RELATIONSHIP MODEL                       |
+=====================================================================+

                          +------------------+
                          |     SOURCE       |
                          +------------------+
                          | id (PK)          |
                          | name             |
                          | base_url         |
                          | api_type         |
                          | rate_limit       |
                          | last_sync        |
                          +------------------+
                                   |
                                   | 1:N
                                   v
+------------------+      +------------------+      +------------------+
|    AUTHOR        |<---->|     SKILL        |<---->|   CATEGORY       |
+------------------+  1:N +------------------+  N:M +------------------+
| id (PK)          |      | id (PK)          |      | id (PK)          |
| name             |      | name             |      | name             |
| github_username  |      | description      |      | display_name     |
| avatar_url       |      | author_id (FK)   |      | parent_id (FK)   |
| verified         |      | source_id (FK)   |      | skill_count      |
| skill_count      |      | repo_url         |      +------------------+
| reputation_score |      | stars            |
+------------------+      | quality_score    |      +------------------+
                          | trust_tier       |      |   TECHNOLOGY     |
                          | embedding_id     |      +------------------+
                          +------------------+      | id (PK)          |
                                   |                | name             |
                                   | 1:N            | type (lang/fw)   |
                                   v                | skill_count      |
                          +------------------+      +------------------+
                          |  SKILL_VERSION   |             ^
                          +------------------+             |
                          | id (PK)          |             | N:M
                          | skill_id (FK)    |             |
                          | version          |      +------------------+
                          | content_hash     |      | SKILL_TECHNOLOGY |
                          | breaking_changes |      +------------------+
                          | created_at       |      | skill_id (FK)    |
                          +------------------+      | technology_id(FK)|
                                                   | confidence       |
                                                   +------------------+

+------------------+      +------------------+      +------------------+
|     USER         |----->|  INTERACTION     |<-----|     SKILL        |
+------------------+  1:N +------------------+  N:1 +------------------+
| id (PK)          |      | id (PK)          |
| anonymous_id     |      | user_id (FK)     |
| created_at       |      | skill_id (FK)    |
| preferences      |      | action_type      |
| installed_skills |      | timestamp        |
+------------------+      | context (JSON)   |
        |                 | session_id       |
        | 1:N             +------------------+
        v
+------------------+
| USER_PREFERENCE  |
+------------------+
| user_id (FK)     |
| key              |
| value            |
| updated_at       |
+------------------+
```

### 1.2 Skill Entity Model

The Skill entity is the central data model, representing a discoverable capability.

```typescript
interface Skill {
  // === Primary Identity ===
  id: string;                      // Globally unique: "source/author/name"
  name: string;                    // Human-readable display name
  slug: string;                    // URL-safe identifier

  // === Content ===
  description: string;             // Short description (max 500 chars)
  long_description?: string;       // Full README content
  search_text: string;             // Concatenated searchable content

  // === Source Tracking ===
  source: SkillSource;             // Origin platform
  source_id: string;               // ID in source system
  repo_url: string;                // Canonical repository URL
  homepage_url?: string;           // Project homepage if different

  // === Author Information ===
  author: Author;                  // Author entity reference
  author_id: string;               // Author FK

  // === Versioning ===
  current_version: string;         // Semantic version or commit hash
  version_history: SkillVersion[]; // Version tracking

  // === Quality Signals ===
  quality_score: number;           // 0.0 - 1.0 composite score
  quality_breakdown: {
    documentation: number;         // 0.0 - 0.25
    popularity: number;            // 0.0 - 0.25 (stars, downloads)
    maintenance: number;           // 0.0 - 0.25 (recency, issues)
    author_reputation: number;     // 0.0 - 0.25
  };

  // === Trust & Security ===
  trust_tier: TrustTier;           // 'official' | 'verified' | 'community' | 'unverified'
  security_scan: {
    status: ScanStatus;            // 'passed' | 'warning' | 'failed' | 'pending'
    last_scanned: string;          // ISO timestamp
    findings: SecurityFinding[];
  };

  // === GitHub Metrics (if applicable) ===
  github_metrics?: {
    stars: number;
    forks: number;
    watchers: number;
    open_issues: number;
    license: string | null;
    primary_language: string;
    topics: string[];
    created_at: string;
    updated_at: string;
    pushed_at: string;
  };

  // === Content Analysis ===
  content_analysis: {
    readme_length: number;
    has_skill_md: boolean;
    skill_md_quality: number;      // 0.0 - 1.0
    has_tests: boolean;
    has_examples: boolean;
    estimated_char_budget: number; // For activation budget planning
  };

  // === Classification ===
  categories: string[];            // ['testing', 'documentation']
  technologies: Technology[];      // Detected/declared tech stack
  use_cases: string[];             // ['unit-testing', 'api-testing']

  // === Semantic Search ===
  embedding_id: number;            // Index into embeddings file
  embedding_version: string;       // Model version used

  // === Indexing Metadata ===
  indexed_at: string;              // First indexed timestamp
  last_updated_at: string;         // Last sync timestamp
  last_scored_at: string;          // Last quality score calculation

  // === Relationships ===
  related_skills: string[];        // Similar skill IDs
  conflicts_with: string[];        // Known conflicting skills
  replaces: string[];              // Superseded skills
}

type SkillSource = 'github' | 'claude-plugins' | 'skillsmp' | 'mcp-so' | 'anthropic-official';
type TrustTier = 'official' | 'verified' | 'community' | 'unverified';
type ScanStatus = 'passed' | 'warning' | 'failed' | 'pending' | 'skipped';
```

### 1.3 User Data Model

User data is stored locally with privacy as the primary concern.

```typescript
interface User {
  // === Identity (Local Only) ===
  id: string;                      // Local UUID, never transmitted
  anonymous_id: string;            // Hashed ID for telemetry (if opted in)

  // === Timestamps ===
  created_at: string;
  last_active_at: string;

  // === Preferences ===
  preferences: UserPreferences;

  // === Installation State ===
  installed_skills: InstalledSkill[];

  // === Session Tracking ===
  current_session: Session | null;
  session_history: SessionSummary[];
}

interface UserPreferences {
  // Discovery preferences
  preferred_categories: string[];
  preferred_technologies: string[];
  trust_tier_minimum: TrustTier;

  // UI preferences
  results_per_page: number;
  show_unverified_skills: boolean;
  compact_view: boolean;

  // Telemetry consent
  telemetry_enabled: boolean;
  telemetry_level: 'none' | 'basic' | 'full';

  // Notification preferences
  show_recommendations: boolean;
  recommendation_frequency: 'always' | 'daily' | 'weekly' | 'never';

  // Character budget
  budget_warning_threshold: number;  // Default: 0.8 (80%)
}

interface InstalledSkill {
  skill_id: string;
  installed_at: string;
  installed_version: string;
  installation_method: 'manual' | 'recommended' | 'cloned';
  activation_count: number;
  last_activated_at: string | null;
  health_status: 'healthy' | 'warning' | 'error' | 'unknown';
}

interface Session {
  id: string;
  started_at: string;
  project_path: string;
  detected_stack: string[];
  actions: SessionAction[];
}

interface SessionAction {
  timestamp: string;
  action_type: ActionType;
  skill_id?: string;
  metadata?: Record<string, unknown>;
}

type ActionType =
  | 'search'
  | 'view_skill'
  | 'install'
  | 'uninstall'
  | 'activate'
  | 'recommend_shown'
  | 'recommend_accepted'
  | 'recommend_dismissed'
  | 'audit_run'
  | 'conflict_detected';
```

### 1.4 Index Data Model

Optimized structures for fast search and retrieval.

```typescript
interface SkillIndex {
  // === Full-Text Search Index ===
  fts_index: FTS5Index;            // SQLite FTS5 virtual table

  // === Vector Embeddings ===
  embedding_index: EmbeddingIndex;

  // === Inverted Indexes ===
  category_index: Map<string, Set<string>>;      // category -> skill_ids
  technology_index: Map<string, Set<string>>;    // technology -> skill_ids
  author_index: Map<string, Set<string>>;        // author_id -> skill_ids
  trust_tier_index: Map<TrustTier, Set<string>>; // tier -> skill_ids

  // === Sorted Indexes ===
  by_quality: string[];            // Skill IDs sorted by quality_score DESC
  by_popularity: string[];         // Skill IDs sorted by stars DESC
  by_recency: string[];            // Skill IDs sorted by updated_at DESC

  // === Bloom Filters (Fast Negative Lookup) ===
  name_bloom: BloomFilter;         // Quick "definitely not exists" check
  repo_url_bloom: BloomFilter;     // Deduplication check
}

interface EmbeddingIndex {
  // File format for memory-mapped access
  header: {
    magic: 'CDEMBED1';             // 8 bytes
    version: number;               // 4 bytes (uint32)
    dimensions: number;            // 4 bytes (uint32) - 384 for MiniLM
    count: number;                 // 8 bytes (uint64)
    model_id: string;              // 64 bytes (null-padded)
    created_at: string;            // 32 bytes (ISO timestamp)
  };

  // Mapping section
  id_to_offset: Map<string, number>;  // skill_id -> byte offset

  // Data section
  embeddings: Float32Array;        // count * dimensions floats

  // Search configuration
  config: {
    model: 'all-MiniLM-L6-v2';
    dimensions: 384;
    similarity_metric: 'cosine';
    top_k_default: 10;
  };
}
```

---

## 2. Storage Strategy

### 2.1 Storage Architecture Diagram

```
+=====================================================================+
|                        STORAGE ARCHITECTURE                          |
+=====================================================================+

~/.claude-discovery/
|
+-- index/
|   |
|   +-- skills.db                 # SQLite database (FTS5 enabled)
|   |   +-- skills                # Core skill data
|   |   +-- skills_fts            # Full-text search index
|   |   +-- skill_categories      # Category mappings
|   |   +-- skill_technologies    # Technology mappings
|   |   +-- authors               # Author data
|   |   +-- sync_state            # Sync tracking
|   |   +-- cache                 # Cached API responses
|   |   +-- blocked_skills        # Blocklist
|   |
|   +-- embeddings/
|   |   +-- embeddings.bin        # Vector embeddings (memory-mapped)
|   |   +-- embeddings.meta.json  # Embedding metadata
|   |
|   +-- cache/
|       +-- github/               # GitHub API response cache
|       +-- search/               # Search result cache
|       +-- recommendations/      # Generated recommendations
|
+-- user/
|   |
|   +-- profile.json              # User preferences
|   +-- installed.json            # Installed skills manifest
|   +-- history.db                # Interaction history (SQLite)
|   +-- sessions/                 # Session data
|
+-- telemetry/
|   |
|   +-- queue.db                  # Pending telemetry events
|   +-- config.json               # Telemetry configuration
|
+-- config/
    |
    +-- settings.json             # Global settings
    +-- blocklist.json            # Custom blocklist additions
    +-- priorities.yaml           # Skill priority overrides
```

### 2.2 SQLite Schema (Complete)

```sql
-- ==================================================================
-- PRAGMA Configuration
-- ==================================================================
PRAGMA journal_mode = WAL;           -- Write-ahead logging for concurrency
PRAGMA synchronous = NORMAL;         -- Balance durability/performance
PRAGMA cache_size = -64000;          -- 64MB cache
PRAGMA mmap_size = 268435456;        -- 256MB memory-mapped I/O
PRAGMA temp_store = MEMORY;          -- Temp tables in memory
PRAGMA foreign_keys = ON;            -- Enforce referential integrity

-- ==================================================================
-- CORE TABLES
-- ==================================================================

-- Sources (data origin platforms)
CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_type TEXT NOT NULL,          -- 'rest', 'graphql', 'scrape'
    rate_limit_per_hour INTEGER,
    requires_auth BOOLEAN DEFAULT FALSE,
    last_full_sync TEXT,
    last_incremental_sync TEXT,
    sync_cursor TEXT,
    sync_etag TEXT,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Authors
CREATE TABLE authors (
    id TEXT PRIMARY KEY,             -- 'github:username' or 'platform:id'
    name TEXT NOT NULL,
    github_username TEXT,
    email TEXT,
    avatar_url TEXT,
    profile_url TEXT,
    verified BOOLEAN DEFAULT FALSE,
    skill_count INTEGER DEFAULT 0,
    total_stars INTEGER DEFAULT 0,
    reputation_score REAL DEFAULT 0.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_authors_github ON authors(github_username);
CREATE INDEX idx_authors_reputation ON authors(reputation_score DESC);

-- Skills (primary entity)
CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    long_description TEXT,
    search_text TEXT,

    -- Source tracking
    source_id TEXT NOT NULL REFERENCES sources(id),
    source_skill_id TEXT,
    repo_url TEXT UNIQUE NOT NULL,
    homepage_url TEXT,

    -- Author
    author_id TEXT REFERENCES authors(id),

    -- Versioning
    current_version TEXT,

    -- Quality scores (0.0 - 1.0)
    quality_score REAL,
    quality_documentation REAL,
    quality_popularity REAL,
    quality_maintenance REAL,
    quality_author REAL,

    -- Trust & Security
    trust_tier TEXT DEFAULT 'unverified',
    security_scan_status TEXT DEFAULT 'pending',
    security_scan_date TEXT,
    security_findings TEXT,          -- JSON array

    -- GitHub metrics
    github_stars INTEGER DEFAULT 0,
    github_forks INTEGER DEFAULT 0,
    github_watchers INTEGER DEFAULT 0,
    github_open_issues INTEGER DEFAULT 0,
    github_license TEXT,
    github_language TEXT,
    github_topics TEXT,              -- JSON array
    github_created_at TEXT,
    github_updated_at TEXT,
    github_pushed_at TEXT,

    -- Content analysis
    readme_length INTEGER,
    has_skill_md BOOLEAN DEFAULT FALSE,
    skill_md_quality REAL,
    has_tests BOOLEAN DEFAULT FALSE,
    has_examples BOOLEAN DEFAULT FALSE,
    estimated_char_budget INTEGER,

    -- Semantic search
    embedding_id INTEGER,
    embedding_version TEXT,

    -- Relationships
    related_skills TEXT,             -- JSON array of skill IDs
    conflicts_with TEXT,             -- JSON array of skill IDs
    replaces TEXT,                   -- JSON array of skill IDs

    -- Indexing metadata
    indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_scored_at TEXT,

    -- Soft delete
    deleted_at TEXT,

    CHECK (trust_tier IN ('official', 'verified', 'community', 'unverified')),
    CHECK (security_scan_status IN ('passed', 'warning', 'failed', 'pending', 'skipped'))
);

-- Indexes for skills table
CREATE INDEX idx_skills_quality ON skills(quality_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_skills_trust ON skills(trust_tier) WHERE deleted_at IS NULL;
CREATE INDEX idx_skills_source ON skills(source_id);
CREATE INDEX idx_skills_author ON skills(author_id);
CREATE INDEX idx_skills_updated ON skills(last_updated_at DESC);
CREATE INDEX idx_skills_stars ON skills(github_stars DESC);
CREATE INDEX idx_skills_language ON skills(github_language);

-- Full-text search
CREATE VIRTUAL TABLE skills_fts USING fts5(
    name,
    description,
    search_text,
    content='skills',
    content_rowid='rowid',
    tokenize='porter unicode61'
);

-- FTS sync triggers
CREATE TRIGGER skills_fts_insert AFTER INSERT ON skills BEGIN
    INSERT INTO skills_fts(rowid, name, description, search_text)
    VALUES (NEW.rowid, NEW.name, NEW.description, NEW.search_text);
END;

CREATE TRIGGER skills_fts_delete AFTER DELETE ON skills BEGIN
    INSERT INTO skills_fts(skills_fts, rowid, name, description, search_text)
    VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.search_text);
END;

CREATE TRIGGER skills_fts_update AFTER UPDATE OF name, description, search_text ON skills BEGIN
    INSERT INTO skills_fts(skills_fts, rowid, name, description, search_text)
    VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.search_text);
    INSERT INTO skills_fts(rowid, name, description, search_text)
    VALUES (NEW.rowid, NEW.name, NEW.description, NEW.search_text);
END;

-- Skill versions
CREATE TABLE skill_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    breaking_changes BOOLEAN DEFAULT FALSE,
    changelog TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(skill_id, version)
);

CREATE INDEX idx_versions_skill ON skill_versions(skill_id);

-- Categories
CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    parent_id TEXT REFERENCES categories(id),
    skill_count INTEGER DEFAULT 0,
    icon TEXT,
    sort_order INTEGER DEFAULT 0
);

-- Skill-Category mapping
CREATE TABLE skill_categories (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    confidence REAL DEFAULT 1.0,
    source TEXT DEFAULT 'detected',  -- 'detected', 'declared', 'manual'
    PRIMARY KEY (skill_id, category_id)
);

CREATE INDEX idx_skill_categories_category ON skill_categories(category_id);

-- Technologies
CREATE TABLE technologies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,              -- 'language', 'framework', 'tool', 'platform'
    aliases TEXT,                    -- JSON array of alternative names
    skill_count INTEGER DEFAULT 0,
    icon TEXT
);

-- Skill-Technology mapping
CREATE TABLE skill_technologies (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    technology_id TEXT NOT NULL REFERENCES technologies(id) ON DELETE CASCADE,
    confidence REAL DEFAULT 1.0,
    PRIMARY KEY (skill_id, technology_id)
);

CREATE INDEX idx_skill_technologies_tech ON skill_technologies(technology_id);

-- ==================================================================
-- BLOCKLIST & SECURITY
-- ==================================================================

CREATE TABLE blocked_skills (
    skill_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    severity TEXT DEFAULT 'warning',  -- 'warning', 'critical'
    blocked_by TEXT,                  -- 'system', 'user', 'community'
    evidence TEXT,                    -- JSON with supporting data
    blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,                  -- NULL = permanent

    CHECK (severity IN ('warning', 'critical'))
);

CREATE TABLE security_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    finding_type TEXT NOT NULL,       -- 'external_url', 'shell_command', 'obfuscation', etc.
    severity TEXT NOT NULL,           -- 'info', 'low', 'medium', 'high', 'critical'
    description TEXT NOT NULL,
    location TEXT,                    -- File/line reference
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,

    CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical'))
);

CREATE INDEX idx_security_skill ON security_findings(skill_id);
CREATE INDEX idx_security_severity ON security_findings(severity);

-- ==================================================================
-- CACHE TABLES
-- ==================================================================

CREATE TABLE cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,             -- JSON serialized
    content_type TEXT DEFAULT 'json',
    expires_at INTEGER NOT NULL,     -- Unix timestamp
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    hit_count INTEGER DEFAULT 0,
    last_hit_at INTEGER
);

CREATE INDEX idx_cache_expires ON cache(expires_at);

-- ==================================================================
-- SYNC STATE
-- ==================================================================

CREATE TABLE sync_state (
    source_id TEXT PRIMARY KEY REFERENCES sources(id),
    last_full_sync TEXT,
    last_incremental_sync TEXT,
    next_scheduled_sync TEXT,
    etag TEXT,
    cursor TEXT,
    page_token TEXT,
    skills_synced INTEGER DEFAULT 0,
    skills_added INTEGER DEFAULT 0,
    skills_updated INTEGER DEFAULT 0,
    skills_removed INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    last_error_at TEXT
);

-- ==================================================================
-- SEED DATA
-- ==================================================================

-- Default sources
INSERT INTO sources (id, name, base_url, api_type, rate_limit_per_hour) VALUES
    ('github', 'GitHub', 'https://api.github.com', 'rest', 5000),
    ('claude-plugins', 'claude-plugins.dev', 'https://claude-plugins.dev', 'scrape', 600),
    ('skillsmp', 'SkillsMP', 'https://skillsmp.com', 'scrape', 300),
    ('mcp-so', 'mcp.so', 'https://mcp.so', 'rest', 1000),
    ('anthropic-official', 'Anthropic Official', 'https://github.com/anthropics', 'rest', 5000);

-- Default categories
INSERT INTO categories (id, name, display_name, sort_order) VALUES
    ('testing', 'testing', 'Testing', 1),
    ('documentation', 'documentation', 'Documentation', 2),
    ('debugging', 'debugging', 'Debugging', 3),
    ('code-quality', 'code-quality', 'Code Quality', 4),
    ('productivity', 'productivity', 'Productivity', 5),
    ('security', 'security', 'Security', 6),
    ('devops', 'devops', 'DevOps', 7),
    ('data', 'data', 'Data & Analytics', 8),
    ('api', 'api', 'API Development', 9),
    ('frontend', 'frontend', 'Frontend', 10),
    ('backend', 'backend', 'Backend', 11),
    ('mobile', 'mobile', 'Mobile', 12);

-- Default technologies
INSERT INTO technologies (id, name, type) VALUES
    ('typescript', 'TypeScript', 'language'),
    ('javascript', 'JavaScript', 'language'),
    ('python', 'Python', 'language'),
    ('rust', 'Rust', 'language'),
    ('go', 'Go', 'language'),
    ('react', 'React', 'framework'),
    ('vue', 'Vue.js', 'framework'),
    ('nextjs', 'Next.js', 'framework'),
    ('nodejs', 'Node.js', 'platform'),
    ('docker', 'Docker', 'tool'),
    ('kubernetes', 'Kubernetes', 'platform');
```

### 2.3 Vector Embeddings Storage

```
+=====================================================================+
|                    EMBEDDING FILE FORMAT                             |
+=====================================================================+

Offset    Size      Field              Description
-------   --------  -----------------  --------------------------------
0x0000    8 bytes   magic              "CDEMBED1" (file identifier)
0x0008    4 bytes   version            Format version (uint32)
0x000C    4 bytes   dimensions         Vector dimensions (384)
0x0010    8 bytes   count              Number of embeddings (uint64)
0x0018    64 bytes  model_id           Model name (null-padded)
0x0058    32 bytes  created_at         ISO timestamp (null-padded)
0x0078    24 bytes  reserved           Future use

0x0090    variable  index_section      ID-to-offset mapping
          ...       (null-terminated skill IDs + uint64 offsets)

variable  variable  data_section       Embedding vectors
          ...       (count * dimensions * 4 bytes float32)

+----------------------------------------------------------------------+
| MEMORY MAPPING STRATEGY                                              |
+----------------------------------------------------------------------+

                   +------------------+
                   |     Header       |  <- Always loaded in memory
                   |     (144 B)      |
                   +------------------+
                   |  Index Section   |  <- Loaded on startup
                   |  (variable)      |     ~50KB for 50K skills
                   +------------------+
                   |                  |
                   |   Data Section   |  <- Memory-mapped, demand paged
                   |   (~200 MB)      |     OS manages caching
                   |                  |
                   +------------------+
```

### 2.4 Storage Size Projections

| Phase | Skills | SQLite | Embeddings | Cache | User Data | Total |
|-------|--------|--------|------------|-------|-----------|-------|
| Phase 1 | 1,000 | 5 MB | 20 MB | 10 MB | 1 MB | ~36 MB |
| Phase 2 | 10,000 | 15 MB | 100 MB | 25 MB | 2 MB | ~142 MB |
| Phase 3 | 25,000 | 30 MB | 150 MB | 40 MB | 5 MB | ~225 MB |
| Phase 4 | 50,000+ | 50 MB | 200 MB | 60 MB | 10 MB | ~320 MB |

**Per-Skill Breakdown:**

| Component | Size | Notes |
|-----------|------|-------|
| SQLite row | ~1 KB | All columns populated |
| FTS index entry | ~200 B | Tokenized content |
| Category mappings | ~50 B | Avg 2 categories |
| Technology mappings | ~50 B | Avg 2 technologies |
| Embedding vector | 1.5 KB | 384 * 4 bytes |
| **Total per skill** | ~2.8 KB | |

---

## 3. Sync Architecture

### 3.1 Multi-Source Sync Strategy

```
+=====================================================================+
|                     SYNC ARCHITECTURE                                |
+=====================================================================+

                              +-------------------+
                              |  SYNC SCHEDULER   |
                              |  (Background)     |
                              +-------------------+
                                       |
              +------------------------+------------------------+
              |                        |                        |
              v                        v                        v
    +------------------+    +------------------+    +------------------+
    | GitHub Syncer    |    | Scraper Pool     |    | MCP.so Syncer    |
    | (Rate: 5K/hr)    |    | (Rate: 10/min)   |    | (Rate: 1K/hr)    |
    +------------------+    +------------------+    +------------------+
              |                        |                        |
              v                        v                        v
    +------------------+    +------------------+    +------------------+
    | REST API         |    | - claude-plugins |    | REST API         |
    | + GraphQL        |    | - skillsmp       |    |                  |
    +------------------+    +------------------+    +------------------+
              |                        |                        |
              +------------------------+------------------------+
                                       |
                                       v
                            +-------------------+
                            | NORMALIZATION     |
                            | PIPELINE          |
                            +-------------------+
                                       |
                     +----------------++-----------------+
                     |                 |                 |
                     v                 v                 v
            +-------------+   +---------------+   +-------------+
            | DEDUPLICATOR|   | QUALITY SCORER|   | SECURITY    |
            | (repo_url)  |   |               |   | SCANNER     |
            +-------------+   +---------------+   +-------------+
                     |                 |                 |
                     +----------------++-----------------+
                                       |
                                       v
                            +-------------------+
                            | SQLite + FTS      |
                            | (UPSERT)          |
                            +-------------------+
                                       |
                                       v
                            +-------------------+
                            | EMBEDDING         |
                            | GENERATOR         |
                            | (Batch, Weekly)   |
                            +-------------------+
```

### 3.2 Source-Specific Sync Strategies

| Source | Method | Full Sync | Incremental | Rate Limiting |
|--------|--------|-----------|-------------|---------------|
| **GitHub** | REST + Events API | Weekly | Hourly | 5K/hr, token rotation |
| **claude-plugins.dev** | Web scraping | Daily | 6 hours | 10 req/min, polite |
| **SkillsMP** | Web scraping | Weekly | Daily | 5 req/min, respectful |
| **mcp.so** | REST API | Daily | 2 hours | 1K/hr |
| **Anthropic Official** | GitHub API | Daily | 4 hours | Prioritized |

### 3.3 Incremental Update Strategy

```typescript
interface IncrementalSyncStrategy {
  // GitHub: Use Events API for efficiency
  github: {
    use_events_api: true;
    events_to_track: ['PushEvent', 'ReleaseEvent', 'StarEvent', 'ForkEvent'];
    max_events_per_sync: 1000;
    fallback_to_search: true;  // If Events API unavailable
  };

  // Scraped sources: Use ETags and If-Modified-Since
  scraped: {
    use_conditional_requests: true;
    compare_content_hash: true;
    track_page_etags: true;
  };

  // Change detection
  change_detection: {
    hash_fields: ['description', 'readme_length', 'github_stars'];
    force_update_fields: ['github_updated_at', 'security_scan_date'];
    ignore_fields: ['hit_count', 'last_hit_at'];
  };
}
```

### 3.4 Conflict Resolution

```
+=====================================================================+
|                     CONFLICT RESOLUTION MATRIX                       |
+=====================================================================+

Conflict Type         Resolution Strategy        Priority
--------------------- -------------------------- --------
Same skill, 2 sources Use source priority list   GitHub > Official > Others
Duplicate repo_url    Keep existing, update meta First indexed wins
Merge conflicts       Last-write-wins + log      Automatic
Quality score drift   Recalculate on update      Always fresh
Trust tier conflict   Use most restrictive       Safety first
Stale data            TTL-based invalidation     24h for metadata
```

```typescript
interface ConflictResolution {
  // Source priority (higher = preferred)
  source_priority: {
    'anthropic-official': 100,
    'github': 80,
    'mcp-so': 60,
    'claude-plugins': 40,
    'skillsmp': 20,
  };

  // Field-level merge rules
  field_rules: {
    // Use most recent
    description: 'latest';
    github_stars: 'latest';
    github_updated_at: 'latest';

    // Use highest
    quality_score: 'max';

    // Use most restrictive
    trust_tier: 'most_restrictive';
    security_scan_status: 'most_restrictive';

    // Merge arrays
    categories: 'union';
    technologies: 'union';
    related_skills: 'union';

    // Never overwrite
    indexed_at: 'preserve';
    id: 'preserve';
  };
}
```

### 3.5 Sync State Machine

```
+=====================================================================+
|                       SYNC STATE MACHINE                             |
+=====================================================================+

                        +-------------+
                        |    IDLE     |
                        +-------------+
                              |
                    (schedule trigger)
                              |
                              v
                        +-------------+
                        |  PREPARING  |
                        +-------------+
                              |
                    (load sync state)
                              |
              +---------------+---------------+
              |                               |
              v                               v
     +----------------+              +----------------+
     | FULL_SYNC      |              | INCREMENTAL    |
     | (if first run  |              | (if recent     |
     |  or stale)     |              |  sync exists)  |
     +----------------+              +----------------+
              |                               |
              +---------------+---------------+
                              |
                              v
                        +-------------+
                        |  FETCHING   |
                        +-------------+
                              |
                    (batch API calls)
                              |
                              v
                        +-------------+
                        |  PROCESSING |
                        +-------------+
                              |
                    (normalize, score)
                              |
                              v
                        +-------------+
                        |   STORING   |
                        +-------------+
                              |
                    (upsert to SQLite)
                              |
              +---------------+---------------+
              |                               |
              v                               v
     +----------------+              +----------------+
     |    SUCCESS     |              |    FAILURE     |
     +----------------+              +----------------+
              |                               |
     (update sync_state)            (log, retry queue)
              |                               |
              +---------------+---------------+
                              |
                              v
                        +-------------+
                        |    IDLE     |
                        +-------------+
```

---

## 4. Data Flow

### 4.1 Ingestion Pipeline

```
+=====================================================================+
|                      INGESTION PIPELINE                              |
+=====================================================================+

STAGE 1: FETCH
+------------------------------------------------------------------+
|                                                                    |
|  [Source A] ----+                                                  |
|                 |     +----------------+     +----------------+    |
|  [Source B] ----+---->| Rate Limiter   |---->| Response Cache |    |
|                 |     +----------------+     +----------------+    |
|  [Source C] ----+            |                      |              |
|                              |                      |              |
|                              v                      v              |
|                        +-----------+          +-----------+        |
|                        | Retry     |          | Cache Hit |        |
|                        | Queue     |          | (bypass)  |        |
|                        +-----------+          +-----------+        |
|                                                                    |
+------------------------------------------------------------------+

STAGE 2: EXTRACT
+------------------------------------------------------------------+
|                                                                    |
|  [Raw Response] ---> [Source Adapter] ---> [Canonical Skill DTO]   |
|                                                                    |
|  Adapters:                                                         |
|  - GitHubAdapter: GraphQL/REST -> SkillDTO                         |
|  - ClaudePluginsAdapter: HTML -> SkillDTO                          |
|  - SkillsMPAdapter: JSON -> SkillDTO                               |
|  - McpSoAdapter: REST -> SkillDTO                                  |
|                                                                    |
+------------------------------------------------------------------+

STAGE 3: TRANSFORM
+------------------------------------------------------------------+
|                                                                    |
|  [Canonical DTO]                                                   |
|        |                                                           |
|        +---> [Deduplication] (repo_url check)                      |
|        |                                                           |
|        +---> [Enrichment]                                          |
|        |         - Fetch README                                    |
|        |         - Detect technologies                             |
|        |         - Parse SKILL.md                                  |
|        |                                                           |
|        +---> [Quality Scoring]                                     |
|        |         - Documentation score                             |
|        |         - Popularity score                                |
|        |         - Maintenance score                               |
|        |         - Author reputation                               |
|        |                                                           |
|        +---> [Security Scanning]                                   |
|        |         - Static analysis                                 |
|        |         - Blocklist check                                 |
|        |         - Typosquatting detection                         |
|        |                                                           |
|        +---> [Classification]                                      |
|                  - Category assignment                             |
|                  - Technology detection                            |
|                  - Use case inference                              |
|                                                                    |
+------------------------------------------------------------------+

STAGE 4: LOAD
+------------------------------------------------------------------+
|                                                                    |
|  [Enriched Skill]                                                  |
|        |                                                           |
|        +---> [SQLite Transaction]                                  |
|        |         - UPSERT skill                                    |
|        |         - Update FTS index                                |
|        |         - Update relationships                            |
|        |                                                           |
|        +---> [Embedding Queue] (async, batched)                    |
|        |         - Generate embedding                              |
|        |         - Update embedding file                           |
|        |                                                           |
|        +---> [Invalidation]                                        |
|                  - Clear search cache                              |
|                  - Clear recommendation cache                       |
|                                                                    |
+------------------------------------------------------------------+
```

### 4.2 Query Flow

```
+=====================================================================+
|                         QUERY FLOW                                   |
+=====================================================================+

User Query: "react testing skills for CI/CD"
                            |
                            v
                   +------------------+
                   | QUERY PARSER     |
                   +------------------+
                   | - Tokenize       |
                   | - Extract intent |
                   | - Identify       |
                   |   technologies   |
                   +------------------+
                            |
            +---------------+---------------+
            |                               |
            v                               v
   +------------------+            +------------------+
   | FTS5 SEARCH      |            | SEMANTIC SEARCH  |
   +------------------+            +------------------+
   | BM25 ranking     |            | Embedding lookup |
   | Token matching   |            | Cosine similarity|
   +------------------+            +------------------+
            |                               |
            v                               v
   +------------------+            +------------------+
   | FTS Results      |            | Semantic Results |
   | (scored 0-1)     |            | (scored 0-1)     |
   +------------------+            +------------------+
            |                               |
            +---------------+---------------+
                            |
                            v
                   +------------------+
                   | FUSION LAYER     |
                   +------------------+
                   | RRF scoring:     |
                   | 1/(k + rank)     |
                   | k = 60           |
                   +------------------+
                            |
                            v
                   +------------------+
                   | POST-PROCESSING  |
                   +------------------+
                   | - Apply filters  |
                   | - Trust tier     |
                   | - Blocklist      |
                   | - Boost quality  |
                   +------------------+
                            |
                            v
                   +------------------+
                   | RANKED RESULTS   |
                   +------------------+
```

### 4.3 Cache Invalidation Strategy

```typescript
interface CacheInvalidation {
  // Time-based invalidation (TTL)
  ttl_config: {
    search_results: 30 * 60,       // 30 minutes
    skill_details: 60 * 60,        // 1 hour
    github_metadata: 60 * 60,      // 1 hour
    github_stars: 24 * 60 * 60,    // 24 hours
    recommendations: 60 * 60,       // 1 hour
    codebase_scan: 60 * 60,        // 1 hour
    embeddings: 7 * 24 * 60 * 60,  // 7 days
  };

  // Event-based invalidation
  invalidation_events: {
    'sync_complete': ['search:*', 'skill:*'],
    'skill_installed': ['recommendations:*', 'conflicts:*'],
    'skill_uninstalled': ['recommendations:*', 'budget:*'],
    'preferences_changed': ['recommendations:*'],
    'project_changed': ['scan:*', 'recommendations:*'],
  };

  // File-based invalidation (watch for changes)
  file_watches: {
    'package.json': ['scan:*'],
    'requirements.txt': ['scan:*'],
    'Cargo.toml': ['scan:*'],
    'go.mod': ['scan:*'],
    '.claude/settings.json': ['preferences:*'],
  };
}
```

---

## 5. Telemetry Data

### 5.1 Telemetry Philosophy

The telemetry system follows these principles:

1. **Opt-out with clear value proposition** - Users can disable, but we explain benefits
2. **Privacy by design** - No PII, hashed identifiers, aggregate-first
3. **Local-first** - Data stays local until explicitly sent
4. **Transparent** - Users can view exactly what would be sent
5. **Beneficial** - Enables social proof features that help discovery

### 5.2 Telemetry Data Model

```typescript
interface TelemetryEvent {
  // === Event Identity ===
  event_id: string;                // UUID for deduplication
  event_type: TelemetryEventType;
  timestamp: string;               // ISO 8601

  // === User Identity (Privacy-Preserving) ===
  anonymous_id: string;            // SHA-256(user_id + salt)
  session_id: string;              // SHA-256(session_start + user_id)

  // === Context (No PII) ===
  context: {
    os: 'darwin' | 'linux' | 'win32';
    arch: 'x64' | 'arm64';
    node_version: string;          // Major.minor only
    discovery_version: string;
    locale: string;                // Language only, e.g., 'en'
  };

  // === Event-Specific Payload ===
  payload: TelemetryPayload;
}

type TelemetryEventType =
  | 'search_executed'
  | 'skill_viewed'
  | 'skill_installed'
  | 'skill_uninstalled'
  | 'skill_activated'
  | 'recommendation_shown'
  | 'recommendation_accepted'
  | 'recommendation_dismissed'
  | 'audit_completed'
  | 'error_occurred';

// Example payloads (no PII)
interface SearchPayload {
  query_tokens: number;            // Count only, not content
  result_count: number;
  latency_ms: number;
  cache_hit: boolean;
  filters_used: string[];          // Category names only
}

interface SkillInstallPayload {
  skill_id: string;
  trust_tier: TrustTier;
  quality_score: number;
  source: SkillSource;
  installation_method: 'search' | 'recommendation' | 'direct' | 'clone';
}

interface SkillActivationPayload {
  skill_id: string;
  activation_success: boolean;
  failure_reason?: string;         // Generic category only
  time_since_install_hours: number;
}
```

### 5.3 Aggregation for Social Proof

```sql
-- ==================================================================
-- AGGREGATED TELEMETRY TABLES (Server-Side)
-- ==================================================================

-- Skill popularity aggregates (updated daily)
CREATE TABLE skill_popularity (
    skill_id TEXT PRIMARY KEY,
    install_count_7d INTEGER DEFAULT 0,
    install_count_30d INTEGER DEFAULT 0,
    install_count_all INTEGER DEFAULT 0,
    activation_count_7d INTEGER DEFAULT 0,
    unique_users_7d INTEGER DEFAULT 0,
    unique_users_30d INTEGER DEFAULT 0,
    trending_score REAL DEFAULT 0.0,  -- Calculated field
    updated_at TEXT NOT NULL
);

-- Category trends (for "Popular in [Category]")
CREATE TABLE category_trends (
    category_id TEXT NOT NULL,
    period TEXT NOT NULL,          -- '7d', '30d', '90d'
    top_skills TEXT NOT NULL,      -- JSON array of skill_ids
    growth_rate REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (category_id, period)
);

-- Technology adoption (for "Developers using [Tech] also use...")
CREATE TABLE technology_adoption (
    technology_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    adoption_rate REAL NOT NULL,   -- 0.0 - 1.0
    co_occurrence_count INTEGER,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (technology_id, skill_id)
);

-- Activation success rates (for quality signals)
CREATE TABLE activation_rates (
    skill_id TEXT PRIMARY KEY,
    success_rate REAL NOT NULL,    -- 0.0 - 1.0
    sample_size INTEGER NOT NULL,
    common_failures TEXT,          -- JSON array of failure types
    updated_at TEXT NOT NULL
);
```

### 5.4 Privacy-Preserving Design

```
+=====================================================================+
|                    PRIVACY ARCHITECTURE                              |
+=====================================================================+

LOCAL DEVICE                           AGGREGATE SERVER
+---------------------------+          +---------------------------+
|                           |          |                           |
| User Activity             |          | Aggregated Statistics     |
| - Search queries          |   NEVER  | - No query content        |
| - Project paths           | -------> | - No file paths           |
| - File contents           |          | - No user identity        |
| - IP address              |          | - No location data        |
|                           |          |                           |
+---------------------------+          +---------------------------+
           |                                      ^
           |                                      |
           v                                      |
+---------------------------+                     |
| LOCAL TELEMETRY QUEUE     |                     |
+---------------------------+                     |
| - Hash user ID            |                     |
| - Strip PII               |                     |
| - Generalize context      |                     |
| - Batch events            |                     |
+---------------------------+                     |
           |                                      |
           | (opt-in only)                        |
           v                                      |
+---------------------------+          +---------------------------+
| TRANSMISSION              |--------->| INGESTION                 |
+---------------------------+          +---------------------------+
| - TLS 1.3                 |          | - Validate schema         |
| - No cookies              |          | - Aggregate immediately   |
| - Ephemeral connection    |          | - Discard raw events      |
+---------------------------+          +---------------------------+
```

### 5.5 User Control Interface

```typescript
interface TelemetryConfig {
  // Master switch
  enabled: boolean;                // Default: true (opt-out)

  // Granular controls
  levels: {
    // Basic: Only counts, no skill IDs
    basic: {
      search_count: boolean;
      install_count: boolean;
      error_count: boolean;
    };

    // Standard: Include skill IDs for social proof
    standard: {
      skill_installs: boolean;
      skill_activations: boolean;
      recommendations: boolean;
    };

    // Full: Include behavioral patterns
    full: {
      session_patterns: boolean;
      workflow_analysis: boolean;
    };
  };

  // Transparency features
  view_pending_events: () => TelemetryEvent[];
  view_sent_history: () => TelemetrySummary[];
  export_all_data: () => TelemetryExport;
  delete_all_data: () => void;
}

// Default configuration (opt-out, standard level)
const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  levels: {
    basic: { search_count: true, install_count: true, error_count: true },
    standard: { skill_installs: true, skill_activations: true, recommendations: true },
    full: { session_patterns: false, workflow_analysis: false },
  },
};
```

### 5.6 Value Proposition for Users

```
+=====================================================================+
|               TELEMETRY VALUE PROPOSITION                            |
+=====================================================================+

WHAT YOU GET BY SHARING (anonymized data):
+------------------------------------------------------------------+
|                                                                    |
|  1. SOCIAL PROOF FEATURES                                          |
|     - "23 developers using React also installed this skill"        |
|     - "Trending in Testing category this week"                     |
|     - "92% activation success rate"                                |
|                                                                    |
|  2. PERSONALIZED RECOMMENDATIONS                                   |
|     - Skills popular with similar tech stacks                      |
|     - Recommendations based on community patterns                  |
|                                                                    |
|  3. QUALITY SIGNALS                                                |
|     - Activation success rates from real usage                     |
|     - Common failure patterns and fixes                            |
|                                                                    |
|  4. ECOSYSTEM HEALTH                                               |
|     - Help skill authors improve their skills                      |
|     - Identify problematic skills faster                           |
|                                                                    |
+------------------------------------------------------------------+

WHAT WE NEVER COLLECT:
+------------------------------------------------------------------+
|                                                                    |
|  - Your identity or email                                          |
|  - Search query content                                            |
|  - File paths or project names                                     |
|  - Source code or repository URLs                                  |
|  - IP address (ephemeral connections only)                         |
|  - Precise location (locale only)                                  |
|                                                                    |
+------------------------------------------------------------------+
```

---

## 6. Implementation Recommendations

### 6.1 Phase 1 Priorities

| Priority | Component | Rationale |
|----------|-----------|-----------|
| P0 | SQLite schema + FTS5 | Core storage, blocking all features |
| P0 | GitHub sync adapter | Largest source, most reliable API |
| P1 | Basic caching layer | Performance requirement |
| P1 | Deduplication logic | Data quality critical |
| P2 | Scraping adapters | Secondary sources |
| P2 | Telemetry queue | Can defer transmission |

### 6.2 Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Database | SQLite 3.45+ | FTS5 + WAL, zero dependencies |
| ORM | better-sqlite3 | Sync API, better performance |
| Embeddings | all-MiniLM-L6-v2 | 384 dims, fast, good quality |
| Embedding Runtime | @xenova/transformers | WASM, no Python deps |
| HTTP Client | undici | Modern, fast, built-in |
| Queue | BullMQ (Redis) or SQLite | Reliable, persistent |

### 6.3 Performance Targets

| Operation | Target | Strategy |
|-----------|--------|----------|
| Search (FTS) | < 50ms | SQLite FTS5 + indexes |
| Search (Semantic) | < 200ms | Memory-mapped embeddings |
| Search (Hybrid) | < 300ms | Parallel + fusion |
| Skill detail fetch | < 100ms | Cache + preload |
| Full sync (50K) | < 30min | Parallel + batching |
| Incremental sync | < 2min | Events API + deltas |

### 6.4 Data Integrity Guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| Atomicity | SQLite transactions |
| Consistency | Foreign keys, CHECK constraints |
| Durability | WAL mode, sync on commit |
| Availability | Local-first, offline capable |

---

## 7. Open Questions

| Question | Options | Recommendation |
|----------|---------|----------------|
| Embedding model hosting | Local WASM vs API | Local (privacy, offline) |
| Telemetry backend | Self-hosted vs SaaS | Start SaaS, migrate later |
| Sync scheduling | Fixed interval vs adaptive | Adaptive (save API quota) |
| Cross-device sync | None vs Cloud sync | Defer to Phase 5+ |

---

## 8. Appendix

### A. Data Source API Details

| Source | API Documentation | Authentication |
|--------|-------------------|----------------|
| GitHub | https://docs.github.com/rest | PAT or GitHub App |
| claude-plugins.dev | No public API | None (scrape) |
| SkillsMP | No public API | None (scrape) |
| mcp.so | https://mcp.so/api/docs | API key |

### B. FTS5 Query Syntax Reference

```sql
-- Basic search
SELECT * FROM skills_fts WHERE skills_fts MATCH 'react testing';

-- Phrase search
SELECT * FROM skills_fts WHERE skills_fts MATCH '"unit testing"';

-- Boolean operators
SELECT * FROM skills_fts WHERE skills_fts MATCH 'react AND testing NOT enzyme';

-- Column-specific search
SELECT * FROM skills_fts WHERE skills_fts MATCH 'name:react OR description:testing';

-- Prefix matching
SELECT * FROM skills_fts WHERE skills_fts MATCH 'test*';

-- BM25 ranking
SELECT *, bm25(skills_fts) as score
FROM skills_fts
WHERE skills_fts MATCH 'react testing'
ORDER BY score;
```

### C. Embedding Model Comparison

| Model | Dimensions | Speed | Quality | Size |
|-------|------------|-------|---------|------|
| all-MiniLM-L6-v2 | 384 | Fast | Good | 80MB |
| all-mpnet-base-v2 | 768 | Medium | Better | 420MB |
| text-embedding-3-small | 1536 | API | Best | N/A |

**Recommendation:** all-MiniLM-L6-v2 for local-first, offline capability.

---

*Document Version: 1.0*
*Last Updated: December 26, 2025*
*Next Review: After Phase 1 implementation*
