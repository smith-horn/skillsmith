/**
 * SMI-577: SQLite Database Schema with FTS5
 *
 * Implements the core database schema for Skillsmith including:
 * - Skills table with full metadata
 * - FTS5 virtual table for full-text search
 * - Sources, Categories, and Cache tables
 * - WAL mode for performance
 * - Indexes for common query patterns
 *
 * SQL constants live in schema-sql.ts (SMI-3910) to avoid circular imports
 * with migration-runner.ts. This file re-exports them for backward compat.
 */

import type { Database } from './database-interface.js'
import {
  createDatabaseSync,
  createDatabaseAsync as createDatabaseAsyncFactory,
} from './createDatabase.js'

// Re-export SQL constants (SMI-3910: extracted to avoid circular imports)
export { SCHEMA_SQL, FTS5_MIGRATION_SQL } from './schema-sql.js'
import { SCHEMA_SQL } from './schema-sql.js'

// Re-export migration runner functions and types (extracted in SMI-3910)
export {
  MIGRATIONS,
  getSchemaVersion,
  runMigrations,
  runMigrationsSafe,
} from './migration-runner.js'
export type { Migration } from './migration-runner.js'

// Re-import for use within this file (openDatabase, openDatabaseAsync)
import { runMigrationsSafe } from './migration-runner.js'

export type DatabaseType = Database

// v11: SMI-3510 content hash verification column
// v12: SMI-3864 risk score history for trend detection
export const SCHEMA_VERSION = 12

/**
 * Initialize the database with the complete schema
 */
export function initializeSchema(db: DatabaseType): void {
  db.exec(SCHEMA_SQL)

  // Record the schema version
  const stmt = db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
  stmt.run(SCHEMA_VERSION)
}

/** @deprecated Use createDatabaseAsync() — requires better-sqlite3 native module. */
export function createDatabase(path: string = ':memory:'): DatabaseType {
  const db = createDatabaseSync(path)

  // Enable foreign keys
  db.pragma('foreign_keys = ON')

  // Initialize schema
  initializeSchema(db)

  return db
}

/**
 * SMI-974: Open an existing database and run pending migrations.
 * @deprecated Use openDatabaseAsync() for cross-platform WASM support.
 */
export function openDatabase(path: string): DatabaseType {
  const db = createDatabaseSync(path)

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
 * Close the database connection safely
 */
export function closeDatabase(db: DatabaseType): void {
  db.close()
}

/**
 * Create a new database connection asynchronously with WASM fallback
 * This initializes the full schema - use openDatabaseAsync for existing databases
 *
 * @param path - Path to database file, or ':memory:' for in-memory
 * @returns Promise resolving to initialized database
 * @throws Error if database creation fails (e.g., invalid path, permission denied)
 * @throws Error if WASM module fails to load when native SQLite is unavailable
 */
export async function createDatabaseAsync(path: string = ':memory:'): Promise<DatabaseType> {
  const db = await createDatabaseAsyncFactory(path)

  // Enable foreign keys
  db.pragma('foreign_keys = ON')

  // Initialize schema
  initializeSchema(db)

  return db
}

/**
 * Open an existing database asynchronously with WASM fallback
 * Runs any pending migrations
 *
 * @param path - Path to existing database file
 * @returns Promise resolving to database with migrations applied
 * @throws Error if file does not exist (SQLITE_CANTOPEN)
 * @throws Error if WASM module fails to load when native SQLite is unavailable
 */
export async function openDatabaseAsync(path: string): Promise<DatabaseType> {
  const db = await createDatabaseAsyncFactory(path, { fileMustExist: true })

  // Enable foreign keys
  db.pragma('foreign_keys = ON')

  // Check if schema_version table exists
  const hasSchemaVersion = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get()

  if (!hasSchemaVersion) {
    // Database has no version tracking - assume it's a legacy import
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
