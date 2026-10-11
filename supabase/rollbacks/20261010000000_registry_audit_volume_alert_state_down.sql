-- Rollback for 20261010000000_registry_audit_volume_alert_state.sql
-- SMI-7050
--
-- Drops the six claim/settle/clear functions, then both state tables. Safe to apply via
-- `supabase db execute --file`.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING
-- ============================================================================
--
-- 1. ORDER. Run 20261010000001_registry_audit_volume_monitor_pg_cron_down.sql FIRST. While the
--    hourly job is scheduled and this migration is gone, the edge function's claim call fails every
--    tick (it audits the failure and raises its `error` health alert, then sends nothing).
-- 2. DESTRUCTIVE. Both tables are dropped with their rows: every per-actor dedup window and every
--    health-alert window is lost. Re-applying the forward migration starts every actor and kind
--    with no recorded alert, so a still-over-threshold actor alerts again immediately.
-- 3. Reverting leaves the monitor without its dedup state. Do not leave the cron job scheduled.
-- 4. schema_version row 121 is NOT deleted by default. The migration's apply NOTICE says whether
--    that transaction inserted 121 or found it already present (a numbering collision). Only if it
--    said "registered 121 (this transaction inserted the row)", uncomment the DELETE below;
--    otherwise row 121 belongs to another migration and must stay.
-- 5. This must run BEFORE 20261008000000_private_registry_audit_attempt_rpc_down.sql, never after.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DROP FUNCTION IF EXISTS public.settle_registry_audit_volume_health(TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.claim_registry_audit_volume_health(TEXT, UUID);
DROP FUNCTION IF EXISTS public.clear_registry_audit_volume_alerts(JSONB);
DROP FUNCTION IF EXISTS public.count_stale_registry_audit_volume_claims();
DROP FUNCTION IF EXISTS public.settle_registry_audit_volume_alerts(UUID, TEXT);
DROP FUNCTION IF EXISTS public.claim_registry_audit_volume_alerts(JSONB, UUID);

DROP TABLE IF EXISTS public.registry_audit_volume_monitor_health;
DROP TABLE IF EXISTS public.registry_audit_volume_alert_state;

-- DELETE FROM schema_version WHERE version = 121;  -- see warning 4 before uncommenting

COMMIT;
