/**
 * SMI-627: Migration to add embeddings support to skills table
 *
 * This migration adds:
 * - embedding BLOB column to skills table for storing vector embeddings
 * - embedding_text TEXT column for the text used to generate the embedding
 * - embedding_updated_at timestamp to track when embedding was last computed
 * - Index on embedding_updated_at for efficient queries
 */

import type { Database as DatabaseType } from 'better-sqlite3'

export const MIGRATION_VERSION = 2
export const MIGRATION_DESCRIPTION = 'Add embeddings support to skills table'

export const MIGRATION_SQL = `
-- Add embedding columns to skills table
ALTER TABLE skills ADD COLUMN embedding BLOB;
ALTER TABLE skills ADD COLUMN embedding_text TEXT;
ALTER TABLE skills ADD COLUMN embedding_updated_at TEXT;

-- Create index for efficient embedding queries
CREATE INDEX IF NOT EXISTS idx_skills_embedding_updated
ON skills(embedding_updated_at);

-- Create separate embeddings table for flexibility (allows different models)
CREATE TABLE IF NOT EXISTS skill_embeddings (
  skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL DEFAULT 'all-MiniLM-L6-v2',
  embedding BLOB NOT NULL,
  embedding_dim INTEGER NOT NULL DEFAULT 384,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for model-based queries
CREATE INDEX IF NOT EXISTS idx_embeddings_model
ON skill_embeddings(model_name);
`

/**
 * Run the migration
 */
export function runMigration(db: DatabaseType): void {
  // Check if migration already applied
  const existingVersion = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as
    | { version: number }
    | undefined

  if (existingVersion && existingVersion.version >= MIGRATION_VERSION) {
    return // Already applied
  }

  // Execute migration
  db.exec(MIGRATION_SQL)

  // Record migration
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(MIGRATION_VERSION)
}

/**
 * Rollback the migration (for testing)
 */
export function rollbackMigration(db: DatabaseType): void {
  // SQLite doesn't support DROP COLUMN in older versions
  // For full rollback, would need to recreate table
  // This is a simplified version that just removes the embeddings table
  db.exec(`
    DROP TABLE IF EXISTS skill_embeddings;
    DELETE FROM schema_version WHERE version = ${MIGRATION_VERSION};
  `)
}

export default {
  version: MIGRATION_VERSION,
  description: MIGRATION_DESCRIPTION,
  sql: MIGRATION_SQL,
  run: runMigration,
  rollback: rollbackMigration,
}
