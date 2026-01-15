# Database Schema Documentation

**Last Updated**: January 2026
**Current Schema Version**: 2
**Related ADRs**: [ADR-011: Integration Test Database Strategy](../adr/011-integration-test-database.md), [ADR-009: Embedding Service Fallback](../adr/009-embedding-service-fallback.md)

## Overview

Skillsmith uses SQLite databases for local data storage. This document covers schema versioning, table definitions, migration strategies, and troubleshooting common schema mismatch issues.

### Database Files

| Database | Location | Purpose |
|----------|----------|---------|
| `skills.db` | `~/.skillsmith/skills.db` or `data/` | Primary skill catalog storage |
| `learning.db` | `~/.skillsmith/learning.db` | Recommendation learning loop (user preferences) |
| `cache.db` | `~/.skillsmith/cache.db` | Embedding cache and search results |

---

## Schema Version Tracking

### Current Version

```typescript
export const SCHEMA_VERSION = 2  // packages/core/src/db/schema.ts
```

### Version History

| Version | Description | Date |
|---------|-------------|------|
| 1 | Initial schema creation (SMI-577) | Phase 3 |
| 2 | Add missing columns for Phase 5 imports (SMI-974) | Phase 5 |

### Checking Schema Version

```typescript
import { getSchemaVersion, openDatabase } from '@skillsmith/core/db/schema'

const db = openDatabase('./skills.db')
const version = getSchemaVersion(db)
console.log(`Schema version: ${version}`)
```

**SQL Query**:
```sql
SELECT MAX(version) as version FROM schema_version;
```

---

## Core Tables

### schema_version

Tracks applied migrations.

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### skills

Main storage for discovered skills.

```sql
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  author TEXT,
  repo_url TEXT UNIQUE,
  quality_score REAL CHECK(quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  trust_tier TEXT CHECK(trust_tier IN ('verified', 'community', 'experimental', 'unknown')) DEFAULT 'unknown',
  tags TEXT DEFAULT '[]',  -- JSON array
  source TEXT,             -- Added in v2
  stars INTEGER,           -- Added in v2
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Column Details**:

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Unique skill identifier (format: `author/name`) |
| `name` | TEXT | NOT NULL | Human-readable skill name |
| `description` | TEXT | - | Skill description for search and display |
| `author` | TEXT | - | Skill author/maintainer |
| `repo_url` | TEXT | UNIQUE | GitHub repository URL |
| `quality_score` | REAL | 0.0-1.0 | Computed quality score (0-100% normalized) |
| `trust_tier` | TEXT | enum | One of: `verified`, `community`, `experimental`, `unknown` |
| `tags` | TEXT | JSON array | Searchable tags (stored as JSON string) |
| `source` | TEXT | - | Import source identifier |
| `stars` | INTEGER | - | GitHub stars count |
| `created_at` | TEXT | NOT NULL | ISO 8601 timestamp |
| `updated_at` | TEXT | NOT NULL | ISO 8601 timestamp |

### skills_fts

FTS5 virtual table for full-text search with BM25 ranking.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name,
  description,
  tags,
  author,
  content='skills',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
```

**FTS Triggers**:
- `skills_ai` - Syncs FTS on INSERT
- `skills_ad` - Syncs FTS on DELETE
- `skills_au` - Syncs FTS on UPDATE

### sources

Tracks skill discovery sources.

```sql
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('github', 'gitlab', 'local', 'registry')),
  url TEXT NOT NULL UNIQUE,
  last_sync_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### categories

Hierarchical skill organization.

```sql
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  skill_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### skill_categories

Many-to-many junction for skills and categories.

```sql
CREATE TABLE IF NOT EXISTS skill_categories (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, category_id)
);
```

### cache

Search result and API response caching.

