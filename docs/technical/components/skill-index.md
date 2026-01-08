# Skill Index

> **Navigation**: [Components Index](./index.md) | [Technical Index](../index.md) | [Data Schema](../data/schema.md)

---

## Data Model

```sql
-- Core skills table
CREATE TABLE skills (
    id TEXT PRIMARY KEY,                -- e.g., "anthropic/skills/test-fixing"
    name TEXT NOT NULL,
    description TEXT,
    author TEXT,
    repo_url TEXT UNIQUE NOT NULL,

    -- Source tracking
    source TEXT NOT NULL,               -- 'github', 'claude-plugins', 'skillsmp'
    source_id TEXT,

    -- GitHub metrics
    stars INTEGER DEFAULT 0,
    forks INTEGER DEFAULT 0,
    open_issues INTEGER DEFAULT 0,
    license TEXT,
    language TEXT,
    topics TEXT,                        -- JSON array
    created_at TEXT,
    updated_at TEXT,

    -- Computed scores (0.0 - 1.0)
    quality_score REAL,
    popularity_score REAL,
    maintenance_score REAL,
    final_score REAL,

    -- Trust and verification
    trust_tier TEXT DEFAULT 'community', -- 'official', 'verified', 'community', 'unverified'
    security_scan_status TEXT,
    security_scan_date TEXT,

    -- Content analysis
    readme_length INTEGER,
    skillmd_quality REAL,
    has_tests BOOLEAN,
    has_examples BOOLEAN,

    -- Indexing metadata
    indexed_at TEXT NOT NULL,
    last_scored_at TEXT,
    embedding_id INTEGER,

    -- Full-text search
    search_text TEXT                    -- Concatenated searchable content
);

-- Full-text search index
CREATE VIRTUAL TABLE skills_fts USING fts5(
    name,
    description,
    search_text,
    content='skills',
    content_rowid='rowid'
);

-- Categories and tags
CREATE TABLE skill_categories (
    skill_id TEXT REFERENCES skills(id),
    category TEXT NOT NULL,
    PRIMARY KEY (skill_id, category)
);

-- Technology tags
CREATE TABLE skill_technologies (
    skill_id TEXT REFERENCES skills(id),
    technology TEXT NOT NULL,
    PRIMARY KEY (skill_id, technology)
);

-- User interactions (local only)
CREATE TABLE skill_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT REFERENCES skills(id),
    action TEXT NOT NULL,               -- 'viewed', 'installed', 'uninstalled', 'activated'
    timestamp TEXT NOT NULL,
    context TEXT                        -- JSON metadata
);

-- Blocklist
CREATE TABLE blocked_skills (
    skill_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    blocked_at TEXT NOT NULL,
    severity TEXT DEFAULT 'warning'     -- 'warning', 'critical'
);
```

---

## Storage Strategy

| Data Type | Storage | Size Estimate | Sync Frequency |
|-----------|---------|---------------|----------------|
| Skill metadata | SQLite | ~50MB for 50K skills | Daily |
| Embeddings | Binary file | ~200MB for 50K skills | Weekly |
| User interactions | SQLite | <10MB | N/A (local only) |
| Recommendations | Markdown files | <5MB | On generation |
| Cache | SQLite + files | <100MB | On demand |

---

## Caching Strategy

```typescript
interface CacheConfig {
  github_api: {
    ttl_hours: 1,           // Repository metadata
    ttl_hours_stars: 24,    // Stars/forks (less volatile)
  },
  skill_search: {
    ttl_minutes: 30,        // Search results
  },
  embeddings: {
    preload: true,          // Load into memory on startup
    max_memory_mb: 100,
  },
  codebase_scan: {
    ttl_minutes: 60,        // Per-project cache
    invalidate_on: ['package.json', 'requirements.txt', 'Cargo.toml'],
  },
}
```

---

## Storage Requirements by Phase

| Phase | Skills Indexed | SQLite Size | Embeddings Size | Total |
|-------|----------------|-------------|-----------------|-------|
| Phase 1 | 1,000 | ~5MB | ~20MB | ~25MB |
| Phase 2 | 10,000 | ~15MB | ~100MB | ~115MB |
| Phase 3 | 25,000 | ~30MB | ~150MB | ~180MB |
| Phase 4 | 50,000+ | ~50MB | ~200MB | ~250MB |

---

## Related Documentation

- [Data Schema](../data/schema.md) - Full schema documentation
- [Sync Strategy](../data/sync-strategy.md) - Data synchronization
- [Caching](../data/caching.md) - Cache configuration

---

*Next: [Codebase Scanner](./codebase-scanner.md)*
