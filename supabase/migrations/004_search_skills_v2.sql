-- Migration: 004_search_skills_v2.sql
-- Issue: SMI-1263
-- Description: Add search_skills_v2 RPC function with database-level filtering
--              for trust_tier, min_score, and category parameters.
--              Replaces in-memory filtering in the skills-search Edge Function.
-- Created: 2026-01-08

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
    ts_rank(s.search_vector, websearch_to_tsquery('english', search_query)) AS rank
  FROM skills s
  LEFT JOIN skill_categories sc ON s.id = sc.skill_id
  LEFT JOIN categories c ON sc.category_id = c.id
  WHERE s.search_vector @@ websearch_to_tsquery('english', search_query)
    AND (filter_trust_tier IS NULL OR s.trust_tier = filter_trust_tier)
    AND (filter_min_score IS NULL OR s.quality_score >= filter_min_score)
    AND (filter_category IS NULL OR c.name = filter_category)
  GROUP BY s.id
  ORDER BY rank DESC, s.quality_score DESC NULLS LAST
  LIMIT limit_count
  OFFSET offset_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- Grant execute permissions to anonymous and authenticated users
GRANT EXECUTE ON FUNCTION search_skills_v2 TO anon, authenticated;
