/**
 * LocalFilesystemAdapter test suite
 *
 * SMI-591: original adapter tests (extracted from ScraperAdapters.test.ts by
 * SMI-4287 so the file stays under the governance 500-line ceiling).
 *
 * SMI-4287-specific symlink, permission, loop, and case-insensitive coverage
 * lives in the sidecar `LocalFilesystemAdapter.coverage.test.ts` — keeping
 * the two split prevents this file from crossing 500 lines again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalFilesystemAdapter } from '../src/sources/LocalFilesystemAdapter.js'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('LocalFilesystemAdapter (SMI-591)', () => {
  let adapter: LocalFilesystemAdapter
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `skillsmith-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(testDir, { recursive: true })

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
      expect(adapter.skillCount).toBe(2)
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

    it('should omit warnings field when the scan is clean (SMI-4287)', async () => {
      const result = await adapter.search({})
      expect(result.warnings).toBeUndefined()
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
      await fs.mkdir(join(testDir, 'skill-three'), { recursive: true })
      await fs.writeFile(join(testDir, 'skill-three', 'SKILL.md'), '# Skill Three')

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

  describe('Symlink Handling (SMI-724) — baseline', () => {
    it('should skip symlinks by default', async () => {
      const externalDir = join(tmpdir(), `external-${Date.now()}`)
      await fs.mkdir(externalDir, { recursive: true })
      await fs.writeFile(join(externalDir, 'SKILL.md'), '# External Skill')

      try {
        await fs.symlink(externalDir, join(testDir, 'symlink-skill'))
      } catch {
        return
      }

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
      expect(newAdapter.skillCount).toBe(2)

      await fs.rm(externalDir, { recursive: true, force: true })
    })
  })

  describe('Deep Directory Structures (SMI-724)', () => {
    it('should respect maxDepth limit', async () => {
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
        maxDepth: 3,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await shallowAdapter.initialize()
      expect(shallowAdapter.skillCount).toBe(2)
    })

    it('should find skills within maxDepth', async () => {
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
      expect(deepAdapter.skillCount).toBe(3)
    })
  })

  describe('Invalid Regex Patterns (SMI-722)', () => {
    it('should not crash with invalid regex patterns like unclosed parenthesis', async () => {
      const adapterWithInvalidPattern = new LocalFilesystemAdapter({
        id: 'test-invalid-regex',
        name: 'Test Invalid Regex',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        excludePatterns: ['(', 'node_modules'],
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await expect(adapterWithInvalidPattern.initialize()).resolves.not.toThrow()
      expect(adapterWithInvalidPattern.skillCount).toBe(2)
    })

    it('should fall back to includes check for invalid regex patterns', async () => {
      await fs.mkdir(join(testDir, 'test(dir'), { recursive: true })
      await fs.writeFile(join(testDir, 'test(dir', 'SKILL.md'), '# Test Paren Dir')

      const adapterWithInvalidPattern = new LocalFilesystemAdapter({
        id: 'test-includes-fallback',
        name: 'Test Includes Fallback',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        excludePatterns: ['(', 'node_modules'],
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await adapterWithInvalidPattern.initialize()
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
      await fs.mkdir(join(testDir, 'test-temp-123'), { recursive: true })
      await fs.writeFile(join(testDir, 'test-temp-123', 'SKILL.md'), '# Temp Skill')

      const adapterWithValidRegex = new LocalFilesystemAdapter({
        id: 'test-valid-regex',
        name: 'Test Valid Regex',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        excludePatterns: ['test-temp-\\d+', 'node_modules'],
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await adapterWithValidRegex.initialize()
      expect(adapterWithValidRegex.skillCount).toBe(2)
    })
  })
})
