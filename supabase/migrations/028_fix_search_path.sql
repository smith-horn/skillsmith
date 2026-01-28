-- SMI-1916: Fix gen_random_bytes not found error
-- The generate_api_key_for_user function was missing 'extensions' in search_path
-- This caused signup to fail with "function gen_random_bytes(integer) does not exist"
-- Created: 2026-01-28

-- ============================================================================
-- FIX: Add 'extensions' to search_path for pgcrypto functions
-- ============================================================================

CREATE OR REPLACE FUNCTION generate_api_key_for_user(
  user_id_input UUID,
  tier_input TEXT DEFAULT 'community'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions  -- FIXED: Added extensions for pgcrypto
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
  -- Generate 32 random bytes
  key_bytes := gen_random_bytes(32);

  -- Convert to base64url
  key_body := translate(encode(key_bytes, 'base64'), '+/=', '-_');

  -- Create full key with prefix
  full_key := 'sk_live_' || key_body;

  -- Create display prefix
  key_prefix_val := left(full_key, 16) || '...';

  -- Hash the key for storage
  key_hash_val := encode(sha256(full_key::bytea), 'hex');

  -- Get rate limit for tier
  rate_limit_val := CASE tier_input
    WHEN 'enterprise' THEN 300
    WHEN 'team' THEN 120
    WHEN 'individual' THEN 60
    ELSE 30  -- community
  END;

  -- Insert the license key
  INSERT INTO license_keys (
    user_id,
    key_hash,
    key_prefix,
    name,
    tier,
    status,
    rate_limit_per_minute,
    metadata
  ) VALUES (
    user_id_input,
    key_hash_val,
    key_prefix_val,
    'Default API Key',
    tier_input,
    'active',
    rate_limit_val,
    jsonb_build_object(
      'generated_via', 'signup',
      'generated_at', NOW()
    )
  );

  -- Get encryption key from app_secrets table
  SELECT value INTO encryption_key
  FROM app_secrets
  WHERE key = 'pending_key_secret';

  -- Fallback to a derived key if secret not found (shouldn't happen after migration)
  IF encryption_key IS NULL OR encryption_key = '' THEN
    encryption_key := encode(sha256(('skillsmith-pending-key-' || user_id_input::text)::bytea), 'hex');
    RAISE WARNING 'pending_key_secret not in app_secrets - using derived key';
  END IF;

  -- Store encrypted key for one-time display
  -- Uses PGP symmetric encryption (AES256 by default)
  INSERT INTO pending_key_display (user_id, payload, expires_at)
  VALUES (
    user_id_input,
    pgp_sym_encrypt(full_key, encryption_key),
    NOW() + INTERVAL '24 hours'
  )
  ON CONFLICT (user_id) DO UPDATE SET
    payload = EXCLUDED.payload,
    expires_at = EXCLUDED.expires_at;

  RETURN full_key;
END;
$$;

-- Update schema version
INSERT INTO schema_version (version) VALUES (28) ON CONFLICT DO NOTHING;
