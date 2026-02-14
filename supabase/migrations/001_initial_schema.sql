-- SMI-1179: Initial Skillsmith Schema for Supabase
-- Converted from SQLite schema (packages/core/src/db/schema.ts)
-- Phase 6A: Production Deployment

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- For trigram similarity search

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert initial schema version
INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;

-- ============================================================================
-- SKILLS TABLE - Main storage for discovered skills
-- ============================================================================
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  name TEXT NOT NULL,
  description TEXT,
  author TEXT,
  repo_url TEXT UNIQUE,
  quality_score NUMERIC CHECK(quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  trust_tier TEXT CHECK(trust_tier IN ('verified', 'community', 'experimental', 'unknown')) DEFAULT 'unknown',
  tags JSONB DEFAULT '[]'::JSONB,
  source TEXT,
  stars INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Full-text search vector column
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(name, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(author, '')), 'C')
  ) STORED
);

-- Comment on table
COMMENT ON TABLE skills IS 'Main storage for discovered Claude Code skills';
COMMENT ON COLUMN skills.quality_score IS 'Score from 0-1 based on quality metrics';
COMMENT ON COLUMN skills.trust_tier IS 'Trust level: verified (Anthropic), community, experimental, unknown';
COMMENT ON COLUMN skills.search_vector IS 'Auto-generated tsvector for full-text search';

-- ============================================================================
-- SOURCES TABLE - Tracks where skills are discovered from
-- ============================================================================
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('github', 'gitlab', 'local', 'registry')),
  url TEXT NOT NULL UNIQUE,
  last_sync_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sources IS 'Sources where skills are discovered from';

-- ============================================================================
-- CATEGORIES TABLE - Hierarchical organization of skills
-- ============================================================================
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  skill_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE categories IS 'Hierarchical organization of skills';

-- ============================================================================
-- SKILL_CATEGORIES - Junction table for skill-category relationships
-- ============================================================================
CREATE TABLE IF NOT EXISTS skill_categories (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (skill_id, category_id)
);

-- ============================================================================
-- CACHE TABLE - For search results and API responses
-- ============================================================================
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  expires_at BIGINT,  -- Unix timestamp, NULL for no expiry
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE cache IS 'Cache for search results and API responses';

-- ============================================================================
-- AUDIT_LOGS TABLE - Security monitoring (SMI-733)
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::TEXT,
  event_type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT,
  resource TEXT,
  action TEXT,
  result TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE audit_logs IS 'Audit logs for security monitoring';

-- ============================================================================
-- INDEXES - For common query patterns
-- ============================================================================

-- Skills indexes
CREATE INDEX IF NOT EXISTS idx_skills_author ON skills(author);
CREATE INDEX IF NOT EXISTS idx_skills_trust_tier ON skills(trust_tier);
CREATE INDEX IF NOT EXISTS idx_skills_quality_score ON skills(quality_score);
CREATE INDEX IF NOT EXISTS idx_skills_updated_at ON skills(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_created_at ON skills(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
CREATE INDEX IF NOT EXISTS idx_skills_stars ON skills(stars DESC NULLS LAST);

-- Full-text search index (GIN for tsvector)
CREATE INDEX IF NOT EXISTS idx_skills_search ON skills USING GIN(search_vector);

-- Trigram index for fuzzy/partial text matching
CREATE INDEX IF NOT EXISTS idx_skills_name_trgm ON skills USING GIN(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_skills_description_trgm ON skills USING GIN(description gin_trgm_ops);

-- Tags GIN index for JSONB array containment queries
CREATE INDEX IF NOT EXISTS idx_skills_tags ON skills USING GIN(tags);

-- Sources indexes
CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);
CREATE INDEX IF NOT EXISTS idx_sources_is_active ON sources(is_active);

-- Categories indexes
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

-- Cache indexes
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

-- Audit logs indexes
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource);
CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_logs(result);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor);

-- ============================================================================
-- TRIGGERS - Auto-update updated_at timestamp
-- ============================================================================

-- Function to update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for skills table
DROP TRIGGER IF EXISTS trigger_skills_updated_at ON skills;
CREATE TRIGGER trigger_skills_updated_at
  BEFORE UPDATE ON skills
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) - Public read access
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_version ENABLE ROW LEVEL SECURITY;

