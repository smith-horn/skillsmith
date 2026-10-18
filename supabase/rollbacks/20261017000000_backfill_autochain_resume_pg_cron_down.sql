-- Rollback for 20261017000000_backfill_autochain_resume_pg_cron.sql
-- SMI-7142
--
-- Unschedules the pg_cron resume job, drops the dispatcher, and puts the stale-marker watcher back to
-- the body 20261016000000 shipped (CREATE OR REPLACE; the section below is that body verbatim). Safe to
-- apply via `supabase db execute --file`.
--
-- WARNING -- READ BEFORE RUNNING
--
-- 1. After this, nothing in Supabase resumes a deferred chain. Only the GitHub `schedule` fallback in
--    indexer-backfill-autochain.yml does, and measured on 2026-10-18 it delivered 3 of 24 slots, none
--    inside an open window. A chain that defers will sit 'open' until the watcher's 12h `stalled` alert.
--    Resume by hand: `gh workflow run indexer-backfill-autochain.yml -f mode=resume -f verify_only=false`.
-- 2. The restored watcher no longer harvests the dispatcher's resume_dispatch rows and no longer alerts
--    resume_dispatch_failed. Rows already written (indexer_backfill_autochain_resume_dispatch,
--    indexer_backfill_autochain_resume_error) and alert rows are NOT deleted.
-- 3. The Vault secrets backfill_autochain_dispatch_pat and SKILLSMITH_BACKFILL_AUTOCHAIN_RESUME_DISABLE
--    are NOT deleted. Revoke the PAT on GitHub if the design is abandoned.
-- 4. pg_net is a shared prerequisite (other cron dispatchers use it) and was created with IF NOT
--    EXISTS, so this rollback intentionally does NOT drop it.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Unschedule the resume job (idempotent -- only if registered). The marker-watch job is untouched.
SELECT cron.unschedule('backfill-autochain-resume')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'backfill-autochain-resume');

DROP FUNCTION IF EXISTS public.invoke_backfill_autochain_resume();

-- The watcher as 20261016000000 defined it (SMI-7121).
CREATE OR REPLACE FUNCTION public.check_backfill_autochain_markers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault, extensions, pg_temp
AS $$
DECLARE
  v_stall_after    CONSTANT interval := interval '12 hours';
  v_reconcile_after CONSTANT interval := interval '1 hour';
  v_dedup          CONSTANT interval := interval '24 hours';
  v_pending        CONSTANT interval := interval '1 hour';
  -- Extra age required before alerting from an UNLOCKED read, when another session holds the
  -- marker row: stalled past 24h (12h + 12h), unreconciled past 13h (1h + 12h).
  v_locked_margin  CONSTANT interval := interval '12 hours';
  v_runbook        CONSTANT text := 'docs/internal/runbooks/backfill-autochain-handover.md';
  v_disable        text;
  v_h              record;
  v_c              record;
  v_m              record;
  v_row_locked     boolean;
  v_margin         interval;
  v_alert          record;
  v_status         integer;
  v_sent           text;
  v_ref            timestamptz;
  v_kind           text;
  v_age            interval;
  v_suppress       boolean;
  v_secrets_loaded boolean := false;
  v_base_url       text;
  v_key            text;
  v_missing        text;
  v_rid            bigint;
  v_section        text;
