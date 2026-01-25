/**
 * SMI-903: Testing-related test skill fixtures
 * Community skills for testing frameworks and tools
 */

import type { TestSkillData } from './skill-types.js'

/**
 * Community skills - Testing (6 total)
 */
export const TESTING_SKILLS: TestSkillData[] = [
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components with comprehensive coverage',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/jest-helper',
    qualityScore: 0.87,
    trustTier: 'community',
    tags: ['jest', 'testing', 'react', 'unit-tests', 'testing'],
  },
  {
    id: 'community/vitest-helper',
    name: 'vitest-helper',
    description: 'Generate Vitest test cases with modern testing patterns',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/vitest-helper',
    qualityScore: 0.85,
    trustTier: 'community',
    tags: ['vitest', 'testing', 'typescript', 'unit-tests', 'testing'],
  },
  {
    id: 'community/playwright-e2e',
    name: 'playwright-e2e',
    description: 'End-to-end testing with Playwright for web applications',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/playwright-e2e',
    qualityScore: 0.84,
    trustTier: 'community',
    tags: ['playwright', 'e2e', 'testing', 'browser', 'testing'],
  },
  {
    id: 'community/cypress-helper',
    name: 'cypress-helper',
    description: 'Cypress test generation and best practices for web testing',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/cypress-helper',
    qualityScore: 0.82,
    trustTier: 'community',
    tags: ['cypress', 'e2e', 'testing', 'web', 'testing'],
  },
  {
    id: 'community/mocha-chai',
    name: 'mocha-chai',
    description: 'Mocha and Chai test generation for Node.js applications',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/mocha-chai',
    qualityScore: 0.78,
    trustTier: 'community',
    tags: ['mocha', 'chai', 'testing', 'nodejs', 'testing'],
  },
  {
    id: 'community/testing-library',
    name: 'testing-library',
    description: 'React Testing Library patterns and component testing',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/testing-library',
    qualityScore: 0.86,
    trustTier: 'community',
    tags: ['testing-library', 'react', 'testing', 'components', 'testing'],
  },
]
