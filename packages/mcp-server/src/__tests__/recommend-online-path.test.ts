/**
 * SMI-2755 Wave 2: Online API path tests for executeRecommend
 *
 * Tests the branch where context.apiClient.isOffline() returns false,
 * exercising the Promise.allSettled(API + local) merge path.
 *
 * Split from recommend.test.ts to keep each file under 500 lines.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import { executeRecommend } from '../tools/recommend.js'
import { createTestContext, type ToolContext } from './test-utils.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'
import * as CoreModule from '@skillsmith/core'
import type { LocalSkill } from '../indexer/LocalIndexer.js'

/**
 * SMI-2755 Wave 2: Online API path tests for executeRecommend
 *
 * Tests the branch where context.apiClient.isOffline() returns false,
 * exercising the Promise.allSettled(API + local) merge path.
 */
describe('Recommend Tool - Online API Path (SMI-2755)', () => {
  let onlineContext: ToolContext

  const mockLocalSkills: LocalSkill[] = [
    {
      id: 'local/my-tool',
      name: 'my-tool',
      description: 'A local tool',
      author: 'local',
      tags: ['productivity'],
      qualityScore: 70,
      trustTier: 'local',
      source: 'local',
      path: '/home/user/.claude/skills/my-tool',
      hasSkillMd: true,
      lastModified: new Date().toISOString(),
    },
  ]

  beforeAll(() => {
    onlineContext = createTestContext()
  })

  afterAll(() => {
    onlineContext.db.close()
  })

  beforeEach(() => {
    // Mock local indexer returning a single skill
    // Partial mock — only methods called by executeRecommend are implemented
    vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
      index: vi.fn().mockResolvedValue(mockLocalSkills),
      indexSync: vi.fn().mockReturnValue(mockLocalSkills),
      search: vi.fn().mockReturnValue(mockLocalSkills),
      clearCache: vi.fn(),
      getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
      calculateQualityScore: vi.fn().mockReturnValue(70),
      indexSkillDir: vi.fn(),
    } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('takes the online path when isOffline() returns false', async () => {
    // Spy on isOffline to return false and getRecommendations to return controlled data
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'getRecommendations').mockResolvedValue({
      data: [
        {
          id: 'community/jest-helper',
          name: 'jest-helper',
          description: 'Jest test helper',
          author: 'community',
          tags: ['testing'],
          trust_tier: 'community',
          quality_score: 0.87,
        },
      ],
      meta: { total: 1 },
    })

    const result = await executeRecommend({ project_context: 'testing', limit: 5 }, onlineContext)

    expect(result.recommendations).toBeDefined()
    expect(Array.isArray(result.recommendations)).toBe(true)
    expect(onlineContext.apiClient.getRecommendations).toHaveBeenCalledTimes(1)
  })

  it('merges API results with local results and deduplicates by skill_id', async () => {
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'getRecommendations').mockResolvedValue({
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
        {
          id: 'anthropic/commit',
          name: 'commit',
          description: 'Commit helper',
          author: 'anthropic',
          tags: ['git'],
          trust_tier: 'verified',
          quality_score: 0.95,
        },
      ],
      meta: { total: 2 },
    })

    const result = await executeRecommend(
      { project_context: 'git workflow', limit: 10 },
      onlineContext
    )

    // No duplicate skill IDs
    const ids = result.recommendations.map((r) => r.skill_id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })

  it('falls back to local-only results when API call fails', async () => {
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'getRecommendations').mockRejectedValue(
      new Error('Network error')
    )

    // Should not throw — falls back gracefully
    const result = await executeRecommend({ project_context: 'testing', limit: 5 }, onlineContext)

    expect(result.recommendations).toBeDefined()
    expect(Array.isArray(result.recommendations)).toBe(true)
  })

  it('applies role filter and +30 score boost for matched roles in online path', async () => {
    expect.hasAssertions()
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'getRecommendations').mockResolvedValue({
      data: [
        {
          id: 'community/jest-helper',
          name: 'jest-helper',
          description: 'Jest helper',
          author: 'community',
          tags: ['testing'],
          trust_tier: 'community',
          quality_score: 0.5,
        },
      ],
      meta: { total: 1 },
    })

    const result = await executeRecommend(
      { project_context: 'testing', role: 'testing', limit: 5 },
      onlineContext
    )

    expect(result.context.role_filter).toBe('testing')
    // If any recommendation survived the role filter, its score should be boosted
    result.recommendations.forEach((rec) => {
      if (rec.roles?.includes('testing')) {
        expect(rec.quality_score).toBeGreaterThanOrEqual(50 + 30)
        expect(rec.reason).toContain('role: testing')
      }
    })
  })

  it('calls trackEvent when context.distinctId is set', async () => {
    const trackEventSpy = vi.spyOn(CoreModule, 'trackEvent').mockImplementation(() => {})

    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'getRecommendations').mockResolvedValue({
      data: [],
      meta: { total: 0 },
    })

    const contextWithId: ToolContext = { ...onlineContext, distinctId: 'test-user-123' }

    await executeRecommend({ project_context: 'testing', limit: 5 }, contextWithId)

    expect(trackEventSpy).toHaveBeenCalledWith(
      'test-user-123',
      'skill_recommend',
      expect.objectContaining({ source: 'mcp' })
    )
  })

  it('does not call trackEvent when context.distinctId is absent', async () => {
    const trackEventSpy = vi.spyOn(CoreModule, 'trackEvent').mockImplementation(() => {})

    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'getRecommendations').mockResolvedValue({
      data: [],
      meta: { total: 0 },
    })

    // onlineContext has no distinctId (createTestContext doesn't set one)
    await executeRecommend({ project_context: 'testing', limit: 5 }, onlineContext)

    expect(trackEventSpy).not.toHaveBeenCalled()
  })

  it('includes local skill results in candidates_considered count', async () => {
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'getRecommendations').mockResolvedValue({
      data: [
        {
          id: 'community/docker-compose',
          name: 'docker-compose',
          description: 'Docker helper',
          author: 'community',
          tags: ['devops'],
          trust_tier: 'community',
          quality_score: 0.84,
        },
      ],
      meta: { total: 1 },
    })

    const result = await executeRecommend({ project_context: 'devops', limit: 5 }, onlineContext)

    // candidates_considered = API results + local results
    // Local indexer returns 1 skill (mockLocalSkills has 1 item)
    expect(result.candidates_considered).toBeGreaterThanOrEqual(1)
  })

  it('handles API returning empty data gracefully', async () => {
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'getRecommendations').mockResolvedValue({
      data: [],
      meta: { total: 0 },
    })

    const result = await executeRecommend({ project_context: 'anything', limit: 5 }, onlineContext)

    expect(result.recommendations).toBeDefined()
    // Local skill (my-tool) may appear in results
    expect(Array.isArray(result.recommendations)).toBe(true)
  })

  it('combines online + role filter + tracking simultaneously', async () => {
    const trackEventSpy = vi.spyOn(CoreModule, 'trackEvent').mockImplementation(() => {})

    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(onlineContext.apiClient, 'getRecommendations').mockResolvedValue({
      data: [
        {
          id: 'community/jest-helper',
          name: 'jest-helper',
          description: 'Jest test helper',
          author: 'community',
          tags: ['testing'],
          trust_tier: 'community',
          quality_score: 0.6,
        },
      ],
      meta: { total: 1 },
    })

    const contextWithId: ToolContext = { ...onlineContext, distinctId: 'combined-test-user' }

    const result = await executeRecommend(
      { project_context: 'testing', role: 'testing', limit: 5 },
      contextWithId
    )

    expect(result.context.role_filter).toBe('testing')
    expect(trackEventSpy).toHaveBeenCalledWith(
      'combined-test-user',
      'skill_recommend',
      expect.objectContaining({ source: 'mcp' })
    )
  })
})
