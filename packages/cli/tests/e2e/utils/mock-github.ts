/**
 * SMI-1474: GitHub API mock utilities for E2E tests
 *
 * Provides mock responses for GitHub API calls without real API access.
 */

import { vi } from 'vitest'

export interface MockGitHubSkill {
  name: string
  full_name: string
  description: string
  html_url: string
  topics: string[]
  stargazers_count: number
}

export const MOCK_SKILLS: MockGitHubSkill[] = [
  {
    name: 'commit-skill',
    full_name: 'anthropics/commit-skill',
    description: 'A skill for git commits',
    html_url: 'https://github.com/anthropics/commit-skill',
    topics: ['claude-skill', 'git', 'commit'],
    stargazers_count: 100,
  },
  {
    name: 'test-helper',
    full_name: 'community/test-helper',
    description: 'Testing utilities skill',
    html_url: 'https://github.com/community/test-helper',
    topics: ['claude-skill', 'testing'],
    stargazers_count: 50,
  },
]

/**
 * Setup mock GitHub API responses
 */
export function setupMockGitHub(customSkills?: MockGitHubSkill[]) {
  const skills = customSkills || MOCK_SKILLS

  // Mock global fetch for GitHub API calls
  const originalFetch = global.fetch
  global.fetch = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('api.github.com/search/repositories')) {
      return {
        ok: true,
        json: async () => ({
          total_count: skills.length,
          items: skills,
        }),
      }
    }
    if (url.includes('api.github.com/repos/')) {
      const repoName = url.split('/repos/')[1]?.split('/')[1]
      const skill = skills.find((s) => s.name === repoName)
      return {
        ok: !!skill,
        json: async () => skill || { message: 'Not Found' },
      }
    }
    // Fall back to original fetch for non-GitHub URLs
    return originalFetch(url)
  })
}

/**
 * Clear GitHub API mocks
 */
export function clearMockGitHub() {
  vi.restoreAllMocks()
}
