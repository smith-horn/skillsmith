/**
 * Analytics Database Schema
 *
 * Implements Phase 4 Product Strategy analytics infrastructure:
 * - Epic 3: Skill usage tracking with 30-day rolling window
 * - Epic 4: A/B testing experiment management
 * - Epic 4: ROI metrics and dashboard data
 *
 * SMI-XXX: Analytics infrastructure for product strategy
 */

/**
 * Analytics schema SQL for skill usage, A/B testing, and ROI tracking
 */
export const ANALYTICS_SCHEMA = `
-- Skill usage events for attribution and value tracking
CREATE TABLE IF NOT EXISTS skill_usage_events (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('activation', 'invocation', 'success', 'failure')),
  context TEXT, -- JSON metadata about the usage context
  value_score REAL, -- Estimated value contribution (0-1)
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for usage queries
CREATE INDEX IF NOT EXISTS idx_usage_skill_id ON skill_usage_events(skill_id);
CREATE INDEX IF NOT EXISTS idx_usage_user_id ON skill_usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_session_id ON skill_usage_events(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON skill_usage_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_event_type ON skill_usage_events(event_type);

-- A/B testing experiments
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  hypothesis TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'paused', 'completed')) DEFAULT 'draft',
  variant_a TEXT NOT NULL, -- JSON config for control group
  variant_b TEXT NOT NULL, -- JSON config for treatment group
  start_date TEXT,
  end_date TEXT,
  target_sample_size INTEGER DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User assignments to experiment variants
CREATE TABLE IF NOT EXISTS experiment_assignments (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK(variant IN ('control', 'treatment')),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(experiment_id, user_id)
);

-- Experiment outcome tracking
CREATE TABLE IF NOT EXISTS experiment_outcomes (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES experiment_assignments(id) ON DELETE CASCADE,
  outcome_type TEXT NOT NULL, -- e.g., 'activation', 'usage_count', 'value_score'
  outcome_value REAL NOT NULL,
  metadata TEXT, -- JSON additional data
  measured_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for experiment queries
CREATE INDEX IF NOT EXISTS idx_assignments_experiment ON experiment_assignments(experiment_id);
CREATE INDEX IF NOT EXISTS idx_assignments_user ON experiment_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_experiment ON experiment_outcomes(experiment_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_assignment ON experiment_outcomes(assignment_id);

-- ROI metrics aggregation (materialized view equivalent)
CREATE TABLE IF NOT EXISTS roi_metrics (
  id TEXT PRIMARY KEY,
  metric_type TEXT NOT NULL, -- 'daily', 'weekly', 'monthly', 'user', 'skill'
  entity_id TEXT, -- user_id or skill_id for entity-level metrics
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  total_activations INTEGER DEFAULT 0,
  total_invocations INTEGER DEFAULT 0,
  total_successes INTEGER DEFAULT 0,
  total_failures INTEGER DEFAULT 0,
  avg_value_score REAL DEFAULT 0.0,
  estimated_time_saved REAL DEFAULT 0.0, -- in minutes
  estimated_value_usd REAL DEFAULT 0.0, -- rough ROI estimate
  metadata TEXT, -- JSON for additional metrics
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for ROI queries
CREATE INDEX IF NOT EXISTS idx_roi_type ON roi_metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_roi_entity ON roi_metrics(entity_id);
CREATE INDEX IF NOT EXISTS idx_roi_period ON roi_metrics(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_roi_computed ON roi_metrics(computed_at);

-- Value attribution mappings
CREATE TABLE IF NOT EXISTS value_attributions (
  id TEXT PRIMARY KEY,
  usage_event_id TEXT NOT NULL REFERENCES skill_usage_events(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  attribution_type TEXT NOT NULL, -- 'inline', 'metadata', 'session'
  value_dimension TEXT NOT NULL, -- 'time_saved', 'quality_improved', 'error_prevented'
  value_amount REAL NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  metadata TEXT, -- JSON additional context
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for attribution queries
CREATE INDEX IF NOT EXISTS idx_attributions_event ON value_attributions(usage_event_id);
CREATE INDEX IF NOT EXISTS idx_attributions_skill ON value_attributions(skill_id);
CREATE INDEX IF NOT EXISTS idx_attributions_type ON value_attributions(attribution_type);

-- ============================================================================
-- Quota Management Tables (SMI-XXXX)
-- ============================================================================

-- Monthly usage quotas per customer/license
-- Tracks API call usage against tier limits
CREATE TABLE IF NOT EXISTS usage_quotas (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  license_tier TEXT NOT NULL CHECK(license_tier IN ('community', 'individual', 'team', 'enterprise')),
  billing_period_start TEXT NOT NULL,
  billing_period_end TEXT NOT NULL,
  api_calls_limit INTEGER NOT NULL,
  api_calls_used INTEGER DEFAULT 0,
  last_warning_threshold INTEGER DEFAULT 0, -- 0, 80, 90, or 100
  last_warning_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(customer_id, billing_period_start)
);

-- Indexes for quota queries
CREATE INDEX IF NOT EXISTS idx_quotas_customer ON usage_quotas(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotas_period ON usage_quotas(billing_period_start, billing_period_end);
CREATE INDEX IF NOT EXISTS idx_quotas_tier ON usage_quotas(license_tier);

-- Individual API call events for detailed tracking
-- Used for quota enforcement and analytics
CREATE TABLE IF NOT EXISTS api_call_events (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  license_key_hash TEXT, -- SHA256 hash of license key for lookup
  tool_name TEXT NOT NULL,
  endpoint TEXT,
  cost INTEGER DEFAULT 1, -- Some operations may cost multiple quota units
  success INTEGER DEFAULT 1, -- 1 for success, 0 for failure
  latency_ms INTEGER,
  session_id TEXT,
  metadata TEXT, -- JSON for additional context
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for API call queries
CREATE INDEX IF NOT EXISTS idx_api_calls_customer ON api_call_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_api_calls_timestamp ON api_call_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_api_calls_license ON api_call_events(license_key_hash);
CREATE INDEX IF NOT EXISTS idx_api_calls_tool ON api_call_events(tool_name);

-- User subscriptions for billing integration
-- Links customers to Stripe subscriptions
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('community', 'individual', 'team', 'enterprise')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('active', 'past_due', 'canceled', 'trialing', 'paused')),
  current_period_start TEXT,
  current_period_end TEXT,
  last_active_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for subscription queries
CREATE INDEX IF NOT EXISTS idx_subs_customer ON user_subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subs_stripe ON user_subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subs_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subs_tier ON user_subscriptions(tier);
CREATE INDEX IF NOT EXISTS idx_subs_last_active ON user_subscriptions(last_active_at);
`

/**
 * Apply analytics schema to a database
 */
import type { Database as DatabaseType } from 'better-sqlite3'

export function initializeAnalyticsSchema(db: DatabaseType): void {
  db.exec(ANALYTICS_SCHEMA)
}
