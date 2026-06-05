-- Rollback for 20260519000004_search_metrics_retention_cron.sql
-- SMI-4968
--
-- Unschedules the retention cron and drops the cleanup function. Safe to apply
-- via `supabase db push`.
--
-- WARNING: reverting disables 90-day retention on search_metrics; the table
-- will grow unbounded again. Re-apply the forward migration or substitute
-- another retention mechanism before leaving this in place.
--
-- Run this BEFORE rolling back 20260519000003 (the table drop) so the cron is
-- gone before its target table disappears.

BEGIN;

-- Unschedule the cron job (idempotent — only if registered).
SELECT cron.unschedule('daily-search-metrics-cleanup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-search-metrics-cleanup');

DROP FUNCTION IF EXISTS cleanup_search_metrics();

COMMIT;
