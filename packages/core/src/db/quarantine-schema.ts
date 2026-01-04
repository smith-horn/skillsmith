/**
 * SMI-865: Quarantine Management System Database Schema
 *
 * Provides database schema for skill quarantine management:
 * - Quarantine table with severity levels and review status
 * - Indexes for efficient querying
 * - Migration support for existing databases
 *
 * Severity Categories:
 * - MALICIOUS: Permanent quarantine, security threat detected
 * - SUSPICIOUS: Manual review required before import
 * - RISKY: Can import with warnings displayed
 * - LOW_QUALITY: Can import with reduced quality score
 */

import type { Database as DatabaseType } from 'better-sqlite3'

/**
 * Severity levels for quarantined skills
 */
export type QuarantineSeverity = 'MALICIOUS' | 'SUSPICIOUS' | 'RISKY' | 'LOW_QUALITY'

/**
 * Review status for quarantined skills
 */
export type QuarantineReviewStatus = 'pending' | 'approved' | 'rejected'

/**
 * Quarantine severity descriptions and policies
 */
export const QUARANTINE_SEVERITY_POLICIES = {
  MALICIOUS: {
    level: 4,
    description: 'Permanent quarantine - security threat detected',
    allowImport: false,
    requiresReview: true,
    autoReject: false,
  },
  SUSPICIOUS: {
    level: 3,
    description: 'Manual review required before import',
    allowImport: false,
    requiresReview: true,
    autoReject: false,
  },
  RISKY: {
    level: 2,
    description: 'Can import with warnings displayed',
    allowImport: true,
    requiresReview: false,
    autoReject: false,
  },
  LOW_QUALITY: {
    level: 1,
    description: 'Can import with reduced quality score',
    allowImport: true,
    requiresReview: false,
    autoReject: false,
  },
} as const

/**
 * SQL statement to create the quarantine table
 */
export const QUARANTINE_SCHEMA_SQL = `
-- SMI-865: Quarantine table for skill security management
CREATE TABLE IF NOT EXISTS quarantine (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  source TEXT NOT NULL,
  quarantine_reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('MALICIOUS', 'SUSPICIOUS', 'RISKY', 'LOW_QUALITY')),
  detected_patterns TEXT DEFAULT '[]', -- JSON array of detected security patterns
  quarantine_date TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by TEXT,
  review_status TEXT NOT NULL CHECK(review_status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  review_notes TEXT,
  review_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_quarantine_skill_id ON quarantine(skill_id);
CREATE INDEX IF NOT EXISTS idx_quarantine_severity ON quarantine(severity);
CREATE INDEX IF NOT EXISTS idx_quarantine_review_status ON quarantine(review_status);
CREATE INDEX IF NOT EXISTS idx_quarantine_source ON quarantine(source);
CREATE INDEX IF NOT EXISTS idx_quarantine_date ON quarantine(quarantine_date);
CREATE INDEX IF NOT EXISTS idx_quarantine_reviewed_by ON quarantine(reviewed_by);
`

/**
 * Initialize the quarantine schema in the database
 *
 * @param db - Database connection
 */
export function initializeQuarantineSchema(db: DatabaseType): void {
  db.exec(QUARANTINE_SCHEMA_SQL)
}

/**
 * Check if the quarantine table exists
 *
 * @param db - Database connection
 * @returns True if quarantine table exists
 */
export function hasQuarantineTable(db: DatabaseType): boolean {
  const result = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quarantine'")
    .get()
  return !!result
}

/**
 * Run quarantine schema migration if needed
 *
 * @param db - Database connection
 * @returns True if migration was run
 */
export function migrateQuarantineSchema(db: DatabaseType): boolean {
  if (!hasQuarantineTable(db)) {
    initializeQuarantineSchema(db)
    return true
  }
  return false
}