BEGIN
  -- Serialise concurrent callers: without this, two overlapping calls can both find no delivered or
  -- pending alert and both POST. A caller that loses the lock does nothing; the winner's alert rows
  -- are committed before the lock releases, so a later caller sees them as pending. The key is this
  -- function's own literal, distinct from every other advisory lock in the schema.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('check_backfill_autochain_markers', 0)) THEN
    RETURN;
  END IF;

  -- Harvest first, ahead of the kill switch: copy each alert's pg_net response into the alert row
  -- before the 6h TTL purges it. The harvest sends nothing, so the kill switch does not gate it:
  -- gating it would lose the delivery proof across a pause longer than 6h and re-page after the
  -- switch clears.
  -- An alert is harvested once: the presence of the status_code KEY marks it (a transport failure
  -- stores JSON null there, and is still harvested). `sent` is parsed per row inside its own
  -- exception block, because one non-JSON body must not abort the rest.
  -- The id is cast only inside a CASE behind its 1-18 digit guard: an AND of guard and cast gives
  -- the planner no evaluation order, so a non-numeric id could reach the cast and raise.
  FOR v_h IN
    SELECT d.id, r.status_code, r.content
    FROM (
      SELECT a.id,
             CASE WHEN a.metadata->>'net_request_id' ~ '^[0-9]{1,18}$'
                  THEN (a.metadata->>'net_request_id')::bigint END AS rid
      FROM audit_logs a
      WHERE a.event_type = 'indexer_backfill_autochain_marker_alert'
        AND a.created_at >= now() - v_dedup
        AND NOT (a.metadata ? 'status_code')
    ) d
    JOIN net._http_response r ON r.id = d.rid
    WHERE d.rid IS NOT NULL
  LOOP
    v_sent := NULL;
    BEGIN
      v_sent := (v_h.content::jsonb)->'data'->>'sent';
    EXCEPTION WHEN OTHERS THEN
      v_sent := NULL;  -- a non-JSON body is "not delivered", never an error
    END;

    UPDATE audit_logs
       SET metadata = metadata || jsonb_build_object('status_code', v_h.status_code, 'sent', v_sent)
     WHERE id = v_h.id;
  END LOOP;

  -- Kill switch (vault flag): silences evaluation and sending only; the harvest above still ran.
  -- Missing secret = enabled.
  SELECT decrypted_secret INTO v_disable
  FROM vault.decrypted_secrets
  WHERE name = 'SKILLSMITH_BACKFILL_AUTOCHAIN_WATCH_DISABLE';
  IF lower(trim(coalesce(v_disable, ''))) IN ('1', 'true') THEN
    RETURN;
  END IF;

  -- Evaluate every live marker. A consumed marker with a dispatched_run_id (empty counts as missing)
  -- has been reconciled and is not watched. The cursor nominates candidates and the kind each was
  -- selected for; eligibility is decided from the row re-read under lock below, or, when another
  -- session holds that row, from this cursor's unlocked snapshot past a wider bound.
  FOR v_c IN
    SELECT a.id, a.created_at, a.metadata,
           CASE WHEN a.metadata->>'state' = 'open' THEN 'stalled' ELSE 'unreconciled' END AS kind
    FROM audit_logs a
    WHERE a.event_type = 'indexer_backfill_autochain_deferred'
      AND (
        a.metadata->>'state' = 'open'
        OR (a.metadata->>'state' = 'consumed'
            AND coalesce(trim(a.metadata->>'dispatched_run_id'), '') = '')
      )
    ORDER BY a.created_at
  LOOP
    -- Revalidate under a row lock. backfill_autochain_marker_transition does not take this
    -- function's advisory lock, so a transition can move the marker after the cursor read it. Each
    -- plpgsql statement takes a fresh READ COMMITTED snapshot, so this re-read sees any transition
    -- that has committed since. SKIP LOCKED: a transition in flight holds the row, and the watcher
    -- does not wait on it. The lock is held through the dedup, the send and the alert-row insert,
    -- and releases at commit.
    --
    -- No row returned: the row is held by another session (or no longer present). A session that
    -- never ends (idle in transaction) would otherwise hide the marker on every tick, silently.
    -- So the candidate is evaluated from the cursor's unlocked snapshot instead, but only past
    -- v_locked_margin more age than usual (stalled past 24h, unreconciled past 13h), which leaves
    -- an ordinary in-flight transition ample time to finish first. That path takes no lock, runs
    -- the same dedup, and marks its alert row_locked.
    v_row_locked := false;
    SELECT a.id, a.created_at, a.metadata INTO v_m
    FROM public.audit_logs a
    WHERE a.id = v_c.id
      AND a.event_type = 'indexer_backfill_autochain_deferred'
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_row_locked := true;
      v_m := v_c;
    END IF;
    v_margin := CASE WHEN v_row_locked THEN v_locked_margin ELSE interval '0' END;

    v_kind := v_c.kind;
    IF v_kind = 'stalled' THEN
      IF v_m.metadata->>'state' IS DISTINCT FROM 'open' THEN
        CONTINUE;
      END IF;
      v_ref := v_m.created_at;
      IF v_ref >= now() - (v_stall_after + v_margin) THEN
        CONTINUE;
      END IF;
      v_section := 'A deferred chain did not resume';
    ELSE
      IF v_m.metadata->>'state' IS DISTINCT FROM 'consumed'
         OR coalesce(trim(v_m.metadata->>'dispatched_run_id'), '') <> '' THEN
        CONTINUE;
      END IF;
      v_ref := NULL;
      BEGIN
        v_ref := (v_m.metadata->>'consumed_at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        v_ref := NULL;  -- unparseable: fall back to created_at below
      END;
      -- A consumed_at in the future (including 'infinity') would hold the alert off indefinitely:
      -- treat it like a missing one.
      IF v_ref > now() THEN
        v_ref := NULL;
      END IF;
      v_ref := coalesce(v_ref, v_m.created_at);
      IF v_ref >= now() - (v_reconcile_after + v_margin) THEN
        CONTINUE;
      END IF;
      v_section := 'Resume after a failed resume dispatch';
    END IF;
    v_age := now() - v_ref;

    -- Dedup on delivery outcome, per (marker id, kind), read ONLY from the alert rows: the harvest
    -- above already copied every available response into them in this same transaction, so this
    -- loop never reads net._http_response. A harvested result (status_code key present) decides:
    -- delivered (2xx and sent = 'true') suppresses; anything else -- non-2xx, null status, sent
    -- false, unparseable body -- does not. An alert with no harvested result has no response yet:
    -- pending (suppresses) while under 1h old, else it re-sends. A response that lands after the
    -- harvest is picked up by the next tick's harvest.
    v_suppress := false;
    FOR v_alert IN
      SELECT a.created_at, a.metadata
      FROM audit_logs a
      WHERE a.event_type = 'indexer_backfill_autochain_marker_alert'
        AND a.created_at >= now() - v_dedup
        AND a.metadata->>'marker_id' = v_m.id
        AND a.metadata->>'kind' = v_kind
      ORDER BY a.created_at DESC
    LOOP
      IF v_alert.metadata ? 'status_code' THEN
        v_status := CASE WHEN v_alert.metadata->>'status_code' ~ '^[0-9]{1,3}$'
                         THEN (v_alert.metadata->>'status_code')::integer END;
        IF v_status BETWEEN 200 AND 299 AND v_alert.metadata->>'sent' = 'true' THEN
          v_suppress := true;
          EXIT;
        END IF;
        CONTINUE;
      END IF;

      IF v_alert.created_at > now() - v_pending THEN
        v_suppress := true;
        EXIT;
      END IF;
    END LOOP;

    IF v_suppress THEN
      CONTINUE;
    END IF;

    IF NOT v_secrets_loaded THEN
      SELECT decrypted_secret INTO v_base_url
      FROM vault.decrypted_secrets
      WHERE name = 'refresh_metadata_functions_base_url';

      SELECT decrypted_secret INTO v_key
      FROM vault.decrypted_secrets
      WHERE name = 'refresh_metadata_service_role_key';

      v_secrets_loaded := true;

      -- Do not RAISE EXCEPTION here: it would roll back the trace. Leave one audit row, warn, return.
      v_missing := concat_ws(', ',
        CASE WHEN v_base_url IS NULL OR length(trim(v_base_url)) = 0
             THEN 'refresh_metadata_functions_base_url' END,
        CASE WHEN v_key IS NULL OR length(trim(v_key)) = 0
             THEN 'refresh_metadata_service_role_key' END);
      IF v_missing <> '' THEN
        INSERT INTO audit_logs (event_type, actor, action, result, metadata)
        VALUES ('indexer_backfill_autochain_watch_error', 'pg_cron', 'alert', 'error',
                jsonb_build_object('missing_secret', v_missing, 'marker_id', v_m.id, 'kind', v_kind));
        RAISE WARNING 'backfill autochain marker watcher cannot alert: vault secret(s) missing: %', v_missing;
        RETURN;
      END IF;
    END IF;

    v_rid := net.http_post(
      url                  := v_base_url || '/functions/v1/alert-notify',
      body                 := jsonb_build_object(
        'type', 'indexer_backfill_autochain_' || v_kind,
        'message', format(
          'Backfill autochain deferral marker %s (completed_run_id %s, supabase_env %s) has been in state %s for %s. Read %s, section "%s".%s',
          v_m.id,
          coalesce(v_m.metadata->>'completed_run_id', 'unknown'),
          coalesce(v_m.metadata->>'supabase_env', 'unknown'),
          v_m.metadata->>'state',
          date_trunc('minute', v_age)::text,
          v_runbook,
          v_section,
          CASE WHEN v_row_locked
               THEN ' The marker row was locked by another session for this tick, so the watcher alerted from an unlocked read.'
               ELSE '' END
        )
      ),
      headers              := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      timeout_milliseconds := 30000
    );

    INSERT INTO audit_logs (event_type, actor, action, result, metadata)
    VALUES ('indexer_backfill_autochain_marker_alert', 'pg_cron', 'alert', 'queued',
            jsonb_build_object(
              'marker_id', v_m.id,
              'kind', v_kind,
              'net_request_id', v_rid,
              'completed_run_id', v_m.metadata->>'completed_run_id',
              'row_locked', v_row_locked
            ));
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.check_backfill_autochain_markers() IS
  'Stale-marker watcher for the backfill autochain: POSTs an alert-notify alert (type indexer_backfill_autochain_stalled for an open marker older than 12h, indexer_backfill_autochain_unreconciled for a consumed marker with no dispatched_run_id whose consumed_at, else created_at when consumed_at is missing, unparseable or in the future, is older than 1h) with Vault credentials, and records an indexer_backfill_autochain_marker_alert row (marker_id, kind, net_request_id, completed_run_id, row_locked). Each tick first copies available pg_net responses into those rows (status_code, sent), even while the kill switch is set. Each candidate marker is re-read FOR UPDATE SKIP LOCKED and re-checked before dedup and send; a marker a concurrent transition has moved is skipped. When another session holds the marker row, the candidate is evaluated from the unlocked cursor read but only past a 12h wider bound (stalled past 24h, unreconciled past 13h), without locking, with the same dedup, and its alert row carries row_locked = true. Re-sends per marker and kind unless an alert in the last 24h was delivered (harvested 2xx and data.sent true) or is pending (not yet harvested, under 1h); dedup reads only the alert rows, never net._http_response. A watcher advisory xact lock lets only one concurrent call send. Missing vault secrets write an indexer_backfill_autochain_watch_error row and warn instead of raising. Vault flag SKILLSMITH_BACKFILL_AUTOCHAIN_WATCH_DISABLE=1/true silences evaluation and sending (the harvest still runs). Cron 29 * * * *. postgres + service_role only. SMI-7121.';

REVOKE EXECUTE ON FUNCTION public.check_backfill_autochain_markers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_backfill_autochain_markers() TO service_role;

COMMIT;
