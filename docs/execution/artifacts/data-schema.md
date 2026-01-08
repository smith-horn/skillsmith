# Skillsmith - Complete SQLite Schema

**Version:** 1.0
**Last Updated:** December 26, 2025
**Status:** Design Complete
**Owner:** Data Architect

---

## Overview

This document contains the complete SQLite schema for the Skillsmith. The schema is designed for:

- **Local-first operation** with offline capability
- **50,000+ skills** indexed from multiple sources
- **Sub-50ms FTS5 search** latency
- **Privacy-preserving** telemetry with clear opt-out
- **Incremental sync** with cursor/ETag support

---

## PRAGMA Configuration

These PRAGMAs must be set on every database connection:

```sql
-- ==================================================================
-- PRAGMA CONFIGURATION
-- Apply these settings on every connection
-- ==================================================================

-- Write-Ahead Logging for better concurrency
PRAGMA journal_mode = WAL;

-- Balance between durability and performance
PRAGMA synchronous = NORMAL;

-- 64MB cache for better performance
PRAGMA cache_size = -64000;

-- 256MB memory-mapped I/O for large result sets
PRAGMA mmap_size = 268435456;

-- Keep temp tables in memory
PRAGMA temp_store = MEMORY;

-- Enforce foreign key constraints
PRAGMA foreign_keys = ON;

-- Secure delete (optional, for privacy)
-- PRAGMA secure_delete = ON;

-- Auto-vacuum for space reclamation
PRAGMA auto_vacuum = INCREMENTAL;
```

---

## Core Tables

### Sources Table

Tracks data origin platforms for skills.

```sql
-- ==================================================================
-- SOURCES TABLE
-- Tracks data origin platforms (GitHub, SkillsMP, etc.)
-- ==================================================================

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_type TEXT NOT NULL CHECK (api_type IN ('rest', 'graphql', 'scrape')),
    rate_limit_per_hour INTEGER,
    requires_auth INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 50,           -- For conflict resolution (higher wins)
    last_full_sync TEXT,
    last_incremental_sync TEXT,
    sync_cursor TEXT,
    sync_etag TEXT,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    last_error_at TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for active sources
CREATE INDEX IF NOT EXISTS idx_sources_active ON sources(is_active) WHERE is_active = 1;
```

### Authors Table

Stores skill author information.

```sql
-- ==================================================================
-- AUTHORS TABLE
-- Skill author profiles
-- ==================================================================

CREATE TABLE IF NOT EXISTS authors (
    id TEXT PRIMARY KEY,                   -- 'github:username' format
    name TEXT NOT NULL,
    github_username TEXT,
    email TEXT,
    avatar_url TEXT,
    profile_url TEXT,
    verified INTEGER DEFAULT 0,
    skill_count INTEGER DEFAULT 0,
    total_stars INTEGER DEFAULT 0,
    reputation_score REAL DEFAULT 0.0 CHECK (reputation_score >= 0.0 AND reputation_score <= 1.0),
    bio TEXT,
    company TEXT,
    location TEXT,
    twitter_username TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for author queries
CREATE INDEX IF NOT EXISTS idx_authors_github ON authors(github_username);
CREATE INDEX IF NOT EXISTS idx_authors_reputation ON authors(reputation_score DESC);
CREATE INDEX IF NOT EXISTS idx_authors_verified ON authors(verified) WHERE verified = 1;
CREATE INDEX IF NOT EXISTS idx_authors_skill_count ON authors(skill_count DESC);
```

### Skills Table

The primary entity table for discoverable skills.

