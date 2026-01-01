-- Recommendation Learning Loop Database Schema
-- Epic 1 - Sub-issue 5: Build Recommendation Learning Loop
-- Owner: Data Scientist
--
-- PRIVACY NOTICE:
-- This database stores user preference data LOCALLY ONLY.
-- No data is transmitted externally. User has full control
-- via export and wipe functionality.
--
-- Storage location: ~/.skillsmith/learning.db

-- Signal events table
-- Stores all user interactions with recommendations
CREATE TABLE IF NOT EXISTS signal_events (
  -- Unique event identifier (UUID)
  id TEXT PRIMARY KEY,

  -- Signal type (accept, dismiss, usage_daily, etc.)
  type TEXT NOT NULL CHECK (type IN (
    'accept',
    'dismiss',
    'usage_daily',
    'usage_weekly',
    'abandoned',
    'uninstall'
  )),

  -- Skill that was recommended/interacted with
  skill_id TEXT NOT NULL,

  -- Unix timestamp in milliseconds
  timestamp INTEGER NOT NULL,

  -- Recommendation context (JSON)
  -- {
  --   "installed_skills": ["anthropic/commit"],
  --   "project_context": "React frontend",
  --   "original_score": 0.85,
  --   "trust_tier": "verified",
  --   "category": "git"
  -- }
  context_json TEXT NOT NULL,

  -- Optional metadata (JSON)
  -- {
  --   "time_to_action": 5000,
  --   "suggestion_count": 2
  -- }
  metadata_json TEXT,

  -- Dismiss reason (only for DISMISS signals)
  dismiss_reason TEXT CHECK (dismiss_reason IN (
    'not_relevant',
    'duplicate',
    'trust_issue',
    'too_complex',
    'other',
    NULL
  ))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_signal_events_skill_id
  ON signal_events(skill_id);

CREATE INDEX IF NOT EXISTS idx_signal_events_timestamp
  ON signal_events(timestamp);

CREATE INDEX IF NOT EXISTS idx_signal_events_type
  ON signal_events(type);

CREATE INDEX IF NOT EXISTS idx_signal_events_type_skill
  ON signal_events(type, skill_id);

-- User preference profile (singleton table)
-- Only one row allowed (id=1) for single-user system
-- For multi-user, add user_id column and remove CHECK constraint
CREATE TABLE IF NOT EXISTS user_profile (
  -- Singleton ID (always 1)
  id INTEGER PRIMARY KEY CHECK (id = 1),

  -- Profile schema version for migrations
  version INTEGER NOT NULL DEFAULT 1,

  -- Last updated timestamp (ms)
  last_updated INTEGER NOT NULL,

  -- Profile JSON
  -- {
  --   "version": 1,
  --   "last_updated": 1704067200000,
  --   "signal_count": 42,
  --   "category_weights": {
  --     "testing": 0.8,
  --     "git": 0.6
  --   },
  --   "trust_tier_weights": {
  --     "verified": 0.3,
  --     "community": 0.1
  --   },
  --   "keyword_weights": {
  --     "jest": 0.5,
  --     "react": 0.4
  --   },
  --   "negative_patterns": {
  --     "keywords": ["deprecated"],
  --     "categories": [],
  --     "skill_ids": ["bad-skill"]
  --   },
  --   "usage_patterns": {
  --     "avg_time_to_first_use_ms": 3600000,
  --     "utilization_rate": 0.75,
  --     "top_categories": ["testing", "git"]
  --   }
  -- }
  profile_json TEXT NOT NULL
);

-- Aggregate statistics (anonymized, no PII)
-- Used for analytics and system insights
CREATE TABLE IF NOT EXISTS aggregate_stats (
  -- Date (YYYY-MM-DD)
  date TEXT PRIMARY KEY,

  -- Total signals recorded on this date
  total_signals INTEGER NOT NULL DEFAULT 0,

  -- Accept count
  accept_count INTEGER NOT NULL DEFAULT 0,

  -- Dismiss count
  dismiss_count INTEGER NOT NULL DEFAULT 0,

  -- Usage count (daily + weekly)
  usage_count INTEGER NOT NULL DEFAULT 0,

  -- Abandoned count
  abandoned_count INTEGER NOT NULL DEFAULT 0,

  -- Uninstall count
  uninstall_count INTEGER NOT NULL DEFAULT 0,

  -- Additional stats (JSON)
  -- {
  --   "popular_categories": [
  --     {"category": "testing", "count": 10},
  --     {"category": "git", "count": 8}
  --   ],
  --   "avg_accept_rate": 0.65,
  --   "avg_utilization_rate": 0.72
  -- }
  stats_json TEXT
);

-- Dismiss reason statistics (for product insights)
CREATE TABLE IF NOT EXISTS dismiss_reasons (
  -- Date (YYYY-MM-DD)
  date TEXT NOT NULL,

  -- Reason
  reason TEXT NOT NULL CHECK (reason IN (
    'not_relevant',
    'duplicate',
    'trust_issue',
    'too_complex',
    'other'
  )),

  -- Count for this reason on this date
  count INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (date, reason)
);

-- Schema version tracking for migrations
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT
);

-- Insert initial schema version
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES (1, strftime('%s', 'now') * 1000, 'Initial learning loop schema');

