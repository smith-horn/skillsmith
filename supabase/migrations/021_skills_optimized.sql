-- Migration: 021_skills_optimized.sql
-- Issue: SMI-1788 (Skillsmith Optimization Layer)
-- Description: Add table for caching optimized skill versions with TTL-based
--              expiry, version tracking, and popularity signals for the hybrid
--              optimization approach.
-- Created: 2026-01-24

-- ============================================================================
-- Step 1: Create skills_optimized table for caching transformed skills
-- ============================================================================
-- This table stores optimized versions of skills that have been processed
-- through the Skillsmith Optimization Layer (analyze -> decompose -> subagent)

CREATE TABLE IF NOT EXISTS skills_optimized (
  -- Primary key matches the original skill ID
  skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,

  -- Original skill content hash for cache invalidation
  -- When original skill content changes, we need to re-transform
  content_hash TEXT NOT NULL,

  -- Optimized main SKILL.md content
  main_skill_content TEXT NOT NULL,

  -- Sub-skills as JSONB array [{filename, content}]
  sub_skills JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- Companion subagent definition (if generated)
  subagent_content TEXT,

  -- CLAUDE.md integration snippet
  claude_md_snippet TEXT,

  -- Transformation statistics as JSONB
  -- {originalLines, optimizedLines, subSkillCount, tokenReductionPercent, ...}
  stats JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- Transformation version for cache invalidation when algorithm changes
  transform_version TEXT NOT NULL DEFAULT '1.0.0',

  -- Popularity tier for TTL management
  -- 'hot': >100 installs, 7-day TTL
  -- 'warm': 10-100 installs, 24-hour TTL
  -- 'cold': <10 installs, 1-hour TTL
  popularity_tier TEXT NOT NULL DEFAULT 'cold' CHECK (popularity_tier IN ('hot', 'warm', 'cold')),

  -- Estimated install count (from API logs or GitHub stats)
  install_count INTEGER NOT NULL DEFAULT 0,

  -- Cache expiry timestamp (NULL = no expiry for hot tier)
  expires_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE skills_optimized IS 'Cache for optimized skill versions from Skillsmith Optimization Layer';
COMMENT ON COLUMN skills_optimized.skill_id IS 'References the original skill in skills table';
COMMENT ON COLUMN skills_optimized.content_hash IS 'Hash of original skill content for cache invalidation';
COMMENT ON COLUMN skills_optimized.main_skill_content IS 'Optimized SKILL.md content (<500 lines)';
COMMENT ON COLUMN skills_optimized.sub_skills IS 'Array of extracted sub-skills [{filename, content}]';
COMMENT ON COLUMN skills_optimized.subagent_content IS 'Generated companion subagent definition';
COMMENT ON COLUMN skills_optimized.claude_md_snippet IS 'CLAUDE.md integration snippet for user';
COMMENT ON COLUMN skills_optimized.stats IS 'Transformation statistics (lines, savings, etc.)';
COMMENT ON COLUMN skills_optimized.transform_version IS 'Algorithm version for cache invalidation';
COMMENT ON COLUMN skills_optimized.popularity_tier IS 'Tier for TTL management (hot/warm/cold)';
COMMENT ON COLUMN skills_optimized.install_count IS 'Estimated install count for popularity';
COMMENT ON COLUMN skills_optimized.expires_at IS 'Cache expiry timestamp (NULL = no expiry)';

-- ============================================================================
-- Step 2: Create indexes for efficient queries
-- ============================================================================

-- Index for finding expired cache entries
CREATE INDEX IF NOT EXISTS idx_skills_optimized_expires
ON skills_optimized(expires_at)
WHERE expires_at IS NOT NULL;

-- Index for popularity tier queries
CREATE INDEX IF NOT EXISTS idx_skills_optimized_tier
ON skills_optimized(popularity_tier);

-- Index for version-based cache invalidation
CREATE INDEX IF NOT EXISTS idx_skills_optimized_version
ON skills_optimized(transform_version);

-- Index for install count (for popularity promotion)
CREATE INDEX IF NOT EXISTS idx_skills_optimized_installs
ON skills_optimized(install_count DESC);

-- ============================================================================
-- Step 3: Create trigger for updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_skills_optimized_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS skills_optimized_updated_at ON skills_optimized;
CREATE TRIGGER skills_optimized_updated_at
  BEFORE UPDATE ON skills_optimized
  FOR EACH ROW
  EXECUTE FUNCTION update_skills_optimized_timestamp();

-- ============================================================================
-- Step 4: Create function to get optimized skill with cache check
-- ============================================================================

CREATE OR REPLACE FUNCTION get_optimized_skill(p_skill_id TEXT, p_transform_version TEXT DEFAULT '1.0.0')
RETURNS TABLE (
  skill_id TEXT,
  main_skill_content TEXT,
  sub_skills JSONB,
  subagent_content TEXT,
  claude_md_snippet TEXT,
  stats JSONB,
  is_cached BOOLEAN,
  is_expired BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    so.skill_id,
    so.main_skill_content,
    so.sub_skills,
    so.subagent_content,
    so.claude_md_snippet,
    so.stats,
    TRUE AS is_cached,
    (so.expires_at IS NOT NULL AND so.expires_at < NOW()) AS is_expired
  FROM skills_optimized so
  WHERE so.skill_id = p_skill_id
    AND so.transform_version = p_transform_version
    AND (so.expires_at IS NULL OR so.expires_at > NOW());
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION get_optimized_skill IS 'Get cached optimized skill if not expired and version matches. Note: Content hash validation is performed at application layer.';

-- ============================================================================
-- Step 5: Create function to upsert optimized skill
-- ============================================================================

CREATE OR REPLACE FUNCTION upsert_optimized_skill(
  p_skill_id TEXT,
  p_content_hash TEXT,
  p_main_skill_content TEXT,
  p_sub_skills JSONB DEFAULT '[]'::JSONB,
  p_subagent_content TEXT DEFAULT NULL,
  p_claude_md_snippet TEXT DEFAULT NULL,
  p_stats JSONB DEFAULT '{}'::JSONB,
  p_transform_version TEXT DEFAULT '1.0.0',
  p_popularity_tier TEXT DEFAULT 'cold',
  p_install_count INTEGER DEFAULT 0
)
RETURNS skills_optimized AS $$
DECLARE
  v_expires_at TIMESTAMPTZ;
  v_result skills_optimized;
BEGIN
  -- Calculate expires_at based on popularity tier
  v_expires_at := CASE p_popularity_tier
    WHEN 'hot' THEN NOW() + INTERVAL '7 days'
    WHEN 'warm' THEN NOW() + INTERVAL '24 hours'
    WHEN 'cold' THEN NOW() + INTERVAL '1 hour'
    ELSE NOW() + INTERVAL '1 hour'
  END;

  INSERT INTO skills_optimized (
    skill_id,
    content_hash,
    main_skill_content,
    sub_skills,
    subagent_content,
    claude_md_snippet,
    stats,
    transform_version,
    popularity_tier,
    install_count,
    expires_at
  ) VALUES (
    p_skill_id,
    p_content_hash,
    p_main_skill_content,
    p_sub_skills,
    p_subagent_content,
    p_claude_md_snippet,
    p_stats,
    p_transform_version,
    p_popularity_tier,
    p_install_count,
    v_expires_at
  )
  ON CONFLICT (skill_id) DO UPDATE SET
    content_hash = EXCLUDED.content_hash,
    main_skill_content = EXCLUDED.main_skill_content,
    sub_skills = EXCLUDED.sub_skills,
    subagent_content = EXCLUDED.subagent_content,
    claude_md_snippet = EXCLUDED.claude_md_snippet,
    stats = EXCLUDED.stats,
    transform_version = EXCLUDED.transform_version,
    popularity_tier = EXCLUDED.popularity_tier,
    install_count = EXCLUDED.install_count,
    expires_at = v_expires_at
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION upsert_optimized_skill IS 'Insert or update optimized skill cache entry with automatic TTL calculation';

-- ============================================================================
-- Step 6: Create function to clean up expired cache entries
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_expired_optimized_skills()
RETURNS INTEGER AS $$
DECLARE
  v_deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM skills_optimized
    WHERE expires_at IS NOT NULL AND expires_at < NOW()
    RETURNING *
  )
  SELECT COUNT(*) INTO v_deleted_count FROM deleted;

  RETURN v_deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_expired_optimized_skills IS 'Remove expired cache entries (run periodically via cron)';

-- ============================================================================
-- Step 7: Create function to update popularity tier based on install count
-- ============================================================================

CREATE OR REPLACE FUNCTION update_skill_popularity(p_skill_id TEXT, p_install_count INTEGER)
RETURNS TEXT AS $$
DECLARE
  v_new_tier TEXT;
  v_new_expires TIMESTAMPTZ;
BEGIN
  -- Determine tier based on install count
  v_new_tier := CASE
    WHEN p_install_count > 100 THEN 'hot'
    WHEN p_install_count > 10 THEN 'warm'
    ELSE 'cold'
  END;

  -- Calculate new expiry
  v_new_expires := CASE v_new_tier
    WHEN 'hot' THEN NOW() + INTERVAL '7 days'
    WHEN 'warm' THEN NOW() + INTERVAL '24 hours'
    ELSE NOW() + INTERVAL '1 hour'
  END;

  -- Update the skill
  UPDATE skills_optimized
  SET
    install_count = p_install_count,
    popularity_tier = v_new_tier,
    expires_at = v_new_expires
  WHERE skill_id = p_skill_id;

  RETURN v_new_tier;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_skill_popularity IS 'Update skill popularity tier based on install count';

-- ============================================================================
-- Step 8: Create view for optimization statistics
-- ============================================================================

CREATE OR REPLACE VIEW v_optimization_stats AS
SELECT
  popularity_tier,
  COUNT(*) AS skill_count,
  AVG((stats->>'tokenReductionPercent')::NUMERIC) AS avg_token_reduction,
  AVG((stats->>'originalLines')::NUMERIC) AS avg_original_lines,
  AVG((stats->>'optimizedLines')::NUMERIC) AS avg_optimized_lines,
  SUM(CASE WHEN sub_skills::TEXT != '[]' THEN 1 ELSE 0 END) AS decomposed_count,
  SUM(CASE WHEN subagent_content IS NOT NULL THEN 1 ELSE 0 END) AS subagent_count
FROM skills_optimized
GROUP BY popularity_tier;

COMMENT ON VIEW v_optimization_stats IS 'Aggregated statistics about skill optimizations by tier';

-- ============================================================================
-- Step 9: Set up Row Level Security
-- ============================================================================

ALTER TABLE skills_optimized ENABLE ROW LEVEL SECURITY;

-- Public read access (optimized skills are public like original skills)
DROP POLICY IF EXISTS skills_optimized_select ON skills_optimized;
CREATE POLICY skills_optimized_select ON skills_optimized
  FOR SELECT USING (TRUE);

-- Service role can do everything
DROP POLICY IF EXISTS skills_optimized_service ON skills_optimized;
CREATE POLICY skills_optimized_service ON skills_optimized
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ============================================================================
-- Step 10: Grant permissions
-- ============================================================================

GRANT SELECT ON skills_optimized TO anon, authenticated;
GRANT ALL ON skills_optimized TO service_role;
GRANT SELECT ON v_optimization_stats TO anon, authenticated;

GRANT EXECUTE ON FUNCTION get_optimized_skill(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION upsert_optimized_skill(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_expired_optimized_skills() TO service_role;
GRANT EXECUTE ON FUNCTION update_skill_popularity(TEXT, INTEGER) TO service_role;

-- ============================================================================
-- Verification queries (can be run manually to test)
-- ============================================================================
-- After applying this migration, the following should work:
--
-- Insert test optimized skill:
-- SELECT upsert_optimized_skill(
--   'test/skill',
--   'abc123',
--   '# Test Skill\n\nOptimized content here.',
--   '[{"filename": "api.md", "content": "# API Reference"}]'::JSONB,
--   '---\nname: test-specialist\n---',
--   '### Subagent: test',
--   '{"tokenReductionPercent": 45}'::JSONB
-- );
--
-- Get optimized skill:
-- SELECT * FROM get_optimized_skill('test/skill');
--
-- View stats:
-- SELECT * FROM v_optimization_stats;
