/**
 * @fileoverview Migration v4 — Add security scan columns to skills table
 * @module @skillsmith/core/db/migrations/v4-security-columns
 * @see SMI-825
 */
export const MIGRATION_V4_SQL = `
-- Add security columns to skills table
ALTER TABLE skills ADD COLUMN risk_score INTEGER CHECK(risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 100));
ALTER TABLE skills ADD COLUMN security_findings_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN security_scanned_at TEXT;
ALTER TABLE skills ADD COLUMN security_passed INTEGER;

-- Index for efficient security queries
CREATE INDEX IF NOT EXISTS idx_skills_risk_score ON skills(risk_score);
CREATE INDEX IF NOT EXISTS idx_skills_security_passed ON skills(security_passed);
`
