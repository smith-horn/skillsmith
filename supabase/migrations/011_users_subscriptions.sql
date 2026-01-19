-- SMI-1178: Users, Subscriptions, and License Keys Tables
-- Wave 3: Database & Auth Foundation
-- Created: 2026-01-18

-- ============================================================================
-- PROFILES TABLE - Extended user information (links to Supabase Auth)
-- ============================================================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  company TEXT,
  avatar_url TEXT,
  tier TEXT NOT NULL DEFAULT 'community' CHECK(tier IN ('community', 'individual', 'team', 'enterprise')),
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin', 'team_admin', 'super_admin')),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE profiles IS 'Extended user profiles linked to Supabase Auth users';
COMMENT ON COLUMN profiles.tier IS 'Subscription tier: community (free), individual, team, enterprise';
COMMENT ON COLUMN profiles.role IS 'User role for access control';

-- ============================================================================
-- SUBSCRIPTIONS TABLE - Active subscription tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  tier TEXT NOT NULL CHECK(tier IN ('individual', 'team', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'canceled', 'past_due', 'paused', 'trialing', 'incomplete')),
  billing_period TEXT NOT NULL CHECK(billing_period IN ('monthly', 'annual')),
  seat_count INTEGER NOT NULL DEFAULT 1 CHECK(seat_count >= 1 AND seat_count <= 1000),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at TIMESTAMPTZ,
  trial_start TIMESTAMPTZ,
  trial_end TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE subscriptions IS 'Tracks active user subscriptions synced with Stripe';
COMMENT ON COLUMN subscriptions.stripe_subscription_id IS 'Stripe subscription ID for webhook matching';

