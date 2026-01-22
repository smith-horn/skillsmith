-- SMI-1675: Expanded skill categorization for 77% coverage target
-- Adds Integrations category and expands Development/Productivity rules
-- Gap analysis: 93.5% of skills (13,300) had no category

-- =============================================================================
-- WAVE 1: Add Integrations category
-- =============================================================================

INSERT INTO categories (id, name, description, skill_count)
VALUES (
  'cat-integrations',
  'integrations',
  'MCP servers, API integrations, and protocol implementations'
  , 0
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- WAVE 2: Populate expanded categories (ADDITIVE - no truncate)
-- =============================================================================

-- Integrations: MCP ecosystem, API integrations
-- Estimated: ~1,200 skills
INSERT INTO skill_categories (skill_id, category_id)
SELECT DISTINCT s.id, 'cat-integrations'
FROM skills s
WHERE
  -- MCP ecosystem
  s.tags::text ILIKE '%"mcp"%'
  OR s.tags::text ILIKE '%"mcp-server"%'
  OR s.tags::text ILIKE '%"mcp-client"%'
  OR s.tags::text ILIKE '%"model-context-protocol"%'
  OR s.tags::text ILIKE '%"mcp-tools"%'
  OR s.tags::text ILIKE '%"mcp-gateway"%'
  -- API integrations
  OR s.tags::text ILIKE '%"api-integration"%'
  OR s.tags::text ILIKE '%"api-client"%'
  -- Description matches
  OR s.description ILIKE '%mcp server%'
  OR s.description ILIKE '%model context protocol%'
ON CONFLICT DO NOTHING;

-- Development: AI/Claude ecosystem expansion
-- Estimated: ~2,500 additional skills
INSERT INTO skill_categories (skill_id, category_id)
SELECT DISTINCT s.id, 'cat-development'
FROM skills s
WHERE
  -- Claude ecosystem
  s.tags::text ILIKE '%"claude"%'
  OR s.tags::text ILIKE '%"anthropic"%'
  OR s.tags::text ILIKE '%"claude-ai"%'
  OR s.tags::text ILIKE '%"anthropic-claude"%'
  OR s.tags::text ILIKE '%"claudecode"%'
  -- AI coding tools
  OR s.tags::text ILIKE '%"ai-coding"%'
  OR s.tags::text ILIKE '%"codex"%'
  OR s.tags::text ILIKE '%"cursor"%'
  OR s.tags::text ILIKE '%"opencode"%'
  -- LLM/AI agents
  OR s.tags::text ILIKE '%"llm"%'
  OR s.tags::text ILIKE '%"ai-agent"%'
  OR s.tags::text ILIKE '%"ai-agents"%'
  OR s.tags::text ILIKE '%"agentic-ai"%'
  OR s.tags::text ILIKE '%"agentic-framework"%'
  OR s.tags::text ILIKE '%"agentic-coding"%'
  -- Other AI providers (for completeness)
  OR s.tags::text ILIKE '%"openai"%'
  OR s.tags::text ILIKE '%"gemini"%'
  OR s.tags::text ILIKE '%"ollama"%'
  -- Description matches
  OR s.description ILIKE '%claude code%'
  OR s.description ILIKE '%large language model%'
ON CONFLICT DO NOTHING;

-- Productivity: AI assistant expansion
-- Estimated: ~500 additional skills
INSERT INTO skill_categories (skill_id, category_id)
SELECT DISTINCT s.id, 'cat-productivity'
FROM skills s
WHERE
  -- AI assistants
  s.tags::text ILIKE '%"ai-assistant"%'
  OR s.tags::text ILIKE '%"chatbot"%'
  OR s.tags::text ILIKE '%"chat-bot"%'
  -- RAG and orchestration
  OR s.tags::text ILIKE '%"rag"%'
  OR s.tags::text ILIKE '%"retrieval-augmented%'
  OR s.tags::text ILIKE '%"orchestration"%'
  -- AI tools
  OR s.tags::text ILIKE '%"ai-tools"%'
  OR s.tags::text ILIKE '%"ai-tool"%'
  -- Description matches
  OR s.description ILIKE '%ai assistant%'
  OR s.description ILIKE '%chatbot%'
ON CONFLICT DO NOTHING;

-- =============================================================================
-- WAVE 3: Update category counts
-- =============================================================================

UPDATE categories c
SET skill_count = (
  SELECT COUNT(*) FROM skill_categories sc WHERE sc.category_id = c.id
);

-- =============================================================================
-- Validation: Log results
-- =============================================================================

DO $$
DECLARE
  total_skills INTEGER;
  categorized_skills INTEGER;
  uncategorized_skills INTEGER;
  coverage_pct NUMERIC;
  cat_record RECORD;
BEGIN
  -- Get total counts
  SELECT COUNT(*) INTO total_skills FROM skills;
  SELECT COUNT(DISTINCT skill_id) INTO categorized_skills FROM skill_categories;
  uncategorized_skills := total_skills - categorized_skills;
  coverage_pct := ROUND((categorized_skills::NUMERIC / total_skills::NUMERIC) * 100, 1);

  RAISE NOTICE '=== Skill Categorization Results ===';
  RAISE NOTICE 'Total skills: %', total_skills;
  RAISE NOTICE 'Categorized: % (%.1%%)', categorized_skills, coverage_pct;
  RAISE NOTICE 'Uncategorized: %', uncategorized_skills;
  RAISE NOTICE '';
  RAISE NOTICE 'Category breakdown:';

  FOR cat_record IN
    SELECT c.name, c.skill_count
    FROM categories c
    ORDER BY c.skill_count DESC
  LOOP
    RAISE NOTICE '  %: % skills', cat_record.name, cat_record.skill_count;
  END LOOP;
END $$;
