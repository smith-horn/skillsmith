-- Rollback for 20260719020000_status_check_pg_cron.sql
-- SMI-5752
--
-- Unschedules the status-check cron and drops the dispatch function. Safe to
-- apply via `supabase db push`.
--
-- WARNING: reverting stops the ~5-minute synthetic status checks; the public
-- status page's `status_checks` table will stop receiving new rows (existing
-- history is untouched — this rollback does not touch `status_checks` or
-- `status_daily_rollups`). Re-apply the forward migration, or provision the
-- Vault secrets and re-schedule manually, before relying on the status page
-- for current data again.

BEGIN;

-- Unschedule the cron job (idempotent — only if registered).
SELECT cron.unschedule('status-check')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'status-check');

DROP FUNCTION IF EXISTS public.invoke_status_check();

COMMIT;
