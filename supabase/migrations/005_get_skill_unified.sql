-- SMI-1264: Unified skill lookup RPC
-- Handles ID, author/name, and fuzzy matching in one query
-- Returns skill with categories in single round trip
--
-- Replaces multiple sequential queries in skills-get Edge Function:
-- 1. Try find by ID
-- 2. Try find by author/name
-- 3. Try fuzzy name match
-- 4. Fetch categories separately

CREATE OR REPLACE FUNCTION get_skill_by_identifier(
  identifier TEXT
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
  source TEXT,
  stars INTEGER,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  categories TEXT[]
) AS $$
DECLARE
  skill_record RECORD;
  lookup_author TEXT;
  lookup_name TEXT;
BEGIN
  -- Strategy 1: Direct ID match
  SELECT s.* INTO skill_record
  FROM skills s
  WHERE s.id = identifier
  LIMIT 1;

  -- Strategy 2: author/name pattern (if contains /)
  IF skill_record IS NULL AND identifier LIKE '%/%' THEN
    lookup_author := split_part(identifier, '/', 1);
    lookup_name := split_part(identifier, '/', 2);

    SELECT s.* INTO skill_record
    FROM skills s
    WHERE s.author = lookup_author AND s.name = lookup_name
    LIMIT 1;
  END IF;

  -- Strategy 3: Fuzzy name match
  IF skill_record IS NULL THEN
    SELECT s.* INTO skill_record
    FROM skills s
    WHERE lower(s.name) = lower(identifier)
    LIMIT 1;
  END IF;

  -- Return with categories if found
  IF skill_record IS NOT NULL THEN
    RETURN QUERY
    SELECT
      skill_record.id,
      skill_record.name,
      skill_record.description,
      skill_record.author,
      skill_record.repo_url,
      skill_record.quality_score,
      skill_record.trust_tier,
      skill_record.tags,
      skill_record.source,
      skill_record.stars,
      skill_record.created_at,
      skill_record.updated_at,
      ARRAY(
        SELECT cat.name
        FROM skill_categories sc
        JOIN categories cat ON sc.category_id = cat.id
        WHERE sc.skill_id = skill_record.id
      ) AS categories;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- Grant execute permissions to API roles
GRANT EXECUTE ON FUNCTION get_skill_by_identifier TO anon, authenticated;
