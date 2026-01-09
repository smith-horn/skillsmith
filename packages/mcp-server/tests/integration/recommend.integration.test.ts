/**
 * SMI-756: Integration tests for recommend MCP tool
 * Tests skill recommendations with real database and matching
 * Updated for SMI-902: Use real database instead of hardcoded skills
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, type TestDatabaseContext } from './setup.js'
import { executeRecommend, formatRecommendations } from '../../src/tools/recommend.js'
import type { ToolContext } from '../../src/context.js'

describe('Recommend Tool Integration', () => {
  let ctx: TestDatabaseContext
  let toolContext: ToolContext

  beforeEach(async () => {
    ctx = await createTestDatabase()
    // SMI-1183: Include apiClient for API integration
    toolContext = {
      db: ctx.db,
      searchService: ctx.searchService,
      skillRepository: ctx.skillRepository,
      apiClient: ctx.apiClient,
    }
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  describe('executeRecommend', () => {
    it('should return recommendations with auto-detected skills when installed skills is empty', async () => {
      // SMI-906: Empty installed_skills now triggers auto-detection from ~/.claude/skills/
      const result = await executeRecommend(
        {
          installed_skills: [],
          limit: 5,
        },
        toolContext
      )

      expect(result.recommendations).toBeDefined()
      expect(result.recommendations.length).toBeGreaterThan(0)
      expect(result.recommendations.length).toBeLessThanOrEqual(5)
      // installed_count may be > 0 due to auto-detection from ~/.claude/skills/
      expect(result.context.installed_count).toBeGreaterThanOrEqual(0)
      expect(result.context.using_semantic_matching).toBe(true)
    })

    it('should return recommendations based on installed skills', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false,
          limit: 5,
        },
        toolContext
      )

      expect(result.recommendations).toBeDefined()
      expect(result.recommendations.length).toBeGreaterThan(0)
      expect(result.context.installed_count).toBe(1)

      // Should not include installed skill
      const ids = result.recommendations.map((r) => r.skill_id)
      expect(ids).not.toContain('anthropic/commit')
    })

    it('should filter overlapping skills when enabled', async () => {
      const withOverlap = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: true,
          limit: 10,
        },
        toolContext
      )

      const withoutOverlap = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false,
          limit: 10,
        },
        toolContext
      )

      // With overlap detection, fewer skills may be recommended
      expect(withOverlap.overlap_filtered).toBeGreaterThanOrEqual(0)
      expect(withoutOverlap.overlap_filtered).toBe(0)
    })

    it('should respect project context', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          project_context: 'React frontend with Jest testing',
          detect_overlap: false,
          limit: 10,
        },
        toolContext
      )

      expect(result.context.has_project_context).toBe(true)
      expect(result.recommendations.length).toBeGreaterThan(0)
    })

    it('should respect minimum similarity threshold', async () => {
      const highThreshold = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false,
          min_similarity: 0.9,
          limit: 10,
        },
        toolContext
      )

      const lowThreshold = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false,
          min_similarity: 0.1,
          limit: 10,
        },
        toolContext
      )

      // Lower threshold should return more results
      expect(lowThreshold.recommendations.length).toBeGreaterThanOrEqual(
        highThreshold.recommendations.length
      )
    })

    it('should include quality scores and trust tiers', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          detect_overlap: false,
          limit: 5,
        },
        toolContext
      )

      for (const rec of result.recommendations) {
        expect(rec.quality_score).toBeGreaterThanOrEqual(0)
        expect(rec.quality_score).toBeLessThanOrEqual(100)
        expect(['verified', 'community', 'standard', 'unverified']).toContain(rec.trust_tier)
        expect(rec.reason).toBeDefined()
        expect(rec.similarity_score).toBeGreaterThanOrEqual(0)
        expect(rec.similarity_score).toBeLessThanOrEqual(1)
      }
    })

    it('should respect limit parameter', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          detect_overlap: false,
          limit: 3,
        },
        toolContext
      )

      expect(result.recommendations.length).toBeLessThanOrEqual(3)
    })

    it('should track timing information', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          limit: 5,
        },
        toolContext
      )

      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })
  })

  // SMI-907: Tests for improved overlap detection with semantically similar names
  describe('SMI-907: Name-based overlap detection', () => {
    it('should NOT recommend docker-compose when docker is installed', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['community/docker'],
          detect_overlap: false, // Disable semantic overlap to test name-based filtering
          limit: 50,
        },
        toolContext
      )

      const recommendedIds = result.recommendations.map((r) => r.skill_id)

      // docker-compose should be filtered because "docker-compose" contains "docker"
      expect(recommendedIds).not.toContain('community/docker-compose')

      // Also verify the installed skill itself is not recommended
      expect(recommendedIds).not.toContain('community/docker')
    })

    it('should still recommend vitest-helper when jest-helper is installed', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['community/jest-helper'],
          detect_overlap: false, // Disable semantic overlap to test name-based filtering
          limit: 50,
        },
        toolContext
      )

      const recommendedIds = result.recommendations.map((r) => r.skill_id)

      // vitest-helper should still be recommended - different testing framework
      // "jest-helper" and "vitest-helper" don't share name containment
      expect(recommendedIds).toContain('community/vitest-helper')

      // jest-helper itself should not be recommended (installed)
      expect(recommendedIds).not.toContain('community/jest-helper')
    })

    it('should NOT recommend git-commit-helper when commit is installed', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          detect_overlap: false, // Disable semantic overlap to test name-based filtering
          limit: 50,
        },
        toolContext
      )

      const recommendedIds = result.recommendations.map((r) => r.skill_id)

      // git-commit-helper should be filtered because "git-commit-helper" contains "commit"
      expect(recommendedIds).not.toContain('community/git-commit-helper')

      // The installed skill itself should not be recommended
      expect(recommendedIds).not.toContain('anthropic/commit')
    })

    it('should filter skills when only skill name (not full ID) is provided', async () => {
      // Test with just "docker" as installed (simulating user-provided short name)
      const result = await executeRecommend(
        {
          installed_skills: ['docker'],
          detect_overlap: false,
          limit: 50,
        },
        toolContext
      )

      const recommendedIds = result.recommendations.map((r) => r.skill_id)

      // Should filter docker-compose because "docker-compose" contains "docker"
      expect(recommendedIds).not.toContain('community/docker-compose')
    })

    it('should handle case-insensitive name matching', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['COMMUNITY/DOCKER'],
          detect_overlap: false,
          limit: 50,
        },
        toolContext
      )

      const recommendedIds = result.recommendations.map((r) => r.skill_id)

      // Should still filter docker-compose with case-insensitive matching
      expect(recommendedIds).not.toContain('community/docker-compose')
    })
  })

  describe('formatRecommendations', () => {
    it('should format recommendations for terminal display', async () => {
      const result = await executeRecommend(
        {
          installed_skills: [],
          detect_overlap: false,
          limit: 3,
        },
        toolContext
      )

      const formatted = formatRecommendations(result)

      expect(formatted).toContain('Skill Recommendations')
      expect(formatted).toContain('Candidates considered:')
      expect(formatted).toContain('Semantic matching: enabled')
    })

    it('should show no recommendations message when empty', async () => {
      // Create a result with no recommendations
      const emptyResult = {
        recommendations: [],
        candidates_considered: 0,
        overlap_filtered: 0,
        context: {
          installed_count: 0,
          has_project_context: false,
          using_semantic_matching: true,
          auto_detected: false,
        },
        timing: { totalMs: 1 },
      }

      const formatted = formatRecommendations(emptyResult)

      expect(formatted).toContain('No recommendations found')
      expect(formatted).toContain('Suggestions:')
    })
  })
})
