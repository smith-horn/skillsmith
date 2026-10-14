-- Rollback for 20261013000000_skills_refresh_metadata_pg_cron.sql
-- SMI-7114
--
-- Unschedules the three cron jobs and drops the four functions. Safe to apply via
-- `supabase db execute --file`.
--
-- WARNING -- READ BEFORE RUNNING
--
-- 1. Until the observer conversion wave lands, the GitHub Actions schedule still triggers the
--    refresh, so this rollback is lossless. AFTER that wave, GHA only observes: revert that change
--    first, or the refresh stops running entirely.
-- 2. The Vault secrets (refresh_metadata_*, SKILLSMITH_REFRESH_OBSERVER_DEADMAN_DISABLE) are NOT
--    deleted. Existing refresh:dispatch / refresh:dispatch_result / refresh:observer /
--    refresh:observer_dead_alert / refresh:observer_deadman_error audit_logs rows are NOT deleted.
-- 3. Dropping check_refresh_observer_heartbeat removes the dead-man: a dead observer is unwatched.
-- 4. The pg_net extension is a shared prerequisite (other cron dispatchers use it) and was created
--    with IF NOT EXISTS, so this rollback intentionally does NOT drop it.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Unschedule the cron jobs (idempotent -- only if registered).
SELECT cron.unschedule('skills-refresh-metadata')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'skills-refresh-metadata');

SELECT cron.unschedule('refresh-observer-heartbeat')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-observer-heartbeat');

SELECT cron.unschedule('refresh-dispatch-harvest')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-dispatch-harvest');

DROP FUNCTION IF EXISTS public.invoke_skills_refresh_metadata();
DROP FUNCTION IF EXISTS public.refresh_metadata_health(interval);
DROP FUNCTION IF EXISTS public.check_refresh_observer_heartbeat(interval);
DROP FUNCTION IF EXISTS public.harvest_refresh_dispatch_results();

COMMIT;
