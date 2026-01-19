-- SMI-1597: Pending Checkouts Table
-- Wave 1: Database & Email Foundation
-- Created: 2026-01-18
--
-- Purpose: Store checkout data for users who pay before signing up.
-- When a checkout.session.completed webhook arrives but the user doesn't
-- exist yet, we store the checkout details here. When the user signs up,
-- a trigger processes the pending checkout to create their subscription.

-- ============================================================================
-- PENDING_CHECKOUTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS pending_checkouts (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  email TEXT NOT NULL UNIQUE, -- One pending checkout per email
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  checkout_session_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('individual', 'team', 'enterprise')),
  billing_period TEXT NOT NULL CHECK(billing_period IN ('monthly', 'annual')),
  seat_count INTEGER NOT NULL DEFAULT 1 CHECK(seat_count >= 1 AND seat_count <= 1000),
  metadata JSONB DEFAULT '{}'::JSONB,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'), -- 7-day TTL
  processed_at TIMESTAMPTZ, -- Set when checkout is processed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pending_checkouts IS 'Stores checkout data for users who pay before signing up';
COMMENT ON COLUMN pending_checkouts.email IS 'Customer email from Stripe checkout - unique constraint ensures one pending checkout per email';
COMMENT ON COLUMN pending_checkouts.expires_at IS '7-day TTL - unprocessed checkouts are cleaned up after expiration';
COMMENT ON COLUMN pending_checkouts.processed_at IS 'Set when the pending checkout has been converted to a subscription';

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_pending_checkouts_email ON pending_checkouts(email);
CREATE INDEX IF NOT EXISTS idx_pending_checkouts_expires_at ON pending_checkouts(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_checkouts_stripe_customer ON pending_checkouts(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_pending_checkouts_processed ON pending_checkouts(processed_at) WHERE processed_at IS NULL;

-- ============================================================================
-- CLEANUP FUNCTION - Remove expired pending checkouts
-- ============================================================================
CREATE OR REPLACE FUNCTION cleanup_expired_pending_checkouts()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM pending_checkouts
  WHERE expires_at < NOW()
    AND processed_at IS NULL;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  IF deleted_count > 0 THEN
    RAISE NOTICE 'Cleaned up % expired pending checkouts', deleted_count;
  END IF;

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION cleanup_expired_pending_checkouts() IS 'Removes pending checkouts that have expired (7 days) without being processed';

-- ============================================================================
-- PROCESS PENDING CHECKOUT FUNCTION
-- Called when a new user signs up to check if they have a pending checkout
-- ============================================================================
CREATE OR REPLACE FUNCTION process_pending_checkout(user_email TEXT, user_uuid UUID)
RETURNS BOOLEAN AS $$
DECLARE
  pending RECORD;
BEGIN
  -- Find unprocessed pending checkout for this email
  SELECT *
  INTO pending
  FROM pending_checkouts
  WHERE email = user_email
    AND processed_at IS NULL
    AND expires_at > NOW()
  FOR UPDATE SKIP LOCKED; -- Prevent race conditions

  IF pending IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Create subscription record
  INSERT INTO subscriptions (
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    tier,
    billing_period,
    seat_count,
    status,
    current_period_start,
    current_period_end,
    metadata
  ) VALUES (
    user_uuid,
    pending.stripe_customer_id,
    pending.stripe_subscription_id,
    pending.tier,
    pending.billing_period,
    pending.seat_count,
    'active',
    pending.created_at,
    pending.created_at + CASE
      WHEN pending.billing_period = 'annual' THEN INTERVAL '1 year'
      ELSE INTERVAL '1 month'
    END,
    pending.metadata || jsonb_build_object('from_pending_checkout', true, 'checkout_session_id', pending.checkout_session_id)
  );

  -- Update user's tier
  UPDATE profiles
  SET tier = pending.tier
  WHERE id = user_uuid;

  -- Mark pending checkout as processed
  UPDATE pending_checkouts
  SET processed_at = NOW()
  WHERE id = pending.id;

  RAISE NOTICE 'Processed pending checkout for email % (user_id: %)', user_email, user_uuid;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION process_pending_checkout(TEXT, UUID) IS 'Processes a pending checkout when user signs up, creating their subscription';

-- ============================================================================
-- TRIGGER FUNCTION - Auto-process pending checkout on user signup
-- ============================================================================
CREATE OR REPLACE FUNCTION handle_new_user_pending_checkout()
RETURNS TRIGGER AS $$
BEGIN
  -- Try to process any pending checkout for this user's email
  PERFORM process_pending_checkout(NEW.email, NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger fires after profile is created (which happens after auth.users insert)
DROP TRIGGER IF EXISTS on_profile_created_check_pending ON profiles;
CREATE TRIGGER on_profile_created_check_pending
  AFTER INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION handle_new_user_pending_checkout();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE pending_checkouts ENABLE ROW LEVEL SECURITY;

-- Service role can manage all pending checkouts (for webhooks)
DROP POLICY IF EXISTS "Service role can manage pending checkouts" ON pending_checkouts;
CREATE POLICY "Service role can manage pending checkouts"
  ON pending_checkouts FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Users cannot access pending_checkouts directly (only via functions)

-- ============================================================================
-- SCHEDULED CLEANUP (using pg_cron if available)
-- ============================================================================
-- Note: This requires the pg_cron extension. If not available, run cleanup
-- manually or via a Supabase Edge Function scheduled task.
DO $$
BEGIN
  -- Check if pg_cron is available
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Schedule daily cleanup at 3 AM UTC
    PERFORM cron.schedule(
      'cleanup-pending-checkouts',
      '0 3 * * *',
      'SELECT cleanup_expired_pending_checkouts()'
    );
    RAISE NOTICE 'Scheduled daily cleanup of pending checkouts';
  ELSE
    RAISE NOTICE 'pg_cron not available - run cleanup_expired_pending_checkouts() manually or via scheduled function';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not schedule cleanup: %', SQLERRM;
END $$;

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT EXECUTE ON FUNCTION cleanup_expired_pending_checkouts TO service_role;
GRANT EXECUTE ON FUNCTION process_pending_checkout TO service_role;

-- Update schema version
INSERT INTO schema_version (version) VALUES (12) ON CONFLICT DO NOTHING;
