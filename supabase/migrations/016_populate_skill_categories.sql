-- SMI-1634: Populate skill_categories based on tags
-- This migration categorizes existing skills based on their tags

-- Clear existing mappings to avoid duplicates on re-run
TRUNCATE skill_categories;

-- Security: pentesting, vulnerability, audit, ctf, cybersecurity
INSERT INTO skill_categories (skill_id, category_id)
SELECT DISTINCT s.id, 'cat-security'
FROM skills s
WHERE
  s.tags::text ILIKE '%security%'
  OR s.tags::text ILIKE '%pentesting%'
  OR s.tags::text ILIKE '%vulnerability%'
  OR s.tags::text ILIKE '%audit%'
  OR s.tags::text ILIKE '%ctf%'
  OR s.tags::text ILIKE '%cybersecurity%'
  OR s.tags::text ILIKE '%hacking%'
  OR s.description ILIKE '%security%'
  OR s.description ILIKE '%pentesting%'
ON CONFLICT DO NOTHING;

-- Testing: testing, test, tdd, jest, vitest, e2e, playwright
INSERT INTO skill_categories (skill_id, category_id)
SELECT DISTINCT s.id, 'cat-testing'
FROM skills s
WHERE
  s.tags::text ILIKE '%testing%'
  OR s.tags::text ILIKE '%"test"%'
  OR s.tags::text ILIKE '%tdd%'
  OR s.tags::text ILIKE '%jest%'
  OR s.tags::text ILIKE '%vitest%'
  OR s.tags::text ILIKE '%e2e%'
  OR s.tags::text ILIKE '%playwright%'
  OR s.tags::text ILIKE '%cypress%'
  OR s.name ILIKE '%test%'
ON CONFLICT DO NOTHING;

-- DevOps: devops, ci, cd, docker, kubernetes, deployment, infrastructure
INSERT INTO skill_categories (skill_id, category_id)
SELECT DISTINCT s.id, 'cat-devops'
FROM skills s
WHERE
  s.tags::text ILIKE '%devops%'
  OR s.tags::text ILIKE '%"ci"%'
  OR s.tags::text ILIKE '%"cd"%'
  OR s.tags::text ILIKE '%docker%'
  OR s.tags::text ILIKE '%kubernetes%'
  OR s.tags::text ILIKE '%deployment%'
  OR s.tags::text ILIKE '%infrastructure%'
  OR s.tags::text ILIKE '%container%'
  OR s.tags::text ILIKE '%github-actions%'
  OR s.tags::text ILIKE '%workflow-automation%'
ON CONFLICT DO NOTHING;

-- Documentation: documentation, docs, readme, writing, markdown
INSERT INTO skill_categories (skill_id, category_id)
SELECT DISTINCT s.id, 'cat-documentation'
FROM skills s
WHERE
  s.tags::text ILIKE '%documentation%'
  OR s.tags::text ILIKE '%"docs"%'
  OR s.tags::text ILIKE '%readme%'
  OR s.tags::text ILIKE '%markdown%'
  OR s.tags::text ILIKE '%technical-writing%'
  OR s.description ILIKE '%documentation%'
ON CONFLICT DO NOTHING;

-- Productivity: productivity, automation, workflow, tools
INSERT INTO skill_categories (skill_id, category_id)
SELECT DISTINCT s.id, 'cat-productivity'
FROM skills s
WHERE
  s.tags::text ILIKE '%productivity%'
  OR s.tags::text ILIKE '%automation%'
  OR s.tags::text ILIKE '%workflow%'
  OR s.tags::text ILIKE '%tools%'
  OR s.tags::text ILIKE '%cli%'
  OR s.tags::text ILIKE '%utility%'
ON CONFLICT DO NOTHING;

-- Development: coding, agent, programming, framework, sdk
INSERT INTO skill_categories (skill_id, category_id)
SELECT DISTINCT s.id, 'cat-development'
FROM skills s
WHERE
  s.tags::text ILIKE '%coding%'
  OR s.tags::text ILIKE '%agent%'
  OR s.tags::text ILIKE '%programming%'
  OR s.tags::text ILIKE '%framework%'
  OR s.tags::text ILIKE '%sdk%'
  OR s.tags::text ILIKE '%mcp-server%'
  OR s.tags::text ILIKE '%claude-code%'
  OR s.tags::text ILIKE '%vibe-coding%'
  OR s.tags::text ILIKE '%ai-coding%'
  OR s.description ILIKE '%coding agent%'
  OR s.description ILIKE '%development%'
ON CONFLICT DO NOTHING;

-- Update category skill counts
UPDATE categories c
SET skill_count = (
  SELECT COUNT(*) FROM skill_categories sc WHERE sc.category_id = c.id
);

-- Log the results
DO $$
DECLARE
  security_count INTEGER;
  testing_count INTEGER;
  devops_count INTEGER;
  docs_count INTEGER;
  productivity_count INTEGER;
  development_count INTEGER;
BEGIN
  SELECT skill_count INTO security_count FROM categories WHERE id = 'cat-security';
  SELECT skill_count INTO testing_count FROM categories WHERE id = 'cat-testing';
  SELECT skill_count INTO devops_count FROM categories WHERE id = 'cat-devops';
  SELECT skill_count INTO docs_count FROM categories WHERE id = 'cat-documentation';
  SELECT skill_count INTO productivity_count FROM categories WHERE id = 'cat-productivity';
  SELECT skill_count INTO development_count FROM categories WHERE id = 'cat-development';

  RAISE NOTICE 'Category population complete:';
  RAISE NOTICE '  Security: % skills', security_count;
  RAISE NOTICE '  Testing: % skills', testing_count;
  RAISE NOTICE '  DevOps: % skills', devops_count;
  RAISE NOTICE '  Documentation: % skills', docs_count;
  RAISE NOTICE '  Productivity: % skills', productivity_count;
  RAISE NOTICE '  Development: % skills', development_count;
END $$;
