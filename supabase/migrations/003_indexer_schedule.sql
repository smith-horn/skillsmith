-- SMI-1248: Configure GitHub indexer schedule
-- This migration sets up pg_cron to run the indexer daily

-- Enable pg_cron extension if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Create a function to invoke the indexer Edge Function
CREATE OR REPLACE FUNCTION invoke_indexer()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  response json;
  service_role_key text;
BEGIN
  -- Get the service role key from vault (must be configured)
  -- Note: In production, use Supabase secrets management
  service_role_key := current_setting('app.settings.service_role_key', true);

  IF service_role_key IS NULL THEN
    RAISE WARNING 'Service role key not configured. Skipping indexer invocation.';
    RETURN;
  END IF;

  -- Invoke the Edge Function
  SELECT content::json INTO response
  FROM http((
    'POST',
    current_setting('app.settings.supabase_url') || '/functions/v1/indexer',
    ARRAY[
      http_header('Authorization', 'Bearer ' || service_role_key),
      http_header('Content-Type', 'application/json')
    ],
    'application/json',
    '{"maxPages": 3}'
  )::http_request);

  -- Log result
  INSERT INTO audit_logs (event_type, actor, action, result, metadata)
  VALUES (
    'cron:indexer',
    'pg_cron',
    'invoke',
    CASE WHEN response->>'data' IS NOT NULL THEN 'success' ELSE 'failed' END,
    jsonb_build_object(
      'response', response,
      'invoked_at', now()
    )
  );

EXCEPTION WHEN OTHERS THEN
  -- Log error but don't fail
  INSERT INTO audit_logs (event_type, actor, action, result, metadata)
  VALUES (
    'cron:indexer',
    'pg_cron',
    'invoke',
    'error',
    jsonb_build_object(
      'error', SQLERRM,
      'invoked_at', now()
    )
  );
END;
$$;

-- Schedule the indexer to run daily at 2:00 AM UTC
-- Note: Uncomment after configuring service_role_key in app settings
-- SELECT cron.schedule(
--   'daily-skill-indexer',
--   '0 2 * * *',
--   $$SELECT invoke_indexer()$$
-- );

-- To manually trigger: SELECT invoke_indexer();
-- To check schedule: SELECT * FROM cron.job;
-- To remove schedule: SELECT cron.unschedule('daily-skill-indexer');

COMMENT ON FUNCTION invoke_indexer() IS 'Invokes the GitHub skill indexer Edge Function. Used by pg_cron for scheduled indexing.';
