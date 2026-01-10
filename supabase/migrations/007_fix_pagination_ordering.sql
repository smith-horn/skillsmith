-- Migration: Fix pagination overlap by adding deterministic ordering
-- Issue: SMI-1295 - Skills appear on multiple pages due to non-deterministic ORDER BY
--
-- Problem: When multiple skills have identical rank and quality_score values,
-- PostgreSQL does not guarantee stable ordering between queries. This causes
-- skills to "jump" between pages.
--
-- Solution: Add the primary key (id) as a final tie-breaker in ORDER BY clauses.
-- This ensures deterministic ordering even when rank and quality_score are equal.

-- Drop existing functions first (required to change return type)
DROP FUNCTION IF EXISTS search_skills(TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS search_skills_v2(TEXT, TEXT, TEXT, NUMERIC, INTEGER, INTEGER);

-- Update search_skills function (original)
CREATE OR REPLACE FUNCTION search_skills(
  search_query TEXT,
  limit_count INTEGER DEFAULT 10,
  offset_count INTEGER DEFAULT 0
)
RETURNS TABLE (
  id TEXT,
  name TEXT,
  description TEXT,
  author_id TEXT,
  source_id TEXT,
  repo_url TEXT,
  trust_tier TEXT,
  quality_score NUMERIC,
  popularity_score NUMERIC,
  maintenance_score NUMERIC,
  final_score NUMERIC,
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
    s.author_id,
    s.source_id,
    s.repo_url,
    s.trust_tier,
    s.quality_score,
    s.popularity_score,
    s.maintenance_score,
    s.final_score,
    s.created_at,
    s.updated_at,
    ts_rank(s.search_vector, websearch_to_tsquery('english', search_query)) AS rank
  FROM skills s
  WHERE s.search_vector @@ websearch_to_tsquery('english', search_query)
  ORDER BY rank DESC, s.quality_score DESC NULLS LAST, s.id ASC  -- Added s.id for deterministic ordering
  LIMIT limit_count
  OFFSET offset_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- Update search_skills_v2 function (enhanced version)
CREATE OR REPLACE FUNCTION search_skills_v2(
  search_query TEXT,
  category_filter TEXT DEFAULT NULL,
  trust_tier_filter TEXT DEFAULT NULL,
  min_score NUMERIC DEFAULT NULL,
  limit_count INTEGER DEFAULT 10,
  offset_count INTEGER DEFAULT 0
)
RETURNS TABLE (
  id TEXT,
  name TEXT,
  description TEXT,
  author_id TEXT,
  source_id TEXT,
  repo_url TEXT,
  trust_tier TEXT,
  quality_score NUMERIC,
  popularity_score NUMERIC,
  maintenance_score NUMERIC,
  final_score NUMERIC,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  rank REAL,
  total_count BIGINT
) AS $$
DECLARE
  total BIGINT;
BEGIN
  -- Get total count for pagination info
  SELECT COUNT(*) INTO total
  FROM skills s
  WHERE s.search_vector @@ websearch_to_tsquery('english', search_query)
    AND (category_filter IS NULL OR s.categories @> ARRAY[category_filter])
    AND (trust_tier_filter IS NULL OR s.trust_tier = trust_tier_filter)
    AND (min_score IS NULL OR s.quality_score >= min_score);

  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.description,
    s.author_id,
    s.source_id,
    s.repo_url,
    s.trust_tier,
    s.quality_score,
    s.popularity_score,
    s.maintenance_score,
    s.final_score,
    s.created_at,
    s.updated_at,
    ts_rank(s.search_vector, websearch_to_tsquery('english', search_query)) AS rank,
    total AS total_count
  FROM skills s
  WHERE s.search_vector @@ websearch_to_tsquery('english', search_query)
    AND (category_filter IS NULL OR s.categories @> ARRAY[category_filter])
    AND (trust_tier_filter IS NULL OR s.trust_tier = trust_tier_filter)
    AND (min_score IS NULL OR s.quality_score >= min_score)
  ORDER BY rank DESC, s.quality_score DESC NULLS LAST, s.id ASC  -- Added s.id for deterministic ordering
  LIMIT limit_count
  OFFSET offset_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- Add comment documenting the fix (using full function signature)
COMMENT ON FUNCTION search_skills(TEXT, INTEGER, INTEGER) IS 'Full-text search with deterministic pagination (fixed SMI-1295)';
COMMENT ON FUNCTION search_skills_v2(TEXT, TEXT, TEXT, NUMERIC, INTEGER, INTEGER) IS 'Enhanced search with filters and deterministic pagination (fixed SMI-1295)';
