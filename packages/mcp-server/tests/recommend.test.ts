/**
 * Tests for SMI-741: MCP Skill Recommend Tool
 * Updated for SMI-902: Use real database instead of hardcoded skills
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { executeRecommend, recommendInputSchema } from '../src/tools/recommend.js'
import { createTestDatabase, type TestDatabaseContext } from './integration/setup.js'
import type { ToolContext } from '../src/context.js'
import * as InstalledSkillsModule from '../src/utils/installed-skills.js'

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
    coInstallRepository: testDbContext.coInstallRepository,
    skillDependencyRepository: testDbContext.skillDependencyRepository,
    sessionInstalledSkillIds: [],
    apiClient: testDbContext.apiClient,
  }
})

afterAll(async () => {
  await testDbContext.cleanup()
})

// SMI-5991: this file's `installed_skills: []` cases rely on SMI-906
// auto-detection to populate the context.stack — reading the real host
// `~/.claude/skills/` directory made results depend on execution
// environment (a dev host with skills installed vs. a clean Docker
// container/CI runner with none), and an empty auto-detect result trips
// the SMI-5896 empty-stack guard, silently degrading assertions written
// against real recommendations. Stub to a fixed, non-empty, synthetic
// skill ID that deliberately does NOT match any seeded fixture in
// TEST_SKILLS (unlike a real fixture ID such as 'anthropic/commit', which
// — with detect_overlap defaulted true — engages OverlapDetector and can
// legitimately filter every candidate away): this keeps the stub's only
// effect "make the derived stack non-empty," without perturbing the
// installed-skill exclusion or overlap-detection filtering paths that
// other tests in this file exercise deliberately via an explicit array.
beforeEach(() => {
  vi.spyOn(InstalledSkillsModule, 'getInstalledSkills').mockResolvedValue([
    'local/smi-5991-autodetect-stub',
  ])
})

afterEach(() => {
  vi.restoreAllMocks()
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recommendedIds = result.recommendations.map((r: any) => r.skill_id)
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recommendedIds = result.recommendations.map((r: any) => r.skill_id)
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
        expect(['verified', 'community', 'experimental', 'unknown', 'local']).toContain(
          rec.trust_tier
        )
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const topSkillNames = result.recommendations.slice(0, 3).map((r: any) => r.name)
      const hasRelevantSkill = topSkillNames.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (name: any) =>
          name.toLowerCase().includes('react') ||
          name.toLowerCase().includes('jest') ||
          name.toLowerCase().includes('test')
      )
      // SMI-5991 (code review): the original `hasRelevantSkill ||
      // recommendations.length > 0` made this vacuously true whenever ANY
      // recommendation existed, regardless of relevance. Assert relevance
      // directly.
      expect(hasRelevantSkill).toBe(true)
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recommendedIds = result.recommendations.map((r: any) => r.skill_id.toLowerCase())
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
      // SMI-5991 (code review): fetch the role-filtered set FIRST — role
      // filtering deterministically selects only testing-role skills from
      // the whole candidate pool, unlike the unfiltered call below, whose
      // similarity ranking gives no guarantee a testing-role skill lands
      // within any particular limit. The previous version's `if
      // (testingSkill)` / `if (boostedSkill)` guards let this test pass
      // with zero assertions executed whenever either lookup missed.
      const withRole = await executeRecommend(
        {
          installed_skills: [],
          role: 'testing',
          detect_overlap: false,
          limit: 20,
        },
        toolContext
      )
      const boostedSkill = withRole.recommendations[0]
      expect(boostedSkill).toBeDefined()

      // Fetch a wide unfiltered set (close to the full 58-skill fixture
      // pool) so the same skill is virtually certain to appear, letting us
      // read its pre-boost baseline score.
      const withoutRole = await executeRecommend(
        {
          installed_skills: [],
          detect_overlap: false,
          limit: 50,
        },
        toolContext
      )
      const testingSkill = withoutRole.recommendations.find(
        (r) => r.skill_id === boostedSkill.skill_id
      )
      expect(testingSkill).toBeDefined()

      if (testingSkill) {
        // Score should be boosted by 30 (capped at 100)
        const expectedScore = Math.min(100, testingSkill.quality_score + 30)
        expect(boostedSkill.quality_score).toBe(expectedScore)
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

  // SMI-5991: formatRecommendations tests split to recommend-format.test.ts
  // to keep this file under the 500-line cap (same precedent as
  // recommend-online-path.test.ts, SMI-2755 Wave 2).
})
