-- Migration: 020_search_vector_include_tags.sql
-- Issue: SMI-1757
-- Description: Add tags to search_vector so searching "Lenny" finds skills with
--              "lenny-podcast" tag. Also updates search functions for hybrid search.
-- Created: 2026-01-23

-- ============================================================================
-- Step 1: Create IMMUTABLE helper function to convert JSONB tags to searchable text
-- ============================================================================
-- This function converts ["lenny-podcast", "product-management"] to
-- "lenny-podcast product-management" which can be included in tsvector
CREATE OR REPLACE FUNCTION tags_to_text(tags JSONB)
RETURNS TEXT AS $$
  -- Remove brackets, quotes, and commas; replace with spaces for tokenization
  -- Input: ["lenny-podcast", "product-management"]
  -- Output: lenny-podcast product-management
  SELECT COALESCE(
    regexp_replace(
      regexp_replace(tags::TEXT, '[\[\]"]', '', 'g'),  -- Remove brackets and quotes
      ',', ' ', 'g'                                      -- Replace commas with spaces
    ),
    ''
  );
$$ LANGUAGE SQL IMMUTABLE STRICT;

COMMENT ON FUNCTION tags_to_text IS 'Convert JSONB tags array to space-separated text for full-text search';

-- ============================================================================
-- Step 2: Drop the existing search_vector generated column
-- ============================================================================
-- PostgreSQL doesn't allow altering generated column expressions,
-- so we must drop and recreate
ALTER TABLE skills DROP COLUMN IF EXISTS search_vector;

-- ============================================================================
-- Step 3: Recreate search_vector with tags included
-- ============================================================================
-- Tags get weight 'C' (same as author) - they're important but not primary
ALTER TABLE skills ADD COLUMN search_vector TSVECTOR GENERATED ALWAYS AS (
  setweight(to_tsvector('english', COALESCE(name, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(description, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(author, '')), 'C') ||
  setweight(to_tsvector('english', tags_to_text(COALESCE(tags, '[]'::JSONB))), 'C')
) STORED;

COMMENT ON COLUMN skills.search_vector IS 'Auto-generated tsvector for full-text search (includes name, description, author, tags)';

-- ============================================================================
-- Step 4: Recreate the GIN index on search_vector
-- ============================================================================
DROP INDEX IF EXISTS idx_skills_search;
CREATE INDEX idx_skills_search ON skills USING GIN(search_vector);

-- ============================================================================
-- Step 5: Update search_skills function to use new vector
-- ============================================================================
-- The existing function already uses search_vector, so it automatically benefits.
-- But we'll recreate it to add a fallback for partial tag matches using ILIKE.
CREATE OR REPLACE FUNCTION search_skills(
  search_query TEXT,
  limit_count INTEGER DEFAULT 20,
  offset_count INTEGER DEFAULT 0
)
RETURNS TABLE (
  id TEXT,
  name TEXT,
  description TEXT,
  author TEXT,
  repo_url TEXT,
  quality_score NUMERIC,
  trust_tier TEXT,
  tags JSONB,
  stars INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.description,
    s.author,
    s.repo_url,
    s.quality_score,
    s.trust_tier,
    s.tags,
    s.stars,
    s.created_at,
    s.updated_at,
    COALESCE(
      ts_rank(s.search_vector, websearch_to_tsquery('english', search_query)),
      0.1  -- Give a base rank for tag ILIKE matches
    ) AS rank
  FROM skills s
  WHERE
    s.search_vector @@ websearch_to_tsquery('english', search_query)
    -- Fallback: also match if any tag contains the search term (case-insensitive)
    OR tags_to_text(s.tags) ILIKE '%' || search_query || '%'
  ORDER BY rank DESC, s.quality_score DESC NULLS LAST
  LIMIT limit_count
  OFFSET offset_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Step 6: Update search_skills_v2 function with tag fallback
-- ============================================================================
CREATE OR REPLACE FUNCTION search_skills_v2(
  search_query TEXT,
  filter_trust_tier TEXT DEFAULT NULL,
  filter_min_score NUMERIC DEFAULT NULL,
  filter_category TEXT DEFAULT NULL,
  limit_count INTEGER DEFAULT 20,
  offset_count INTEGER DEFAULT 0
)
RETURNS TABLE (
  id TEXT,
  name TEXT,
  description TEXT,
  author TEXT,
  repo_url TEXT,
  quality_score NUMERIC,
  trust_tier TEXT,
  tags JSONB,
  stars INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  rank REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.description,
    s.author,
    s.repo_url,
    s.quality_score,
    s.trust_tier,
    s.tags,
    s.stars,
    s.created_at,
    s.updated_at,
    COALESCE(
      ts_rank(s.search_vector, websearch_to_tsquery('english', search_query)),
      0.1  -- Give a base rank for tag ILIKE matches
    ) AS rank
  FROM skills s
  LEFT JOIN skill_categories sc ON s.id = sc.skill_id
  LEFT JOIN categories c ON sc.category_id = c.id
  WHERE (
      s.search_vector @@ websearch_to_tsquery('english', search_query)
      -- Fallback: also match if any tag contains the search term (case-insensitive)
      OR tags_to_text(s.tags) ILIKE '%' || search_query || '%'
    )
    AND (filter_trust_tier IS NULL OR s.trust_tier = filter_trust_tier)
    AND (filter_min_score IS NULL OR s.quality_score >= filter_min_score)
    AND (filter_category IS NULL OR c.name = filter_category)
  GROUP BY s.id
  ORDER BY rank DESC, s.quality_score DESC NULLS LAST
  LIMIT limit_count
  OFFSET offset_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Step 7: Grant permissions (with full function signatures)
-- ============================================================================
GRANT EXECUTE ON FUNCTION tags_to_text(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION search_skills(TEXT, INTEGER, INTEGER) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION search_skills_v2(TEXT, TEXT, NUMERIC, TEXT, INTEGER, INTEGER) TO anon, authenticated;

-- ============================================================================
-- Verification query (can be run manually to test)
-- ============================================================================
-- After applying this migration, the following should work:
-- SELECT * FROM search_skills('lenny') LIMIT 5;
-- This should now find skills with tags like "lenny-podcast"