```sql
-- ==================================================================
-- SKILLS TABLE
-- Primary entity: discoverable skills/plugins
-- ==================================================================

CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,                   -- 'source/author/name' format
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    long_description TEXT,                 -- Full README content
    search_text TEXT,                      -- Concatenated searchable content

    -- Source tracking
    source_id TEXT NOT NULL REFERENCES sources(id),
    source_skill_id TEXT,                  -- ID in source system
    repo_url TEXT UNIQUE NOT NULL,
    homepage_url TEXT,

    -- Author
    author_id TEXT REFERENCES authors(id),

    -- Versioning
    current_version TEXT,

    -- Quality scores (0.0 - 1.0)
    quality_score REAL CHECK (quality_score >= 0.0 AND quality_score <= 1.0),
    quality_documentation REAL CHECK (quality_documentation >= 0.0 AND quality_documentation <= 0.25),
    quality_popularity REAL CHECK (quality_popularity >= 0.0 AND quality_popularity <= 0.25),
    quality_maintenance REAL CHECK (quality_maintenance >= 0.0 AND quality_maintenance <= 0.25),
    quality_author REAL CHECK (quality_author >= 0.0 AND quality_author <= 0.25),

    -- Trust & Security
    trust_tier TEXT DEFAULT 'unverified' CHECK (trust_tier IN ('official', 'verified', 'community', 'unverified')),
    security_scan_status TEXT DEFAULT 'pending' CHECK (security_scan_status IN ('passed', 'warning', 'failed', 'pending', 'skipped')),
    security_scan_date TEXT,
    security_findings TEXT,                -- JSON array

    -- GitHub metrics
    github_stars INTEGER DEFAULT 0,
    github_forks INTEGER DEFAULT 0,
    github_watchers INTEGER DEFAULT 0,
    github_open_issues INTEGER DEFAULT 0,
    github_license TEXT,
    github_language TEXT,
    github_topics TEXT,                    -- JSON array
    github_created_at TEXT,
    github_updated_at TEXT,
    github_pushed_at TEXT,

    -- Content analysis
    readme_length INTEGER DEFAULT 0,
    has_skill_md INTEGER DEFAULT 0,
    skill_md_quality REAL,
    has_tests INTEGER DEFAULT 0,
    has_examples INTEGER DEFAULT 0,
    estimated_char_budget INTEGER DEFAULT 0,

    -- Semantic search
    embedding_id INTEGER,
    embedding_version TEXT,

    -- Relationships (JSON arrays of skill IDs)
    related_skills TEXT,
    conflicts_with TEXT,
    replaces TEXT,

    -- Indexing metadata
    indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_scored_at TEXT,

    -- Soft delete
    deleted_at TEXT
);

-- Primary indexes for skills
CREATE INDEX IF NOT EXISTS idx_skills_quality ON skills(quality_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_skills_trust ON skills(trust_tier) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source_id);
CREATE INDEX IF NOT EXISTS idx_skills_author ON skills(author_id);
CREATE INDEX IF NOT EXISTS idx_skills_updated ON skills(last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_stars ON skills(github_stars DESC);
CREATE INDEX IF NOT EXISTS idx_skills_language ON skills(github_language);
CREATE INDEX IF NOT EXISTS idx_skills_security ON skills(security_scan_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_skills_scored ON skills(last_scored_at) WHERE deleted_at IS NULL;

-- Compound index for common query patterns
CREATE INDEX IF NOT EXISTS idx_skills_trust_quality ON skills(trust_tier, quality_score DESC) WHERE deleted_at IS NULL;
```

### Skill Versions Table

Tracks version history for skills.

```sql
-- ==================================================================
-- SKILL VERSIONS TABLE
-- Version history for skills
-- ==================================================================

CREATE TABLE IF NOT EXISTS skill_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    breaking_changes INTEGER DEFAULT 0,
    changelog TEXT,
    file_size INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(skill_id, version)
);

-- Index for version queries
CREATE INDEX IF NOT EXISTS idx_versions_skill ON skill_versions(skill_id);
CREATE INDEX IF NOT EXISTS idx_versions_created ON skill_versions(created_at DESC);
```

---

## Classification Tables

### Categories Table

Hierarchical skill categories.

