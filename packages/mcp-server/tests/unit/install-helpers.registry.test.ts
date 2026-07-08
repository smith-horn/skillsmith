/**
 * @fileoverview Tests for install.helpers.ts registry-lookup + GitHub-fetch functions
 * @module @skillsmith/mcp-server/tests/unit/install-helpers.registry
 *
 * Split out of install-helpers.test.ts (SMI-5582) to stay under the
 * 500-line/file cap — this half covers the network-facing registry lookup
 * and raw.githubusercontent.com fetch path; the sibling file covers
 * ID/URL parsing and the manifest-lock/load/save helpers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { lookupSkillFromRegistry, fetchFromGitHub } from '../../src/tools/install.helpers.js'
import type { ToolContext } from '../../src/context.js'

// Mock global fetch
const mockFetch = vi.fn()
global.fetch = mockFetch

describe('install.helpers (registry + fetch)', () => {
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
      // SMI-5582: fetch now carries a 10s AbortSignal.timeout() option.
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/owner/repo/main/SKILL.md',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
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
        'https://raw.githubusercontent.com/owner/repo/develop/file.md',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
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
        'https://raw.githubusercontent.com/owner/repo/master/SKILL.md',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
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

    // SMI-3221: git-crypt encrypted content detection in fetch paths
    it('throws encrypted error when main returns git-crypt content', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('\x00GITCRYPT\x00\x12\x34'),
      })

      await expect(fetchFromGitHub('owner', 'repo', 'SKILL.md')).rejects.toThrow(
        'git-crypt encrypted'
      )
    })

    it('throws encrypted error when master fallback returns git-crypt content', async () => {
      // main fails with 404, master returns encrypted content
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('\x00GITCRYPT\x00\x56\x78'),
      })

      await expect(fetchFromGitHub('owner', 'repo', 'SKILL.md')).rejects.toThrow(
        'git-crypt encrypted'
      )
    })
  })
})
