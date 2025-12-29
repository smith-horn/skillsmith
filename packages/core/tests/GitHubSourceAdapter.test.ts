/**
 * GitHub Source Adapter Tests (SMI-590)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  GitHubSourceAdapter,
  createGitHubAdapter,
  type SourceConfig,
} from '../src/sources/index.js'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('GitHubSourceAdapter (SMI-590)', () => {
  let adapter: GitHubSourceAdapter

  const config: SourceConfig = {
    id: 'github-test',
    name: 'GitHub Test',
    type: 'github',
    baseUrl: 'https://api.github.com',
    enabled: true,
    auth: {
      type: 'token',
      credentials: 'test-token',
    },
    rateLimit: {
      maxRequests: 30,
      windowMs: 60000,
      minDelayMs: 0, // No delay for tests
    },
  }

  beforeEach(() => {
    mockFetch.mockClear()
    adapter = new GitHubSourceAdapter(config)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('Configuration', () => {
    it('should store configuration', () => {
      expect(adapter.id).toBe('github-test')
      expect(adapter.name).toBe('GitHub Test')
      expect(adapter.type).toBe('github')
    })

    it('should use default base URL', () => {
      const adapterWithDefaults = createGitHubAdapter({
        id: 'github-default',
        name: 'GitHub Default',
        enabled: true,
      })
      expect(adapterWithDefaults.config.baseUrl).toBe('https://api.github.com')
    })
  })

  describe('Health Check', () => {
    it('should return healthy status with rate limit info', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          resources: {
            core: { limit: 5000, remaining: 4999, reset: 1704067200 },
            search: { limit: 30, remaining: 29, reset: 1704067200 },
          },
        }),
        headers: new Headers(),
      })

      const health = await adapter.checkHealth()

      expect(health.healthy).toBe(true)
      expect(health.rateLimitRemaining).toBe(29)
      expect(health.rateLimitReset).toBeDefined()
    })

    it('should return unhealthy on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: new Headers(),
      })

      const health = await adapter.checkHealth()

      expect(health.healthy).toBe(false)
      expect(health.error).toBeDefined()
      expect(health.error!).toContain('503')
    })
  })

  describe('Search', () => {
    const mockSearchResponse = {
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          id: 1,
          full_name: 'owner1/skill-one',
          name: 'skill-one',
          owner: { login: 'owner1' },
          description: 'A test skill',
          html_url: 'https://github.com/owner1/skill-one',
          stargazers_count: 100,
          forks_count: 20,
          topics: ['claude-skill'],
          updated_at: '2024-01-01T00:00:00Z',
          created_at: '2023-01-01T00:00:00Z',
          default_branch: 'main',
          license: { spdx_id: 'MIT', name: 'MIT License' },
        },
        {
          id: 2,
          full_name: 'owner2/skill-two',
          name: 'skill-two',
          owner: { login: 'owner2' },
          description: 'Another skill',
          html_url: 'https://github.com/owner2/skill-two',
          stargazers_count: 50,
          forks_count: 10,
          topics: ['claude-code'],
          updated_at: '2024-01-02T00:00:00Z',
          created_at: '2023-02-01T00:00:00Z',
          default_branch: 'main',
          license: null,
        },
      ],
    }

    it('should search for repositories by default topics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSearchResponse,
        headers: new Headers(),
      })

      const result = await adapter.search({})

      expect(result.repositories).toHaveLength(2)
      expect(result.totalCount).toBe(2)
      // Check for URL-encoded topic (topic:claude-code-skill -> topic%3Aclaude-code-skill)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('topic%3Aclaude-code-skill'),
        expect.any(Object)
      )
    })

    it('should search with custom topics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSearchResponse,
        headers: new Headers(),
      })

      await adapter.search({ topics: ['custom-topic'] })

      // Check for URL-encoded topic
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('topic%3Acustom-topic'),
        expect.any(Object)
      )
    })

    it('should search with custom query', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSearchResponse,
        headers: new Headers(),
      })

      await adapter.search({ query: 'authentication' })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('authentication'),
        expect.any(Object)
      )
    })

    it('should map repository fields correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSearchResponse,
        headers: new Headers(),
      })

      const result = await adapter.search({})
      const repo = result.repositories[0]

      expect(repo.id).toBe('1')
      expect(repo.name).toBe('skill-one')
      expect(repo.owner).toBe('owner1')
      expect(repo.url).toBe('https://github.com/owner1/skill-one')
      expect(repo.description).toBe('A test skill')
      expect(repo.stars).toBe(100)
      expect(repo.forks).toBe(20)
      expect(repo.topics).toContain('claude-skill')
      expect(repo.defaultBranch).toBe('main')
      expect(repo.license).toBe('MIT')
    })

    it('should handle null license', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSearchResponse,
        headers: new Headers(),
      })

      const result = await adapter.search({})
      const repo = result.repositories[1]

      expect(repo.license).toBeNull()
    })

    it('should throw on rate limit', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
      })

      await expect(adapter.search({})).rejects.toThrow('rate limit')
    })

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
      })

      await expect(adapter.search({})).rejects.toThrow('GitHub API error: 500')
    })
  })

  describe('Get Repository', () => {
    const mockRepoResponse = {
      id: 123,
      full_name: 'test-owner/test-repo',
      name: 'test-repo',
      owner: { login: 'test-owner' },
      description: 'Test repository',
      html_url: 'https://github.com/test-owner/test-repo',
      stargazers_count: 42,
      forks_count: 5,
      topics: ['claude-skill'],
      updated_at: '2024-01-01T00:00:00Z',
      created_at: '2023-01-01T00:00:00Z',
      default_branch: 'main',
      license: { spdx_id: 'MIT', name: 'MIT License' },
    }

    it('should get repository by location', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockRepoResponse,
        headers: new Headers(),
      })

      const repo = await adapter.getRepository({
        owner: 'test-owner',
        repo: 'test-repo',
      })

      expect(repo.name).toBe('test-repo')
      expect(repo.owner).toBe('test-owner')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/test-owner/test-repo',
        expect.any(Object)
      )
    })

    it('should throw on repository not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      })

      await expect(adapter.getRepository({ owner: 'nobody', repo: 'nothing' })).rejects.toThrow(
        'Repository not found'
      )
    })
  })

  describe('Fetch Skill Content', () => {
    const mockSkillContent = {
      name: 'SKILL.md',
      path: 'SKILL.md',
      sha: 'abc123def456',
      content: Buffer.from('---\nname: "Test Skill"\ndescription: "A test"\n---\n# Test').toString(
        'base64'
      ),
      encoding: 'base64',
    }

    it('should fetch skill content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockSkillContent,
        headers: new Headers(),
      })

      const content = await adapter.fetchSkillContent({
        owner: 'test-owner',
        repo: 'test-repo',
      })

      expect(content.rawContent).toContain('Test Skill')
      expect(content.sha).toBe('abc123def456')
      expect(content.filePath).toBe('SKILL.md')
    })

    it('should try multiple file paths', async () => {
      // First path fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      })
      // Second path succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...mockSkillContent,
          path: 'skill.md',
        }),
        headers: new Headers(),
      })

      const content = await adapter.fetchSkillContent({
        owner: 'test-owner',
        repo: 'test-repo',
      })

      expect(content.filePath).toBe('skill.md')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('should use custom path when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ...mockSkillContent,
          path: 'custom/SKILL.md',
        }),
        headers: new Headers(),
      })

      await adapter.fetchSkillContent({
        owner: 'test-owner',
        repo: 'test-repo',
        path: 'custom/SKILL.md',
      })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('custom/SKILL.md'),
        expect.any(Object)
      )
    })

    it('should throw when no skill file found', async () => {
      // All paths fail
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
      })

      await expect(
        adapter.fetchSkillContent({
          owner: 'test-owner',
          repo: 'test-repo',
        })
      ).rejects.toThrow('No skill file found')
    })
  })

  describe('Skill Exists', () => {
    it('should return true when skill exists', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sha: 'abc123' }),
        headers: new Headers(),
      })

      const exists = await adapter.skillExists({
        owner: 'test-owner',
        repo: 'test-repo',
      })

      expect(exists).toBe(true)
    })

    it('should return false when skill does not exist', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
      })

      const exists = await adapter.skillExists({
        owner: 'test-owner',
        repo: 'test-repo',
      })

      expect(exists).toBe(false)
    })
  })

  describe('Get Skill SHA', () => {
    it('should return SHA when skill exists', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sha: 'abc123def456' }),
        headers: new Headers(),
      })

      const sha = await adapter.getSkillSha({
        owner: 'test-owner',
        repo: 'test-repo',
      })

      expect(sha).toBe('abc123def456')
    })

    it('should return null when skill does not exist', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
      })

      const sha = await adapter.getSkillSha({
        owner: 'test-owner',
        repo: 'test-repo',
      })

      expect(sha).toBeNull()
    })
  })

  describe('Authentication', () => {
    it('should include auth header when token provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ resources: { search: { remaining: 30, reset: 0 } } }),
      })

      await adapter.checkHealth()

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.any(Headers),
        })
      )

      const callArgs = mockFetch.mock.calls[0]
      const headers = callArgs[1]?.headers as Headers
      expect(headers.get('Authorization')).toBe('Bearer test-token')
    })
  })

  describe('createGitHubAdapter Factory', () => {
    it('should create adapter with defaults', () => {
      const adapter = createGitHubAdapter({
        id: 'factory-test',
        name: 'Factory Test',
        enabled: true,
      })

      expect(adapter.id).toBe('factory-test')
      expect(adapter.type).toBe('github')
      expect(adapter.config.baseUrl).toBe('https://api.github.com')
    })
  })
})