```sql
-- ==================================================================
-- CATEGORIES TABLE
-- Hierarchical skill categories
-- ==================================================================

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    parent_id TEXT REFERENCES categories(id),
    skill_count INTEGER DEFAULT 0,
    icon TEXT,
    color TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for category hierarchy
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories(sort_order);
```

### Skill Categories Junction Table

```sql
-- ==================================================================
-- SKILL_CATEGORIES TABLE
-- Many-to-many: skills <-> categories
-- ==================================================================

CREATE TABLE IF NOT EXISTS skill_categories (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    confidence REAL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    source TEXT DEFAULT 'detected' CHECK (source IN ('detected', 'declared', 'manual')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (skill_id, category_id)
);

-- Index for category lookups
CREATE INDEX IF NOT EXISTS idx_skill_categories_category ON skill_categories(category_id);
```

### Technologies Table

Languages, frameworks, tools, and platforms.

```sql
-- ==================================================================
-- TECHNOLOGIES TABLE
-- Languages, frameworks, tools, platforms
-- ==================================================================

CREATE TABLE IF NOT EXISTS technologies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('language', 'framework', 'tool', 'platform', 'library')),
    aliases TEXT,                          -- JSON array of alternative names
    skill_count INTEGER DEFAULT 0,
    icon TEXT,
    color TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for technology type
CREATE INDEX IF NOT EXISTS idx_technologies_type ON technologies(type);
```

### Skill Technologies Junction Table

```sql
-- ==================================================================
-- SKILL_TECHNOLOGIES TABLE
-- Many-to-many: skills <-> technologies
-- ==================================================================

CREATE TABLE IF NOT EXISTS skill_technologies (
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    technology_id TEXT NOT NULL REFERENCES technologies(id) ON DELETE CASCADE,
    confidence REAL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    is_primary INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (skill_id, technology_id)
);

-- Index for technology lookups
CREATE INDEX IF NOT EXISTS idx_skill_technologies_tech ON skill_technologies(technology_id);
CREATE INDEX IF NOT EXISTS idx_skill_technologies_primary ON skill_technologies(is_primary) WHERE is_primary = 1;
```

---

## Security Tables

### Security Scans Table

Detailed security scan results.

```sql
-- ==================================================================
-- SECURITY_SCANS TABLE
-- Security scan results for skills
-- ==================================================================

CREATE TABLE IF NOT EXISTS security_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    scan_version TEXT NOT NULL,            -- Scanner version
    scan_type TEXT NOT NULL CHECK (scan_type IN ('static', 'dependency', 'content')),
    status TEXT NOT NULL CHECK (status IN ('passed', 'warning', 'failed')),
    findings_count INTEGER DEFAULT 0,
    critical_count INTEGER DEFAULT 0,
    high_count INTEGER DEFAULT 0,
    medium_count INTEGER DEFAULT 0,
    low_count INTEGER DEFAULT 0,
    info_count INTEGER DEFAULT 0,
    scan_duration_ms INTEGER,
    scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for scan queries
CREATE INDEX IF NOT EXISTS idx_security_scans_skill ON security_scans(skill_id);
CREATE INDEX IF NOT EXISTS idx_security_scans_status ON security_scans(status);
CREATE INDEX IF NOT EXISTS idx_security_scans_date ON security_scans(scanned_at DESC);
```

### Security Findings Table

Individual security findings.

```sql
-- ==================================================================
-- SECURITY_FINDINGS TABLE
-- Individual security findings from scans
-- ==================================================================

CREATE TABLE IF NOT EXISTS security_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    scan_id INTEGER REFERENCES security_scans(id) ON DELETE CASCADE,
    finding_type TEXT NOT NULL,            -- 'external_url', 'shell_command', 'obfuscation', etc.
    severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    file_path TEXT,
    line_number INTEGER,
    code_snippet TEXT,
    recommendation TEXT,
    cwe_id TEXT,                           -- Common Weakness Enumeration
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    false_positive INTEGER DEFAULT 0
);

-- Indexes for findings
CREATE INDEX IF NOT EXISTS idx_findings_skill ON security_findings(skill_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);
CREATE INDEX IF NOT EXISTS idx_findings_type ON security_findings(finding_type);
CREATE INDEX IF NOT EXISTS idx_findings_unresolved ON security_findings(skill_id) WHERE resolved_at IS NULL;
```

