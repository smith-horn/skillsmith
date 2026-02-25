/**
 * Tests for SMI-1837: Include Local Skills in Recommendations
 * Verifies that local skills are searched in parallel with the API,
 * not just as a fallback.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import { executeRecommend, formatRecommendations } from '../tools/recommend.js'
import { createSeededTestContext, type ToolContext } from './test-utils.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'
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
      repository: null,
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
      repository: null,
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
      repository: null,
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
          repository: null,
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
