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
import type { Database as BetterSqliteDatabase } from 'better-sqlite3'

export type DatabaseType = BetterSqliteDatabase

export const SCHEMA_VERSION = 2

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
  {
    version: 2,
    description: 'SMI-974: Add missing columns for Phase 5 imported databases',
    sql: `
-- Add updated_at column if missing (for Phase 5 imported databases)
ALTER TABLE skills ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

-- Add source column if missing (from import scripts)
ALTER TABLE skills ADD COLUMN source TEXT;

-- Add stars column if missing (from import scripts)
ALTER TABLE skills ADD COLUMN stars INTEGER;
`,
  },
]

/**
 * SMI-974: Migration SQL for adding FTS5 to existing database
 * Run separately as FTS5 creation can fail if table exists
 */
export const FTS5_MIGRATION_SQL = `
-- Create FTS5 virtual table if not exists
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name,
  description,
  tags,
  author,
  content='skills',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Populate FTS from existing skills (safe to run multiple times)
INSERT OR IGNORE INTO skills_fts(rowid, name, description, tags, author)
SELECT rowid, name, description, tags, author FROM skills;
`

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
 * Handles duplicate column errors gracefully since the initial schema
 * already includes all columns, but migrations need to support databases
 * created by other means (e.g., Phase 5 import scripts)
 */
export function runMigrations(db: DatabaseType): number {
  const currentVersion = getSchemaVersion(db)
  let migrationsRun = 0

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      // Execute each statement separately to handle duplicate column errors
      const statements = migration.sql.split(';').filter((s) => s.trim())
      for (const stmt of statements) {
        try {
          db.exec(stmt)
        } catch (error) {
          // Ignore "duplicate column" errors - column already exists from initial schema
          const msg = error instanceof Error ? error.message : String(error)
          if (!msg.includes('duplicate column')) {
            throw error
          }
        }
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
      migrationsRun++
    }
  }

  return migrationsRun
}

/**
 * Create a new database connection with proper configuration
 * This initializes the full schema - use openDatabase for existing databases
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
 * SMI-974: Open an existing database and run any pending migrations
 * Use this for databases that may have been created by different versions
 */
export function openDatabase(path: string): DatabaseType {
  const db = new Database(path)

  // Enable foreign keys
  db.pragma('foreign_keys = ON')

  // Check if schema_version table exists
  const hasSchemaVersion = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get()

  if (!hasSchemaVersion) {
    // Database has no version tracking - assume it's a Phase 5 import or similar
    // Create schema_version table and set to version 1
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO schema_version (version) VALUES (1);
    `)
  }

  // Run pending migrations safely
  runMigrationsSafe(db)

  return db
}

/**
 * SMI-974: Run migrations with error handling for existing columns
 */
export function runMigrationsSafe(db: DatabaseType): number {
  const currentVersion = getSchemaVersion(db)
  let migrationsRun = 0

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      try {
        // Try to run migration, but handle "duplicate column" errors gracefully
        const statements = migration.sql.split(';').filter((s) => s.trim())
        for (const stmt of statements) {
          try {
            db.exec(stmt)
          } catch (error) {
            // Ignore "duplicate column" errors - column already exists
            const msg = error instanceof Error ? error.message : String(error)
            if (!msg.includes('duplicate column')) {
              throw error
            }
          }
        }
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
        migrationsRun++
      } catch (error) {
        // Log but don't fail on migration errors
        console.warn(`Migration ${migration.version} failed:`, error)
      }
    }
  }

  // Try to create FTS5 table (may already exist)
  try {
    db.exec(FTS5_MIGRATION_SQL)
  } catch {
    // FTS5 may already exist or have issues - that's ok
  }

  return migrationsRun
}

/**
 * Close the database connection safely
 */
export function closeDatabase(db: DatabaseType): void {
  db.close()
}
