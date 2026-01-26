-- SMI-1715: GitHub OAuth Authentication
-- Adds GitHub-specific fields to profiles and updates the handle_new_user function
-- Created: 2026-01-25

-- ============================================================================
-- ADD GITHUB-SPECIFIC COLUMNS TO PROFILES TABLE
-- ============================================================================

-- Add github_username column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'github_username'
  ) THEN
    ALTER TABLE profiles ADD COLUMN github_username TEXT;
  END IF;
END $$;

-- Add github_id column if it doesn't exist (for reliable identity)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'github_id'
  ) THEN
    ALTER TABLE profiles ADD COLUMN github_id TEXT;
  END IF;
END $$;

-- Add auth_provider column to track how user signed up
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'auth_provider'
  ) THEN
    ALTER TABLE profiles ADD COLUMN auth_provider TEXT DEFAULT 'email' CHECK(auth_provider IN ('email', 'github', 'google'));
  END IF;
END $$;

-- Add comments
COMMENT ON COLUMN profiles.github_username IS 'GitHub username from OAuth';
COMMENT ON COLUMN profiles.github_id IS 'GitHub user ID from OAuth (stable identifier)';
COMMENT ON COLUMN profiles.auth_provider IS 'How the user signed up: email, github, or google';

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_profiles_github_id ON profiles(github_id) WHERE github_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_github_username ON profiles(github_username) WHERE github_username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_auth_provider ON profiles(auth_provider);

-- ============================================================================
-- UPDATED HANDLE_NEW_USER FUNCTION
-- ============================================================================

-- Update the handle_new_user function to handle GitHub OAuth metadata
-- IMPORTANT: SET search_path = public is required for trigger to work on auth.users
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  provider TEXT;
  github_username_val TEXT;
  github_id_val TEXT;
  full_name_val TEXT;
  avatar_url_val TEXT;
BEGIN
  -- Determine auth provider and extract metadata
  provider := COALESCE(NEW.raw_app_meta_data->>'provider', 'email');

  IF provider = 'github' THEN
    -- Extract GitHub-specific metadata
    github_username_val := COALESCE(
      NEW.raw_user_meta_data->>'user_name',
      NEW.raw_user_meta_data->>'preferred_username'
    );
    github_id_val := NEW.raw_user_meta_data->>'provider_id';
    full_name_val := COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      github_username_val,
      ''
    );
    avatar_url_val := NEW.raw_user_meta_data->>'avatar_url';
  ELSE
    -- Email or other provider
    github_username_val := NULL;
    github_id_val := NULL;
    full_name_val := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
    avatar_url_val := NEW.raw_user_meta_data->>'avatar_url';
  END IF;

  INSERT INTO profiles (
    id,
    email,
    full_name,
    avatar_url,
    github_username,
    github_id,
    auth_provider,
    tier,
    role,
    email_verified,
    email_verified_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    full_name_val,
    avatar_url_val,
    github_username_val,
    github_id_val,
    provider,
    'community',
    'user',
    -- GitHub users are pre-verified
    CASE WHEN provider = 'github' THEN TRUE ELSE FALSE END,
    CASE WHEN provider = 'github' THEN NOW() ELSE NULL END
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION TO SYNC GITHUB PROFILE ON LOGIN
-- ============================================================================

-- Function to update GitHub profile data on subsequent logins
CREATE OR REPLACE FUNCTION sync_github_profile()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  provider TEXT;
BEGIN
  provider := COALESCE(NEW.raw_app_meta_data->>'provider', 'email');

  IF provider = 'github' THEN
    UPDATE profiles SET
      avatar_url = COALESCE(NEW.raw_user_meta_data->>'avatar_url', avatar_url),
      full_name = COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name',
        full_name
      ),
      github_username = COALESCE(
        NEW.raw_user_meta_data->>'user_name',
        NEW.raw_user_meta_data->>'preferred_username',
        github_username
      ),
      updated_at = NOW()
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to sync profile on user update (login refreshes metadata)
DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW
  WHEN (OLD.raw_user_meta_data IS DISTINCT FROM NEW.raw_user_meta_data)
  EXECUTE FUNCTION sync_github_profile();

-- Update schema version
INSERT INTO schema_version (version) VALUES (22) ON CONFLICT DO NOTHING;
