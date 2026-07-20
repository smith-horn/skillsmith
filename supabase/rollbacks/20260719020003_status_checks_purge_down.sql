-- Rollback for 20260719020003_status_checks_purge.sql
-- SMI-5752
--
-- Unschedules the daily purge cron and drops the function. Does NOT restore
-- any already-purged status_checks rows (they are gone by design once older
-- than 100 days; status_daily_rollups is the durable record for that data).
--
-- Safe to run standalone via:
--   docker exec skillsmith-dev-1 varlock run -- ./scripts/pooler-psql.sh -f supabase/rollbacks/20260719020003_status_checks_purge_down.sql

SELECT cron.unschedule('status-checks-purge')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'status-checks-purge');

DROP FUNCTION IF EXISTS public.purge_status_checks();
