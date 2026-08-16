-- Rollback for 20260816000001_release_cadence_heartbeat_state.sql
-- SMI-6052
--
-- Drops the release_cadence_heartbeat_state table. Safe to apply via
-- `supabase db execute --file`.
--
-- WARNING: apply 20260816000002_release_cadence_heartbeat_pg_cron_down.sql
-- FIRST (unschedule the cron + drop the dispatch function) — this table is
-- what that function's edge-function target writes to on every tick.

BEGIN;

DROP TABLE IF EXISTS release_cadence_heartbeat_state;

COMMIT;
