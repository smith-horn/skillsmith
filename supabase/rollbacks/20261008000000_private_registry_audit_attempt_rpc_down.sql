-- Rollback for 20261008000000_private_registry_audit_attempt_rpc.sql
-- SMI-6114 / SMI-6669
--
-- Removes the client-report audit RPC and the volume-monitor predicate. Safe to apply via
-- `supabase db execute --file`.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING
-- ============================================================================
--
-- 1. The @skillsmith/mcp-server build that routes recordRegistryAudit() through this RPC will get a
--    "function does not exist" error on every audit call after this runs. That build is fail-soft,
--    so the caller's own operation is unaffected, but denied/not_found/error/read events are again
--    recorded NOWHERE on the sanctioned (no service-role key) deployment -- the state SMI-6114 was
--    filed against. Roll the client back first, or accept the loss; treat running this as an
--    incident with a follow-up, not a clean revert.
-- 2. audit_logs rows the RPC already wrote (metadata->>'audit_source' = 'client_reported') are NOT
--    deleted. They are records of what authenticated clients reported.
-- 3. This migration created no pg_cron job (the monitor's edge function and dispatcher are a
--    separate change), so there is no cron job to unschedule here. If that follow-up has landed
--    and scheduled a job calling registry_audit_volume_over_threshold(), unschedule it BEFORE
--    running this, or the job will fail every hour.
-- 4. schema_version row 120 is NOT deleted by default. The migration's apply NOTICE says whether
--    that transaction inserted 120 or found it already present (a numbering collision). Only if it
--    said "registered 120 (this transaction inserted the row)", uncomment the DELETE below;
--    otherwise row 120 belongs to another migration and must stay.
--
-- DROP FUNCTION takes no relation lock; audit_logs writers are never blocked.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DROP FUNCTION IF EXISTS public.registry_audit_volume_over_threshold(INTEGER, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.record_private_registry_audit_attempt(
  TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT);

-- DELETE FROM schema_version WHERE version = 120;  -- see warning 4 before uncommenting

COMMIT;
