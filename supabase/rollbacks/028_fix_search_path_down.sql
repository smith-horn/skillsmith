-- ROLLBACK: 028_fix_search_path
-- Reverts generate_api_key_for_user to version without 'extensions' in search_path
-- WARNING: This will break signup - pgcrypto functions won't be found

CREATE OR REPLACE FUNCTION generate_api_key_for_user(
  user_id_input UUID,
  tier_input TEXT DEFAULT 'community'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public  -- REVERTED: Removed 'extensions'
AS $$
DECLARE
  key_bytes BYTEA;
  key_body TEXT;
  full_key TEXT;
  key_hash_val TEXT;
  key_prefix_val TEXT;
  rate_limit_val INTEGER;
  encryption_key TEXT;
BEGIN
  key_bytes := gen_random_bytes(32);
  key_body := translate(encode(key_bytes, 'base64'), '+/=', '-_');
  full_key := 'sk_live_' || key_body;
  key_prefix_val := left(full_key, 16) || '...';
  key_hash_val := encode(sha256(full_key::bytea), 'hex');

  rate_limit_val := CASE tier_input
    WHEN 'enterprise' THEN 300
    WHEN 'team' THEN 120
    WHEN 'individual' THEN 60
    ELSE 30
  END;

  INSERT INTO license_keys (
    user_id, key_hash, key_prefix, name, tier, status, rate_limit_per_minute, metadata
  ) VALUES (
    user_id_input, key_hash_val, key_prefix_val, 'Default API Key', tier_input, 'active',
    rate_limit_val, jsonb_build_object('generated_via', 'signup', 'generated_at', NOW())
  );

  SELECT value INTO encryption_key FROM app_secrets WHERE key = 'pending_key_secret';

  IF encryption_key IS NULL OR encryption_key = '' THEN
    encryption_key := encode(sha256(('skillsmith-pending-key-' || user_id_input::text)::bytea), 'hex');
  END IF;

  INSERT INTO pending_key_display (user_id, payload, expires_at)
  VALUES (user_id_input, pgp_sym_encrypt(full_key, encryption_key), NOW() + INTERVAL '24 hours')
  ON CONFLICT (user_id) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at;

  RETURN full_key;
END;
$$;

-- Remove schema version entry
DELETE FROM schema_version WHERE version = 28;