### Blocked Skills Table

Blocklist for unsafe or malicious skills.

```sql
-- ==================================================================
-- BLOCKED_SKILLS TABLE
-- Blocklist for unsafe or malicious skills
-- ==================================================================

CREATE TABLE IF NOT EXISTS blocked_skills (
    skill_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    severity TEXT DEFAULT 'warning' CHECK (severity IN ('warning', 'critical')),
    blocked_by TEXT NOT NULL CHECK (blocked_by IN ('system', 'user', 'community', 'security')),
    evidence TEXT,                         -- JSON with supporting data
    reporter TEXT,
    blocked_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT,                       -- NULL = permanent
    reviewed_at TEXT,
    reviewed_by TEXT
);

-- Index for blocked skills
CREATE INDEX IF NOT EXISTS idx_blocked_severity ON blocked_skills(severity);
CREATE INDEX IF NOT EXISTS idx_blocked_by ON blocked_skills(blocked_by);
```

---

## User Data Tables

### User Preferences Table

User settings and preferences.

```sql
-- ==================================================================
-- USER_PREFERENCES TABLE
-- User settings stored locally
-- ==================================================================

CREATE TABLE IF NOT EXISTS user_preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    value_type TEXT DEFAULT 'string' CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Default preferences
INSERT OR IGNORE INTO user_preferences (key, value, value_type, description) VALUES
    ('telemetry_enabled', 'true', 'boolean', 'Enable anonymous telemetry'),
    ('telemetry_level', 'standard', 'string', 'Telemetry detail level: basic, standard, full'),
    ('trust_tier_minimum', 'community', 'string', 'Minimum trust tier for recommendations'),
    ('results_per_page', '20', 'number', 'Number of search results per page'),
    ('show_unverified_skills', 'true', 'boolean', 'Show unverified skills in search'),
    ('compact_view', 'false', 'boolean', 'Use compact view for skill listings'),
    ('show_recommendations', 'true', 'boolean', 'Show skill recommendations'),
    ('recommendation_frequency', 'daily', 'string', 'Recommendation frequency: always, daily, weekly, never'),
    ('budget_warning_threshold', '0.8', 'number', 'Character budget warning threshold (0.0-1.0)'),
    ('preferred_categories', '[]', 'json', 'Preferred skill categories'),
    ('preferred_technologies', '[]', 'json', 'Preferred technologies');
```

### Installed Skills Table

Tracks locally installed skills.

```sql
-- ==================================================================
-- INSTALLED_SKILLS TABLE
-- Locally installed skills
-- ==================================================================

CREATE TABLE IF NOT EXISTS installed_skills (
    skill_id TEXT PRIMARY KEY REFERENCES skills(id),
    installed_version TEXT NOT NULL,
    installation_method TEXT DEFAULT 'manual' CHECK (installation_method IN ('manual', 'recommended', 'cloned', 'auto')),
    installation_path TEXT,
    activation_count INTEGER DEFAULT 0,
    last_activated_at TEXT,
    health_status TEXT DEFAULT 'unknown' CHECK (health_status IN ('healthy', 'warning', 'error', 'unknown')),
    last_health_check TEXT,
    health_details TEXT,                   -- JSON with health check results
    pinned_version TEXT,                   -- If pinned to specific version
    auto_update INTEGER DEFAULT 1,
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for installed skills
CREATE INDEX IF NOT EXISTS idx_installed_health ON installed_skills(health_status);
CREATE INDEX IF NOT EXISTS idx_installed_activated ON installed_skills(last_activated_at DESC);
CREATE INDEX IF NOT EXISTS idx_installed_method ON installed_skills(installation_method);
```

