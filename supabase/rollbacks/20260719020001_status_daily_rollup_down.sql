-- Rollback for 20260719020001_status_daily_rollup.sql
-- SMI-5752
--
-- Unschedules the daily rollup cron and drops the aggregation function. Safe
-- to apply via `supabase db push`.
--
-- WARNING: reverting stops the 90-day uptime strip's daily rollup —
-- `status_daily_rollups` stops receiving new rows (existing rows are
-- untouched — this rollback does not delete any `status_daily_rollups` or
-- `status_checks` data). Re-apply the forward migration before relying on
-- the status page's uptime strip for current data again.

BEGIN;

-- Unschedule the cron job (idempotent — only if registered).
SELECT cron.unschedule('status-daily-rollup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'status-daily-rollup');

DROP FUNCTION IF EXISTS public.compute_status_daily_rollups();

COMMIT;