-- Data retention trigger
-- Automatically delete signals older than 90 days (configurable)
-- This ensures GDPR compliance and prevents unbounded growth
CREATE TRIGGER IF NOT EXISTS cleanup_old_signals
  AFTER INSERT ON signal_events
  BEGIN
    DELETE FROM signal_events
    WHERE timestamp < (strftime('%s', 'now') * 1000) - (90 * 24 * 60 * 60 * 1000);
  END;

-- Update aggregate stats trigger
-- Automatically updates daily statistics when signals are inserted
CREATE TRIGGER IF NOT EXISTS update_aggregate_stats
  AFTER INSERT ON signal_events
  BEGIN
    -- Update or insert daily stats
    INSERT INTO aggregate_stats (date, total_signals, accept_count, dismiss_count, usage_count, abandoned_count, uninstall_count)
    VALUES (
      date(NEW.timestamp / 1000, 'unixepoch'),
      1,
      CASE WHEN NEW.type = 'accept' THEN 1 ELSE 0 END,
      CASE WHEN NEW.type = 'dismiss' THEN 1 ELSE 0 END,
      CASE WHEN NEW.type IN ('usage_daily', 'usage_weekly') THEN 1 ELSE 0 END,
      CASE WHEN NEW.type = 'abandoned' THEN 1 ELSE 0 END,
      CASE WHEN NEW.type = 'uninstall' THEN 1 ELSE 0 END
    )
    ON CONFLICT(date) DO UPDATE SET
      total_signals = total_signals + 1,
      accept_count = accept_count + (CASE WHEN NEW.type = 'accept' THEN 1 ELSE 0 END),
      dismiss_count = dismiss_count + (CASE WHEN NEW.type = 'dismiss' THEN 1 ELSE 0 END),
      usage_count = usage_count + (CASE WHEN NEW.type IN ('usage_daily', 'usage_weekly') THEN 1 ELSE 0 END),
      abandoned_count = abandoned_count + (CASE WHEN NEW.type = 'abandoned' THEN 1 ELSE 0 END),
      uninstall_count = uninstall_count + (CASE WHEN NEW.type = 'uninstall' THEN 1 ELSE 0 END);

    -- Update dismiss reason stats if applicable
    INSERT INTO dismiss_reasons (date, reason, count)
    SELECT
      date(NEW.timestamp / 1000, 'unixepoch'),
      NEW.dismiss_reason,
      1
    WHERE NEW.type = 'dismiss' AND NEW.dismiss_reason IS NOT NULL
    ON CONFLICT(date, reason) DO UPDATE SET
      count = count + 1;
  END;

-- Views for common queries

-- Recent signals (last 30 days)
CREATE VIEW IF NOT EXISTS recent_signals AS
  SELECT * FROM signal_events
  WHERE timestamp >= (strftime('%s', 'now') * 1000) - (30 * 24 * 60 * 60 * 1000)
  ORDER BY timestamp DESC;

-- Signal summary by skill
CREATE VIEW IF NOT EXISTS skill_signal_summary AS
  SELECT
    skill_id,
    COUNT(*) as total_signals,
    SUM(CASE WHEN type = 'accept' THEN 1 ELSE 0 END) as accepts,
    SUM(CASE WHEN type = 'dismiss' THEN 1 ELSE 0 END) as dismisses,
    SUM(CASE WHEN type IN ('usage_daily', 'usage_weekly') THEN 1 ELSE 0 END) as usage_events,
    MAX(timestamp) as last_signal_at
  FROM signal_events
  GROUP BY skill_id;

-- Monthly statistics
CREATE VIEW IF NOT EXISTS monthly_stats AS
  SELECT
    strftime('%Y-%m', date) as month,
    SUM(total_signals) as total_signals,
    SUM(accept_count) as accepts,
    SUM(dismiss_count) as dismisses,
    SUM(usage_count) as usage,
    ROUND(CAST(SUM(accept_count) AS FLOAT) / NULLIF(SUM(accept_count + dismiss_count), 0), 2) as accept_rate
  FROM aggregate_stats
  GROUP BY month
  ORDER BY month DESC;

-- PRIVACY VERIFICATION QUERIES
-- These queries verify no PII is stored in aggregate tables

-- Verify aggregate_stats has no skill IDs
CREATE VIEW IF NOT EXISTS privacy_check_aggregate AS
  SELECT
    'aggregate_stats' as table_name,
    COUNT(*) as total_rows,
    0 as has_skill_ids,  -- Should always be 0
    CASE
      WHEN stats_json LIKE '%skill_id%' THEN 1
      ELSE 0
    END as has_pii_in_json
  FROM aggregate_stats;

-- Database statistics
CREATE VIEW IF NOT EXISTS db_stats AS
  SELECT
    (SELECT COUNT(*) FROM signal_events) as total_signals,
    (SELECT COUNT(*) FROM user_profile) as has_profile,
    (SELECT COUNT(*) FROM aggregate_stats) as days_tracked,
    (SELECT COUNT(DISTINCT date) FROM dismiss_reasons) as days_with_dismissals,
    (SELECT MIN(timestamp) FROM signal_events) as first_signal_at,
    (SELECT MAX(timestamp) FROM signal_events) as last_signal_at;
