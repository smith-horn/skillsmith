/**
 * @fileoverview Test database helpers — prevents "no such table" for migrated tables
 * @see SMI-2749
 *
 * Use createTestDatabase() instead of createDatabase(':memory:') whenever tests
 * need tables that only exist in migration files (e.g. skill_versions).
 *
 * WHY THIS EXISTS:
 * createDatabase(':memory:') calls initializeSchema(), which records SCHEMA_VERSION=5
 * directly in schema_version WITHOUT running the intermediate migration SQLs.
 * runMigrations() then sees version=5 and skips all migrations — a no-op.
 * Tables defined only in migration SQL (not in SCHEMA_SQL) are never created.
 * Example: skill_versions is in MIGRATION_V5_SQL, not SCHEMA_SQL.
 *
 * createTestDatabase() iterates MIGRATIONS directly (no version gate) so every
 * migration's SQL runs unconditionally. New migrations added to MIGRATIONS are
 * automatically included — no change required here.
 */

import { createDatabase, MIGRATIONS } from '../../src/db/schema.js'
import type { Database } from '../../src/db/database-interface.js'

// Re-exported for test convenience — tests only need to import from this module
export { closeDatabase } from '../../src/db/schema.js'
export type { Database } from '../../src/db/database-interface.js'

/**
 * Create an in-memory SQLite database with ALL schema + migrations applied.
 *
 * Safe to use for any test that needs migrated tables (e.g. skill_versions,
 * sync_config, sync_history). Forward-compatible: new migrations added to
 * MIGRATIONS are included automatically.
 *
 * @returns Database with full schema + all migrations applied
 */
export function createTestDatabase(): Database {
  // createDatabase() calls initializeSchema() — runs SCHEMA_SQL (handling FTS5 triggers
  // and multi-statement SQL correctly) and stamps SCHEMA_VERSION in schema_version.
  const db = createDatabase()

  // Run all migrations unconditionally (no version gate) so tables that only exist in
  // migration SQL (not SCHEMA_SQL) are created. db.exec() handles multi-statement SQL
  // natively — no semicolon split needed.
  //
  // "duplicate column" errors are caught: some migration SQL adds columns that are
  // already included in the canonical SCHEMA_SQL. Those errors are expected and safe.
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration.sql)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (!msg.includes('duplicate column')) throw error
    }
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(migration.version)
  }

  return db
}
