-- SMI-1841: Skill Transformations Table
-- Stores pre-computed skill transformations for efficient serving
-- Part of the skillsmith-transform feature

-- ============================================================================
-- SKILL_TRANSFORMATIONS TABLE - Pre-computed transformations
-- ============================================================================
CREATE TABLE IF NOT EXISTS skill_transformations (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  transformed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Transformed content
  main_content TEXT NOT NULL,
  sub_skills JSONB DEFAULT '[]'::JSONB,
  subagent_definition JSONB,
  claude_md_snippet TEXT,

  -- Metadata
  stats JSONB NOT NULL DEFAULT '{}'::JSONB,
  source_hash TEXT NOT NULL,

  -- Ensure one transformation per skill
  UNIQUE(skill_id)
);

-- Comments
COMMENT ON TABLE skill_transformations IS 'Pre-computed skill transformations for efficient serving';
COMMENT ON COLUMN skill_transformations.skill_id IS 'Foreign key to the source skill';
COMMENT ON COLUMN skill_transformations.transformed_at IS 'When the transformation was computed';
COMMENT ON COLUMN skill_transformations.main_content IS 'The primary transformed skill content';
COMMENT ON COLUMN skill_transformations.sub_skills IS 'Array of extracted sub-skills';
COMMENT ON COLUMN skill_transformations.subagent_definition IS 'Generated subagent configuration';
COMMENT ON COLUMN skill_transformations.claude_md_snippet IS 'Generated CLAUDE.md integration snippet';
COMMENT ON COLUMN skill_transformations.stats IS 'Transformation statistics (tokens, sections, etc.)';
COMMENT ON COLUMN skill_transformations.source_hash IS 'Hash of source content for cache invalidation';

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_skill_transformations_skill_id
  ON skill_transformations(skill_id);

CREATE INDEX IF NOT EXISTS idx_skill_transformations_transformed_at
  ON skill_transformations(transformed_at DESC);

CREATE INDEX IF NOT EXISTS idx_skill_transformations_source_hash
  ON skill_transformations(source_hash);

-- ============================================================================
-- TRIGGERS - Auto-update transformed_at on changes
-- ============================================================================
CREATE OR REPLACE FUNCTION update_transformed_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.transformed_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_skill_transformations_updated ON skill_transformations;
CREATE TRIGGER trigger_skill_transformations_updated
  BEFORE UPDATE ON skill_transformations
  FOR EACH ROW
  EXECUTE FUNCTION update_transformed_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================
ALTER TABLE skill_transformations ENABLE ROW LEVEL SECURITY;

-- Public read access (anyone can view transformations)
DROP POLICY IF EXISTS "Allow public read access on skill_transformations" ON skill_transformations;
CREATE POLICY "Allow public read access on skill_transformations"
  ON skill_transformations FOR SELECT
  TO anon, authenticated
  USING (true);

-- Service role has full access for edge functions
DROP POLICY IF EXISTS "Allow service role full access on skill_transformations" ON skill_transformations;
CREATE POLICY "Allow service role full access on skill_transformations"
  ON skill_transformations FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can insert/update (for API access)
DROP POLICY IF EXISTS "Allow authenticated insert on skill_transformations" ON skill_transformations;
CREATE POLICY "Allow authenticated insert on skill_transformations"
  ON skill_transformations FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated update on skill_transformations" ON skill_transformations;
CREATE POLICY "Allow authenticated update on skill_transformations"
  ON skill_transformations FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated delete on skill_transformations" ON skill_transformations;
CREATE POLICY "Allow authenticated delete on skill_transformations"
  ON skill_transformations FOR DELETE
  TO authenticated
  USING (true);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Get transformation by skill ID
CREATE OR REPLACE FUNCTION get_skill_transformation(p_skill_id TEXT)
RETURNS TABLE (
  id TEXT,
  skill_id TEXT,
  transformed_at TIMESTAMPTZ,
  main_content TEXT,
  sub_skills JSONB,
  subagent_definition JSONB,
  claude_md_snippet TEXT,
  stats JSONB,
  source_hash TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    st.id,
    st.skill_id,
    st.transformed_at,
    st.main_content,
    st.sub_skills,
    st.subagent_definition,
    st.claude_md_snippet,
    st.stats,
    st.source_hash
  FROM skill_transformations st
  WHERE st.skill_id = p_skill_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- Upsert transformation (insert or update based on skill_id)
CREATE OR REPLACE FUNCTION upsert_skill_transformation(
  p_skill_id TEXT,
  p_main_content TEXT,
  p_sub_skills JSONB DEFAULT '[]'::JSONB,
  p_subagent_definition JSONB DEFAULT NULL,
  p_claude_md_snippet TEXT DEFAULT NULL,
  p_stats JSONB DEFAULT '{}'::JSONB,
  p_source_hash TEXT DEFAULT ''
)
RETURNS TEXT AS $$
DECLARE
  v_id TEXT;
BEGIN
  INSERT INTO skill_transformations (
    skill_id,
    main_content,
    sub_skills,
    subagent_definition,
    claude_md_snippet,
    stats,
    source_hash
  ) VALUES (
    p_skill_id,
    p_main_content,
    p_sub_skills,
    p_subagent_definition,
    p_claude_md_snippet,
    p_stats,
    p_source_hash
  )
  ON CONFLICT (skill_id) DO UPDATE SET
    main_content = EXCLUDED.main_content,
    sub_skills = EXCLUDED.sub_skills,
    subagent_definition = EXCLUDED.subagent_definition,
    claude_md_snippet = EXCLUDED.claude_md_snippet,
    stats = EXCLUDED.stats,
    source_hash = EXCLUDED.source_hash,
    transformed_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permissions on functions
GRANT EXECUTE ON FUNCTION get_skill_transformation TO anon, authenticated;
GRANT EXECUTE ON FUNCTION upsert_skill_transformation TO authenticated;

-- ============================================================================
-- SCHEMA VERSION
-- ============================================================================
INSERT INTO schema_version (version, applied_at)
VALUES (23, NOW())
ON CONFLICT (version) DO NOTHING;
