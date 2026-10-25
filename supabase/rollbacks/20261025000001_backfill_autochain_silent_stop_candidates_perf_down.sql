-- Rollback for 20261025000001_backfill_autochain_silent_stop_candidates_perf.sql
-- SMI-7167
--
-- Restores backfill_autochain_silent_stop_candidates() to its 20261025000000 body (verbatim below).
-- Safe to apply via `supabase db execute --file`.
--
-- WARNING -- READ BEFORE RUNNING
--
-- 1. The 20261025000000 body is correct but QUADRATIC in the ledger size (measured: 1,000 dispatched
--    runs 3.8 s, 8,000 runs 44 s; a 37,000-run ledger exceeded a 120 s statement timeout). Once the
--    autochain has been dispatching for a few weeks, the hourly detector can exceed its statement
--    budget and page nothing. Roll back only to undo a defect in 20261025000001 itself, and put prod
--    back on the local driver (BACKFILL_AUTOCHAIN_DISABLE=1) first.
-- 2. CREATE OR REPLACE keeps the grants; nothing else changes. The detector and its cron job are
--    untouched (20261025000000 owns them; its own rollback removes them).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.backfill_autochain_silent_stop_candidates()
RETURNS TABLE (
  arm               text,
  key               text,
  sub_kind          text,
  deadline          timestamptz,
  ref_at            timestamptz,
  checkpoint_at     timestamptz,
  supabase_env      text,
  link_run_id       text,
  link_run_attempt  text,
  dispatch_token    text,
  dispatched_run_id text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH ledger AS MATERIALIZED (
    SELECT a.event_type, a.created_at, a.metadata AS m
    FROM public.audit_logs a
    WHERE a.event_type IN (
        'indexer_backfill_autochain_dispatch_prepared',
        'indexer_backfill_autochain_dispatch_resolved',
        'indexer_backfill_autochain_link_started',
        'indexer_backfill_autochain_link_finished',
        'indexer_backfill_autochain_silent_stop_ack'
      )
      AND a.created_at >= now() - interval '1 year'
  ),
  -- Arm A: one row per dispatched run id (the earliest resolved row names it).
  dispatched AS (
    SELECT DISTINCT ON (l.m->>'dispatched_run_id')
           l.m->>'dispatched_run_id' AS rid, l.created_at, l.m
    FROM ledger l
    WHERE l.event_type = 'indexer_backfill_autochain_dispatch_resolved'
      AND l.m->>'outcome' = 'dispatched'
      AND jsonb_typeof(l.m->'dispatched_run_id') = 'string'
      AND l.m->>'dispatched_run_id' ~ '^[1-9][0-9]{0,18}$'
    ORDER BY l.m->>'dispatched_run_id', l.created_at
  ),
  unresolved_a AS (
    SELECT d.*
    FROM dispatched d
    WHERE NOT EXISTS (
            SELECT 1 FROM ledger f
            WHERE f.event_type = 'indexer_backfill_autochain_link_finished'
              AND jsonb_typeof(f.m->'completed_run_id') = 'string'
              AND f.m->>'completed_run_id' = d.rid
              AND f.m->>'status' = 'success')
      AND NOT EXISTS (
            SELECT 1 FROM ledger k
            WHERE k.event_type = 'indexer_backfill_autochain_silent_stop_ack'
              AND k.m->>'arm' = 'A'
              AND jsonb_typeof(k.m->'key') = 'string'
              AND k.m->>'key' = d.rid)
  ),
  arm_a AS (
    SELECT u.*,
           (SELECT max(c.created_at)
              FROM public.audit_logs c
             WHERE c.event_type = 'indexer_backfill_checkpoint'
               AND c.created_at >= u.created_at - interval '1 day'
               AND c.metadata->>'run_id' = u.rid
               AND coalesce(c.metadata->>'dry_run', 'false') <> 'true') AS ckpt
    FROM unresolved_a u
  ),
  -- Arm B: one row per (token, attempt).
  prepared AS (
    SELECT DISTINCT ON (l.m->>'dispatch_token', l.m->>'link_run_attempt')
           l.m->>'dispatch_token' AS tok, l.m->>'link_run_attempt' AS att, l.created_at, l.m
    FROM ledger l
    WHERE l.event_type = 'indexer_backfill_autochain_dispatch_prepared'
      AND jsonb_typeof(l.m->'dispatch_token') = 'string'
      AND jsonb_typeof(l.m->'link_run_attempt') = 'string'
      AND l.m->>'dispatch_token' ~ '^ac-[1-9][0-9]{0,18}$'
      AND l.m->>'link_run_attempt' ~ '^[1-9][0-9]{0,4}$'
    ORDER BY l.m->>'dispatch_token', l.m->>'link_run_attempt', l.created_at
  )
  SELECT 'A'::text,
         a.rid,
         -- A finish row is the stronger evidence, so it is tested first: a failed finish whose start
         -- write was lost reads link_failed, not no_link.
         CASE
           WHEN EXISTS (SELECT 1 FROM ledger f
                         WHERE f.event_type = 'indexer_backfill_autochain_link_finished'
                           AND jsonb_typeof(f.m->'completed_run_id') = 'string'
                           AND f.m->>'completed_run_id' = a.rid) THEN 'link_failed'
           WHEN EXISTS (SELECT 1 FROM ledger s
                         WHERE s.event_type = 'indexer_backfill_autochain_link_started'
                           AND jsonb_typeof(s.m->'completed_run_id') = 'string'
                           AND s.m->>'completed_run_id' = a.rid) THEN 'link_unfinished'
           ELSE 'no_link'
         END,
         coalesce(a.ckpt + interval '30 minutes', a.created_at + interval '12 hours'),
         a.created_at,
         a.ckpt,
         a.m->>'supabase_env',
         a.m->>'link_run_id',
         a.m->>'link_run_attempt',
         a.m->>'dispatch_token',
         a.rid
  FROM arm_a a
  WHERE coalesce(a.ckpt + interval '30 minutes', a.created_at + interval '12 hours') <= now()
  UNION ALL
  SELECT 'B'::text,
         p.tok || ':' || p.att,
         'unresolved'::text,
         p.created_at + interval '30 minutes',
         p.created_at,
         NULL::timestamptz,
         p.m->>'supabase_env',
         p.m->>'link_run_id',
         p.att,
         p.tok,
         NULL::text
  FROM prepared p
  WHERE p.created_at + interval '30 minutes' <= now()
    AND NOT EXISTS (
          SELECT 1 FROM ledger r
          WHERE r.event_type = 'indexer_backfill_autochain_dispatch_resolved'
            AND jsonb_typeof(r.m->'dispatch_token') = 'string'
            AND jsonb_typeof(r.m->'link_run_attempt') = 'string'
            AND r.m->>'dispatch_token' = p.tok
            AND r.m->>'link_run_attempt' = p.att)
    AND NOT EXISTS (
          SELECT 1 FROM ledger k
          WHERE k.event_type = 'indexer_backfill_autochain_silent_stop_ack'
            AND k.m->>'arm' = 'B'
            AND jsonb_typeof(k.m->'key') = 'string'
            AND k.m->>'key' = p.tok || ':' || p.att)
$$;

COMMENT ON FUNCTION public.backfill_autochain_silent_stop_candidates() IS
  'Read-only. Open silent-stop candidates from the backfill autochain ledger (ADR-183). Arm A: a dispatch_resolved row with outcome dispatched and run id R, with no link_finished row for R with status success and no silent_stop_ack {arm A, key R}, past its deadline (latest non-dry-run checkpoint for R + 30 min, else the resolved row + 12 h); sub_kind no_link / link_failed / link_unfinished. Arm B: a dispatch_prepared row (token, link_run_attempt) with no matching dispatch_resolved row and no silent_stop_ack {arm B, key token:attempt}, older than 30 min. Ids compared as text; malformed rows ignored. 1-year window. SECURITY INVOKER. service_role only. SMI-7167.';

COMMIT;
