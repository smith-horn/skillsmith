-- Rollback for 20260828010001_indexer_lock_starvation_monitor_pg_cron.sql
-- SMI-6209
--
-- Unschedules the indexer-lock-starvation-monitor cron and drops the
-- dispatch function. Safe to apply via `supabase db execute --file`.
--
-- WARNING: reverting stops the lock-starvation self-check entirely — a
-- perpetually lock-skipped or silently unscheduled indexer run (the
-- SMI-6209 failure mode this monitor exists to catch) would again go
-- undetected. Re-apply the forward migration, or provision the Vault
-- secrets and re-schedule manually, before relying on this self-check again.

BEGIN;

-- Unschedule the cron job (idempotent — only if registered).
SELECT cron.unschedule('indexer-lock-starvation-monitor')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'indexer-lock-starvation-monitor');

DROP FUNCTION IF EXISTS public.invoke_indexer_lock_starvation_monitor();

COMMIT;
