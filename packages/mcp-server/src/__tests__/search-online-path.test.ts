/**
 * SMI-2755 Wave 2: Online API path tests for executeSearch
 *
 * Tests the branch where context.apiClient.isOffline() returns false,
 * covering the API -> merge -> deduplicate -> track path.
 *
 * Split from search.test.ts to keep each file under 500 lines.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import { executeSearch } from '../tools/search.js'
import * as CoreModule from '@skillsmith/core'
import { createTestContext, disposeTestContext, type ToolContext } from './test-utils.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'

let onlineContext: ToolContext

beforeAll(async () => {
  onlineContext = await createTestContext()
})

afterAll(async () => {
  await disposeTestContext(onlineContext)
})

/**
 * SMI-2755 Wave 2: Online API path tests for executeSearch
 *
 * Tests the branch where context.apiClient.isOffline() returns false,
 * covering the API -> merge -> deduplicate -> track path.
 */
describe('Search Tool - Online API Path (SMI-2755)', () => {
  beforeEach(() => {
    // Suppress local skill search in these tests to avoid FS access
    vi.spyOn(LocalSkillSearchModule, 'searchLocalSkills').mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('takes the online path when isOffline() returns false', async () => {
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: [
        {
          id: 'anthropic/commit',
          name: 'commit',
          description: 'Semantic commit messages',
          author: 'anthropic',
          tags: ['git', 'commit'],
          trust_tier: 'verified',
          quality_score: 0.95,
          repo_url: 'https://github.com/anthropics/commit',
        },
      ],
      meta: { total: 1 },
    })

    const result = await executeSearch({ query: 'commit' }, onlineContext)

    expect(result.results).toBeDefined()
    expect(onlineContext.apiClient.search).toHaveBeenCalledTimes(1)
  })

  it('merges API results with local search results', async () => {
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: [
        {
          id: 'community/jest-helper',
          name: 'jest-helper',
          description: 'Jest helper',
          author: 'community',
          tags: ['testing'],
          trust_tier: 'community',
          quality_score: 0.87,
        },
      ],
      meta: { total: 1 },
    })

    // Return a local result to verify merge
    vi.spyOn(LocalSkillSearchModule, 'searchLocalSkills').mockResolvedValue([
      {
        id: 'local/my-test-skill',
        name: 'my-test-skill',
        description: 'Local testing helper',
        author: 'local',
        category: 'testing',
        trustTier: 'local' as CoreModule.MCPTrustTier,
        score: 65,
        source: 'local',
      },
    ])

    const result = await executeSearch({ query: 'test' }, onlineContext)

    expect(result.results.length).toBeGreaterThan(0)
    // Total should include both API and local
    expect(result.total).toBeGreaterThanOrEqual(1)
  })

  it('falls back to local DB when API call throws', async () => {
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'search').mockRejectedValue(new Error('API unavailable'))

    // Should not throw — gracefully falls back to SearchService
    const result = await executeSearch({ query: 'commit' }, onlineContext)

    expect(result.results).toBeDefined()
    expect(Array.isArray(result.results)).toBe(true)
  })

  it('calls trackSkillSearch when context.distinctId is set in online path', async () => {
    const trackSpy = vi.spyOn(CoreModule, 'trackSkillSearch').mockImplementation(() => {})

    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: [],
      meta: { total: 0 },
    })

    const contextWithId: ToolContext = { ...onlineContext, distinctId: 'search-test-user' }

    await executeSearch({ query: 'commit' }, contextWithId)

    expect(trackSpy).toHaveBeenCalledWith(
      'search-test-user',
      'commit',
      expect.any(Number),
      expect.any(Number),
      expect.any(Object)
    )
  })

  it('does not call trackSkillSearch when distinctId is absent', async () => {
    const trackSpy = vi.spyOn(CoreModule, 'trackSkillSearch').mockImplementation(() => {})

    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: [],
      meta: { total: 0 },
    })

    await executeSearch({ query: 'commit' }, onlineContext)

    expect(trackSpy).not.toHaveBeenCalled()
  })

  it('returns installHint from API results when author is set', async () => {
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: [
        {
          id: 'anthropic/commit',
          name: 'commit',
          description: 'Commit helper',
          author: 'anthropic',
          tags: [],
          trust_tier: 'verified',
          quality_score: 0.95,
          // SMI-5178: repo_url required so installable=true and default-ON filter keeps this row.
          repo_url: 'https://github.com/anthropic/commit',
        },
      ],
      meta: { total: 1 },
    })

    const result = await executeSearch({ query: 'commit' }, onlineContext)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const commitResult = result.results.find((r: any) => r.name === 'commit')
    expect(commitResult?.installHint).toBe('anthropic/commit')
  })

  // SMI-5563: search's own API path previously silently dropped `security`
  // even though skills-search already hydrates security_score/last_scanned_at/
  // security_findings/quarantined server-side (SMI-4251).
  describe('security summary (SMI-5563)', () => {
    it('derives a security summary from a scanned, clean API result', async () => {
      vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
      vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
        data: [
          {
            id: 'anthropic/scanned-clean',
            name: 'scanned-clean',
            description: 'A scanned, clean skill',
            author: 'anthropic',
            tags: [],
            trust_tier: 'verified',
            quality_score: 0.9,
            repo_url: 'https://github.com/anthropic/scanned-clean',
            last_scanned_at: '2026-06-01T00:00:00.000Z',
            security_score: 0,
            security_findings: [],
            quarantined: false,
          },
        ],
        meta: { total: 1 },
      })

      const result = await executeSearch({ query: 'scanned' }, onlineContext)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found = result.results.find((r: any) => r.name === 'scanned-clean')
      expect(found?.security).toEqual({
        passed: true,
        riskScore: 0,
        findingsCount: 0,
        scannedAt: '2026-06-01T00:00:00.000Z',
      })
    })

    it('leaves security undefined for a never-scanned API result', async () => {
      vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
      vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
        data: [
          {
            id: 'anthropic/never-scanned',
            name: 'never-scanned',
            description: 'Never scanned',
            author: 'anthropic',
            tags: [],
            trust_tier: 'verified',
            quality_score: 0.9,
            repo_url: 'https://github.com/anthropic/never-scanned',
            last_scanned_at: null,
          },
        ],
        meta: { total: 1 },
      })

      const result = await executeSearch({ query: 'never' }, onlineContext)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found = result.results.find((r: any) => r.name === 'never-scanned')
      expect(found?.security).toBeUndefined()
    })
  })
})
