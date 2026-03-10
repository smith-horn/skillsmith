-- Rollback: restore views without security_invoker, disable RLS on indexer_lock

-- Restore v_indexer_health (052 version)
DROP VIEW IF EXISTS v_indexer_health;
CREATE VIEW v_indexer_health AS
SELECT
  id, created_at, result,
  (metadata->>'found')::int AS found,
  (metadata->>'indexed')::int AS indexed,
  (metadata->>'updated')::int AS updated,
  (metadata->>'stale')::int AS stale,
  (metadata->>'unchanged')::int AS unchanged,
  (metadata->>'failed')::int AS failed,
  metadata->>'run_type' AS run_type,
  (metadata->>'github_skill_count')::int AS github_skill_count,
  metadata->'code_search' AS code_search
FROM audit_logs
WHERE event_type = 'indexer:run'
  AND created_at >= NOW() - INTERVAL '7 days'
ORDER BY created_at DESC;
GRANT SELECT ON v_indexer_health TO authenticated, service_role;

-- Restore v_refresh_health (051/052 version, unchanged)
DROP VIEW IF EXISTS v_refresh_health;
CREATE VIEW v_refresh_health AS
SELECT
  id, created_at, result,
  (metadata->>'processed')::int AS processed,
  (metadata->>'updated')::int AS updated,
  (metadata->>'skipped')::int AS skipped,
  (metadata->>'failed')::int AS failed,
  (metadata->>'skip_rate')::int AS skip_rate,
  (metadata->>'batch_size')::int AS batch_size,
  (metadata->>'stale_days')::int AS stale_days
FROM audit_logs
WHERE event_type = 'refresh:run'
  AND created_at >= NOW() - INTERVAL '48 hours'
ORDER BY created_at DESC;
GRANT SELECT ON v_refresh_health TO authenticated, service_role;

-- Remove RLS from indexer_lock
DROP POLICY IF EXISTS "Service role full access on indexer_lock" ON indexer_lock;
ALTER TABLE indexer_lock DISABLE ROW LEVEL SECURITY;

DELETE FROM schema_version WHERE version = 59;