```sql
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER,  -- Unix timestamp, NULL for no expiry
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### audit_logs

Security monitoring (SMI-733).

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT,
  resource TEXT,
  action TEXT,
  result TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## Indexes

### Skills Table Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_skills_author ON skills(author);
CREATE INDEX IF NOT EXISTS idx_skills_trust_tier ON skills(trust_tier);
CREATE INDEX IF NOT EXISTS idx_skills_quality_score ON skills(quality_score);
CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills(updated_at);
CREATE INDEX IF NOT EXISTS idx_skills_created_at ON skills(created_at);
```

### Other Indexes

```sql
-- Sources
CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);
CREATE INDEX IF NOT EXISTS idx_sources_is_active ON sources(is_active);

-- Categories
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

-- Cache
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

-- Audit Logs
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource);
CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_logs(result);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor);
```

---

## Quarantine Schema (SMI-865)

Separate schema for skill security management.

```sql
CREATE TABLE IF NOT EXISTS quarantine (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  source TEXT NOT NULL,
  quarantine_reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('MALICIOUS', 'SUSPICIOUS', 'RISKY', 'LOW_QUALITY')),
  detected_patterns TEXT DEFAULT '[]',  -- JSON array
  quarantine_date TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by TEXT,
  review_status TEXT NOT NULL CHECK(review_status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  review_notes TEXT,
  review_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Severity Levels**:

| Severity | Level | Policy |
|----------|-------|--------|
| `MALICIOUS` | 4 | Permanent quarantine, cannot import |
| `SUSPICIOUS` | 3 | Manual review required |
| `RISKY` | 2 | Can import with warnings |
| `LOW_QUALITY` | 1 | Can import with reduced score |

---

## Analytics Schema

Located in `packages/core/src/analytics/schema.ts`. Tables include:

- `skill_usage_events` - Usage tracking with 30-day rolling window
- `experiments` - A/B testing management
- `experiment_assignments` - User variant assignments
- `experiment_outcomes` - Outcome tracking
- `roi_metrics` - ROI aggregation
- `value_attributions` - Value attribution mappings
- `usage_quotas` - Quota management (SMI-XXXX)
- `api_call_events` - API call tracking
- `user_subscriptions` - Subscription management

---

## Learning Schema

Located in `packages/core/src/learning/schema.sql`. Stored locally at `~/.skillsmith/learning.db`.

**Tables**:
- `signal_events` - User interaction signals
- `user_profile` - Singleton preference profile
- `aggregate_stats` - Anonymized daily statistics
- `dismiss_reasons` - Dismiss reason tracking
- `schema_version` - Learning schema version

**Privacy Features**:
- 90-day automatic data retention cleanup
- Local storage only (no external transmission)
- Aggregate statistics are anonymized

---

## Migration System

### Migration Structure

```typescript
export interface Migration {
  version: number
  description: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema creation',
    sql: SCHEMA_SQL,
  },
  {
    version: 2,
    description: 'SMI-974: Add missing columns for Phase 5 imported databases',
    sql: `
      ALTER TABLE skills ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
      ALTER TABLE skills ADD COLUMN source TEXT;
      ALTER TABLE skills ADD COLUMN stars INTEGER;
    `,
  },
]
```

### Running Migrations

**Programmatic**:
```typescript
import { openDatabase, runMigrations, getSchemaVersion } from '@skillsmith/core/db/schema'

const db = openDatabase('./skills.db')
const currentVersion = getSchemaVersion(db)
const migrationsRun = runMigrations(db)

console.log(`Migrated from v${currentVersion}, ran ${migrationsRun} migrations`)
```

**Safe Migration (handles duplicate columns)**:
```typescript
import { runMigrationsSafe } from '@skillsmith/core/db/schema'

// Handles "duplicate column" errors gracefully
const migrationsRun = runMigrationsSafe(db)
```

### Creating vs Opening Databases

```typescript
// Create NEW database with full schema
import { createDatabase } from '@skillsmith/core/db/schema'
const db = createDatabase('./new-skills.db')  // Initializes full schema

