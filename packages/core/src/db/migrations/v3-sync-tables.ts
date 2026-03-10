/**
 * @fileoverview Migration v3 — Registry sync tables for local-to-live synchronization
 * @module @skillsmith/core/db/migrations/v3-sync-tables
 */
export const MIGRATION_V3_SQL = `
-- Sync configuration table (singleton pattern)
CREATE TABLE IF NOT EXISTS sync_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  enabled INTEGER NOT NULL DEFAULT 1,
  frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('daily', 'weekly')),
  interval_ms INTEGER NOT NULL DEFAULT 86400000,
  last_sync_at TEXT,
  next_sync_at TEXT,
  last_sync_count INTEGER DEFAULT 0,
  last_sync_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initialize default config if empty
INSERT OR IGNORE INTO sync_config (id) VALUES ('default');

-- Sync history table for tracking sync runs
CREATE TABLE IF NOT EXISTS sync_history (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'success', 'failed', 'partial')),
  skills_added INTEGER DEFAULT 0,
  skills_updated INTEGER DEFAULT 0,
  skills_unchanged INTEGER DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for efficient history queries
CREATE INDEX IF NOT EXISTS idx_sync_history_started ON sync_history(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_history_status ON sync_history(status);
`
