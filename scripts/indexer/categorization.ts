/**
 * Skill Categorization Logic
 * @module scripts/indexer/categorization
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/categorization.ts`. Body is byte-identical —
 * pure categorization logic with no Deno-only APIs or `fetch()` calls. Parity
 * guarded by `scripts/indexer/tests/parity.test.ts`.
 *
 * SMI-1659: Categorization rules based on migration 016_populate_skill_categories.sql
 * SMI-1675: Expanded rules for 77% coverage target
 * SMI-1682: Extracted for testability with vitest
 * SMI-2378: Unified taxonomy — 11 categories matching MCP server + science
 * SMI-2377: Science/bioinformatics keywords for bioSkills
 * SMI-2389: Exact tag matching replaces substring matching
 */

/**
 * Category IDs matching the database schema.
 * SMI-2378: Unified with MCP server taxonomy (packages/core/src/types.ts SkillCategory).
 */
export const CATEGORY_IDS = {
  security: 'cat-security',
  testing: 'cat-testing',
  devops: 'cat-devops',
  documentation: 'cat-documentation',
  productivity: 'cat-productivity',
  development: 'cat-development',
  integrations: 'cat-integrations',
  database: 'cat-database',
  'ai-ml': 'cat-ai-ml',
  science: 'cat-science',
  other: 'cat-other',
} as const

export type CategoryId = (typeof CATEGORY_IDS)[keyof typeof CATEGORY_IDS]

/**
 * Keyword arrays for category matching (SMI-1689)
 * SMI-2389: These are matched against exact tags, not substrings.
 */
const SECURITY_KEYWORDS = [
  'security',
  'pentesting',
  'vulnerability',
  'audit',
  'ctf',
  'cybersecurity',
  'hacking',
] as const

const TESTING_KEYWORDS = [
  'testing',
  'test',
  'tdd',
  'jest',
  'vitest',
  'e2e',
  'playwright',
  'cypress',
] as const

const DEVOPS_KEYWORDS = [
  'devops',
  'ci',
  'cd',
  'docker',
  'kubernetes',
  'deployment',
  'infrastructure',
  'container',
  'github-actions',
  'workflow-automation',
] as const

const DOC_KEYWORDS = ['documentation', 'docs', 'readme', 'markdown', 'technical-writing'] as const

const PRODUCTIVITY_KEYWORDS = [
  'productivity',
  'automation',
  'workflow',
  'tools',
  'cli',
  'utility',
  // SMI-1678: AI assistant expansion
  'ai-assistant',
  'chatbot',
  'chat-bot',
  'rag',
  'ai-tools',
  'ai-tool',
  'orchestration',
] as const

const INTEGRATIONS_KEYWORDS = [
  'mcp',
  'mcp-server',
  'mcp-client',
  'model-context-protocol',
  'mcp-tools',
  'mcp-gateway',
  'api-integration',
  'api-client',
] as const

const DEV_KEYWORDS = [
  'coding',
  'agent',
  'programming',
  'framework',
  'sdk',
  'claude-code',
  'vibe-coding',
  'ai-coding',
  // SMI-1677: Claude/AI ecosystem expansion
  'claude',
  'anthropic',
  'claude-ai',
  'anthropic-claude',
  'claudecode',
  'codex',
  'cursor',
  'opencode',
  'llm',
  'ai-agent',
  'ai-agents',
  'agentic-ai',
  'agentic-framework',
  'agentic-coding',
  'openai',
  'gemini',
  'ollama',
] as const

// SMI-2378: New category keywords
const DATABASE_KEYWORDS = [
  'database',
  'sql',
  'nosql',
  'postgresql',
  'postgres',
  'mysql',
  'mongodb',
  'redis',
  'sqlite',
  'supabase',
  'prisma',
  'orm',
  'migration',
  'schema',
] as const

const AI_ML_KEYWORDS = [
  'machine-learning',
  'deep-learning',
  'neural-network',
  'tensorflow',
  'pytorch',
  'huggingface',
  'transformers',
  'nlp',
  'computer-vision',
  'ml-ops',
  'model-training',
  'fine-tuning',
  'embeddings',
  'vector-search',
  'onnx',
] as const

// SMI-2377: Science/bioinformatics keywords for bioSkills
const SCIENCE_KEYWORDS = [
  'bioinformatics',
  'genomics',
  'proteomics',
  'biology',
  'single-cell',
  'transcriptomics',
  'computational-biology',
  'phylogenetics',
  'alignment',
  'sequencing',
  'molecular',
  'scientific-computing',
  'biostatistics',
  'data-analysis',
  'statistics',
  'chemistry',
  'physics',
  'neuroscience',
  'ecology',
  'metagenomics',
] as const

