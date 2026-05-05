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
-- Copy verbatim from migration 030 lines 65-180.

-- STEP 5: Restore issue_license_key_if_profile_complete comments
-- Copy verbatim from migration 080 lines 471-605.

-- STEP 6: Remove schema version
DELETE FROM schema_version WHERE version = 86 AND TRUE;

COMMIT;
