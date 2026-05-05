-- Rollback for 20260504000001_allow_multi_key_per_tier (SMI-4740)
-- WARNING: Revokes excess keys (>1 per user/tier). Notify support before running.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- STEP 1: Revoke extra keys (keep newest active per user/tier, revoke older ones)
-- Must run BEFORE recreating the unique index
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY user_id, tier ORDER BY created_at DESC) AS rn
  FROM license_keys WHERE status = 'active'
),
extras AS (SELECT id FROM ranked WHERE rn > 1)
UPDATE license_keys
SET status = 'revoked', revoked_at = NOW(),
    metadata = metadata || '{"revoked_reason":"rollback_excess_key_cleanup"}'
WHERE id IN (SELECT id FROM extras)
  AND TRUE;

-- STEP 2: Drop replacement community index
DROP INDEX IF EXISTS idx_license_keys_community_active;

-- STEP 3: Recreate original index
CREATE UNIQUE INDEX idx_license_keys_user_tier_active
ON license_keys (user_id, tier)
WHERE status = 'active';

COMMENT ON INDEX idx_license_keys_user_tier_active IS
  'Ensures only one active license key per user per tier (SMI-1922). Restored by SMI-4740 rollback.';

-- STEP 4: Restore generate_api_key_for_user with existence-based precheck + ON CONFLICT
-- Verbatim from migration 030 (SMI-1922) lines 65-180.
CREATE OR REPLACE FUNCTION generate_api_key_for_user(
  user_id_input UUID,
  tier_input TEXT DEFAULT 'community'
)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  key_bytes BYTEA;
  key_body TEXT;
  full_key TEXT;
  key_hash_val TEXT;
  key_prefix_val TEXT;
  rate_limit_val INTEGER;
  encryption_key TEXT;
  new_key_id TEXT;
  existing_key_prefix TEXT;
BEGIN
  -- Check if user already has an active key for this tier
  SELECT key_prefix INTO existing_key_prefix
  FROM license_keys
  WHERE user_id = user_id_input
    AND tier = tier_input
    AND status = 'active'
  LIMIT 1;

  -- If active key exists, return NULL (idempotency protection)
  IF existing_key_prefix IS NOT NULL THEN
    RAISE NOTICE 'User % already has active % key: %', user_id_input, tier_input, existing_key_prefix;
    RETURN NULL;
  END IF;

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

  -- Insert the license key with ON CONFLICT protection
  -- If somehow a duplicate slips through (race condition), do nothing
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
  )
  ON CONFLICT (user_id, tier) WHERE status = 'active'
  DO NOTHING
  RETURNING id INTO new_key_id;

  -- If ON CONFLICT triggered (DO NOTHING), no key was created
  IF new_key_id IS NULL THEN
    RAISE NOTICE 'Duplicate key prevented for user % tier %', user_id_input, tier_input;
    RETURN NULL;
  END IF;

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

