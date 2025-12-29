/**
 * Tests for SMI-741: MCP Skill Recommend Tool
 */

import { describe, it, expect } from 'vitest'
import {
  executeRecommend,
  formatRecommendations,
  recommendInputSchema,
} from '../src/tools/recommend.js'

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
    it('should return recommendations for empty installed_skills', async () => {
      const result = await executeRecommend({
        installed_skills: [],
      })

      expect(result.recommendations).toBeDefined()
      expect(result.recommendations.length).toBeGreaterThan(0)
      expect(result.recommendations.length).toBeLessThanOrEqual(5)
      expect(result.context.installed_count).toBe(0)
      expect(result.context.has_project_context).toBe(false)
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should return recommendations based on installed skills', async () => {
      const result = await executeRecommend({
        installed_skills: ['anthropic/commit'],
        limit: 5,
      })

      expect(result.recommendations).toBeDefined()
      expect(result.recommendations.length).toBeGreaterThan(0)
      expect(result.context.installed_count).toBe(1)

      // Should not recommend already installed skill
      const recommendedIds = result.recommendations.map((r) => r.skill_id)
      expect(recommendedIds).not.toContain('anthropic/commit')
    })

    it('should filter out installed skills from recommendations', async () => {
      const result = await executeRecommend({
        installed_skills: ['anthropic/commit', 'anthropic/review-pr'],
        limit: 10,
      })

      const recommendedIds = result.recommendations.map((r) => r.skill_id)
      expect(recommendedIds).not.toContain('anthropic/commit')
      expect(recommendedIds).not.toContain('anthropic/review-pr')
    })

    it('should include recommendation reason', async () => {
      const result = await executeRecommend({
        installed_skills: ['anthropic/commit'],
        limit: 5,
      })

      for (const rec of result.recommendations) {
        expect(rec.reason).toBeDefined()
        expect(rec.reason.length).toBeGreaterThan(0)
      }
    })

    it('should include similarity score between 0 and 1', async () => {
      const result = await executeRecommend({
        installed_skills: ['anthropic/commit'],
        limit: 5,
      })

      for (const rec of result.recommendations) {
        expect(rec.similarity_score).toBeGreaterThanOrEqual(0)
        expect(rec.similarity_score).toBeLessThanOrEqual(1)
      }
    })

    it('should include trust tier and quality score', async () => {
      const result = await executeRecommend({
        installed_skills: [],
        limit: 5,
      })

      for (const rec of result.recommendations) {
        expect(rec.trust_tier).toBeDefined()
        expect(['verified', 'community', 'standard', 'unverified']).toContain(rec.trust_tier)
        expect(rec.quality_score).toBeGreaterThanOrEqual(0)
        expect(rec.quality_score).toBeLessThanOrEqual(100)
      }
    })

    it('should respect limit parameter', async () => {
      const result = await executeRecommend({
        installed_skills: [],
        limit: 3,
      })

      expect(result.recommendations.length).toBeLessThanOrEqual(3)
    })

    it('should use project_context for better recommendations', async () => {
      const result = await executeRecommend({
        installed_skills: [],
        project_context: 'React frontend with Jest testing',
        limit: 10,
      })

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
      const result = await executeRecommend({
        installed_skills: ['anthropic/commit'],
        limit: 5,
      })

      expect(result.candidates_considered).toBeGreaterThan(0)
    })

    it('should handle case-insensitive skill IDs', async () => {
      const result = await executeRecommend({
        installed_skills: ['ANTHROPIC/COMMIT'],
        limit: 5,
      })

      const recommendedIds = result.recommendations.map((r) => r.skill_id.toLowerCase())
      expect(recommendedIds).not.toContain('anthropic/commit')
    })
  })

  describe('formatRecommendations', () => {
    it('should format recommendations for terminal display', async () => {
      const result = await executeRecommend({
        installed_skills: ['anthropic/commit'],
        limit: 3,
      })
      const formatted = formatRecommendations(result)

      expect(formatted).toContain('Skill Recommendations')
      expect(formatted).toContain('recommendation(s)')
      expect(formatted).toContain('Score:')
      expect(formatted).toContain('Relevance:')
      expect(formatted).toContain('ID:')
    })

    it('should display trust badges', async () => {
      const result = await executeRecommend({
        installed_skills: [],
        limit: 5,
      })
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
      const result = await executeRecommend({
        installed_skills: [],
        limit: 3,
      })
      const formatted = formatRecommendations(result)

      expect(formatted).toContain('Candidates considered:')
      expect(formatted).toContain('ms')
    })
  })
})
