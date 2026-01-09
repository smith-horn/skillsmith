/**
 * Test utilities for MCP server tests
 * @see SMI-792: Database initialization
 */

import { createToolContext, type ToolContext } from '../context.js'

export type { ToolContext }

/**
 * Create a test context with in-memory database
 * SMI-1183: Uses offline mode to avoid API calls during tests
 */
export function createTestContext(): ToolContext {
  return createToolContext({
    dbPath: ':memory:',
    apiClientConfig: { offlineMode: true },
  })
}

/**
 * Seed test data into the context
 */
export function seedTestData(context: ToolContext): void {
  const { skillRepository } = context

  // Add test skills
  skillRepository.create({
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages following conventional commits',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills',
    qualityScore: 0.95,
    trustTier: 'verified',
    tags: ['git', 'commit', 'conventional-commits', 'automation'],
  })

  skillRepository.create({
    id: 'anthropic/review-pr',
    name: 'review-pr',
    description: 'Review pull requests with detailed code analysis',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code-skills-pr',
    qualityScore: 0.93,
    trustTier: 'verified',
    tags: ['git', 'pull-request', 'code-review', 'quality'],
  })

  skillRepository.create({
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/jest-helper',
    qualityScore: 0.87,
    trustTier: 'community',
    tags: ['jest', 'testing', 'react', 'unit-tests'],
  })

  skillRepository.create({
    id: 'community/vitest-helper',
    name: 'vitest-helper',
    description: 'Generate Vitest test cases with modern testing patterns',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/vitest-helper',
    qualityScore: 0.85,
    trustTier: 'community',
    tags: ['vitest', 'testing', 'typescript', 'unit-tests'],
  })

  skillRepository.create({
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/docker-compose',
    qualityScore: 0.84,
    trustTier: 'community',
    tags: ['docker', 'devops', 'containers', 'infrastructure'],
  })

  skillRepository.create({
    id: 'community/api-docs',
    name: 'api-docs',
    description: 'Generate OpenAPI documentation from code',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/api-docs',
    qualityScore: 0.78,
    trustTier: 'experimental',
    tags: ['documentation', 'openapi', 'api'],
  })
}

/**
 * Create a seeded test context
 */
export function createSeededTestContext(): ToolContext {
  const context = createTestContext()
  seedTestData(context)
  return context
}
