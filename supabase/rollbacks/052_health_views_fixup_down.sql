-- Rollback for 052_health_views_fixup.sql
-- Restores v_indexer_health to LIMIT-based (no time filter)
-- and restores anon grants from original 051

-- Restore v_indexer_health with LIMIT instead of time filter
CREATE OR REPLACE VIEW v_indexer_health AS
SELECT
  id,
  created_at,
  result,
  (metadata->>'found')::int            AS found,
  (metadata->>'indexed')::int          AS indexed,
  (metadata->>'updated')::int          AS updated,
  (metadata->>'stale')::int            AS stale,
  (metadata->>'unchanged')::int        AS unchanged,
  (metadata->>'failed')::int           AS failed,
  metadata->>'run_type'                AS run_type,
  (metadata->>'github_skill_count')::int AS github_skill_count,
  metadata->'code_search'              AS code_search
FROM audit_logs
WHERE event_type = 'indexer:run'
ORDER BY created_at DESC
LIMIT 21;

-- Restore anon grants
GRANT SELECT ON v_indexer_health TO anon, authenticated;
GRANT SELECT ON v_refresh_health TO anon, authenticated;

-- Revoke service_role (wasn't in original 051)
REVOKE SELECT ON v_indexer_health FROM service_role;
REVOKE SELECT ON v_refresh_health FROM service_role;

DELETE FROM schema_version WHERE version = 52;
