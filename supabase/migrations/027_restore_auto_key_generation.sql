-- SMI-1906: Restore auto-generate API key on signup
-- Migration 022 (GitHub OAuth) accidentally removed the key generation from handle_new_user()
-- This migration restores that functionality
-- Created: 2026-01-28

-- ============================================================================
-- UPDATED HANDLE_NEW_USER FUNCTION (with API key generation restored)
-- ============================================================================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public, extensions
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

  -- Insert profile
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

  -- Auto-generate API key for new user (restored from migration 014)
  -- This creates both the license_key and pending_key_display records
  PERFORM generate_api_key_for_user(NEW.id, 'community');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- BACKFILL: Generate keys for existing users without one
-- ============================================================================

DO $$
DECLARE
  user_record RECORD;
BEGIN
  -- Find users without any license keys
  FOR user_record IN
    SELECT p.id, p.tier
    FROM profiles p
    LEFT JOIN license_keys lk ON lk.user_id = p.id
    WHERE lk.id IS NULL
  LOOP
    -- Generate a key for this user (creates both license_key and pending_key_display)
    PERFORM generate_api_key_for_user(user_record.id, COALESCE(user_record.tier, 'community'));
    RAISE NOTICE 'Generated key for user %', user_record.id;
  END LOOP;
END;
$$;

-- Update schema version
INSERT INTO schema_version (version) VALUES (27) ON CONFLICT DO NOTHING;
