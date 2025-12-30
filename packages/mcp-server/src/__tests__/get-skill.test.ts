/**
 * Tests for SMI-582: MCP Get Skill Tool
 * Updated for SMI-790: Wire to SkillRepository
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
  })
})
