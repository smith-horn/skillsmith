/**
 * Scraper Adapters Tests (SMI-591)
 *
 * Tests for RawUrlSourceAdapter, LocalFilesystemAdapter, and GitLabSourceAdapter
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { RawUrlSourceAdapter } from '../src/sources/RawUrlSourceAdapter.js'
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

  describe('Path Traversal Prevention (SMI-720)', () => {
    it('should reject relative path traversal with ../', async () => {
      await expect(
        adapter.fetchSkillContent({
          path: '../../../etc/passwd',
        })
      ).rejects.toThrow('Path traversal detected')
    })

    it('should reject deeply nested path traversal', async () => {
      await expect(
        adapter.fetchSkillContent({
          path: 'skill-one/../../../../../../etc/shadow',
        })
      ).rejects.toThrow('Path traversal detected')
    })

    it('should reject absolute paths outside rootDir', async () => {
      await expect(
        adapter.fetchSkillContent({
          path: '/etc/passwd',
        })
      ).rejects.toThrow('Path traversal detected')
    })

    it('should reject path traversal via owner/repo', async () => {
      await expect(
        adapter.getRepository({
          owner: '..',
          repo: '../../../etc',
        })
      ).rejects.toThrow('Path traversal detected')
    })

    it('should reject path traversal via repo only', async () => {
      await expect(
        adapter.skillExists({
          repo: '../../../etc/passwd',
        })
      ).rejects.toThrow('Path traversal detected')
    })

    it('should allow valid paths within rootDir', async () => {
      const exists = await adapter.skillExists({
        path: join(testDir, 'skill-one', 'SKILL.md'),
      })
      expect(exists).toBe(true)
    })

    it('should allow valid relative paths that stay within rootDir', async () => {
      const content = await adapter.fetchSkillContent({
        path: 'skill-one/SKILL.md',
      })
      expect(content.rawContent).toContain('# Skill One')
    })
  })

  describe('Symlink Handling (SMI-724)', () => {
    it('should skip symlinks by default', async () => {
      // Create a symlink to external directory
      const externalDir = join(tmpdir(), `external-${Date.now()}`)
      await fs.mkdir(externalDir, { recursive: true })
      await fs.writeFile(join(externalDir, 'SKILL.md'), '# External Skill')

      try {
        await fs.symlink(externalDir, join(testDir, 'symlink-skill'))
      } catch {
        // Skip test on platforms that don't support symlinks
        return
      }

      // Create new adapter (symlinks disabled by default)
      const newAdapter = new LocalFilesystemAdapter({
        id: 'test-symlink',
        name: 'Test Symlink',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        followSymlinks: false,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await newAdapter.initialize()
      // Should not include symlinked skill
      expect(newAdapter.skillCount).toBe(2)

      // Cleanup
      await fs.rm(externalDir, { recursive: true, force: true })
    })

    it('should follow symlinks when enabled', async () => {
      // Create a symlink to skill directory
      const externalDir = join(tmpdir(), `external-follow-${Date.now()}`)
      await fs.mkdir(externalDir, { recursive: true })
      await fs.writeFile(join(externalDir, 'SKILL.md'), '# Symlinked Skill')

      try {
        await fs.symlink(externalDir, join(testDir, 'symlink-follow'))
      } catch {
        // Skip test on platforms that don't support symlinks
        return
      }

      const followAdapter = new LocalFilesystemAdapter({
        id: 'test-follow-symlink',
        name: 'Test Follow Symlink',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        followSymlinks: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await followAdapter.initialize()
      // Should include symlinked skill
      expect(followAdapter.skillCount).toBe(3)

      // Cleanup
      await fs.rm(externalDir, { recursive: true, force: true })
    })
  })

  describe('Deep Directory Structures (SMI-724)', () => {
    it('should respect maxDepth limit', async () => {
      // Create deeply nested skill
      const deepPath = join(testDir, 'level1', 'level2', 'level3', 'level4', 'level5', 'level6')
      await fs.mkdir(deepPath, { recursive: true })
      await fs.writeFile(join(deepPath, 'SKILL.md'), '# Deep Skill')

      const shallowAdapter = new LocalFilesystemAdapter({
        id: 'test-shallow',
        name: 'Test Shallow',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        maxDepth: 3, // Only go 3 levels deep
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await shallowAdapter.initialize()
      // Should not find the deep skill (at level 6)
      expect(shallowAdapter.skillCount).toBe(2)
    })

    it('should find skills within maxDepth', async () => {
      // Create skill at level 3
      const level3Path = join(testDir, 'a', 'b', 'c')
      await fs.mkdir(level3Path, { recursive: true })
      await fs.writeFile(join(level3Path, 'SKILL.md'), '# Level 3 Skill')

      const deepAdapter = new LocalFilesystemAdapter({
        id: 'test-deep',
        name: 'Test Deep',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        maxDepth: 5,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await deepAdapter.initialize()
      // Should find the level 3 skill
      expect(deepAdapter.skillCount).toBe(3)
    })
  })

  describe('Invalid Regex Patterns (SMI-722)', () => {
    it('should not crash with invalid regex patterns like unclosed parenthesis', async () => {
      // Create adapter with invalid regex pattern that would crash without fix
      const adapterWithInvalidPattern = new LocalFilesystemAdapter({
        id: 'test-invalid-regex',
        name: 'Test Invalid Regex',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        excludePatterns: ['(', 'node_modules'], // '(' is invalid regex
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      // Should not throw during initialization
      await expect(adapterWithInvalidPattern.initialize()).resolves.not.toThrow()
      expect(adapterWithInvalidPattern.skillCount).toBe(2)
    })

    it('should fall back to includes check for invalid regex patterns', async () => {
      // Create a directory that contains the invalid pattern as substring
      await fs.mkdir(join(testDir, 'test(dir'), { recursive: true })
      await fs.writeFile(join(testDir, 'test(dir', 'SKILL.md'), '# Test Paren Dir')

      const adapterWithInvalidPattern = new LocalFilesystemAdapter({
        id: 'test-includes-fallback',
        name: 'Test Includes Fallback',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        excludePatterns: ['(', 'node_modules'], // '(' should match via includes
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await adapterWithInvalidPattern.initialize()
      // test(dir should be excluded because it includes '('
      expect(adapterWithInvalidPattern.skillCount).toBe(2)
    })

    it('should handle multiple invalid regex patterns', async () => {
      const adapterWithMultipleInvalid = new LocalFilesystemAdapter({
        id: 'test-multiple-invalid',
        name: 'Test Multiple Invalid',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        excludePatterns: ['[invalid', '(unclosed', '*bad', 'node_modules'],
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await expect(adapterWithMultipleInvalid.initialize()).resolves.not.toThrow()
      expect(adapterWithMultipleInvalid.skillCount).toBe(2)
    })

    it('should still work with valid regex patterns', async () => {
      // Create a directory matching a valid regex pattern
      await fs.mkdir(join(testDir, 'test-temp-123'), { recursive: true })
      await fs.writeFile(join(testDir, 'test-temp-123', 'SKILL.md'), '# Temp Skill')

      const adapterWithValidRegex = new LocalFilesystemAdapter({
        id: 'test-valid-regex',
        name: 'Test Valid Regex',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        excludePatterns: ['test-temp-\\d+', 'node_modules'], // Valid regex
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await adapterWithValidRegex.initialize()
      // test-temp-123 should be excluded by valid regex
      expect(adapterWithValidRegex.skillCount).toBe(2)
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