-- ============================================================================
-- LICENSE_KEYS TABLE - License keys for CLI/MCP authentication
-- ============================================================================
CREATE TABLE IF NOT EXISTS license_keys (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL, -- First 8 chars for display (e.g., "sk_live_a1b2...")
  name TEXT DEFAULT 'Default Key',
  tier TEXT NOT NULL CHECK(tier IN ('community', 'individual', 'team', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked', 'expired')),
  last_used_at TIMESTAMPTZ,
  usage_count INTEGER NOT NULL DEFAULT 0,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE license_keys IS 'License keys for authenticating CLI/MCP server requests';
COMMENT ON COLUMN license_keys.key_hash IS 'SHA-256 hash of the full license key';
COMMENT ON COLUMN license_keys.key_prefix IS 'Display prefix for user identification';

-- ============================================================================
-- TEAMS TABLE - Team/organization management
-- ============================================================================
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  max_members INTEGER NOT NULL DEFAULT 5,
  settings JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE teams IS 'Team/organization for group subscriptions';

-- ============================================================================
-- TEAM_MEMBERS TABLE - Junction table for team membership
-- ============================================================================
CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
  invited_by UUID REFERENCES profiles(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at TIMESTAMPTZ,
  UNIQUE(team_id, user_id)
);

COMMENT ON TABLE team_members IS 'Team membership and roles';

-- ============================================================================
-- EMAIL_VERIFICATIONS TABLE - Track email verification tokens
-- ============================================================================
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE email_verifications IS 'Email verification tokens';

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Profiles indexes
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_tier ON profiles(tier);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

-- Subscriptions indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_subscription ON subscriptions(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tier ON subscriptions(tier);
CREATE INDEX IF NOT EXISTS idx_subscriptions_period_end ON subscriptions(current_period_end);

-- License keys indexes
CREATE INDEX IF NOT EXISTS idx_license_keys_user_id ON license_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_license_keys_subscription ON license_keys(subscription_id);
CREATE INDEX IF NOT EXISTS idx_license_keys_key_hash ON license_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_license_keys_status ON license_keys(status);
CREATE INDEX IF NOT EXISTS idx_license_keys_tier ON license_keys(tier);

-- Teams indexes
CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_id);
CREATE INDEX IF NOT EXISTS idx_teams_slug ON teams(slug);
CREATE INDEX IF NOT EXISTS idx_teams_subscription ON teams(subscription_id);

-- Team members indexes
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- Email verifications indexes
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications(token_hash);
CREATE INDEX IF NOT EXISTS idx_email_verifications_expires ON email_verifications(expires_at);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-update updated_at for profiles
DROP TRIGGER IF EXISTS trigger_profiles_updated_at ON profiles;
CREATE TRIGGER trigger_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at for subscriptions
DROP TRIGGER IF EXISTS trigger_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trigger_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at for teams
DROP TRIGGER IF EXISTS trigger_teams_updated_at ON teams;
CREATE TRIGGER trigger_teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to create profile on user signup (triggered by auth.users insert)
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, tier, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    'community',
    'user'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to auto-create profile on user signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Function to get user's current subscription
CREATE OR REPLACE FUNCTION get_user_subscription(user_uuid UUID)
RETURNS TABLE (
  subscription_id TEXT,
  tier TEXT,
  status TEXT,
  billing_period TEXT,
  seat_count INTEGER,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.tier,
    s.status,
    s.billing_period,
    s.seat_count,
    s.current_period_end,
    s.cancel_at_period_end
  FROM subscriptions s
  WHERE s.user_id = user_uuid
    AND s.status IN ('active', 'trialing', 'past_due')
  ORDER BY s.created_at DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Function to validate a license key
CREATE OR REPLACE FUNCTION validate_license_key(key_hash_input TEXT)
RETURNS TABLE (
  is_valid BOOLEAN,
  user_id UUID,
  tier TEXT,
  rate_limit INTEGER
) AS $$
DECLARE
  key_record RECORD;
BEGIN
  SELECT lk.user_id, lk.tier, lk.rate_limit_per_minute, lk.status, lk.expires_at
  INTO key_record
  FROM license_keys lk
  WHERE lk.key_hash = key_hash_input
    AND lk.status = 'active'
    AND (lk.expires_at IS NULL OR lk.expires_at > NOW());

  IF key_record IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, NULL::INTEGER;
  ELSE
    -- Update last used
    UPDATE license_keys SET
      last_used_at = NOW(),
      usage_count = usage_count + 1
    WHERE key_hash = key_hash_input;

    RETURN QUERY SELECT TRUE, key_record.user_id, key_record.tier, key_record.rate_limit_per_minute;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute on functions
GRANT EXECUTE ON FUNCTION get_user_subscription TO authenticated;
GRANT EXECUTE ON FUNCTION validate_license_key TO anon, authenticated;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all new tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;

-- Profiles: Users can read/update their own profile
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Subscriptions: Users can view their own subscriptions
DROP POLICY IF EXISTS "Users can view own subscriptions" ON subscriptions;
CREATE POLICY "Users can view own subscriptions"
  ON subscriptions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- License keys: Users can manage their own keys
DROP POLICY IF EXISTS "Users can view own license keys" ON license_keys;
CREATE POLICY "Users can view own license keys"
  ON license_keys FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own license keys" ON license_keys;
CREATE POLICY "Users can insert own license keys"
  ON license_keys FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own license keys" ON license_keys;
CREATE POLICY "Users can update own license keys"
  ON license_keys FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Teams: Team members can view their teams
DROP POLICY IF EXISTS "Team members can view teams" ON teams;
CREATE POLICY "Team members can view teams"
  ON teams FOR SELECT
  TO authenticated
  USING (
    owner_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = teams.id AND tm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Team owners can update teams" ON teams;
CREATE POLICY "Team owners can update teams"
  ON teams FOR UPDATE
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "Users can create teams" ON teams;
CREATE POLICY "Users can create teams"
  ON teams FOR INSERT
  TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- Team members: View membership
DROP POLICY IF EXISTS "Team members can view membership" ON team_members;
CREATE POLICY "Team members can view membership"
  ON team_members FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_members.team_id AND t.owner_id = auth.uid()
    )
  );

-- Email verifications: Users can view their own
DROP POLICY IF EXISTS "Users can view own verifications" ON email_verifications;
CREATE POLICY "Users can view own verifications"
  ON email_verifications FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================================
-- SERVICE ROLE POLICIES (for Supabase functions/webhooks)
-- ============================================================================

-- Allow service role full access to subscriptions (for Stripe webhooks)
DROP POLICY IF EXISTS "Service role can manage subscriptions" ON subscriptions;
CREATE POLICY "Service role can manage subscriptions"
  ON subscriptions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Allow service role full access to license keys (for generation after payment)
DROP POLICY IF EXISTS "Service role can manage license keys" ON license_keys;
CREATE POLICY "Service role can manage license keys"
  ON license_keys FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Allow service role to manage profiles (for webhook updates)
DROP POLICY IF EXISTS "Service role can manage profiles" ON profiles;
CREATE POLICY "Service role can manage profiles"
  ON profiles FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Allow service role to manage email verifications
DROP POLICY IF EXISTS "Service role can manage email verifications" ON email_verifications;
CREATE POLICY "Service role can manage email verifications"
  ON email_verifications FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Update schema version
INSERT INTO schema_version (version) VALUES (11) ON CONFLICT DO NOTHING;
