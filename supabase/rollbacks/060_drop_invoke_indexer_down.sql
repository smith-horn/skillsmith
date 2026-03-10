-- Rollback: recreate invoke_indexer() (still non-functional without http extension)
-- Restored from migration 003 + 033 search_path fix

CREATE OR REPLACE FUNCTION invoke_indexer()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  response json;
  service_role_key text;
BEGIN
  service_role_key := current_setting('app.settings.service_role_key', true);

  IF service_role_key IS NULL THEN
    RAISE WARNING 'Service role key not configured. Skipping indexer invocation.';
    RETURN;
  END IF;

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

COMMENT ON FUNCTION invoke_indexer() IS 'Invokes the GitHub skill indexer Edge Function. Used by pg_cron for scheduled indexing.';

DELETE FROM schema_version WHERE version = 60;
