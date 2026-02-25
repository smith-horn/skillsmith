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
import { createTestContext, type ToolContext } from './test-utils.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'

let onlineContext: ToolContext

beforeAll(() => {
  onlineContext = createTestContext()
})

afterAll(() => {
  onlineContext.db.close()
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
        },
      ],
      meta: { total: 1 },
    })

    const result = await executeSearch({ query: 'commit' }, onlineContext)

    const commitResult = result.results.find((r) => r.name === 'commit')
    expect(commitResult?.installHint).toBe('anthropic/commit')
  })
})
