-- Rollback for 20260728000001_scan_coverage_monitor_pg_cron.sql
-- SMI-5866
--
-- Unschedules the scan-coverage-monitor cron and drops the dispatch
-- function. Safe to apply via `supabase db execute --file`.
--
-- WARNING: reverting stops the daily scan-coverage self-check entirely — a
-- silent security-scan write-path regression (the SMI-5849 failure mode this
-- issue exists to catch) would again go undetected. Re-apply the forward
-- migration, or provision the Vault secrets and re-schedule manually, before
-- relying on this self-check again.

BEGIN;

-- Unschedule the cron job (idempotent — only if registered).
SELECT cron.unschedule('scan-coverage-monitor')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scan-coverage-monitor');

DROP FUNCTION IF EXISTS public.invoke_scan_coverage_monitor();

COMMIT;
