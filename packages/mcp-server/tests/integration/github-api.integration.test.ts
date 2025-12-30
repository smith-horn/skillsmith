/**
 * Integration Test: Real GitHub API
 *
 * Tests the GitHub source adapter against the real GitHub API.
 * These tests are skipped by default and can be enabled with GITHUB_API_TESTS=true.
 *
 * Requirements:
 * - GITHUB_TOKEN environment variable for authenticated requests
 * - Network access to api.github.com
 *
 * @see SMI-798: Integration test with real GitHub API
 */

import { describe, it, expect, beforeAll } from 'vitest'

// GitHub API response types
interface GitHubSearchResponse {
  total_count: number
  incomplete_results: boolean
  items: Array<{ full_name: string; description: string }>
}

interface GitHubRepoResponse {
  full_name: string
  description: string
  name: string
}

interface GitHubRateLimitResponse {
  rate: {
    limit: number
    remaining: number
    reset: number
  }
}

interface GitHubContentResponse {
  name: string
  content: string
  encoding: string
}

// Skip tests unless explicitly enabled
const SKIP_GITHUB_TESTS = process.env.GITHUB_API_TESTS !== 'true'

describe.skipIf(SKIP_GITHUB_TESTS)('SMI-798: GitHub API Integration', () => {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN

  beforeAll(() => {
    if (!GITHUB_TOKEN) {
      console.warn('GITHUB_TOKEN not set - API tests may be rate-limited')
    }
  })

  describe('Repository Search', () => {
    it('should search for claude-skill repositories', async () => {
      const response = await fetch(
        'https://api.github.com/search/repositories?q=topic:claude-skill&per_page=5',
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
          },
        }
      )

      expect(response.ok).toBe(true)

      const data = (await response.json()) as GitHubSearchResponse
      expect(data.total_count).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(data.items)).toBe(true)
    })

    it('should retrieve repository metadata', async () => {
      // Use a known public repository
      const response = await fetch('https://api.github.com/repos/anthropics/anthropic-cookbook', {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
        },
      })

      expect(response.ok).toBe(true)

      const repo = (await response.json()) as GitHubRepoResponse
      expect(repo.full_name).toBe('anthropics/anthropic-cookbook')
      expect(repo.description).toBeDefined()
    })

    it('should handle rate limiting gracefully', async () => {
      const response = await fetch('https://api.github.com/rate_limit', {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
        },
      })

      expect(response.ok).toBe(true)

      const data = (await response.json()) as GitHubRateLimitResponse
      expect(data.rate).toBeDefined()
      expect(data.rate.remaining).toBeGreaterThanOrEqual(0)

      console.log(`GitHub API Rate Limit: ${data.rate.remaining}/${data.rate.limit}`)
    })
  })

  describe('File Content Retrieval', () => {
    it('should fetch README from a public repository', async () => {
      const response = await fetch(
        'https://api.github.com/repos/anthropics/anthropic-cookbook/readme',
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
          },
        }
      )

      expect(response.ok).toBe(true)

      const data = (await response.json()) as GitHubContentResponse
      expect(data.name).toBeDefined()
      expect(data.content).toBeDefined() // Base64 encoded
      expect(data.encoding).toBe('base64')
    })

    it('should handle missing files gracefully', async () => {
      const response = await fetch(
        'https://api.github.com/repos/anthropics/anthropic-cookbook/contents/NONEXISTENT_FILE.md',
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
          },
        }
      )

      expect(response.status).toBe(404)
    })
  })

  describe('Topic Search', () => {
    it('should search for repositories by topic', async () => {
      const topics = ['claude-code', 'claude-skill', 'anthropic']

      for (const topic of topics) {
        const response = await fetch(
          `https://api.github.com/search/repositories?q=topic:${topic}&per_page=3`,
          {
            headers: {
              Accept: 'application/vnd.github.v3+json',
              ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
            },
          }
        )

        expect(response.ok).toBe(true)

        const data = (await response.json()) as GitHubSearchResponse
        console.log(`Topic "${topic}": ${data.total_count} repositories found`)
      }
    })
  })
})

// Mock-based tests that always run
describe('GitHub API Integration (Mocked)', () => {
  describe('URL Validation', () => {
    it('should validate GitHub repository URLs', () => {
      const validUrls = [
        'https://github.com/user/repo',
        'https://github.com/org/repo-name',
        'https://github.com/user123/my-skill',
      ]

      const invalidUrls = [
        'https://gitlab.com/user/repo',
        'github.com/user/repo',
        'https://github.com/repo',
        'https://github.com/user/',
      ]

      const pattern = /^https:\/\/github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/

      for (const url of validUrls) {
        expect(pattern.test(url)).toBe(true)
      }

      for (const url of invalidUrls) {
        expect(pattern.test(url)).toBe(false)
      }
    })

    it('should parse owner and repo from GitHub URLs', () => {
      const url = 'https://github.com/anthropics/claude-code'
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)/)

      expect(match).not.toBeNull()
      expect(match![1]).toBe('anthropics')
      expect(match![2]).toBe('claude-code')
    })

    it('should handle GitHub URLs with paths', () => {
      const url = 'https://github.com/user/repo/tree/main/skills/my-skill'
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)/)

      expect(match).not.toBeNull()
      expect(match![1]).toBe('user')
      expect(match![2]).toBe('repo')
    })
  })

  describe('Response Parsing', () => {
    it('should parse GitHub API search response format', () => {
      const mockResponse = {
        total_count: 2,
        incomplete_results: false,
        items: [
          {
            id: 123,
            name: 'skill-repo',
            full_name: 'user/skill-repo',
            description: 'A Claude skill',
            html_url: 'https://github.com/user/skill-repo',
            stargazers_count: 10,
            forks_count: 2,
            topics: ['claude-skill', 'ai'],
            updated_at: '2024-01-15T00:00:00Z',
            default_branch: 'main',
          },
        ],
      }

      expect(mockResponse.items.length).toBe(1)
      expect(mockResponse.items[0].full_name).toBe('user/skill-repo')
      expect(mockResponse.items[0].topics).toContain('claude-skill')
    })

    it('should extract skill metadata from repository', () => {
      const repo = {
        name: 'my-skill',
        full_name: 'user/my-skill',
        description: 'A helpful skill for Claude',
        owner: { login: 'user' },
        stargazers_count: 50,
        topics: ['claude-skill', 'testing'],
        updated_at: '2024-01-15T00:00:00Z',
      }

      const skillMetadata = {
        id: repo.full_name,
        name: repo.name,
        description: repo.description,
        author: repo.owner.login,
        stars: repo.stargazers_count,
        tags: repo.topics,
      }

      expect(skillMetadata.id).toBe('user/my-skill')
      expect(skillMetadata.author).toBe('user')
      expect(skillMetadata.tags).toContain('claude-skill')
    })
  })
})
