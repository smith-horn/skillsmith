-- SMI-1271: Performance indexes for new RPC functions
-- Created: 2026-01-08

-- ============================================================================
-- INDEX VERIFICATION
-- ============================================================================
-- The following indexes already exist from 001_initial_schema.sql and support
-- the search_skills_v2 RPC function:
--   - idx_skills_trust_tier ON skills(trust_tier)
--   - idx_skills_quality_score ON skills(quality_score)
--   - idx_skills_author ON skills(author)
--   - idx_skills_name ON skills(name)

-- ============================================================================
-- NEW INDEXES FOR RPC FUNCTIONS
-- ============================================================================

-- Index for case-insensitive name lookup in get_skill_by_identifier
-- Enables efficient: WHERE lower(name) = lower($1)
CREATE INDEX IF NOT EXISTS idx_skills_name_lower ON skills(lower(name));

-- Composite index for author/name lookup pattern in get_skill_by_identifier
-- Enables efficient: WHERE author = $1 AND name = $2
-- Note: idx_skills_author exists but composite index is more efficient for this pattern
CREATE INDEX IF NOT EXISTS idx_skills_author_name ON skills(author, name);

-- ============================================================================
-- PERFORMANCE NOTES
-- ============================================================================
-- get_skill_by_identifier uses these patterns:
--   1. Direct UUID lookup: WHERE id = $1 (uses PRIMARY KEY)
--   2. Author/name lookup: WHERE author = $1 AND name = $2 (uses idx_skills_author_name)
--   3. Case-insensitive name: WHERE lower(name) = lower($1) (uses idx_skills_name_lower)
--
-- search_skills_v2 uses these patterns:
--   - Full-text search: search_vector @@ query (uses idx_skills_search GIN)
--   - Trust tier filter: WHERE trust_tier = $1 (uses idx_skills_trust_tier)
--   - Min score filter: WHERE quality_score >= $1 (uses idx_skills_quality_score)
--   - Category filter: JOIN skill_categories (uses PRIMARY KEY)
