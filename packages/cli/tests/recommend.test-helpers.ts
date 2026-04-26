/**
 * Shared fixtures for the SMI-1353 recommend command test files.
 *
 * The full suite was split across three sibling files (`recommend.test.ts`,
 * `recommend.errors.test.ts`, `recommend.filters.test.ts`) so each file stays
 * under the 500-line standard. Pure fixtures (no `vi.hoisted`, no mock
 * factory) live here; each test file owns its own `vi.hoisted` mocks +
 * `vi.mock(...)` block since vitest doesn't allow exporting hoisted values
 * across module boundaries.
 */

/**
 * Skill data type for mock responses
 */
export interface MockSkillData {
  id: string
  name: string
  description: string
  author: string
  repo_url: string | null
  quality_score: number
  trust_tier: string
  tags: string[]
  stars: number
  created_at: string
  updated_at: string
}

/**
 * Creates a mock CodebaseContext for testing
 */
export function createMockCodebaseContext(overrides = {}) {
  return {
    rootPath: '/test/project',
    imports: [],
    exports: [],
    functions: [],
    frameworks: [
      { name: 'React', confidence: 0.95, source: 'dep', detectedFrom: [] },
      { name: 'TypeScript', confidence: 0.9, source: 'dep', detectedFrom: [] },
    ],
    dependencies: [
      { name: 'react', version: '^18.0.0', isDev: false },
      { name: 'typescript', version: '^5.0.0', isDev: true },
      { name: 'jest', version: '^29.0.0', isDev: true },
    ],
    stats: {
      totalFiles: 42,
      filesByExtension: { '.ts': 30, '.tsx': 12 },
      totalLines: 5000,
    },
    metadata: {
      durationMs: 150,
      version: '1.0.0',
    },
    ...overrides,
  }
}

/**
 * Creates a mock API response for recommendations
 */
export function createMockApiResponse(skills: MockSkillData[] = []) {
  return {
    data:
      skills.length > 0
        ? skills
        : [
            {
              id: 'anthropic/jest-helper',
              name: 'Jest Helper',
              description: 'Jest testing utilities',
              author: 'anthropic',
              repo_url: 'https://github.com/anthropic/jest-helper',
              quality_score: 0.85,
              trust_tier: 'verified',
              tags: ['testing', 'jest'],
              stars: 150,
              created_at: '2024-01-01',
              updated_at: '2024-01-15',
            },
            {
              id: 'community/react-tools',
              name: 'React Tools',
              description: 'React development utilities',
              author: 'community',
              repo_url: 'https://github.com/community/react-tools',
              quality_score: 0.72,
              trust_tier: 'community',
              tags: ['react', 'development'],
              stars: 89,
              created_at: '2024-02-01',
              updated_at: '2024-02-10',
            },
          ],
    meta: {},
  }
}
