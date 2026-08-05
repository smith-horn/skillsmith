-- Rollback for 20260728000000_scan_coverage_state.sql
-- SMI-5866
--
-- Drops the check_scan_coverage() RPC and the scan_coverage_state table.
-- Safe to apply via `supabase db execute --file`.
--
-- WARNING: reverting removes the scan-coverage self-check's only data
-- surface — any dedup/trend history in scan_coverage_state is lost. Apply
-- 20260728000001_scan_coverage_monitor_pg_cron_down.sql FIRST (or at least
-- before this), otherwise the still-scheduled pg_cron job will call a
-- now-missing RPC and every invocation will error until re-applied.

BEGIN;

DROP FUNCTION IF EXISTS public.check_scan_coverage(INT);
DROP TABLE IF EXISTS scan_coverage_state;

COMMIT;