-- Skills: Public read access (anyone can search/view skills)
DROP POLICY IF EXISTS "Allow public read access on skills" ON skills;
CREATE POLICY "Allow public read access on skills"
  ON skills FOR SELECT
  TO anon, authenticated
  USING (true);

-- Skills: Authenticated users can insert/update (future: admin only)
DROP POLICY IF EXISTS "Allow authenticated insert on skills" ON skills;
CREATE POLICY "Allow authenticated insert on skills"
  ON skills FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated update on skills" ON skills;
CREATE POLICY "Allow authenticated update on skills"
  ON skills FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Sources: Public read access
DROP POLICY IF EXISTS "Allow public read access on sources" ON sources;
CREATE POLICY "Allow public read access on sources"
  ON sources FOR SELECT
  TO anon, authenticated
  USING (true);

-- Categories: Public read access
DROP POLICY IF EXISTS "Allow public read access on categories" ON categories;
CREATE POLICY "Allow public read access on categories"
  ON categories FOR SELECT
  TO anon, authenticated
  USING (true);

-- Skill Categories: Public read access
DROP POLICY IF EXISTS "Allow public read access on skill_categories" ON skill_categories;
CREATE POLICY "Allow public read access on skill_categories"
  ON skill_categories FOR SELECT
  TO anon, authenticated
  USING (true);

-- Cache: Public read access (cached search results)
DROP POLICY IF EXISTS "Allow public read access on cache" ON cache;
CREATE POLICY "Allow public read access on cache"
  ON cache FOR SELECT
  TO anon, authenticated
  USING (true);

-- Audit logs: Authenticated read only (for transparency)
DROP POLICY IF EXISTS "Allow authenticated read on audit_logs" ON audit_logs;
CREATE POLICY "Allow authenticated read on audit_logs"
  ON audit_logs FOR SELECT
  TO authenticated
  USING (true);

-- Schema version: Public read access
DROP POLICY IF EXISTS "Allow public read on schema_version" ON schema_version;
CREATE POLICY "Allow public read on schema_version"
  ON schema_version FOR SELECT
  TO anon, authenticated
  USING (true);

-- ============================================================================
-- HELPER FUNCTIONS - For search operations
-- ============================================================================

-- Full-text search function with ranking
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
    ts_rank(s.search_vector, websearch_to_tsquery('english', search_query)) AS rank
  FROM skills s
  WHERE s.search_vector @@ websearch_to_tsquery('english', search_query)
  ORDER BY rank DESC, s.quality_score DESC NULLS LAST
  LIMIT limit_count
  OFFSET offset_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- Fuzzy search function using trigrams
CREATE OR REPLACE FUNCTION fuzzy_search_skills(
  search_query TEXT,
  similarity_threshold REAL DEFAULT 0.3,
  limit_count INTEGER DEFAULT 20
)
RETURNS TABLE (
  id TEXT,
  name TEXT,
  description TEXT,
  author TEXT,
  quality_score NUMERIC,
  trust_tier TEXT,
  similarity REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.name,
    s.description,
    s.author,
    s.quality_score,
    s.trust_tier,
    GREATEST(
      similarity(s.name, search_query),
      similarity(COALESCE(s.description, ''), search_query)
    ) AS similarity
  FROM skills s
  WHERE
    similarity(s.name, search_query) > similarity_threshold
    OR similarity(COALESCE(s.description, ''), search_query) > similarity_threshold
  ORDER BY similarity DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql STABLE;

-- Grant execute permissions on functions
GRANT EXECUTE ON FUNCTION search_skills TO anon, authenticated;
GRANT EXECUTE ON FUNCTION fuzzy_search_skills TO anon, authenticated;

-- ============================================================================
-- SEED DATA (Optional: Default categories)
-- ============================================================================

INSERT INTO categories (id, name, description) VALUES
  ('cat-development', 'Development', 'Skills for software development workflows'),
  ('cat-testing', 'Testing', 'Skills for testing and quality assurance'),
  ('cat-devops', 'DevOps', 'Skills for CI/CD, deployment, and infrastructure'),
  ('cat-documentation', 'Documentation', 'Skills for documentation and technical writing'),
  ('cat-productivity', 'Productivity', 'Skills for enhancing developer productivity'),
  ('cat-security', 'Security', 'Skills for security auditing and best practices')
ON CONFLICT (id) DO NOTHING;
