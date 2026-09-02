-- Rollback for 20260902000000_cloud_usage_analytics_wiring.sql
-- SMI-6362 Wave 1
--
-- Restores the three analytics_skill_* RPCs to their pre-migration
-- UUID-typed, event_type='skill_invoke' signatures and bodies; drops the
-- three new RPCs (analytics_tool_usage, analytics_team_reporting_coverage,
-- resolve_telemetry_identity); reverts get_team_usage_for_period to its
-- pre-migration audit_logs-based body; restores the original
-- consent_decided_at column comment. Safe to apply via
-- `supabase db execute --file`.
--
-- ============================================================================
-- WARNING -- READ BEFORE RUNNING
-- ============================================================================
--
-- 1. THE consent_decided_at REPAIR (forward migration item 6b) IS NOT
--    REVERTED, and cannot safely be. The forward migration filled
--    consent_decided_at for every row with enabled=TRUE AND
--    consent_decided_at IS NULL, stamped at each row's own updated_at. After
--    that repair runs, there is no way to distinguish "repaired by this
--    migration" from "already decided via some other write" -- the repair is
--    evidence-preserving by construction (it stamps a real historical
--    timestamp, not now()), and un-repairing it would re-strand every one of
--    those users at a permanent consent_required prompt they had already
--    resolved. This rollback deliberately leaves that data alone. If you
--    need to undo it anyway, you must reconstruct the affected row set from
--    a pre-migration backup/snapshot -- there is no query against the
--    post-migration table alone that can recover it.
-- 2. Any search_metrics rows already written under the new event types
--    (telemetry:tool_call) or with a server-stamped team_id survive this
--    rollback -- dropping analytics_tool_usage does not delete data, it only
--    removes the RPC that reads it. If Wave 2's events edge function is still
--    live and deployed, it will continue writing telemetry:tool_call rows
--    that nothing can then read until this migration is re-applied.
-- 3. DROP FUNCTION on the TEXT-signature RPCs is safe here specifically
--    because Surface Grounding (docs/internal/implementation/
--    smi-6362-cloud-usage-analytics.md) confirmed analytics.supabase.service.ts
--    has zero non-test importers as of this migration -- nothing else in the
--    schema calls these by name. Re-verify that is still true before running
--    this in an environment where Wave 4 (the read-path wiring) has shipped.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- Drop the new RPCs this migration introduced.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.analytics_tool_usage(TEXT, INT);
DROP FUNCTION IF EXISTS public.analytics_team_reporting_coverage(TEXT);
DROP FUNCTION IF EXISTS public.resolve_telemetry_identity(UUID, TEXT);

