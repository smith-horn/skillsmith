-- Rollback for 20261010000001_registry_audit_volume_monitor_pg_cron.sql
-- SMI-7050
--
-- Unschedules the registry-audit-volume-monitor cron job and drops the dispatch function. Safe to
-- apply via `supabase db execute --file`.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING
-- ============================================================================
--
-- 1. ORDER. Roll back in this order: THIS file first, then
--    20261010000000_registry_audit_volume_alert_state_down.sql, then (if at all)
--    20261008000000_private_registry_audit_attempt_rpc_down.sql. That last rollback's warning 3
--    requires the cron job to be unscheduled before it runs; this file is what does that.
-- 2. Reverting stops the volume monitor. ADR-178's risk acceptance (any authenticated user can insert
--    unbounded client_reported private_registry audit rows) was granted on the condition that this
--    monitor runs, so the unbounded-insert risk is again unwatched. Treat this as an incident with a
--    follow-up, not a clean revert.
-- 3. The edge function is NOT removed (it auto-deploys); uncalled, it returns 401 without the
--    service-role bearer. The Vault secrets are NOT deleted.
-- 4. schema_version row 122 is NOT deleted by default. The migration's apply NOTICE says whether
--    that transaction inserted 122 or found it already present (a numbering collision). Only if it
--    said "registered 122 (this transaction inserted the row)", uncomment the DELETE below;
--    otherwise row 122 belongs to another migration and must stay.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Unschedule the cron job (idempotent -- only if registered).
SELECT cron.unschedule('registry-audit-volume-monitor')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'registry-audit-volume-monitor');

DROP FUNCTION IF EXISTS public.invoke_registry_audit_volume_monitor();

-- DELETE FROM schema_version WHERE version = 122;  -- see warning 4 before uncommenting

COMMIT;
