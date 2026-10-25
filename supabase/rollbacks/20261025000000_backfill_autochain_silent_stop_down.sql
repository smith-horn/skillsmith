-- Rollback for 20261025000000_backfill_autochain_silent_stop.sql
-- SMI-7167
--
-- Unschedules the silent-stop detector's cron job and drops both functions. Safe to apply via
-- `supabase db execute --file`.
--
-- WARNING -- READ BEFORE RUNNING
--
-- 1. Dropping check_backfill_autochain_silent_stop removes the only detector for a backfill run the
--    autochain dispatched whose completion produced no green link (ADR-183). While the autochain is
--    the dispatcher (BACKFILL_AUTOCHAIN_DISABLE=0) that class is then unwatched again. Put prod back
--    on the local driver (BACKFILL_AUTOCHAIN_DISABLE=1) first.
-- 2. The workflow keeps writing ledger rows (dispatch_prepared, dispatch_resolved, link_started,
--    link_finished); they are harmless without the detector. Revert the workflow change to stop them.
--    Note the dispatch_prepared write still fails closed: a Supabase write outage stops the chain.
-- 3. Ledger rows, ack rows, alert rows (indexer_backfill_autochain_silent_stop_alert) and error rows
--    (indexer_backfill_autochain_silent_stop_error) are NOT deleted. Neither is the Vault secret
--    SKILLSMITH_BACKFILL_AUTOCHAIN_SILENT_STOP_DISABLE, nor the shared refresh_metadata_* secrets.
-- 4. The pg_net extension is a shared prerequisite and was created with IF NOT EXISTS, so this
--    rollback intentionally does NOT drop it.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Unschedule the cron job (idempotent -- only if registered).
SELECT cron.unschedule('backfill-autochain-silent-stop-watch')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'backfill-autochain-silent-stop-watch');

DROP FUNCTION IF EXISTS public.check_backfill_autochain_silent_stop();
DROP FUNCTION IF EXISTS public.backfill_autochain_silent_stop_candidates();

COMMIT;
