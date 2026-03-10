/**
 * @fileoverview Migration v2 — Add missing columns for Phase 5 imported databases
 * @module @skillsmith/core/db/migrations/v2-phase5-columns
 * @see SMI-974
 */
export const MIGRATION_V2_SQL = `
-- Add updated_at column if missing (for Phase 5 imported databases)
ALTER TABLE skills ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));

-- Add source column if missing (from import scripts)
ALTER TABLE skills ADD COLUMN source TEXT;

-- Add stars column if missing (from import scripts)
ALTER TABLE skills ADD COLUMN stars INTEGER;
`
