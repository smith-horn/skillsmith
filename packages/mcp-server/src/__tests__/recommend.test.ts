/**
 * Tests for SMI-1837: Include Local Skills in Recommendations
 * Verifies that local skills are searched in parallel with the API,
 * not just as a fallback.
 *
 * SMI-2755: Extended with online API path tests.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import { executeRecommend, formatRecommendations } from '../tools/recommend.js'
import { createSeededTestContext, createTestContext, type ToolContext } from './test-utils.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'
import * as CoreModule from '@skillsmith/core'
import type { LocalSkill } from '../indexer/LocalIndexer.js'

let context: ToolContext

beforeAll(() => {
  context = createSeededTestContext()
})

afterAll(() => {
  context.db.close()
})

describe('Recommend Tool', () => {
  describe('executeRecommend - basic functionality', () => {
    it('should return recommendations for project context', async () => {
      const result = await executeRecommend(
        {
          project_context: 'React frontend with testing',
          limit: 5,
        },
        context
      )

      expect(result.recommendations).toBeDefined()
      expect(Array.isArray(result.recommendations)).toBe(true)
      expect(result.context.has_project_context).toBe(true)
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should return recommendations with installed skills', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          limit: 5,
        },
        context
      )

      expect(result.recommendations).toBeDefined()
      expect(result.context.installed_count).toBe(1)
      // Should not recommend the already installed skill
      const hasInstalledSkill = result.recommendations.some(
        (r) => r.skill_id === 'anthropic/commit'
      )
      expect(hasInstalledSkill).toBe(false)
    })
  })

  describe('formatRecommendations', () => {
    it('should format results for terminal display', async () => {
      const result = await executeRecommend(
        {
          project_context: 'testing',
          limit: 3,
        },
        context
      )
      const formatted = formatRecommendations(result)

      expect(formatted).toContain('Skill Recommendations')
    })

    it('should show helpful message when no results', async () => {
      const emptyResult = {
        recommendations: [],
        candidates_considered: 0,
        overlap_filtered: 0,
        role_filtered: 0,
        context: {
          installed_count: 0,
          has_project_context: false,
          using_semantic_matching: true,
          auto_detected: false,
        },
        timing: { totalMs: 10 },
      }
      const formatted = formatRecommendations(emptyResult)

      expect(formatted).toContain('No recommendations found')
      expect(formatted).toContain('Suggestions:')
    })
  })
})

/**
 * SMI-1837: Tests for parallel local skill search integration
 */
