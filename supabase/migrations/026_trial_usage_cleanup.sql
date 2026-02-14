-- SMI-53: Scheduled cleanup for trial_usage table
-- Deletes entries older than 90 days to prevent unbounded table growth
-- Created: 2026-01-27

-- ============================================================================
-- CLEANUP FUNCTION: Delete old trial_usage entries
-- ============================================================================
CREATE OR REPLACE FUNCTION cleanup_trial_usage()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Delete ALL entries older than 90 days
  -- Rationale:
  -- - If user signed up, their trial usage is irrelevant
  -- - If user didn't sign up after 90 days, a fresh trial is acceptable
  DELETE FROM trial_usage
  WHERE last_request_at < NOW() - INTERVAL '90 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  -- Log to audit_logs for monitoring
  INSERT INTO audit_logs (event_type, actor, action, result, metadata)
  VALUES (
    'cron:trial_cleanup',
    'pg_cron',
    'cleanup',
    'success',
    jsonb_build_object(
      'deleted_count', deleted_count,
      'retention_days', 90,
      'executed_at', NOW()
    )
  );

  RETURN deleted_count;

EXCEPTION WHEN OTHERS THEN
  -- Log error but don't fail
  INSERT INTO audit_logs (event_type, actor, action, result, metadata)
  VALUES (
    'cron:trial_cleanup',
    'pg_cron',
    'cleanup',
    'error',
    jsonb_build_object(
      'error', SQLERRM,
      'executed_at', NOW()
    )
  );
  RETURN 0;
END;
$$;

COMMENT ON FUNCTION cleanup_trial_usage() IS 'Deletes trial_usage entries older than 90 days. Run by pg_cron daily at 3 AM UTC.';

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION cleanup_trial_usage() TO service_role;

-- ============================================================================
-- SCHEDULE: Run daily at 3:00 AM UTC
-- ============================================================================
-- Note: pg_cron must be enabled (done in migration 003)

-- Remove existing schedule if any (idempotent)
SELECT cron.unschedule('daily-trial-cleanup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-trial-cleanup');

-- Schedule the cleanup job
SELECT cron.schedule(
  'daily-trial-cleanup',
  '0 3 * * *',  -- 3:00 AM UTC daily
  $$SELECT cleanup_trial_usage()$$
);

-- ============================================================================
-- ALSO: Cleanup expired pending_key_display entries
-- ============================================================================
CREATE OR REPLACE FUNCTION cleanup_expired_pending_keys()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM pending_key_display
  WHERE expires_at < NOW();

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  -- Only log if we deleted something
  IF deleted_count > 0 THEN
    INSERT INTO audit_logs (event_type, actor, action, result, metadata)
    VALUES (
      'cron:pending_key_cleanup',
      'pg_cron',
      'cleanup',
      'success',
      jsonb_build_object(
        'deleted_count', deleted_count,
        'executed_at', NOW()
      )
    );
  END IF;

  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_expired_pending_keys() IS 'Deletes expired pending_key_display entries. Run by pg_cron daily at 3 AM UTC.';

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION cleanup_expired_pending_keys() TO service_role;

-- Schedule pending key cleanup (runs right after trial cleanup)
SELECT cron.unschedule('daily-pending-key-cleanup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-pending-key-cleanup');

SELECT cron.schedule(
  'daily-pending-key-cleanup',
  '5 3 * * *',  -- 3:05 AM UTC daily
  $$SELECT cleanup_expired_pending_keys()$$
);

-- ============================================================================
-- Update schema version
-- ============================================================================
INSERT INTO schema_version (version) VALUES (26) ON CONFLICT DO NOTHING;
