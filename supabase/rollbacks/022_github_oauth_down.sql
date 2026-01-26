-- Rollback migration for 022_github_oauth.sql
-- SMI-1833: Manual rollback for GitHub OAuth changes
-- Created: 2026-01-25
--
-- ============================================================================
-- IMPORTANT: Supabase does not auto-run down migrations.
-- Run this manually if you need to rollback:
--
--   psql $DATABASE_URL -f supabase/migrations/022_github_oauth_down.sql
--
-- Or via Supabase CLI:
--   supabase db execute --file supabase/migrations/022_github_oauth_down.sql
--
-- ============================================================================
-- WARNING: This will DELETE all GitHub-related profile data!
-- - github_username values will be lost
-- - github_id values will be lost
-- - auth_provider values will be lost
--
-- Ensure you have a backup before running this migration.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. DROP TRIGGER FIRST (depends on sync_github_profile function)
-- ============================================================================
DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;

-- ============================================================================
-- 2. DROP SYNC FUNCTION (depends on profiles columns)
-- ============================================================================
DROP FUNCTION IF EXISTS sync_github_profile() CASCADE;

-- ============================================================================
-- 3. RESTORE ORIGINAL handle_new_user FUNCTION
-- This reverts to the version from 011_users_subscriptions.sql
-- ============================================================================
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

-- ============================================================================
-- 4. DROP INDEXES (before dropping columns)
-- ============================================================================
DROP INDEX IF EXISTS idx_profiles_github_id;
DROP INDEX IF EXISTS idx_profiles_github_username;
DROP INDEX IF EXISTS idx_profiles_auth_provider;

-- ============================================================================
-- 5. REMOVE GITHUB-RELATED COLUMNS FROM PROFILES TABLE
-- Note: This will automatically remove column comments
-- ============================================================================
ALTER TABLE profiles
  DROP COLUMN IF EXISTS github_username,
  DROP COLUMN IF EXISTS github_id,
  DROP COLUMN IF EXISTS auth_provider;

-- ============================================================================
-- 6. REMOVE SCHEMA VERSION ENTRY
-- ============================================================================
DELETE FROM schema_version WHERE version = 22;

COMMIT;

-- ============================================================================
-- POST-ROLLBACK VERIFICATION
-- Run these queries to verify rollback was successful:
--
-- Check columns are removed:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'profiles' AND column_name IN ('github_username', 'github_id', 'auth_provider');
--   -- Should return 0 rows
--
-- Check indexes are removed:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'profiles' AND indexname LIKE '%github%';
--   -- Should return 0 rows
--
-- Check function is reverted:
--   SELECT prosrc FROM pg_proc WHERE proname = 'handle_new_user';
--   -- Should NOT contain 'github_username' or 'auth_provider'
--
-- Check sync function is removed:
--   SELECT 1 FROM pg_proc WHERE proname = 'sync_github_profile';
--   -- Should return 0 rows
--
-- Check trigger is removed:
--   SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_updated';
--   -- Should return 0 rows
-- ============================================================================
