-- Rollback for 20261013000000_skills_refresh_metadata_pg_cron.sql
-- SMI-7114
--
-- Unschedules both cron jobs and drops the three functions. Safe to apply via
-- `supabase db execute --file`.
--
-- WARNING -- READ BEFORE RUNNING
--
-- 1. Until the observer conversion wave lands, the GitHub Actions schedule still triggers the
--    refresh, so this rollback is lossless. AFTER that wave, GHA only observes: revert that change
--    first, or the refresh stops running entirely.
-- 2. The Vault secrets (refresh_metadata_*, SKILLSMITH_REFRESH_OBSERVER_DEADMAN_DISABLE) are NOT
--    deleted. Existing refresh:dispatch / refresh:observer audit_logs rows are NOT deleted.
-- 3. Dropping check_refresh_observer_heartbeat removes the dead-man: a dead observer is unwatched.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Unschedule the cron jobs (idempotent -- only if registered).
SELECT cron.unschedule('skills-refresh-metadata')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'skills-refresh-metadata');

SELECT cron.unschedule('refresh-observer-heartbeat')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-observer-heartbeat');

DROP FUNCTION IF EXISTS public.invoke_skills_refresh_metadata();
DROP FUNCTION IF EXISTS public.refresh_metadata_health(interval);
DROP FUNCTION IF EXISTS public.check_refresh_observer_heartbeat(interval);

COMMIT;
