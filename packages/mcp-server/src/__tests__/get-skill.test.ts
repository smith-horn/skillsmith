/**
 * Tests for SMI-582: MCP Get Skill Tool
 * Updated for SMI-790: Wire to SkillRepository
 * Updated for SMI-1614: Coverage gaps
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { executeGetSkill, formatSkillDetails } from '../tools/get-skill.js'
import { SkillsmithError, ErrorCodes } from '@skillsmith/core'
import { createSeededTestContext, type ToolContext } from './test-utils.js'

let context: ToolContext

beforeAll(() => {
  context = createSeededTestContext()
})

afterAll(() => {
  context.db.close()
})

describe('Get Skill Tool', () => {
  describe('executeGetSkill', () => {
    it('should return skill details for valid ID', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)

      expect(result.skill).toBeDefined()
      expect(result.skill.id).toBe('anthropic/commit')
      expect(result.skill.name).toBe('commit')
      expect(result.skill.author).toBe('anthropic')
      expect(result.skill.description).toBeDefined()
      expect(result.skill.trustTier).toBe('verified')
      expect(result.skill.score).toBeGreaterThan(0)
      expect(result.installCommand).toBeDefined()
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should include repository URL', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)

      expect(result.skill.repository).toBeDefined()
      expect(result.skill.repository).toContain('github.com')
    })

    it('should throw SKILL_NOT_FOUND for invalid skill', async () => {
      try {
        await executeGetSkill({ id: 'nonexistent/skill' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_NOT_FOUND)
      }
    })

    it('should throw SKILL_INVALID_ID for malformed ID', async () => {
      try {
        await executeGetSkill({ id: 'not-valid-format' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_INVALID_ID)
      }
    })

    it('should throw VALIDATION_REQUIRED_FIELD for empty ID', async () => {
      try {
        await executeGetSkill({ id: '' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.VALIDATION_REQUIRED_FIELD)
      }
    })
  })

  describe('formatSkillDetails', () => {
    it('should format skill details for terminal display', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('commit')
      expect(formatted).toContain('Author:')
      expect(formatted).toContain('Trust Tier:')
      expect(formatted).toContain('Overall Score:')
      expect(formatted).toContain('Installation')
    })

    it('should include trust tier explanation', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('VERIFIED')
    })

    it('should show installation command', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('claude skill add')
    })

    it('should format community trust tier', async () => {
      const result = await executeGetSkill({ id: 'community/jest-helper' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('COMMUNITY')
    })

    it('should format experimental trust tier', async () => {
      const result = await executeGetSkill({ id: 'community/api-docs' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('EXPERIMENTAL')
    })

    it('should display tags when present', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('Tags:')
      expect(formatted).toContain('git')
    })

    it('should display N/A for missing version', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('Version: N/A')
    })

    it('should display timing information', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('Retrieved in')
      expect(formatted).toContain('ms')
    })

    it('should display repository URL', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      const formatted = formatSkillDetails(result)

      expect(formatted).toContain('Repository:')
      expect(formatted).toContain('github.com')
    })
  })

  describe('edge cases', () => {
    it('should handle whitespace in skill ID', async () => {
      const result = await executeGetSkill({ id: '  anthropic/commit  ' }, context)
      expect(result.skill.id).toBe('anthropic/commit')
    })

    it('should throw for whitespace-only ID', async () => {
      try {
        await executeGetSkill({ id: '   ' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.VALIDATION_REQUIRED_FIELD)
      }
    })

    it('should provide suggestion for not found skill', async () => {
      try {
        await executeGetSkill({ id: 'nonexistent/skill' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).suggestion).toBeDefined()
        expect((error as SkillsmithError).suggestion).toContain('search')
      }
    })

    it('should provide suggestion for invalid ID format', async () => {
      try {
        await executeGetSkill({ id: 'invalid-format' }, context)
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).suggestion).toBeDefined()
        expect((error as SkillsmithError).suggestion).toContain('author/skill-name')
      }
    })
  })

  describe('score conversion', () => {
    it('should convert quality score from decimal to percentage', async () => {
      const result = await executeGetSkill({ id: 'anthropic/commit' }, context)
      // Quality score in seed data is 0.95, should convert to 95
      expect(result.skill.score).toBe(95)
    })

    it('should handle lower quality scores', async () => {
      const result = await executeGetSkill({ id: 'community/api-docs' }, context)
      // Quality score in seed data is 0.78, should convert to 78
      expect(result.skill.score).toBe(78)
    })
  })
})
