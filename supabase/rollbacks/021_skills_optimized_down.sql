-- Rollback migration: 021_skills_optimized_down.sql
-- Issue: SMI-1788 (Skillsmith Optimization Layer)
-- Description: Rollback script to remove optimization layer tables and functions
-- Created: 2026-01-24

-- ============================================================================
-- Step 1: Revoke permissions
-- ============================================================================

REVOKE EXECUTE ON FUNCTION update_skill_popularity(TEXT, INTEGER) FROM service_role;
REVOKE EXECUTE ON FUNCTION cleanup_expired_optimized_skills() FROM service_role;
REVOKE EXECUTE ON FUNCTION upsert_optimized_skill(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT, TEXT, INTEGER) FROM service_role;
REVOKE EXECUTE ON FUNCTION get_optimized_skill(TEXT, TEXT) FROM anon, authenticated;

REVOKE SELECT ON v_optimization_stats FROM anon, authenticated;
REVOKE ALL ON skills_optimized FROM service_role;
REVOKE SELECT ON skills_optimized FROM anon, authenticated;

-- ============================================================================
-- Step 2: Drop RLS policies
-- ============================================================================

DROP POLICY IF EXISTS skills_optimized_service ON skills_optimized;
DROP POLICY IF EXISTS skills_optimized_select ON skills_optimized;

-- ============================================================================
-- Step 3: Drop view
-- ============================================================================

DROP VIEW IF EXISTS v_optimization_stats;

-- ============================================================================
-- Step 4: Drop functions
-- ============================================================================

DROP FUNCTION IF EXISTS update_skill_popularity(TEXT, INTEGER);
DROP FUNCTION IF EXISTS cleanup_expired_optimized_skills();
DROP FUNCTION IF EXISTS upsert_optimized_skill(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS get_optimized_skill(TEXT, TEXT);
DROP FUNCTION IF EXISTS update_skills_optimized_timestamp();

-- ============================================================================
-- Step 5: Drop trigger
-- ============================================================================

DROP TRIGGER IF EXISTS skills_optimized_updated_at ON skills_optimized;

-- ============================================================================
-- Step 6: Drop indexes
-- ============================================================================

DROP INDEX IF EXISTS idx_skills_optimized_installs;
DROP INDEX IF EXISTS idx_skills_optimized_version;
DROP INDEX IF EXISTS idx_skills_optimized_tier;
DROP INDEX IF EXISTS idx_skills_optimized_expires;

-- ============================================================================
-- Step 7: Drop table
-- ============================================================================

DROP TABLE IF EXISTS skills_optimized;

-- ============================================================================
-- Verification
-- ============================================================================
-- After running this rollback:
-- 1. skills_optimized table should not exist
-- 2. All related functions should be dropped
-- 3. v_optimization_stats view should not exist