-- ---------------------------------------------------------------------------
-- Restore the three analytics_skill_* RPCs to their pre-migration
-- UUID-typed, event_type='skill_invoke' bodies (as shipped by
-- 20260519000005_skill_invoke_rpcs.sql).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.analytics_skill_top(TEXT, INT);
DROP FUNCTION IF EXISTS public.analytics_skill_stale(TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.analytics_skill_cooccurrence(TEXT, INT);

CREATE OR REPLACE FUNCTION public.analytics_skill_top(
  p_team_id UUID,
  p_window_days INT
)
RETURNS TABLE (
  skill_name TEXT,
  invocation_count BIGINT,
  distinct_developers BIGINT,
  week_over_week_delta NUMERIC,
  framework_breakdown JSONB
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_now           TIMESTAMPTZ := now();
  v_window_start  TIMESTAMPTZ := v_now - (p_window_days || ' days')::INTERVAL;
  v_prev_start    TIMESTAMPTZ := v_window_start - (p_window_days || ' days')::INTERVAL;
BEGIN
  RETURN QUERY
  WITH cur AS (
    SELECT
      sm.metadata->>'skill_name' AS sn,
      COUNT(*)::BIGINT          AS cnt,
      COUNT(DISTINCT sm.actor)::BIGINT AS devs,
      jsonb_object_agg(
        COALESCE(sm.metadata->>'framework', 'unknown'),
        cnt_by_framework
      ) AS fw_breakdown
    FROM search_metrics sm
    CROSS JOIN LATERAL (
      SELECT COUNT(*) AS cnt_by_framework
      FROM search_metrics sm2
      WHERE sm2.event_type = 'skill_invoke'
        AND sm2.metadata->>'skill_name' = sm.metadata->>'skill_name'
        AND COALESCE(sm2.metadata->>'framework', 'unknown')
            = COALESCE(sm.metadata->>'framework', 'unknown')
        AND sm2.created_at >= v_window_start
        AND sm2.metadata->>'team_id' = p_team_id::TEXT
    ) lat
    WHERE sm.event_type = 'skill_invoke'
      AND sm.created_at >= v_window_start
      AND sm.metadata->>'team_id' = p_team_id::TEXT
    GROUP BY sm.metadata->>'skill_name'
  ),
  prev AS (
    SELECT
      sm.metadata->>'skill_name' AS sn,
      COUNT(*)::BIGINT           AS prev_cnt
    FROM search_metrics sm
    WHERE sm.event_type = 'skill_invoke'
      AND sm.created_at >= v_prev_start
      AND sm.created_at <  v_window_start
      AND sm.metadata->>'team_id' = p_team_id::TEXT
    GROUP BY sm.metadata->>'skill_name'
  )
  SELECT
    cur.sn                                                  AS skill_name,
    cur.cnt                                                 AS invocation_count,
    cur.devs                                                AS distinct_developers,
    CASE
      WHEN prev.prev_cnt IS NULL OR prev.prev_cnt = 0 THEN NULL
      ELSE ((cur.cnt - prev.prev_cnt)::NUMERIC / prev.prev_cnt::NUMERIC)
    END                                                     AS week_over_week_delta,
    cur.fw_breakdown                                        AS framework_breakdown
  FROM cur
  LEFT JOIN prev ON prev.sn = cur.sn
  ORDER BY cur.cnt DESC
  LIMIT 50;
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_skill_stale(
  p_team_id UUID,
  p_window_days INT,
  p_threshold INT
)
RETURNS TABLE (
  skill_name TEXT,
  last_invoked TIMESTAMPTZ,
  invocation_count BIGINT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ := now() - (p_window_days || ' days')::INTERVAL;
BEGIN
  RETURN QUERY
  SELECT
    sm.metadata->>'skill_name'           AS skill_name,
    MAX(sm.created_at)                    AS last_invoked,
    COUNT(*)::BIGINT                      AS invocation_count
  FROM search_metrics sm
  WHERE sm.event_type = 'skill_invoke'
    AND sm.created_at >= v_window_start
    AND sm.metadata->>'team_id' = p_team_id::TEXT
  GROUP BY sm.metadata->>'skill_name'
  HAVING COUNT(*) < p_threshold
  ORDER BY MAX(sm.created_at) ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_skill_cooccurrence(
  p_team_id UUID,
  p_window_days INT
)
RETURNS TABLE (
  skill_a TEXT,
  skill_b TEXT,
  cooccurrence_count BIGINT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ := now() - (p_window_days || ' days')::INTERVAL;
BEGIN
  RETURN QUERY
  SELECT
    LEAST(sm_a.metadata->>'skill_name',
          sm_b.metadata->>'skill_name')          AS skill_a,
    GREATEST(sm_a.metadata->>'skill_name',
             sm_b.metadata->>'skill_name')       AS skill_b,
    COUNT(*)::BIGINT                              AS cooccurrence_count
  FROM search_metrics sm_a
  JOIN search_metrics sm_b
    ON sm_a.metadata->>'session_id' = sm_b.metadata->>'session_id'
   AND sm_a.metadata->>'skill_name' <  sm_b.metadata->>'skill_name'
  WHERE sm_a.event_type = 'skill_invoke'
    AND sm_b.event_type = 'skill_invoke'
    AND sm_a.created_at >= v_window_start
    AND sm_b.created_at >= v_window_start
    AND sm_a.metadata->>'team_id' = p_team_id::TEXT
    AND sm_b.metadata->>'team_id' = p_team_id::TEXT
  GROUP BY 1, 2
  ORDER BY cooccurrence_count DESC
  LIMIT 100;
END;
$$;

-- ---------------------------------------------------------------------------
-- Restore get_team_usage_for_period's pre-migration audit_logs-based body.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_team_usage_for_period(
  p_team_id TEXT,
  p_period_start TIMESTAMPTZ,
  p_period_end TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result JSONB;
  v_is_member BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM team_members tm
     WHERE tm.team_id = p_team_id AND tm.user_id = auth.uid()
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RETURN jsonb_build_object('error', 'not_a_member');
  END IF;

  SELECT jsonb_build_object(
    'total_events',      COUNT(*),
    'api_calls',         COUNT(*) FILTER (WHERE event_type LIKE 'search:%' OR event_type LIKE 'skills:%'),
    'skills_installed',  COUNT(*) FILTER (WHERE action = 'install_skill' OR event_type = 'install'),
    'audits_run',        COUNT(*) FILTER (WHERE event_type LIKE '%audit%'),
    'period_start',      p_period_start,
    'period_end',        p_period_end
  )
    INTO v_result
    FROM audit_logs
   WHERE metadata->>'team_id' = p_team_id
     AND timestamp >= p_period_start
     AND timestamp < p_period_end;

  RETURN COALESCE(v_result, jsonb_build_object('total_events', 0));
END;
$$;

REVOKE ALL ON FUNCTION get_team_usage_for_period(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_team_usage_for_period(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Restore the original consent_decided_at column comment (SMI-5531 wording).
-- The DATA the forward migration repaired is deliberately left alone -- see
-- warning 1 above.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN user_telemetry_preferences.consent_decided_at IS
  'SMI-5531: timestamp of the user''s explicit consent decision (opt-in OR opt-out) on the telemetry dashboard / CLI. NULL means never decided -- consentRequired stays true regardless of enabled''s stored value. Set exactly once per explicit save; the telemetry-consent edge function''s upsert-on-first-contact path must never set this.';

COMMIT;
