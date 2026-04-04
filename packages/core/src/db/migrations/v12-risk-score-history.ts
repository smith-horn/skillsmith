/**
 * @fileoverview Migration v12 -- Risk score history for trend detection
 * @see SMI-3864
 *
 * Stores point-in-time risk score snapshots after each security scan.
 * No FOREIGN KEY on skill_id — direct-install skills (GitHub URLs) may not
 * exist in the local skills table (Review #6).
 */
export const MIGRATION_V12_SQL = `
CREATE TABLE IF NOT EXISTS risk_score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,
  risk_score INTEGER NOT NULL CHECK(risk_score >= 0 AND risk_score <= 100),
  findings_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'install'
);

CREATE INDEX IF NOT EXISTS idx_risk_score_history_skill_id
  ON risk_score_history(skill_id);
CREATE INDEX IF NOT EXISTS idx_risk_score_history_scanned_at
  ON risk_score_history(skill_id, scanned_at);
`