// Open EXISTING database and run pending migrations
import { openDatabase } from '@skillsmith/core/db/schema'
const db = openDatabase('./existing-skills.db')  // Runs migrations if needed
```

---

## Common Schema Mismatch Issues

### Issue 1: Missing `updated_at` Column

**Symptom**:
```
SQLITE_ERROR: no such column: updated_at
```

**Cause**: Database was created before v2 migration or by Phase 5 import scripts.

**Fix**:
```typescript
import { openDatabase } from '@skillsmith/core/db/schema'
const db = openDatabase('./skills.db')  // Automatically runs migrations
```

Or manually:
```sql
ALTER TABLE skills ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
```

### Issue 2: Missing `schema_version` Table

**Symptom**:
```
SQLITE_ERROR: no such table: schema_version
```

**Cause**: Database was created by external tools or very old Skillsmith version.

**Fix**:
```typescript
import { openDatabase } from '@skillsmith/core/db/schema'
// openDatabase() automatically creates schema_version if missing
const db = openDatabase('./skills.db')
```

Or manually:
```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
```

### Issue 3: FTS5 Table Not Synced

**Symptom**: Full-text search returns no results despite skills existing.

**Cause**: FTS triggers not created or FTS table out of sync.

**Fix**:
```typescript
import { FTS5_MIGRATION_SQL } from '@skillsmith/core/db/schema'
db.exec(FTS5_MIGRATION_SQL)
```

Or manually:
```sql
-- Rebuild FTS index
INSERT INTO skills_fts(skills_fts) VALUES('rebuild');
```

### Issue 4: Native Module Version Mismatch

**Symptom**:
```
ERR_DLOPEN_FAILED: Module was compiled against a different Node.js version
```

**Cause**: Node.js version changed since `better-sqlite3` was compiled.

**Fix**:
```bash
# In Docker (preferred)
docker exec skillsmith-dev-1 npm rebuild better-sqlite3

# Or locally
npm rebuild better-sqlite3
```

See [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md).

---

## Database Pragmas

The following SQLite pragmas are applied for performance:

```sql
PRAGMA journal_mode = WAL;       -- Write-ahead logging for concurrency
PRAGMA synchronous = NORMAL;     -- Balance safety and performance
PRAGMA cache_size = -64000;      -- 64MB cache
PRAGMA temp_store = MEMORY;      -- In-memory temp tables
PRAGMA foreign_keys = ON;        -- Enforce referential integrity
```

Note: In-memory databases (`:memory:`) cannot use WAL mode and will use `memory` journal mode instead.

---

## Verification Queries

### Check Schema Version
```sql
SELECT MAX(version) as version FROM schema_version;
```

### List All Tables
```sql
SELECT name FROM sqlite_master
WHERE type='table' AND name NOT LIKE 'sqlite_%'
ORDER BY name;
```

### List All Indexes
```sql
SELECT name FROM sqlite_master
WHERE type='index' AND name LIKE 'idx_%';
```

### Check Skills Table Structure
```sql
PRAGMA table_info(skills);
```

### Verify FTS Sync
```sql
-- Count in base table
SELECT COUNT(*) as skills_count FROM skills;

-- Count in FTS table
SELECT COUNT(*) as fts_count FROM skills_fts;
```

### Check Foreign Key Status
```sql
PRAGMA foreign_keys;  -- Should return 1
```

---

## References

- **Source Files**:
  - `packages/core/src/db/schema.ts` - Main schema and migrations
  - `packages/core/src/db/quarantine-schema.ts` - Quarantine schema
  - `packages/core/src/analytics/schema.ts` - Analytics schema
  - `packages/core/src/learning/schema.sql` - Learning loop schema
  - `scripts/lib/migration-utils.ts` - Migration utilities

- **Related ADRs**:
  - [ADR-009: Embedding Service Fallback](../adr/009-embedding-service-fallback.md)
  - [ADR-011: Integration Test Database Strategy](../adr/011-integration-test-database.md)
  - [ADR-012: Native Module Version Management](../adr/012-native-module-version-management.md)

- **Linear Issues**:
  - SMI-577: SQLite Database Schema with FTS5
  - SMI-733: Audit logging table
  - SMI-865: Quarantine management schema
  - SMI-974: Migration for Phase 5 imported databases