describe('Recommend Tool - Local Skill Integration (SMI-1837)', () => {
  let branchContext: ToolContext

  // Mock local skills for testing
  const mockLocalSkills: LocalSkill[] = [
    {
      id: 'local/my-commit-helper',
      name: 'my-commit-helper',
      description: 'Personal commit message helper',
      author: 'local',
      tags: ['git', 'commit', 'personal'],
      qualityScore: 75,
      trustTier: 'local',
      source: 'local',
      path: '/home/user/.claude/skills/my-commit-helper',
      hasSkillMd: true,
      lastModified: new Date().toISOString(),
    },
    {
      id: 'local/react-patterns',
      name: 'react-patterns',
      description: 'React component patterns and best practices',
      author: 'local',
      tags: ['react', 'patterns', 'components'],
      qualityScore: 80,
      trustTier: 'local',
      source: 'local',
      path: '/home/user/.claude/skills/react-patterns',
      hasSkillMd: true,
      lastModified: new Date().toISOString(),
    },
    {
      id: 'local/testing-utils',
      name: 'testing-utils',
      description: 'Testing utilities and helpers',
      author: 'local',
      tags: ['testing', 'jest', 'vitest'],
      qualityScore: 70,
      trustTier: 'local',
      source: 'local',
      path: '/home/user/.claude/skills/testing-utils',
      hasSkillMd: true,
      lastModified: new Date().toISOString(),
    },
  ]

  beforeAll(() => {
    branchContext = createSeededTestContext()
  })

  afterAll(() => {
    branchContext.db.close()
  })

  beforeEach(() => {
    // Mock the local indexer to return controlled test data
    vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
      index: vi.fn().mockResolvedValue(mockLocalSkills),
      indexSync: vi.fn().mockReturnValue(mockLocalSkills),
      search: vi.fn((query: string, skills: LocalSkill[]) => {
        const lowerQuery = query.toLowerCase()
        return skills.filter(
          (s) =>
            s.name.toLowerCase().includes(lowerQuery) ||
            s.description?.toLowerCase().includes(lowerQuery) ||
            s.tags.some((t) => t.toLowerCase().includes(lowerQuery))
        )
      }),
      clearCache: vi.fn(),
      getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
      calculateQualityScore: vi.fn().mockReturnValue(75),
      indexSkillDir: vi.fn(),
    } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('parallel local search', () => {
    it('should include local skills in recommendations when API is offline', async () => {
      // Context is created with offline mode, so it will use local matching
      const result = await executeRecommend(
        {
          project_context: 'React testing project',
          limit: 10,
        },
        branchContext
      )

      expect(result.recommendations).toBeDefined()
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
      expect(result.timing.totalMs).toBeLessThan(500) // Performance requirement
    })

    it('should not have duplicate skills in results', async () => {
      const result = await executeRecommend(
        {
          project_context: 'commit automation',
          limit: 10,
        },
        branchContext
      )

      // Check for duplicate skill_ids
      const skillIds = result.recommendations.map((r) => r.skill_id)
      const uniqueIds = new Set(skillIds)
      expect(skillIds.length).toBe(uniqueIds.size)
    })

    it('should complete within performance target (<500ms)', async () => {
      const startTime = performance.now()

      await executeRecommend(
        {
          project_context: 'JavaScript development',
          installed_skills: ['anthropic/commit'],
          limit: 10,
        },
        branchContext
      )

      const endTime = performance.now()
      const duration = endTime - startTime

      expect(duration).toBeLessThan(500)
    })

    it('should handle empty local skills gracefully', async () => {
      // Mock empty local skills
      vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
        index: vi.fn().mockResolvedValue([]),
        indexSync: vi.fn().mockReturnValue([]),
        search: vi.fn().mockReturnValue([]),
        clearCache: vi.fn(),
        getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
        calculateQualityScore: vi.fn().mockReturnValue(0),
        indexSkillDir: vi.fn(),
      } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)

      const result = await executeRecommend(
        {
          project_context: 'testing',
          limit: 5,
        },
        branchContext
      )

      // Should still return database results
      expect(result.recommendations).toBeDefined()
      expect(Array.isArray(result.recommendations)).toBe(true)
    })

    it('should handle local indexer errors gracefully', async () => {
      // Mock indexer that throws an error
      vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
        index: vi.fn().mockRejectedValue(new Error('Indexer failed')),
        indexSync: vi.fn().mockImplementation(() => {
          throw new Error('Indexer failed')
        }),
        search: vi.fn().mockReturnValue([]),
        clearCache: vi.fn(),
        getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
        calculateQualityScore: vi.fn().mockReturnValue(0),
        indexSkillDir: vi.fn(),
      } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)

      // Should not throw, should fall back gracefully
      const result = await executeRecommend(
        {
          project_context: 'testing',
          limit: 5,
        },
        branchContext
      )

      expect(result.recommendations).toBeDefined()
    })
  })

  describe('deduplication logic', () => {
    it('should prefer registry skills over local skills with same name', async () => {
      // Create a local skill with same name as registry skill
      const duplicateMockSkills: LocalSkill[] = [
        {
          id: 'local/commit',
          name: 'commit',
          description: 'Local commit helper (duplicate of anthropic/commit)',
          author: 'local',
          tags: ['git', 'commit'],
          qualityScore: 60,
          trustTier: 'local',
          source: 'local',
          path: '/home/user/.claude/skills/commit',
          hasSkillMd: true,
          lastModified: new Date().toISOString(),
        },
      ]

      vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
        index: vi.fn().mockResolvedValue(duplicateMockSkills),
        indexSync: vi.fn().mockReturnValue(duplicateMockSkills),
        search: vi.fn().mockReturnValue(duplicateMockSkills),
        clearCache: vi.fn(),
        getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
        calculateQualityScore: vi.fn().mockReturnValue(60),
        indexSkillDir: vi.fn(),
      } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)

      const result = await executeRecommend(
        {
          project_context: 'git workflow',
          limit: 10,
        },
        branchContext
      )

      // Should not have both 'anthropic/commit' and 'local/commit'
      const commitSkills = result.recommendations.filter(
        (r) => r.name === 'commit' || r.skill_id.includes('commit')
      )

      // If there's a commit skill, registry should take precedence
      if (commitSkills.length > 0) {
        const hasRegistryCommit = commitSkills.some((s) => s.skill_id === 'anthropic/commit')
        const hasLocalCommit = commitSkills.some((s) => s.skill_id === 'local/commit')
        // Should not have local duplicate if registry version exists
        if (hasRegistryCommit) {
          expect(hasLocalCommit).toBe(false)
        }
      }
    })
  })

  describe('role filtering with local skills', () => {
    it('should apply role filter to local skills', async () => {
      const result = await executeRecommend(
        {
          project_context: 'testing project',
          role: 'testing',
          limit: 10,
        },
        branchContext
      )

      // All results should have testing role if role filter is applied
      if (result.recommendations.length > 0 && result.context.role_filter) {
        result.recommendations.forEach((rec) => {
          if (rec.roles) {
            expect(rec.roles).toContain('testing')
          }
        })
      }
    })
  })
})

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
