/**
 * Scraper Adapters Tests (SMI-591)
 *
 * Tests for RawUrlSourceAdapter, LocalFilesystemAdapter, and GitLabSourceAdapter
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RawUrlSourceAdapter, type SkillUrlEntry } from '../src/sources/RawUrlSourceAdapter.js'
import { LocalFilesystemAdapter } from '../src/sources/LocalFilesystemAdapter.js'
import { GitLabSourceAdapter } from '../src/sources/GitLabSourceAdapter.js'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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

describe('LocalFilesystemAdapter (SMI-591)', () => {
  let adapter: LocalFilesystemAdapter
  let testDir: string

  beforeEach(async () => {
    // Create test directory structure
    testDir = join(tmpdir(), `skillsmith-test-${Date.now()}`)
    await fs.mkdir(testDir, { recursive: true })

    // Create test skill files
    await fs.mkdir(join(testDir, 'skill-one'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'skill-one', 'SKILL.md'),
      '---\nname: Skill One\ndescription: First skill\n---\n# Skill One'
    )

    await fs.mkdir(join(testDir, 'skill-two'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'skill-two', 'SKILL.md'),
      '---\nname: Skill Two\n---\n# Skill Two'
    )

    // Create node_modules (should be excluded)
    await fs.mkdir(join(testDir, 'node_modules', 'some-module'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'node_modules', 'some-module', 'SKILL.md'),
      '# Should be excluded'
    )

    adapter = new LocalFilesystemAdapter({
      id: 'test-local',
      name: 'Test Local',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })

    await adapter.initialize()
  })

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('Initialization', () => {
    it('should discover skill files in root directory', () => {
      expect(adapter.skillCount).toBe(2)
    })

    it('should exclude node_modules', () => {
      expect(adapter.skillCount).toBe(2) // Only skill-one and skill-two
    })
  })

  describe('Health Check', () => {
    it('should return healthy when root directory exists', async () => {
      const health = await adapter.checkHealth()
      expect(health.healthy).toBe(true)
    })

    it('should return unhealthy when root directory does not exist', async () => {
      const badAdapter = new LocalFilesystemAdapter({
        id: 'bad',
        name: 'Bad',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: '/nonexistent/path',
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      const health = await badAdapter.checkHealth()
      expect(health.healthy).toBe(false)
    })
  })

  describe('Search', () => {
    it('should return all discovered skills', async () => {
      const result = await adapter.search({})
      expect(result.repositories).toHaveLength(2)
    })

    it('should filter by query', async () => {
      const result = await adapter.search({ query: 'skill-one' })
      expect(result.repositories).toHaveLength(1)
      expect(result.repositories[0].name).toBe('Skill One')
    })

    it('should extract name from frontmatter', async () => {
      const result = await adapter.search({})
      const names = result.repositories.map((r) => r.name)
      expect(names).toContain('Skill One')
      expect(names).toContain('Skill Two')
    })

    it('should extract description from frontmatter', async () => {
      const result = await adapter.search({})
      const skillOne = result.repositories.find((r) => r.name === 'Skill One')
      expect(skillOne?.description).toBe('First skill')
    })
  })

  describe('Fetch Skill Content', () => {
    it('should fetch skill content by path', async () => {
      const content = await adapter.fetchSkillContent({
        path: join(testDir, 'skill-one', 'SKILL.md'),
      })

      expect(content.rawContent).toContain('# Skill One')
      expect(content.sha).toBeDefined()
    })

    it('should throw error for non-existent skill', async () => {
      await expect(
        adapter.fetchSkillContent({
          path: join(testDir, 'nonexistent', 'SKILL.md'),
        })
      ).rejects.toThrow('Failed to read skill file')
    })
  })

  describe('Skill Exists', () => {
    it('should return true for existing skill', async () => {
      const exists = await adapter.skillExists({
        path: join(testDir, 'skill-one', 'SKILL.md'),
      })
      expect(exists).toBe(true)
    })

    it('should return false for non-existent skill', async () => {
      const exists = await adapter.skillExists({
        path: join(testDir, 'nonexistent', 'SKILL.md'),
      })
      expect(exists).toBe(false)
    })
  })

  describe('Rescan', () => {
    it('should discover newly added skills', async () => {
      // Add a new skill
      await fs.mkdir(join(testDir, 'skill-three'), { recursive: true })
      await fs.writeFile(join(testDir, 'skill-three', 'SKILL.md'), '# Skill Three')

      // Rescan
      const count = await adapter.rescan()
      expect(count).toBe(3)
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
        headers: new Map([
          ['ratelimit-remaining', '100'],
          ['ratelimit-reset', String(Math.floor(Date.now() / 1000) + 3600)],
        ]),
        json: async () => ({ version: '15.0.0' }),
      })

      const health = await adapter.checkHealth()
      expect(health.healthy).toBe(true)
    })

    it('should return unhealthy when API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Map(),
      })

      const health = await adapter.checkHealth()
      expect(health.healthy).toBe(false)
    })
  })

  describe('Search', () => {
    it('should search for projects with topics', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ['x-total', '2'],
          ['x-total-pages', '1'],
        ]),
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
        headers: new Map(),
      })

      await expect(adapter.search({})).rejects.toThrow('rate limit')
    })
  })

  describe('Get Repository', () => {
    it('should get repository by location', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
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
        headers: new Map(),
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
        headers: new Map(),
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
        headers: new Map(),
      })

      // Second path succeeds
      const content = '# Skill'
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map(),
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
