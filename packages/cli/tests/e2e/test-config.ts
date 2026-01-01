/**
 * E2E Test Configuration
 *
 * Centralizes configurable values for E2E tests to avoid hardcoded URLs
 * and make tests adaptable to different environments.
 */

/**
 * Base URL for test repository references.
 * Used to construct mock skill repository URLs in seed data.
 *
 * Can be overridden via TEST_REPO_URL_BASE environment variable.
 *
 * @default 'https://github.com/skillsmith-community'
 */
export const TEST_REPO_URL_BASE =
  process.env['TEST_REPO_URL_BASE'] || 'https://github.com/skillsmith-community'

/**
 * Anthropic official skills repository base URL.
 * Used for verified/official skill references.
 *
 * Can be overridden via TEST_ANTHROPIC_REPO_URL environment variable.
 *
 * @default 'https://github.com/anthropics/claude-code/tree/main/skills'
 */
export const TEST_ANTHROPIC_REPO_URL =
  process.env['TEST_ANTHROPIC_REPO_URL'] ||
  'https://github.com/anthropics/claude-code/tree/main/skills'

/**
 * Build a skill repository URL using the configured base.
 *
 * @param skillName - Name of the skill (e.g., 'jest-helper')
 * @returns Full repository URL
 */
export function buildRepoUrl(skillName: string): string {
  return `${TEST_REPO_URL_BASE}/${skillName}`
}

/**
 * Build an Anthropic official skill repository URL.
 *
 * @param skillName - Name of the skill (e.g., 'commit')
 * @returns Full repository URL
 */
export function buildAnthropicRepoUrl(skillName: string): string {
  return `${TEST_ANTHROPIC_REPO_URL}/${skillName}`
}
