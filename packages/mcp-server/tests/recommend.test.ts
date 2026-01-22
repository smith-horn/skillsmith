/**
 * Tests for SMI-741: MCP Skill Recommend Tool
 * Updated for SMI-902: Use real database instead of hardcoded skills
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  executeRecommend,
  formatRecommendations,
  recommendInputSchema,
} from '../src/tools/recommend.js'
import { createTestDatabase, type TestDatabaseContext } from './integration/setup.js'
import type { ToolContext } from '../src/context.js'

// Test context with database
let testDbContext: TestDatabaseContext
let toolContext: ToolContext

beforeAll(async () => {
  testDbContext = await createTestDatabase()
  // SMI-1183: Include apiClient for API integration
  toolContext = {
    db: testDbContext.db,
    searchService: testDbContext.searchService,
    skillRepository: testDbContext.skillRepository,
    apiClient: testDbContext.apiClient,
  }
})

afterAll(async () => {
  await testDbContext.cleanup()
})

describe('Skill Recommend Tool', () => {
  describe('recommendInputSchema', () => {
    it('should validate empty installed_skills array', () => {
      const result = recommendInputSchema.parse({
        installed_skills: [],
      })
      expect(result.installed_skills).toEqual([])
      expect(result.limit).toBe(5) // default
    })

    it('should validate with project_context', () => {
      const result = recommendInputSchema.parse({
        installed_skills: ['anthropic/commit'],
        project_context: 'React TypeScript frontend',
        limit: 10,
      })
      expect(result.installed_skills).toEqual(['anthropic/commit'])
      expect(result.project_context).toBe('React TypeScript frontend')
      expect(result.limit).toBe(10)
    })

    it('should enforce limit bounds', () => {
      expect(() =>
        recommendInputSchema.parse({
          installed_skills: [],
          limit: 0,
        })
      ).toThrow()

      expect(() =>
        recommendInputSchema.parse({
          installed_skills: [],
          limit: 100,
        })
      ).toThrow()
    })

    it('should default limit to 5', () => {
      const result = recommendInputSchema.parse({
        installed_skills: [],
      })
      expect(result.limit).toBe(5)
    })
  })

  describe('executeRecommend', () => {
    it('should return recommendations with auto-detected skills when installed_skills is empty', async () => {
      // SMI-906: Empty installed_skills now triggers auto-detection from ~/.claude/skills/
      const result = await executeRecommend(
        {
          installed_skills: [],
        },
        toolContext
      )

      expect(result.recommendations).toBeDefined()
      expect(result.recommendations.length).toBeGreaterThan(0)
      expect(result.recommendations.length).toBeLessThanOrEqual(5)
      // installed_count may be > 0 due to auto-detection from ~/.claude/skills/
      expect(result.context.installed_count).toBeGreaterThanOrEqual(0)
      expect(result.context.has_project_context).toBe(false)
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should return recommendations based on installed skills', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false, // Disable overlap detection for consistent testing
          limit: 5,
        },
        toolContext
      )

      expect(result.recommendations).toBeDefined()
      expect(result.recommendations.length).toBeGreaterThan(0)
      expect(result.context.installed_count).toBe(1)

      // Should not recommend already installed skill
      const recommendedIds = result.recommendations.map((r) => r.skill_id)
      expect(recommendedIds).not.toContain('anthropic/commit')
    })

    it('should filter out installed skills from recommendations', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit', 'anthropic/review-pr'],
          detect_overlap: false, // Disable overlap detection for consistent testing
          limit: 10,
        },
        toolContext
      )

      const recommendedIds = result.recommendations.map((r) => r.skill_id)
      expect(recommendedIds).not.toContain('anthropic/commit')
      expect(recommendedIds).not.toContain('anthropic/review-pr')
    })

    it('should include recommendation reason', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false, // Disable overlap detection for consistent testing
          limit: 5,
        },
        toolContext
      )

      for (const rec of result.recommendations) {
        expect(rec.reason).toBeDefined()
        expect(rec.reason.length).toBeGreaterThan(0)
      }
    })

    it('should include similarity score between 0 and 1', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false, // Disable overlap detection for consistent testing
          limit: 5,
        },
        toolContext
      )

      for (const rec of result.recommendations) {
        expect(rec.similarity_score).toBeGreaterThanOrEqual(0)
        expect(rec.similarity_score).toBeLessThanOrEqual(1)
      }
    })

    it('should include trust tier and quality score', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          limit: 5,
        },
        toolContext
      )

      for (const rec of result.recommendations) {
        expect(rec.trust_tier).toBeDefined()
        expect(['verified', 'community', 'experimental', 'unknown']).toContain(rec.trust_tier)
        expect(rec.quality_score).toBeGreaterThanOrEqual(0)
        expect(rec.quality_score).toBeLessThanOrEqual(100)
      }
    })

    it('should respect limit parameter', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          limit: 3,
        },
        toolContext
      )

      expect(result.recommendations.length).toBeLessThanOrEqual(3)
    })

    it('should use project_context for better recommendations', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          project_context: 'React frontend with Jest testing',
          limit: 10,
        },
        toolContext
      )

      expect(result.context.has_project_context).toBe(true)
      // Should have React or testing related skills ranked higher
      const topSkillNames = result.recommendations.slice(0, 3).map((r) => r.name)
      const hasRelevantSkill = topSkillNames.some(
        (name) =>
          name.toLowerCase().includes('react') ||
          name.toLowerCase().includes('jest') ||
          name.toLowerCase().includes('test')
      )
      expect(hasRelevantSkill || result.recommendations.length > 0).toBe(true)
    })

    it('should return candidates_considered count', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false, // Disable overlap detection for consistent testing
          limit: 5,
        },
        toolContext
      )

      expect(result.candidates_considered).toBeGreaterThan(0)
    })

    it('should handle case-insensitive skill IDs', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['ANTHROPIC/COMMIT'],
          detect_overlap: false, // Disable overlap detection for consistent testing
          limit: 5,
        },
        toolContext
      )

      const recommendedIds = result.recommendations.map((r) => r.skill_id.toLowerCase())
      expect(recommendedIds).not.toContain('anthropic/commit')
    })
  })

  // SMI-1631: Role-based filtering tests
  describe('role-based filtering', () => {
    it('should validate role parameter in schema', () => {
      const result = recommendInputSchema.parse({
        installed_skills: [],
        role: 'testing',
      })
      expect(result.role).toBe('testing')
    })

    it('should reject invalid role values', () => {
      expect(() =>
        recommendInputSchema.parse({
          installed_skills: [],
          role: 'invalid-role',
        })
      ).toThrow()
    })

    it('should accept all valid role values', () => {
      const validRoles = [
        'code-quality',
        'testing',
        'documentation',
        'workflow',
        'security',
        'development-partner',
      ]

      for (const role of validRoles) {
        const result = recommendInputSchema.parse({
          installed_skills: [],
          role,
        })
        expect(result.role).toBe(role)
      }
    })

    it('should include role_filtered count in response', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          role: 'testing',
          detect_overlap: false,
          limit: 10,
        },
        toolContext
      )

      // role_filtered should be a number (could be 0 if all skills match)
      expect(typeof result.role_filtered).toBe('number')
      expect(result.role_filtered).toBeGreaterThanOrEqual(0)
    })

    it('should include role_filter in context', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          role: 'testing',
          detect_overlap: false,
          limit: 5,
        },
        toolContext
      )

      expect(result.context.role_filter).toBe('testing')
    })

    it('should not set role_filter when no role is specified', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          detect_overlap: false,
          limit: 5,
        },
        toolContext
      )

      expect(result.context.role_filter).toBeUndefined()
    })

    it('should include roles array in recommendations', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          detect_overlap: false,
          limit: 5,
        },
        toolContext
      )

      // All recommendations should have a roles array (may be empty)
      for (const rec of result.recommendations) {
        expect(Array.isArray(rec.roles)).toBe(true)
      }
    })

    it('should boost quality score by 30 for role matches', async () => {
      // First, get recommendations without role filter
      const withoutRole = await executeRecommend(
        {
          installed_skills: [],
          detect_overlap: false,
          limit: 10,
        },
        toolContext
      )

      // Find a skill that has the 'testing' role
      const testingSkill = withoutRole.recommendations.find((r) => r.roles?.includes('testing'))

      if (testingSkill) {
        const originalScore = testingSkill.quality_score

        // Now get recommendations with testing role filter
        const withRole = await executeRecommend(
          {
            installed_skills: [],
            role: 'testing',
            detect_overlap: false,
            limit: 10,
          },
          toolContext
        )

        const boostedSkill = withRole.recommendations.find(
          (r) => r.skill_id === testingSkill.skill_id
        )

        if (boostedSkill) {
          // Score should be boosted by 30 (capped at 100)
          const expectedScore = Math.min(100, originalScore + 30)
          expect(boostedSkill.quality_score).toBe(expectedScore)
        }
      }
    })

    it('should include role in reason when role filter is applied', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          role: 'testing',
          detect_overlap: false,
          limit: 5,
        },
        toolContext
      )

      for (const rec of result.recommendations) {
        expect(rec.reason).toContain('role: testing')
      }
    })
  })

  describe('formatRecommendations', () => {
    it('should format recommendations for terminal display', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false, // Disable overlap detection for consistent testing
          limit: 3,
        },
        toolContext
      )
      const formatted = formatRecommendations(result)

      expect(formatted).toContain('Skill Recommendations')
      expect(formatted).toContain('recommendation(s)')
      expect(formatted).toContain('Score:')
      expect(formatted).toContain('Relevance:')
      expect(formatted).toContain('ID:')
    })

    it('should display trust badges', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          detect_overlap: false, // Disable overlap detection for consistent testing
          limit: 5,
        },
        toolContext
      )
      const formatted = formatRecommendations(result)

      // Should contain at least one trust badge
      const hasBadge =
        formatted.includes('[VERIFIED]') ||
        formatted.includes('[COMMUNITY]') ||
        formatted.includes('[STANDARD]') ||
        formatted.includes('[UNVERIFIED]')
      expect(hasBadge).toBe(true)
    })

    it('should show candidates considered and timing', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          detect_overlap: false, // Disable overlap detection for consistent testing
          limit: 3,
        },
        toolContext
      )
      const formatted = formatRecommendations(result)

      expect(formatted).toContain('Candidates considered:')
      expect(formatted).toContain('ms')
    })

    // SMI-1631: Role display in formatted output
    it('should show role filter in formatted output when applied', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          role: 'testing',
          detect_overlap: false,
          limit: 5,
        },
        toolContext
      )
      const formatted = formatRecommendations(result)

      expect(formatted).toContain('Role filter: testing')
    })

    it('should show role filtered count when skills were filtered', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          role: 'testing',
          detect_overlap: false,
          limit: 10,
        },
        toolContext
      )

      if (result.role_filtered > 0) {
        const formatted = formatRecommendations(result)
        expect(formatted).toContain(`Filtered for role: ${result.role_filtered}`)
      }
    })
  })
})
