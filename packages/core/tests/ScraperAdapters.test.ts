/**
 * Scraper Adapters Tests (SMI-591)
 *
 * Tests for RawUrlSourceAdapter and GitLabSourceAdapter.
 *
 * LocalFilesystemAdapter tests live in `LocalFilesystemAdapter.test.ts`
 * (extracted by SMI-4287 to keep this file under the 500-line governance
 * ceiling and avoid a duplicate `describe` block — see SMI-4286 retro).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RawUrlSourceAdapter } from '../src/sources/RawUrlSourceAdapter.js'
import { GitLabSourceAdapter } from '../src/sources/GitLabSourceAdapter.js'

// Mock fetch for network adapters
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('RawUrlSourceAdapter (SMI-591)', () => {
  let adapter: RawUrlSourceAdapter

  beforeEach(() => {
    mockFetch.mockReset()
    adapter = new RawUrlSourceAdapter({
      id: 'test-raw-url',
      name: 'Test Raw URL',
      type: 'raw-url',
      baseUrl: 'https://example.com',
      enabled: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      skillUrls: [
        {
          id: '1',
          name: 'Test Skill 1',
          url: 'https://example.com/skills/skill1.md',
          description: 'First test skill',
          tags: ['test', 'example'],
        },
        {
          id: '2',
          name: 'Test Skill 2',
          url: 'https://example.com/skills/skill2.md',
          tags: ['test'],
        },
      ],
    })
  })

  describe('Initialization', () => {
    it('should initialize with predefined skill URLs', async () => {
      const urls = adapter.getSkillUrls()
      expect(urls).toHaveLength(2)
      expect(urls[0].name).toBe('Test Skill 1')
    })

    it('should have correct type', () => {
      expect(adapter.type).toBe('raw-url')
    })
  })

  describe('Health Check', () => {
    it('should return healthy when base URL is reachable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
      })

      const health = await adapter.checkHealth()
      expect(health.healthy).toBe(true)
    })

    it('should return unhealthy when base URL is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const health = await adapter.checkHealth()
      expect(health.healthy).toBe(false)
    })
  })

  describe('Search', () => {
    it('should return all skills when no filters', async () => {
      const result = await adapter.search({})
      expect(result.repositories).toHaveLength(2)
      expect(result.totalCount).toBe(2)
    })

    it('should filter by query', async () => {
      const result = await adapter.search({ query: 'First' })
      expect(result.repositories).toHaveLength(1)
      expect(result.repositories[0].name).toBe('Test Skill 1')
    })

    it('should filter by topics', async () => {
      const result = await adapter.search({ topics: ['example'] })
      expect(result.repositories).toHaveLength(1)
      expect(result.repositories[0].name).toBe('Test Skill 1')
    })

    it('should apply limit', async () => {
      const result = await adapter.search({ limit: 1 })
      expect(result.repositories).toHaveLength(1)
      expect(result.hasMore).toBe(true)
    })
  })

  describe('Fetch Skill Content', () => {
    it('should fetch skill content from URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        text: async () => '---\nname: Test\n---\n# Test Skill',
      })

      const content = await adapter.fetchSkillContent({
        repo: '1',
        path: 'https://example.com/skills/skill1.md',
      })

      expect(content.rawContent).toContain('# Test Skill')
      expect(content.sha).toBeDefined()
    })

    it('should throw error when fetch fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      })

      await expect(
        adapter.fetchSkillContent({
          repo: 'unknown',
          path: 'https://example.com/unknown.md',
        })
      ).rejects.toThrow('Failed to fetch skill content')
    })
  })

  describe('Registry Loading (SMI-724)', () => {
    it('should handle registry loading failure gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
      })

      const adapterWithRegistry = new RawUrlSourceAdapter({
        id: 'test-registry-fail',
        name: 'Test Registry Fail',
        type: 'raw-url',
        baseUrl: 'https://example.com',
        enabled: true,
        registryUrl: 'https://example.com/registry.json',
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      // Should not throw - registry load is optional
      await expect(adapterWithRegistry.initialize()).resolves.not.toThrow()
      // No skills from registry
      expect(adapterWithRegistry.getSkillUrls()).toHaveLength(0)
    })

    it('should merge registry skills with predefined skills', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          skills: [
            {
              id: 'registry-1',
              name: 'Registry Skill',
              url: 'https://example.com/registry-skill.md',
            },
          ],
        }),
      })

      const adapterWithBoth = new RawUrlSourceAdapter({
        id: 'test-merge',
        name: 'Test Merge',
        type: 'raw-url',
        baseUrl: 'https://example.com',
        enabled: true,
        registryUrl: 'https://example.com/registry.json',
        skillUrls: [
          {
            id: 'predefined-1',
            name: 'Predefined Skill',
            url: 'https://example.com/predefined.md',
          },
        ],
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await adapterWithBoth.initialize()
      expect(adapterWithBoth.getSkillUrls()).toHaveLength(2)
    })
  })

  describe('Skill URL Management', () => {
    it('should add skill URL', () => {
      adapter.addSkillUrl({
        id: '3',
        name: 'New Skill',
        url: 'https://example.com/new.md',
      })

      const urls = adapter.getSkillUrls()
      expect(urls).toHaveLength(3)
    })

    it('should remove skill URL', () => {
      const removed = adapter.removeSkillUrl('1')
      expect(removed).toBe(true)
      expect(adapter.getSkillUrls()).toHaveLength(1)
    })

    it('should return false when removing non-existent URL', () => {
      const removed = adapter.removeSkillUrl('999')
      expect(removed).toBe(false)
    })
  })
})

describe('GitLabSourceAdapter (SMI-591)', () => {
  let adapter: GitLabSourceAdapter

  beforeEach(() => {
    mockFetch.mockReset()
    adapter = new GitLabSourceAdapter({
      id: 'test-gitlab',
      name: 'Test GitLab',
      type: 'gitlab',
      baseUrl: 'https://gitlab.com/api/v4',
      enabled: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })
  })

  describe('Initialization', () => {
    it('should have correct type', () => {
      expect(adapter.type).toBe('gitlab')
    })
  })

  describe('Health Check', () => {
    it('should return healthy when API is reachable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'ratelimit-remaining': '100',
          'ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        }),
        json: async () => ({ version: '15.0.0' }),
      })

      const health = await adapter.checkHealth()
      expect(health.healthy).toBe(true)
    })

    it('should return unhealthy when API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
      })

      const health = await adapter.checkHealth()
      expect(health.healthy).toBe(false)
    })
  })

  describe('Search', () => {
    it('should search for projects with topics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'x-total': '2',
          'x-total-pages': '1',
        }),
        json: async () => [
          {
            id: 1,
            name: 'Skill Repo',
            path_with_namespace: 'user/skill-repo',
            namespace: { path: 'user', name: 'User' },
            description: 'A skill repository',
            web_url: 'https://gitlab.com/user/skill-repo',
            star_count: 10,
            forks_count: 5,
            topics: ['claude-skill'],
            last_activity_at: '2024-01-01T00:00:00Z',
            created_at: '2023-01-01T00:00:00Z',
            default_branch: 'main',
          },
        ],
      })

      const result = await adapter.search({ topics: ['claude-skill'] })

      expect(result.repositories).toHaveLength(1)
      expect(result.repositories[0].name).toBe('Skill Repo')
      expect(result.repositories[0].owner).toBe('user')
    })

    it('should throw on rate limit', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers(),
      })

      await expect(adapter.search({})).rejects.toThrow('rate limit')
    })
  })

  describe('Paginated Search (SMI-724)', () => {
    it('should handle searchWithCursor pagination', async () => {
      // First page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'x-total': '50',
          'x-total-pages': '2',
        }),
        json: async () => [
          {
            id: 1,
            name: 'Skill 1',
            path_with_namespace: 'user/skill-1',
            namespace: { path: 'user', name: 'User' },
            description: 'First skill',
            web_url: 'https://gitlab.com/user/skill-1',
            star_count: 10,
            forks_count: 5,
            topics: ['claude-skill'],
            last_activity_at: '2024-01-01T00:00:00Z',
            created_at: '2023-01-01T00:00:00Z',
            default_branch: 'main',
          },
        ],
      })

      const result = await adapter.searchWithCursor({ limit: 30 }, 1)

      expect(result.repositories).toHaveLength(1)
      expect(result.hasMore).toBe(true)
      expect(result.nextCursor).toBe('2')
    })

    it('should indicate no more pages on last page', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'x-total': '25',
          'x-total-pages': '1',
        }),
        json: async () => [
          {
            id: 1,
            name: 'Skill 1',
            path_with_namespace: 'user/skill-1',
            namespace: { path: 'user', name: 'User' },
            description: 'Only skill',
            web_url: 'https://gitlab.com/user/skill-1',
            star_count: 5,
            forks_count: 2,
            topics: ['claude-skill'],
            last_activity_at: '2024-01-01T00:00:00Z',
            created_at: '2023-01-01T00:00:00Z',
            default_branch: 'main',
          },
        ],
      })

      const result = await adapter.searchWithCursor({}, 1)

      expect(result.hasMore).toBe(false)
      expect(result.nextCursor).toBeUndefined()
    })
  })

  describe('Get Repository', () => {
    it('should get repository by location', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          id: 1,
          name: 'skill-repo',
          path_with_namespace: 'user/skill-repo',
          namespace: { path: 'user', name: 'User' },
          description: 'A skill repository',
          web_url: 'https://gitlab.com/user/skill-repo',
          star_count: 10,
          forks_count: 5,
          topics: [],
          last_activity_at: '2024-01-01T00:00:00Z',
          created_at: '2023-01-01T00:00:00Z',
          default_branch: 'main',
        }),
      })

      const repo = await adapter.getRepository({ owner: 'user', repo: 'skill-repo' })

      expect(repo.name).toBe('skill-repo')
      expect(repo.owner).toBe('user')
    })

    it('should throw for non-existent repository', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      })

      await expect(adapter.getRepository({ owner: 'user', repo: 'nonexistent' })).rejects.toThrow(
        'not found'
      )
    })
  })

  describe('Fetch Skill Content', () => {
    it('should fetch and decode skill content', async () => {
      const content = '---\nname: Test\n---\n# Test Skill'
      const base64Content = Buffer.from(content).toString('base64')

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          file_name: 'SKILL.md',
          file_path: 'SKILL.md',
          content: base64Content,
          encoding: 'base64',
          content_sha256: 'abc123',
          last_commit_id: 'def456',
        }),
      })

      const result = await adapter.fetchSkillContent({
        owner: 'user',
        repo: 'skill-repo',
      })

      expect(result.rawContent).toBe(content)
      expect(result.sha).toBe('abc123')
    })

    it('should try multiple skill file paths', async () => {
      // First path fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      })

      // Second path succeeds
      const content = '# Skill'
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          file_name: 'skill.md',
          file_path: 'skill.md',
          content: Buffer.from(content).toString('base64'),
          encoding: 'base64',
          content_sha256: 'xyz789',
        }),
      })

      const result = await adapter.fetchSkillContent({
        owner: 'user',
        repo: 'skill-repo',
      })

      expect(result.rawContent).toBe(content)
    })
  })
})
