-- Rollback for 20260828010000_indexer_lock_starvation_state.sql
-- SMI-6209
--
-- Drops the indexer_lock_starvation_state table. Safe to apply via
-- `supabase db execute --file`.
--
-- WARNING: reverting removes the lock-starvation monitor's only data
-- surface — any dedup/trend history in indexer_lock_starvation_state is
-- lost. Apply 20260828010001_indexer_lock_starvation_monitor_pg_cron_down.sql
-- FIRST (or at least before this), otherwise the still-scheduled pg_cron job
-- will call an edge function that fails writing to a now-missing table on
-- every invocation until re-applied.

BEGIN;

DROP TABLE IF EXISTS indexer_lock_starvation_state;

COMMIT;
