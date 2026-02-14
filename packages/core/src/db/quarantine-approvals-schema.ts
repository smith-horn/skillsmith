/**
 * SMI-2277: Quarantine Approvals Schema
 *
 * Database schema for persisting multi-approval state. Replaces the
 * in-memory Map<string, ApprovalState> that was lost on service restart.
 *
 * Note on type mappings:
 * - `reviewer_id` is TEXT here (SQLite) but UUID in the Supabase migration.
 *   In production, values are always UUIDs from auth providers. Tests may
 *   use human-readable strings like 'user-456' for clarity.
 * - `is_complete` is INTEGER 0/1 here (SQLite has no native boolean) but
 *   BOOLEAN in the PostgreSQL migration. Queries in ApprovalRepository use
 *   integer literals (0/1) which are SQLite-specific.
 * - `created_at` uses `datetime('now') || 'Z'` to produce UTC ISO-8601
 *   strings (e.g. '2026-02-13 12:00:00Z') so Date parsing is unambiguous.
 *
 * @module @skillsmith/core/db/quarantine-approvals-schema
 */

import type { Database as DatabaseType } from './database-interface.js'

/**
 * SQL statement to create the quarantine_approvals table
 */
export const QUARANTINE_APPROVALS_SCHEMA_SQL = `
-- SMI-2277: Quarantine multi-approval persistence
CREATE TABLE IF NOT EXISTS quarantine_approvals (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewer_email TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now') || 'Z'),
  completed_at TEXT,
  required_approvals INTEGER NOT NULL DEFAULT 2,
  is_complete INTEGER NOT NULL DEFAULT 0
);

-- Index for efficient lookup by skill_id (most common query path)
CREATE INDEX IF NOT EXISTS idx_quarantine_approvals_skill_id
  ON quarantine_approvals(skill_id);

-- Enforce one pending review per reviewer per skill (defense-in-depth)
CREATE UNIQUE INDEX IF NOT EXISTS idx_quarantine_approvals_reviewer_unique
  ON quarantine_approvals(skill_id, reviewer_id)
  WHERE is_complete = 0;

-- Efficient count of pending approvals (used by isComplete check)
CREATE INDEX IF NOT EXISTS idx_quarantine_approvals_pending
  ON quarantine_approvals(skill_id, decision)
  WHERE is_complete = 0;
`

/**
 * Initialize the quarantine_approvals schema in the database
 *
 * @param db - Database connection
 */
export function initializeQuarantineApprovalsSchema(db: DatabaseType): void {
  db.exec(QUARANTINE_APPROVALS_SCHEMA_SQL)
}

/**
 * Check if the quarantine_approvals table exists
 *
 * @param db - Database connection
 * @returns True if quarantine_approvals table exists
 */
export function hasQuarantineApprovalsTable(db: DatabaseType): boolean {
  const result = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quarantine_approvals'")
    .get()
  return !!result
}