---

## Telemetry Tables

### Telemetry Queue Table

Local queue for telemetry events.

```sql
-- ==================================================================
-- TELEMETRY_QUEUE TABLE
-- Local queue for telemetry events (privacy-preserving)
-- ==================================================================

CREATE TABLE IF NOT EXISTS telemetry_queue (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    anonymous_id TEXT NOT NULL,            -- SHA-256 hash, never raw ID
    session_id TEXT NOT NULL,
    payload TEXT NOT NULL,                 -- JSON (sanitized, no PII)
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'transmitting', 'transmitted', 'failed')),
    retry_count INTEGER DEFAULT 0,
    last_retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for telemetry queue
CREATE INDEX IF NOT EXISTS idx_telemetry_status ON telemetry_queue(status);
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_event_type ON telemetry_queue(event_type);
```

### Telemetry Events Table (Local History)

```sql
-- ==================================================================
-- TELEMETRY_EVENTS TABLE
-- Local history of telemetry events (for user inspection)
-- ==================================================================

CREATE TABLE IF NOT EXISTS telemetry_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,                 -- Human-readable summary
    transmitted INTEGER DEFAULT 0,
    transmitted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for event history
CREATE INDEX IF NOT EXISTS idx_telemetry_events_type ON telemetry_events(event_type);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_created ON telemetry_events(created_at DESC);

-- Auto-cleanup old events (keep 30 days)
-- Run periodically: DELETE FROM telemetry_events WHERE created_at < datetime('now', '-30 days');
```

---

## Cache Tables

### Cache Entries Table

General-purpose cache with TTL.

```sql
-- ==================================================================
-- CACHE_ENTRIES TABLE
-- General-purpose cache with TTL
-- ==================================================================

CREATE TABLE IF NOT EXISTS cache_entries (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,                   -- JSON serialized
    content_type TEXT DEFAULT 'json',
    expires_at INTEGER NOT NULL,           -- Unix timestamp
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    hit_count INTEGER DEFAULT 0,
    last_hit_at INTEGER,
    size_bytes INTEGER,
    tags TEXT                              -- JSON array for cache invalidation
);

-- Indexes for cache
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries(expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_hits ON cache_entries(hit_count DESC);
```

---

## Sync State Tables

### Sync State Table

Tracks sync progress per source.

```sql
-- ==================================================================
-- SYNC_STATE TABLE
-- Tracks sync progress per source
-- ==================================================================

CREATE TABLE IF NOT EXISTS sync_state (
    source_id TEXT PRIMARY KEY REFERENCES sources(id),
    state TEXT DEFAULT 'idle' CHECK (state IN ('idle', 'preparing', 'fetching', 'processing', 'storing', 'success', 'failure')),
    sync_type TEXT CHECK (sync_type IN ('full', 'incremental')),
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
    skills_failed INTEGER DEFAULT 0,
    progress_current INTEGER DEFAULT 0,
    progress_total INTEGER DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    error_count INTEGER DEFAULT 0,
    last_error TEXT,
    last_error_at TEXT
);
```

### Sync Log Table

Detailed sync operation logs.

```sql
-- ==================================================================
-- SYNC_LOG TABLE
-- Detailed sync operation logs
-- ==================================================================

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL REFERENCES sources(id),
    sync_type TEXT NOT NULL CHECK (sync_type IN ('full', 'incremental')),
    status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'cancelled')),
    skills_processed INTEGER DEFAULT 0,
    skills_added INTEGER DEFAULT 0,
    skills_updated INTEGER DEFAULT 0,
    skills_removed INTEGER DEFAULT 0,
    skills_failed INTEGER DEFAULT 0,
    duration_ms INTEGER,
    error_message TEXT,
    metadata TEXT,                         -- JSON with additional details
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for sync logs
CREATE INDEX IF NOT EXISTS idx_sync_log_source ON sync_log(source_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at DESC);
```

