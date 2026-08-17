-- Rollback for 20260816225201_release_cadence_heartbeat_pg_cron.sql
-- SMI-6052
--
-- Unschedules the release-cadence-heartbeat-monitor cron and drops the
-- dispatch function. Safe to apply via `supabase db execute --file`.
--
-- WARNING: reverting stops the positive liveness backstop for
-- release-cadence.yml entirely — a future recurrence of an SMI-6052-shaped
-- incident (or a genuine multi-week silent skip) would again have no
-- detection independent of GitHub Actions' own event-driven alert. Re-apply
-- the forward migration, or provision the Vault secrets and re-schedule
-- manually, before relying on this backstop again.

BEGIN;

-- Unschedule the cron job (idempotent — only if registered).
SELECT cron.unschedule('release-cadence-heartbeat-monitor')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'release-cadence-heartbeat-monitor');

DROP FUNCTION IF EXISTS public.invoke_release_cadence_heartbeat_monitor();

COMMIT;
