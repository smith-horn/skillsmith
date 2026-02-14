-- SMI-XXXX: API Key Authentication with Trial Tracking
-- Implements 10 requests TOTAL trial limit for unauthenticated users
-- Created: 2026-01-27

-- ============================================================================
-- TRIAL USAGE TABLE - Permanent trial tracking (no daily reset)
-- ============================================================================
CREATE TABLE IF NOT EXISTS trial_usage (
  ip_hash TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 0,
  first_request_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_request_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE trial_usage IS 'Tracks API trial usage by hashed IP - 10 requests TOTAL limit';
COMMENT ON COLUMN trial_usage.ip_hash IS 'SHA-256 hash of IP + salt for privacy';
COMMENT ON COLUMN trial_usage.request_count IS 'Total requests made (never resets)';

-- ============================================================================
-- INDEX FOR CLEANUP QUERIES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_trial_usage_last_request ON trial_usage(last_request_at);

-- ============================================================================
-- FUNCTION: check_trial_usage
-- Checks and increments trial usage for an IP hash
-- Returns: allowed (bool), used (int), remaining (int)
-- ============================================================================
CREATE OR REPLACE FUNCTION check_trial_usage(ip_hash_input TEXT)
RETURNS TABLE(allowed BOOLEAN, used INTEGER, remaining INTEGER)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  current_count INTEGER;
  trial_limit CONSTANT INTEGER := 10;
BEGIN
  -- Upsert: insert new or increment existing
  INSERT INTO trial_usage (ip_hash, request_count, first_request_at, last_request_at)
  VALUES (ip_hash_input, 1, NOW(), NOW())
  ON CONFLICT (ip_hash) DO UPDATE SET
    request_count = trial_usage.request_count + 1,
    last_request_at = NOW()
  RETURNING request_count INTO current_count;

  -- Return result
  RETURN QUERY
  SELECT
    current_count <= trial_limit AS allowed,
    current_count AS used,
    GREATEST(0, trial_limit - current_count) AS remaining;
END;
$$;

COMMENT ON FUNCTION check_trial_usage IS 'Check and increment trial usage. Returns allowed status and remaining requests.';

-- Grant execute to anon (for Edge Functions)
GRANT EXECUTE ON FUNCTION check_trial_usage TO anon;

-- ============================================================================
-- RLS POLICY: Allow anon to trigger validate_license_key updates
-- The validate_license_key function updates last_used_at and usage_count
-- ============================================================================
DROP POLICY IF EXISTS "RPC can update license key usage" ON license_keys;
CREATE POLICY "RPC can update license key usage"
  ON license_keys FOR UPDATE TO anon
  USING (true)
  WITH CHECK (key_hash IS NOT NULL);

-- ============================================================================
-- PENDING KEY DISPLAY TABLE - One-time key display after signup
-- ============================================================================
CREATE TABLE IF NOT EXISTS pending_key_display (
  user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  encrypted_key TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pending_key_display IS 'Temporary storage for one-time API key display after signup';

-- Enable RLS
ALTER TABLE pending_key_display ENABLE ROW LEVEL SECURITY;

-- Users can only view their own pending key
DROP POLICY IF EXISTS "Users can view own pending key" ON pending_key_display;
CREATE POLICY "Users can view own pending key"
  ON pending_key_display FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Service role can manage pending keys
DROP POLICY IF EXISTS "Service role can manage pending keys" ON pending_key_display;
CREATE POLICY "Service role can manage pending keys"
  ON pending_key_display FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- FUNCTION: generate_api_key_for_user
-- Generates an API key for a new user (called from handle_new_user trigger)
-- ============================================================================
CREATE OR REPLACE FUNCTION generate_api_key_for_user(
  user_id_input UUID,
  tier_input TEXT DEFAULT 'community'
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  key_bytes BYTEA;
  key_body TEXT;
  full_key TEXT;
  key_hash_val TEXT;
  key_prefix_val TEXT;
  rate_limit_val INTEGER;
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

  -- Store for one-time display (encrypted with app key in Edge Function)
  -- We store the full key temporarily for the first login display
  INSERT INTO pending_key_display (user_id, encrypted_key, expires_at)
  VALUES (user_id_input, full_key, NOW() + INTERVAL '24 hours')
  ON CONFLICT (user_id) DO UPDATE SET
    encrypted_key = EXCLUDED.encrypted_key,
    expires_at = EXCLUDED.expires_at;

  RETURN full_key;
END;
$$;

COMMENT ON FUNCTION generate_api_key_for_user IS 'Generates an API key for a user and stores it for one-time display';

-- Grant execute to service_role only
GRANT EXECUTE ON FUNCTION generate_api_key_for_user TO service_role;

-- ============================================================================
-- UPDATE: handle_new_user to auto-generate API key
-- ============================================================================
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- Set search_path to prevent schema confusion
  SET search_path = public, auth;

  -- Insert profile
  INSERT INTO profiles (id, email, full_name, tier, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'community',
    'user'
  );

  -- Auto-generate API key for new user
  PERFORM generate_api_key_for_user(NEW.id, 'community');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth;

-- ============================================================================
-- CLEANUP: Remove expired pending key displays (run periodically)
-- ============================================================================
CREATE OR REPLACE FUNCTION cleanup_expired_pending_keys()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM pending_key_display
  WHERE expires_at < NOW();

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- ============================================================================
-- Update schema version
-- ============================================================================
INSERT INTO schema_version (version) VALUES (14) ON CONFLICT DO NOTHING;