-- STEP 5: Restore issue_license_key_if_profile_complete comments
-- Verbatim from migration 080 (SMI-4400) lines 471-604.
CREATE OR REPLACE FUNCTION public.issue_license_key_if_profile_complete(
  user_id_input UUID
)
RETURNS TABLE (
  issued_now BOOLEAN,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $function$
DECLARE
  r RECORD;
  issuance_epoch TIMESTAMPTZ;
  did_issue BOOLEAN;
BEGIN
  -- Step 1: auth check. Must run BEFORE any profiles read so we don't
  -- leak presence/absence of a row to unauthorized callers.
  IF auth.uid() IS NULL OR auth.uid() <> user_id_input THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501',
            HINT = 'Caller JWT subject does not match user_id_input.';
  END IF;

  -- Step 2: read profile (read-only, no lock needed). H-5 refactor —
  -- gate check runs BEFORE advisory lock so callers with incomplete
  -- profile get 'profile_incomplete' (corrective) instead of
  -- 'concurrent_call' (retry-hint), avoiding retry amplification under
  -- bot/retry-storm scenarios.
  SELECT p.tier,
         p.profile_completed_at,
         p.email_verified,
         p.first_name,
         p.last_name
    INTO r
    FROM profiles p
   WHERE p.id = user_id_input;

  IF NOT FOUND THEN
    -- Profile row missing — treat as incomplete. handle_new_user should
    -- always have created it; this branch is defensive.
    RETURN QUERY SELECT FALSE, 'profile_incomplete'::TEXT;
    RETURN;
  END IF;

  -- Step 3: gate checks. All four must pass. Wave 2 form + email-confirm
  -- are responsible for setting profile_completed_at and email_verified.
  -- H-3: tier IS NULL guard — migration 011 has no NOT NULL on
  -- profiles.tier, so a future cohort migration could theoretically
  -- leave it blank. generate_api_key_for_user has no NULL-tier guard
  -- either, so a NULL-tier row would violate the partial index scope.
  IF r.profile_completed_at IS NULL
     OR r.email_verified IS NOT TRUE
     OR r.tier IS NULL
     OR r.first_name IS NULL
     OR r.first_name !~ '[A-Za-z]'
     OR r.last_name IS NULL
     OR r.last_name !~ '[A-Za-z]' THEN
    RETURN QUERY SELECT FALSE, 'profile_incomplete'::TEXT;
    RETURN;
  END IF;

  -- Step 4: race guard — gate passed; now serialize issuance + audit.
  -- Acquiring the lock here (not pre-gate) means profile-incomplete
  -- callers never compete for the lock, avoiding retry amplification
  -- where they'd receive 'concurrent_call' (retry-hint) instead of
  -- 'profile_incomplete' (corrective). H-5 (plan-review 2026-04-21).
  -- No re-read of tier needed: tier mutations are Stripe-webhook driven
  -- and rare; r.tier from the gate-read is fresh enough. If the user
  -- upgraded mid-call, step 5 issues for the pre-upgrade tier — benign
  -- (migration 030 idempotency still holds at the new tier separately).
  IF NOT pg_try_advisory_xact_lock(
       hashtext('issue_license:' || user_id_input::TEXT)
     ) THEN
    RETURN QUERY SELECT FALSE, 'concurrent_call'::TEXT;
    RETURN;
  END IF;

  -- Step 5: issuance. Record issuance_epoch BEFORE calling so we can
  -- post-hoc detect whether the call created a new row (issued_now=TRUE)
  -- or short-circuited on the migration 030 precheck / ON CONFLICT
  -- (issued_now=FALSE, reason='already_issued'). generate_api_key_for_user
  -- returns TEXT (the raw key on new issue) or NULL (on duplicate short
  -- circuit); we don't surface the key here (/complete-profile reads
  -- pending_key_display separately).
  issuance_epoch := clock_timestamp();
  PERFORM public.generate_api_key_for_user(user_id_input, r.tier);

  SELECT EXISTS(
    SELECT 1
      FROM license_keys
     WHERE user_id = user_id_input
       AND tier = r.tier
       AND status = 'active'
       AND created_at >= issuance_epoch
  ) INTO did_issue;

  IF NOT did_issue THEN
    -- Migration 030 precheck / partial-index ON CONFLICT short-circuit.
    -- User already has an active key for this tier. Idempotent no-op;
    -- no audit emission (would be duplicate).
    RETURN QUERY SELECT FALSE, 'already_issued'::TEXT;
    RETURN;
  END IF;

  -- Step 6: audit. One row per successful issuance. Advisory lock
  -- guarantees no duplicate emission under concurrent calls.
  INSERT INTO audit_logs (
    event_type, actor, resource, action, result, metadata
  )
  VALUES (
    'auth:profile:completed',
    user_id_input::TEXT,
    'profiles',
    'complete',
    'success',
    jsonb_build_object(
      'tier', r.tier,
      'email_verified', TRUE,
      'issued_key', TRUE
    )
  );

  -- Step 7: return issued_now=TRUE with NULL reason.
  RETURN QUERY SELECT TRUE, NULL::TEXT;
END;
$function$;

-- Authenticated only. Anon cannot complete a profile (no auth.uid()).
GRANT EXECUTE ON FUNCTION public.issue_license_key_if_profile_complete(UUID)
  TO authenticated;

COMMENT ON FUNCTION public.issue_license_key_if_profile_complete(UUID) IS
  'SMI-4400: issues a community (or user-current-tier) license key iff profile gates pass. Idempotent via migration 030 partial index. Advisory lock serializes audit_logs emission. Called by Wave 2 /complete-profile form submit.';

-- STEP 6: Remove schema version
DELETE FROM schema_version WHERE version = 86 AND TRUE;

COMMIT;