---

## Full-Text Search (FTS5)

### Skills FTS Virtual Table

```sql
-- ==================================================================
-- SKILLS_FTS VIRTUAL TABLE
-- Full-text search using FTS5 with porter tokenizer
-- ==================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    name,
    description,
    search_text,
    content='skills',
    content_rowid='rowid',
    tokenize='porter unicode61 remove_diacritics 2'
);
```

### FTS Sync Triggers

Automatically keep FTS index in sync with skills table.

```sql
-- ==================================================================
-- FTS SYNC TRIGGERS
-- Automatically sync FTS index with skills table
-- ==================================================================

-- Trigger for INSERT
CREATE TRIGGER IF NOT EXISTS skills_fts_insert AFTER INSERT ON skills BEGIN
    INSERT INTO skills_fts(rowid, name, description, search_text)
    VALUES (NEW.rowid, NEW.name, NEW.description, NEW.search_text);
END;

-- Trigger for DELETE
CREATE TRIGGER IF NOT EXISTS skills_fts_delete AFTER DELETE ON skills BEGIN
    INSERT INTO skills_fts(skills_fts, rowid, name, description, search_text)
    VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.search_text);
END;

-- Trigger for UPDATE
CREATE TRIGGER IF NOT EXISTS skills_fts_update AFTER UPDATE OF name, description, search_text ON skills BEGIN
    INSERT INTO skills_fts(skills_fts, rowid, name, description, search_text)
    VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.search_text);
    INSERT INTO skills_fts(rowid, name, description, search_text)
    VALUES (NEW.rowid, NEW.name, NEW.description, NEW.search_text);
END;
```

---

## Schema Migrations Table

### Migrations Tracking

```sql
-- ==================================================================
-- SCHEMA_MIGRATIONS TABLE
-- Tracks applied migrations
-- ==================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    checksum TEXT,                         -- SHA-256 of migration file
    executed_at TEXT NOT NULL DEFAULT (datetime('now')),
    execution_time_ms INTEGER,
    rollback_sql TEXT                      -- SQL to rollback this migration
);
```

---

## Seed Data

### Default Sources

```sql
-- ==================================================================
-- SEED DATA: Default Sources
-- ==================================================================

INSERT OR IGNORE INTO sources (id, name, base_url, api_type, rate_limit_per_hour, priority) VALUES
    ('github', 'GitHub', 'https://api.github.com', 'rest', 5000, 80),
    ('claude-plugins', 'claude-plugins.dev', 'https://claude-plugins.dev', 'scrape', 600, 40),
    ('skillsmp', 'SkillsMP', 'https://skillsmp.com', 'scrape', 300, 20),
    ('mcp-so', 'mcp.so', 'https://mcp.so', 'rest', 1000, 60),
    ('anthropic-official', 'Anthropic Official', 'https://github.com/anthropics', 'rest', 5000, 100);
```

### Default Categories

```sql
-- ==================================================================
-- SEED DATA: Default Categories
-- ==================================================================

INSERT OR IGNORE INTO categories (id, name, display_name, description, sort_order) VALUES
    ('testing', 'testing', 'Testing', 'Unit testing, integration testing, E2E testing', 1),
    ('documentation', 'documentation', 'Documentation', 'Code documentation, README generation, API docs', 2),
    ('debugging', 'debugging', 'Debugging', 'Error analysis, debugging assistance, log analysis', 3),
    ('code-quality', 'code-quality', 'Code Quality', 'Linting, formatting, code review, refactoring', 4),
    ('productivity', 'productivity', 'Productivity', 'Workflow automation, task management, efficiency', 5),
    ('security', 'security', 'Security', 'Security analysis, vulnerability detection, best practices', 6),
    ('devops', 'devops', 'DevOps', 'CI/CD, deployment, infrastructure, containerization', 7),
    ('data', 'data', 'Data & Analytics', 'Data processing, analytics, visualization', 8),
    ('api', 'api', 'API Development', 'API design, REST, GraphQL, OpenAPI', 9),
    ('frontend', 'frontend', 'Frontend', 'UI development, React, Vue, CSS, accessibility', 10),
    ('backend', 'backend', 'Backend', 'Server-side development, databases, APIs', 11),
    ('mobile', 'mobile', 'Mobile', 'iOS, Android, React Native, Flutter', 12),
    ('ai-ml', 'ai-ml', 'AI & ML', 'Machine learning, AI integration, LLM tools', 13),
    ('git', 'git', 'Git & Version Control', 'Git workflows, PR reviews, merge strategies', 14);
```

