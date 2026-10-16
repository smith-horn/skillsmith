-- Rollback for 20261016000000_backfill_autochain_markers.sql
-- SMI-7121
--
-- Unschedules the marker-watcher cron job and drops both functions. Safe to apply via
-- `supabase db execute --file`.
--
-- WARNING -- READ BEFORE RUNNING
--
-- 1. Once Wave 2b (the autochain deferral and resume) is live, the autochain calls
--    backfill_autochain_marker_transition over PostgREST for every claim, reconciliation and
--    needs_intervention move. Dropping it turns those steps red. Revert or disable Wave 2b first
--    (BACKFILL_AUTOCHAIN_DISABLE=1).
-- 2. Dropping check_backfill_autochain_markers removes the stale-marker watcher: a stalled or
--    unreconciled deferral is then unwatched outside GitHub's failure domain.
-- 3. Marker rows (indexer_backfill_autochain_deferred), alert rows
--    (indexer_backfill_autochain_marker_alert) and error rows (indexer_backfill_autochain_watch_error)
--    are NOT deleted. Neither is the Vault secret SKILLSMITH_BACKFILL_AUTOCHAIN_WATCH_DISABLE, nor the
--    shared refresh_metadata_* secrets.
-- 4. The pg_net extension is a shared prerequisite (other cron dispatchers use it) and was created
--    with IF NOT EXISTS, so this rollback intentionally does NOT drop it.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Unschedule the cron job (idempotent -- only if registered).
SELECT cron.unschedule('backfill-autochain-marker-watch')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'backfill-autochain-marker-watch');

DROP FUNCTION IF EXISTS public.check_backfill_autochain_markers();
DROP FUNCTION IF EXISTS public.backfill_autochain_marker_transition(text, text, text, jsonb);

COMMIT;