/**
 * Check if any keyword appears as an exact tag match.
 * SMI-2389: Replaces substring `.includes()` to prevent false positives
 * (e.g., 'test' matching 'fastest', 'ci' matching 'scientific').
 */
function hasTagMatch(tagsLower: string[], keywords: readonly string[]): boolean {
  return tagsLower.some((tag) => keywords.includes(tag))
}

/**
 * Determines which categories a skill belongs to based on tags and description
 * @param tags - Array of skill tags (case-insensitive matching)
 * @param description - Optional skill description for additional matching
 * @returns Array of category IDs the skill belongs to
 */
export function categorizeSkill(tags: string[], description?: string | null): CategoryId[] {
  const categories: CategoryId[] = []
  const tagsLower = tags.map((t) => t.toLowerCase())
  const descLower = description?.toLowerCase() || ''

  // Security: security, pentesting, vulnerability, audit, ctf, cybersecurity, hacking
  if (
    hasTagMatch(tagsLower, SECURITY_KEYWORDS) ||
    descLower.includes('security') ||
    descLower.includes('pentesting')
  ) {
    categories.push(CATEGORY_IDS.security)
  }

  // Testing: testing, test, tdd, jest, vitest, e2e, playwright, cypress
  if (
    hasTagMatch(tagsLower, TESTING_KEYWORDS) ||
    descLower.includes('testing') ||
    descLower.includes('unit test') ||
    descLower.includes('test framework')
  ) {
    categories.push(CATEGORY_IDS.testing)
  }

  // DevOps: devops, ci, cd, docker, kubernetes, deployment, infrastructure, container, github-actions
  if (
    hasTagMatch(tagsLower, DEVOPS_KEYWORDS) ||
    descLower.includes('deployment') ||
    descLower.includes('ci/cd') ||
    descLower.includes('continuous integration') ||
    descLower.includes('infrastructure')
  ) {
    categories.push(CATEGORY_IDS.devops)
  }

  // Documentation: documentation, docs, readme, markdown, technical-writing
  if (hasTagMatch(tagsLower, DOC_KEYWORDS) || descLower.includes('documentation')) {
    categories.push(CATEGORY_IDS.documentation)
  }

  // Productivity: productivity, automation, workflow, tools, cli, utility + AI assistants (SMI-1678)
  if (
    hasTagMatch(tagsLower, PRODUCTIVITY_KEYWORDS) ||
    descLower.includes('ai assistant') ||
    descLower.includes('chatbot')
  ) {
    categories.push(CATEGORY_IDS.productivity)
  }

  // Integrations: MCP ecosystem, API integrations (SMI-1676)
  if (
    hasTagMatch(tagsLower, INTEGRATIONS_KEYWORDS) ||
    descLower.includes('mcp server') ||
    descLower.includes('model context protocol')
  ) {
    categories.push(CATEGORY_IDS.integrations)
  }

  // Development: coding, agent, programming, framework, sdk, claude-code, vibe-coding, ai-coding + AI/LLM (SMI-1677)
  if (
    hasTagMatch(tagsLower, DEV_KEYWORDS) ||
    descLower.includes('coding agent') ||
    descLower.includes('development') ||
    descLower.includes('claude code') ||
    descLower.includes('large language model')
  ) {
    categories.push(CATEGORY_IDS.development)
  }

  // SMI-2378: Database
  if (
    hasTagMatch(tagsLower, DATABASE_KEYWORDS) ||
    descLower.includes('database') ||
    descLower.includes('sql query') ||
    descLower.includes('data model')
  ) {
    categories.push(CATEGORY_IDS.database)
  }

  // SMI-2378: AI/ML
  if (
    hasTagMatch(tagsLower, AI_ML_KEYWORDS) ||
    descLower.includes('machine learning') ||
    descLower.includes('deep learning') ||
    descLower.includes('neural network') ||
    descLower.includes('model training')
  ) {
    categories.push(CATEGORY_IDS['ai-ml'])
  }

  // SMI-2377: Science/Bioinformatics
  if (
    hasTagMatch(tagsLower, SCIENCE_KEYWORDS) ||
    descLower.includes('bioinformatics') ||
    descLower.includes('genomics') ||
    descLower.includes('proteomics') ||
    descLower.includes('computational biology') ||
    descLower.includes('scientific computing')
  ) {
    categories.push(CATEGORY_IDS.science)
  }

  return categories
}