### Default Technologies

```sql
-- ==================================================================
-- SEED DATA: Default Technologies
-- ==================================================================

INSERT OR IGNORE INTO technologies (id, name, type) VALUES
    -- Languages
    ('typescript', 'TypeScript', 'language'),
    ('javascript', 'JavaScript', 'language'),
    ('python', 'Python', 'language'),
    ('rust', 'Rust', 'language'),
    ('go', 'Go', 'language'),
    ('java', 'Java', 'language'),
    ('csharp', 'C#', 'language'),
    ('ruby', 'Ruby', 'language'),
    ('php', 'PHP', 'language'),
    ('swift', 'Swift', 'language'),
    ('kotlin', 'Kotlin', 'language'),

    -- Frameworks
    ('react', 'React', 'framework'),
    ('vue', 'Vue.js', 'framework'),
    ('angular', 'Angular', 'framework'),
    ('nextjs', 'Next.js', 'framework'),
    ('nuxt', 'Nuxt.js', 'framework'),
    ('svelte', 'Svelte', 'framework'),
    ('express', 'Express.js', 'framework'),
    ('nestjs', 'NestJS', 'framework'),
    ('django', 'Django', 'framework'),
    ('flask', 'Flask', 'framework'),
    ('fastapi', 'FastAPI', 'framework'),
    ('rails', 'Ruby on Rails', 'framework'),
    ('laravel', 'Laravel', 'framework'),
    ('spring', 'Spring Boot', 'framework'),

    -- Platforms
    ('nodejs', 'Node.js', 'platform'),
    ('deno', 'Deno', 'platform'),
    ('bun', 'Bun', 'platform'),
    ('aws', 'AWS', 'platform'),
    ('gcp', 'Google Cloud', 'platform'),
    ('azure', 'Azure', 'platform'),
    ('vercel', 'Vercel', 'platform'),
    ('netlify', 'Netlify', 'platform'),

    -- Tools
    ('docker', 'Docker', 'tool'),
    ('kubernetes', 'Kubernetes', 'tool'),
    ('terraform', 'Terraform', 'tool'),
    ('git', 'Git', 'tool'),
    ('github-actions', 'GitHub Actions', 'tool'),
    ('jest', 'Jest', 'tool'),
    ('vitest', 'Vitest', 'tool'),
    ('playwright', 'Playwright', 'tool'),
    ('cypress', 'Cypress', 'tool'),
    ('webpack', 'Webpack', 'tool'),
    ('vite', 'Vite', 'tool'),
    ('eslint', 'ESLint', 'tool'),
    ('prettier', 'Prettier', 'tool');
```

---

## Maintenance SQL

### Cache Cleanup

```sql
-- Clean expired cache entries
DELETE FROM cache_entries WHERE expires_at <= strftime('%s', 'now');

-- Clean old telemetry events (keep 30 days)
DELETE FROM telemetry_events WHERE created_at < datetime('now', '-30 days');

-- Clean old sync logs (keep 90 days)
DELETE FROM sync_log WHERE created_at < datetime('now', '-90 days');
```

### Index Optimization

