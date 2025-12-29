/**
 * SMI-577: SQLite Database Schema with FTS5
 *
 * Implements the core database schema for Skillsmith including:
 * - Skills table with full metadata
 * - FTS5 virtual table for full-text search
 * - Sources, Categories, and Cache tables
 * - WAL mode for performance
 * - Indexes for common query patterns
 */

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'

export const SCHEMA_VERSION = 1

/**
 * SQL statements for creating the database schema
 */
export const SCHEMA_SQL = `
-- Enable WAL mode for better concurrent performance
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000; -- 64MB cache
PRAGMA temp_store = MEMORY;

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Skills table - main storage for discovered skills
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  author TEXT,
  repo_url TEXT UNIQUE,
  quality_score REAL CHECK(quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  trust_tier TEXT CHECK(trust_tier IN ('verified', 'community', 'experimental', 'unknown')) DEFAULT 'unknown',
  tags TEXT DEFAULT '[]', -- JSON array of tags
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 virtual table for full-text search with BM25 ranking
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name,
  description,
  tags,
  author,
  content='skills',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS index in sync with skills table
CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, tags, author)
  VALUES (NEW.rowid, NEW.name, NEW.description, NEW.tags, NEW.author);
END;

CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, tags, author)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.tags, OLD.author);
END;

CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, tags, author)
  VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.tags, OLD.author);
  INSERT INTO skills_fts(rowid, name, description, tags, author)
  VALUES (NEW.rowid, NEW.name, NEW.description, NEW.tags, NEW.author);
END;

-- Sources table - tracks where skills are discovered from
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('github', 'gitlab', 'local', 'registry')),
  url TEXT NOT NULL UNIQUE,
  last_sync_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Categories table - hierarchical organization of skills
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  skill_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Skill-Category junction table
CREATE TABLE IF NOT EXISTS skill_categories (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, category_id)
);

-- Cache table for search results and API responses
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER, -- Unix timestamp, NULL for no expiry
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_skills_author ON skills(author);
CREATE INDEX IF NOT EXISTS idx_skills_trust_tier ON skills(trust_tier);
CREATE INDEX IF NOT EXISTS idx_skills_quality_score ON skills(quality_score);
CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills(updated_at);
CREATE INDEX IF NOT EXISTS idx_skills_created_at ON skills(created_at);
CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);
CREATE INDEX IF NOT EXISTS idx_sources_is_active ON sources(is_active);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

-- SMI-733: Audit logs table for security monitoring
-- See: docs/security/index.md §3 Audit Logging
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

CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource);
CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_logs(result);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor);
`

/**
 * Migration definitions for schema upgrades
 */
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
]

/**
 * Initialize the database with the complete schema
 */
export function initializeSchema(db: DatabaseType): void {
  db.exec(SCHEMA_SQL)

  // Record the schema version
  const stmt = db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
  stmt.run(SCHEMA_VERSION)
}

/**
 * Get the current schema version from the database
 */
export function getSchemaVersion(db: DatabaseType): number {
  try {
    const result = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as
      | { version: number }
      | undefined
    return result?.version ?? 0
  } catch {
    return 0
  }
}

/**
 * Run pending migrations to upgrade the schema
 */
export function runMigrations(db: DatabaseType): number {
  const currentVersion = getSchemaVersion(db)
  let migrationsRun = 0

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
      migrationsRun++
    }
  }

  return migrationsRun
}

/**
 * Create a new database connection with proper configuration
 */
export function createDatabase(path: string = ':memory:'): DatabaseType {
  const db = new Database(path)

  // Enable foreign keys
  db.pragma('foreign_keys = ON')

  // Initialize schema
  initializeSchema(db)

  return db
}

/**
 * Close the database connection safely
 */
export function closeDatabase(db: DatabaseType): void {
  db.close()
}
