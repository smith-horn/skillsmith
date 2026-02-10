/**
 * @fileoverview Tests for install.helpers.ts functions
 * @module @skillsmith/mcp-server/tests/unit/install-helpers
 *
 * SMI-1721: Comprehensive tests to improve coverage from 36% to 80%+
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs/promises'
import type { Stats } from 'fs'
import {
  parseSkillId,
  parseRepoUrl,
  validateSkillMd,
  generateTips,
  acquireManifestLock,
  releaseManifestLock,
  loadManifest,
  saveManifest,
  updateManifestSafely,
  lookupSkillFromRegistry,
  fetchFromGitHub,
} from '../../src/tools/install.helpers.js'
import type { ToolContext } from '../../src/context.js'

// Mock fs module
vi.mock('fs/promises')

// Mock global fetch
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('install.helpers', () => {
  describe('parseSkillId', () => {
    it('parses full GitHub URL', () => {
      const result = parseSkillId('https://github.com/owner/repo')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
        isRegistryId: false,
      })
    })

    it('parses GitHub URL with path', () => {
      const result = parseSkillId('https://github.com/owner/repo/tree/main/skills/my-skill')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'tree/main/skills/my-skill',
        isRegistryId: false,
      })
    })

    it('parses 2-part registry ID', () => {
      const result = parseSkillId('author/skill-name')
      expect(result).toEqual({
        owner: 'author',
        repo: 'skill-name',
        path: '',
        isRegistryId: true,
      })
    })

    it('parses 3-part direct reference', () => {
      const result = parseSkillId('owner/repo/skills/my-skill')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'skills/my-skill',
        isRegistryId: false,
      })
    })

    it('throws for invalid format', () => {
      expect(() => parseSkillId('invalid')).toThrow('Invalid skill ID format')
    })
  })

  describe('parseRepoUrl', () => {
    it('parses simple GitHub URL', () => {
      const result = parseRepoUrl('https://github.com/owner/repo')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
        branch: 'main',
      })
    })

    it('parses GitHub URL with tree path', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/tree/develop/src/skills')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'src/skills',
        branch: 'develop',
      })
    })

    it('parses GitHub URL with blob path', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/blob/feature/path/file.md')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'path/file.md',
        branch: 'feature',
      })
    })

    it('rejects non-GitHub hosts', () => {
      expect(() => parseRepoUrl('https://gitlab.com/owner/repo')).toThrow('Invalid repository host')
    })

    it('rejects malicious hosts', () => {
      expect(() => parseRepoUrl('https://evil.com/owner/repo')).toThrow('Invalid repository host')
    })

    it('accepts www.github.com', () => {
      const result = parseRepoUrl('https://www.github.com/owner/repo')
      expect(result.owner).toBe('owner')
      expect(result.repo).toBe('repo')
    })
  })

  describe('validateSkillMd', () => {
    it('validates valid SKILL.md', () => {
      const content = `# My Skill

This is a skill that does something useful. It has enough content to pass validation.

## Usage
Use this skill to do things.
`
      const result = validateSkillMd(content)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects missing title', () => {
      const content =
        'This is content without a heading. It is long enough but has no title marker.'
      const result = validateSkillMd(content)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing title (# heading)')
    })

    it('rejects too short content', () => {
      const content = '# Title\n\nToo short.'
      const result = validateSkillMd(content)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('SKILL.md is too short (minimum 100 characters)')
    })

    it('collects multiple errors', () => {
      const content = 'No title, too short'
      const result = validateSkillMd(content)
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBe(2)
    })
  })

  describe('generateTips', () => {
    it('generates tips with skill name', () => {
      const tips = generateTips('my-skill')
      expect(tips).toHaveLength(4)
      expect(tips[0]).toContain('my-skill')
      expect(tips[0]).toContain('installed successfully')
    })

    it('includes usage instructions', () => {
      const tips = generateTips('test-skill')
      expect(tips.some((t) => t.includes('Use the test-skill skill'))).toBe(true)
    })

    it('includes ls command', () => {
      const tips = generateTips('any-skill')
      expect(tips.some((t) => t.includes('ls ~/.claude/skills/'))).toBe(true)
    })

    it('includes uninstall hint', () => {
      const tips = generateTips('any-skill')
      expect(tips.some((t) => t.includes('uninstall_skill'))).toBe(true)
    })
  })

  // ============================================================================
  // SMI-1721: New tests for async/file system functions
  // ============================================================================

  describe('acquireManifestLock', () => {
    const mockWriteFile = vi.mocked(fs.writeFile)
    const mockStat = vi.mocked(fs.stat)
    const mockUnlink = vi.mocked(fs.unlink)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('acquires lock successfully on first try', async () => {
      mockWriteFile.mockResolvedValueOnce(undefined)

      await expect(acquireManifestLock()).resolves.toBeUndefined()
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('manifest.json.lock'),
        expect.any(String),
        { flag: 'wx' }
      )
    })

    it('retries when lock exists and eventually succeeds', async () => {
      // First call fails with EEXIST, second succeeds
      const existsError = new Error('EEXIST') as NodeJS.ErrnoException
      existsError.code = 'EEXIST'

      mockWriteFile.mockRejectedValueOnce(existsError).mockResolvedValueOnce(undefined)

      // Mock stat to show lock is NOT stale (recent)
      mockStat.mockResolvedValueOnce({
        mtimeMs: Date.now() - 1000, // 1 second old
      } as Stats)

      await expect(acquireManifestLock()).resolves.toBeUndefined()
      expect(mockWriteFile).toHaveBeenCalledTimes(2)
    })

    it('removes stale lock and acquires', async () => {
      const existsError = new Error('EEXIST') as NodeJS.ErrnoException
      existsError.code = 'EEXIST'

      mockWriteFile.mockRejectedValueOnce(existsError).mockResolvedValueOnce(undefined)

      // Mock stat to show lock is stale (old)
      mockStat.mockResolvedValueOnce({
        mtimeMs: Date.now() - 60000, // 60 seconds old (stale)
      } as Stats)

      mockUnlink.mockResolvedValueOnce(undefined)

      await expect(acquireManifestLock()).resolves.toBeUndefined()
      expect(mockUnlink).toHaveBeenCalled()
    })

    it('throws non-EEXIST errors immediately', async () => {
      const permError = new Error('EACCES') as NodeJS.ErrnoException
      permError.code = 'EACCES'

      mockWriteFile.mockRejectedValueOnce(permError)

      await expect(acquireManifestLock()).rejects.toThrow('EACCES')
    })
  })

  describe('releaseManifestLock', () => {
    const mockUnlink = vi.mocked(fs.unlink)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('releases lock successfully', async () => {
      mockUnlink.mockResolvedValueOnce(undefined)

      await expect(releaseManifestLock()).resolves.toBeUndefined()
      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('manifest.json.lock'))
    })

    it('ignores errors when lock already released', async () => {
      mockUnlink.mockRejectedValueOnce(new Error('ENOENT'))

      // Should not throw
      await expect(releaseManifestLock()).resolves.toBeUndefined()
    })
  })

  describe('loadManifest', () => {
    const mockReadFile = vi.mocked(fs.readFile)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('loads existing manifest', async () => {
      const manifest = {
        version: '1.0.0',
        installedSkills: {
          'test/skill': {
            id: 'test/skill',
            name: 'test-skill',
            version: '1.0.0',
            source: 'github',
            installPath: '/path/to/skill',
            installedAt: '2024-01-01',
            lastUpdated: '2024-01-01',
          },
        },
      }

      mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))

      const result = await loadManifest()
      expect(result).toEqual(manifest)
    })

    it('returns empty manifest when file does not exist', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))

      const result = await loadManifest()
      expect(result).toEqual({
        version: '1.0.0',
        installedSkills: {},
      })
    })

    it('returns empty manifest on parse error', async () => {
      mockReadFile.mockResolvedValueOnce('invalid json {{{')

      const result = await loadManifest()
      expect(result).toEqual({
        version: '1.0.0',
        installedSkills: {},
      })
    })
  })

  describe('saveManifest', () => {
    const mockMkdir = vi.mocked(fs.mkdir)
    const mockWriteFile = vi.mocked(fs.writeFile)
    const mockRename = vi.mocked(fs.rename)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('saves manifest with atomic write', async () => {
      mockMkdir.mockResolvedValueOnce(undefined)
      mockWriteFile.mockResolvedValueOnce(undefined)
      mockRename.mockResolvedValueOnce(undefined)

      const manifest = {
        version: '1.0.0',
        installedSkills: {},
      }

      await saveManifest(manifest)

      expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true })
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp.'),
        JSON.stringify(manifest, null, 2)
      )
      expect(mockRename).toHaveBeenCalled()
    })
  })

  describe('updateManifestSafely', () => {
    const mockWriteFile = vi.mocked(fs.writeFile)
    const mockReadFile = vi.mocked(fs.readFile)
    const mockMkdir = vi.mocked(fs.mkdir)
    const mockRename = vi.mocked(fs.rename)
    const mockUnlink = vi.mocked(fs.unlink)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('acquires lock, updates, and releases lock', async () => {
      // Mock lock acquisition
      mockWriteFile.mockResolvedValue(undefined)
      // Mock load
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          version: '1.0.0',
          installedSkills: {},
        })
      )
      // Mock save
      mockMkdir.mockResolvedValueOnce(undefined)
      mockRename.mockResolvedValueOnce(undefined)
      // Mock release
      mockUnlink.mockResolvedValueOnce(undefined)

      const updateFn = vi.fn((m) => ({
        ...m,
        installedSkills: { 'new/skill': { id: 'new/skill' } },
      }))

      await updateManifestSafely(updateFn)

      expect(updateFn).toHaveBeenCalled()
      expect(mockUnlink).toHaveBeenCalled() // Lock released
    })

    it('releases lock even on error', async () => {
      // Mock lock acquisition
      mockWriteFile.mockResolvedValue(undefined)
      // Mock load - throw error
      mockReadFile.mockRejectedValueOnce(new Error('Read error'))
      // Mock release
      mockUnlink.mockResolvedValueOnce(undefined)

      const updateFn = vi.fn()

      // loadManifest catches errors and returns empty manifest
      // so this should still succeed
      await expect(updateManifestSafely(updateFn)).resolves.toBeUndefined()
    })
  })

  describe('lookupSkillFromRegistry', () => {
    it('returns skill info from API when online', async () => {
      const mockContext = {
        apiClient: {
          isOffline: () => false,
          getSkill: vi.fn().mockResolvedValue({
            data: {
              name: 'test-skill',
              repo_url: 'https://github.com/owner/repo',
              trust_tier: 'community',
            },
          }),
        },
        skillRepository: {
          findById: vi.fn(),
        },
      } as unknown as ToolContext

      const result = await lookupSkillFromRegistry('test/skill', mockContext)

      expect(result).toEqual({
        repoUrl: 'https://github.com/owner/repo',
        name: 'test-skill',
        trustTier: 'community',
        quarantined: false,
      })
      expect(mockContext.apiClient.getSkill).toHaveBeenCalledWith('test/skill')
    })

    it('falls back to local DB when API offline', async () => {
      const mockContext = {
        apiClient: {
          isOffline: () => true,
        },
        skillRepository: {
          findById: vi.fn().mockReturnValue({
            name: 'local-skill',
            repoUrl: 'https://github.com/local/repo',
            trustTier: 'experimental',
          }),
        },
        // SMI-2437: QuarantineRepository needs a db with exec() and prepare().all()
        db: {
          exec: vi.fn(),
          prepare: vi.fn().mockReturnValue({
            get: vi.fn(),
            all: vi.fn().mockReturnValue([]),
            run: vi.fn(),
          }),
        },
      } as unknown as ToolContext

      const result = await lookupSkillFromRegistry('local/skill', mockContext)

      expect(result).toEqual({
        repoUrl: 'https://github.com/local/repo',
        name: 'local-skill',
        trustTier: 'experimental',
        quarantined: false,
      })
    })

    it('falls back to local DB when API fails', async () => {
      const mockContext = {
        apiClient: {
          isOffline: () => false,
          getSkill: vi.fn().mockRejectedValue(new Error('API error')),
        },
        skillRepository: {
          findById: vi.fn().mockReturnValue({
            name: 'fallback-skill',
            repoUrl: 'https://github.com/fallback/repo',
            trustTier: 'community',
          }),
        },
        // SMI-2437: QuarantineRepository needs a db with exec() and prepare().all()
        db: {
          exec: vi.fn(),
          prepare: vi.fn().mockReturnValue({
            get: vi.fn(),
            all: vi.fn().mockReturnValue([]),
            run: vi.fn(),
          }),
        },
      } as unknown as ToolContext

      const result = await lookupSkillFromRegistry('fallback/skill', mockContext)

      expect(result).toEqual({
        repoUrl: 'https://github.com/fallback/repo',
        name: 'fallback-skill',
        trustTier: 'community',
        quarantined: false,
      })
    })

    it('returns null when skill not found anywhere', async () => {
      const mockContext = {
        apiClient: {
          isOffline: () => true,
        },
        skillRepository: {
          findById: vi.fn().mockReturnValue(null),
        },
      } as unknown as ToolContext

      const result = await lookupSkillFromRegistry('nonexistent/skill', mockContext)

      expect(result).toBeNull()
    })

    it('returns null when API returns skill without repo_url', async () => {
      const mockContext = {
        apiClient: {
          isOffline: () => false,
          getSkill: vi.fn().mockResolvedValue({
            data: {
              name: 'seed-skill',
              repo_url: null, // No repo URL (seed data)
            },
          }),
        },
        skillRepository: {
          findById: vi.fn().mockReturnValue(null),
        },
      } as unknown as ToolContext

      const result = await lookupSkillFromRegistry('seed/skill', mockContext)

      expect(result).toBeNull()
    })
  })

  describe('fetchFromGitHub', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mockFetch.mockReset()
    })

    it('fetches file from main branch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('# SKILL.md content'),
      })

      const result = await fetchFromGitHub('owner', 'repo', 'SKILL.md')

      expect(result).toBe('# SKILL.md content')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/owner/repo/main/SKILL.md'
      )
    })

    it('fetches from specified branch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('content from develop'),
      })

      const result = await fetchFromGitHub('owner', 'repo', 'file.md', 'develop')

      expect(result).toBe('content from develop')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/owner/repo/develop/file.md'
      )
    })

    it('falls back to master when main fails', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('content from master'),
      })

      const result = await fetchFromGitHub('owner', 'repo', 'SKILL.md')

      expect(result).toBe('content from master')
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch).toHaveBeenLastCalledWith(
        'https://raw.githubusercontent.com/owner/repo/master/SKILL.md'
      )
    })

    it('throws when both main and master fail', async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({ ok: false, status: 404 })

      await expect(fetchFromGitHub('owner', 'repo', 'SKILL.md')).rejects.toThrow(
        'Failed to fetch SKILL.md: 404'
      )
    })

    it('does not try master fallback for non-main branches', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 })

      await expect(fetchFromGitHub('owner', 'repo', 'SKILL.md', 'develop')).rejects.toThrow(
        'Failed to fetch SKILL.md: 404'
      )

      // Should only call once, no master fallback
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })
})
