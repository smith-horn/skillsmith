-- Rollback for 20260519000001_audit_logs_drop_unused_indexes.sql
-- SMI-4968
--
-- !! CONCURRENTLY — DO NOT APPLY VIA `supabase db push` OR inside a txn !!
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. Run each
-- statement standalone in autocommit via the pooler:
--
--   docker exec skillsmith-dev-1 varlock run -- ./scripts/pooler-psql.sh \
--     -c "<one statement>"
--
-- Recreates the 5 indexes dropped by the forward runbook step. These were
-- redundant/unused at drop time (see forward migration header); recreate only
-- if a regression shows a real query path depends on one of them.
--
-- WARNING: each CREATE INDEX CONCURRENTLY on the 6M-row audit_logs table is a
-- multi-minute non-blocking build. Run during low traffic.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_event_type
  ON audit_logs (event_type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_actor
  ON audit_logs (actor);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_result
  ON audit_logs (result);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_resource
  ON audit_logs (resource);

-- idx_audit_logs_team_id was a functional index on metadata->>'team_id'
-- (migration 075). Recreate with the same expression.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_team_id
  ON audit_logs ((metadata->>'team_id'));