```sql
-- Analyze tables for query optimization
ANALYZE skills;
ANALYZE authors;
ANALYZE skill_categories;
ANALYZE skill_technologies;
ANALYZE cache_entries;

-- Rebuild FTS index if needed
INSERT INTO skills_fts(skills_fts) VALUES('rebuild');

-- Vacuum to reclaim space
PRAGMA incremental_vacuum(1000);
```

### Health Check Queries

```sql
-- Table row counts
SELECT 'skills' as table_name, COUNT(*) as count FROM skills WHERE deleted_at IS NULL
UNION ALL
SELECT 'authors', COUNT(*) FROM authors
UNION ALL
SELECT 'categories', COUNT(*) FROM categories
UNION ALL
SELECT 'technologies', COUNT(*) FROM technologies
UNION ALL
SELECT 'installed_skills', COUNT(*) FROM installed_skills
UNION ALL
SELECT 'cache_entries', COUNT(*) FROM cache_entries WHERE expires_at > strftime('%s', 'now')
UNION ALL
SELECT 'telemetry_queue', COUNT(*) FROM telemetry_queue WHERE status = 'pending';

-- Database file size
SELECT page_count * page_size as size_bytes FROM pragma_page_count(), pragma_page_size();

-- Index fragmentation
SELECT name, stat FROM sqlite_stat1;
```

---

## FTS5 Query Examples

### Basic Search

```sql
-- Simple search
SELECT s.id, s.name, s.description, bm25(skills_fts) as score
FROM skills_fts
JOIN skills s ON skills_fts.rowid = s.rowid
WHERE skills_fts MATCH 'react testing'
  AND s.deleted_at IS NULL
ORDER BY score
LIMIT 20;
```

### Phrase Search

```sql
-- Exact phrase search
SELECT s.id, s.name, bm25(skills_fts) as score
FROM skills_fts
JOIN skills s ON skills_fts.rowid = s.rowid
WHERE skills_fts MATCH '"unit testing"'
  AND s.deleted_at IS NULL
ORDER BY score
LIMIT 20;
```

### Boolean Operators

```sql
-- Boolean search with AND, OR, NOT
SELECT s.id, s.name, bm25(skills_fts) as score
FROM skills_fts
JOIN skills s ON skills_fts.rowid = s.rowid
WHERE skills_fts MATCH 'react AND testing NOT enzyme'
  AND s.deleted_at IS NULL
ORDER BY score
LIMIT 20;
```

### Column-Specific Search

```sql
-- Search in specific columns
SELECT s.id, s.name, bm25(skills_fts) as score
FROM skills_fts
JOIN skills s ON skills_fts.rowid = s.rowid
WHERE skills_fts MATCH 'name:react OR description:testing'
  AND s.deleted_at IS NULL
ORDER BY score
LIMIT 20;
```

### Prefix Matching

```sql
-- Prefix search
SELECT s.id, s.name, bm25(skills_fts) as score
FROM skills_fts
JOIN skills s ON skills_fts.rowid = s.rowid
WHERE skills_fts MATCH 'test*'
  AND s.deleted_at IS NULL
ORDER BY score
LIMIT 20;
```

### Weighted BM25 Ranking

```sql
-- Weighted ranking (name: 10.0, description: 5.0, search_text: 1.0)
SELECT s.id, s.name, s.description, bm25(skills_fts, 10.0, 5.0, 1.0) as score
FROM skills_fts
JOIN skills s ON skills_fts.rowid = s.rowid
WHERE skills_fts MATCH 'typescript'
  AND s.deleted_at IS NULL
ORDER BY score
LIMIT 20;
```

---

## References

- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [SQLite PRAGMA Reference](https://www.sqlite.org/pragma.html)
- [Data Architecture Design](/docs/architecture/data.md)
- [PRD v3](/docs/prd-v3.md)

---

*Schema Version: 1.0*
*Last Updated: December 26, 2025*
*Compatibility: SQLite 3.45+*
