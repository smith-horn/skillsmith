/**
 * Skill Categorization Logic
 * @module indexer/categorization
 *
 * SMI-1659: Categorization rules based on migration 016_populate_skill_categories.sql
 * SMI-1675: Expanded rules for 77% coverage target
 * SMI-1682: Extracted for testability with vitest
 *
 * This module contains pure categorization logic with no Deno dependencies,
 * enabling testing with Node.js/vitest.
 */

/**
 * Category IDs matching the database schema
 */
export const CATEGORY_IDS = {
  security: 'cat-security',
  testing: 'cat-testing',
  devops: 'cat-devops',
  documentation: 'cat-documentation',
  productivity: 'cat-productivity',
  development: 'cat-development',
  integrations: 'cat-integrations',
} as const

export type CategoryId = (typeof CATEGORY_IDS)[keyof typeof CATEGORY_IDS]

/**
 * Keyword arrays for category matching (SMI-1689)
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

/**
 * Determines which categories a skill belongs to based on tags and description
 * @param tags - Array of skill tags (case-insensitive matching)
 * @param description - Optional skill description for additional matching
 * @returns Array of category IDs the skill belongs to
 */
export function categorizeSkill(tags: string[], description?: string | null): CategoryId[] {
  const categories: CategoryId[] = []
  const tagsLower = tags.map((t) => t.toLowerCase())
  const tagsText = tagsLower.join(' ')
  const descLower = description?.toLowerCase() || ''

  // Security: security, pentesting, vulnerability, audit, ctf, cybersecurity, hacking
  if (
    SECURITY_KEYWORDS.some((kw) => tagsText.includes(kw)) ||
    descLower.includes('security') ||
    descLower.includes('pentesting')
  ) {
    categories.push(CATEGORY_IDS.security)
  }

  // Testing: testing, test, tdd, jest, vitest, e2e, playwright, cypress
  if (
    TESTING_KEYWORDS.some((kw) => tagsText.includes(kw)) ||
    descLower.includes('testing') ||
    descLower.includes('unit test') ||
    descLower.includes('test framework')
  ) {
    categories.push(CATEGORY_IDS.testing)
  }

  // DevOps: devops, ci, cd, docker, kubernetes, deployment, infrastructure, container, github-actions
  if (
    DEVOPS_KEYWORDS.some((kw) => tagsText.includes(kw)) ||
    descLower.includes('deployment') ||
    descLower.includes('ci/cd') ||
    descLower.includes('continuous integration') ||
    descLower.includes('infrastructure')
  ) {
    categories.push(CATEGORY_IDS.devops)
  }

  // Documentation: documentation, docs, readme, markdown, technical-writing
  if (DOC_KEYWORDS.some((kw) => tagsText.includes(kw)) || descLower.includes('documentation')) {
    categories.push(CATEGORY_IDS.documentation)
  }

  // Productivity: productivity, automation, workflow, tools, cli, utility + AI assistants (SMI-1678)
  if (
    PRODUCTIVITY_KEYWORDS.some((kw) => tagsText.includes(kw)) ||
    descLower.includes('ai assistant') ||
    descLower.includes('chatbot')
  ) {
    categories.push(CATEGORY_IDS.productivity)
  }

  // Integrations: MCP ecosystem, API integrations (SMI-1676)
  if (
    INTEGRATIONS_KEYWORDS.some((kw) => tagsText.includes(kw)) ||
    descLower.includes('mcp server') ||
    descLower.includes('model context protocol')
  ) {
    categories.push(CATEGORY_IDS.integrations)
  }

  // Development: coding, agent, programming, framework, sdk, claude-code, vibe-coding, ai-coding + AI/LLM (SMI-1677)
  if (
    DEV_KEYWORDS.some((kw) => tagsText.includes(kw)) ||
    descLower.includes('coding agent') ||
    descLower.includes('development') ||
    descLower.includes('claude code') ||
    descLower.includes('large language model')
  ) {
    categories.push(CATEGORY_IDS.development)
  }

  return categories
}
