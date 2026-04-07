/**
 * @fileoverview Tests for private registry MCP tools
 * @see SMI-3902: Private Registry MCP Tools
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  privateRegistryPublishInputSchema,
  privateRegistryManageInputSchema,
  executePrivateRegistryPublish,
  executePrivateRegistryManage,
  createStubRegistryService,
  setPrivateRegistryService,
  type PrivateRegistryPublishInput,
  type PrivateRegistryManageInput,
} from './registry-tools.js'

const mockContext = {} as ToolContext

describe('registry-tools', () => {
  beforeEach(() => {
    // Reset to fresh stub service before each test
    setPrivateRegistryService(createStubRegistryService())
  })

  // ==========================================================================
  // Schema validation
  // ==========================================================================

  describe('privateRegistryPublishInputSchema', () => {
    it('should accept valid publish input', () => {
      const input = { skillId: 'myteam/my-skill', version: '1.0.0' }
      const parsed = privateRegistryPublishInputSchema.parse(input)
      expect(parsed.skillId).toBe('myteam/my-skill')
      expect(parsed.version).toBe('1.0.0')
    })

    it('should accept publish input with description', () => {
      const input = {
        skillId: 'myteam/my-skill',
        version: '1.0.0',
        description: 'A useful skill',
      }
      const parsed = privateRegistryPublishInputSchema.parse(input)
      expect(parsed.description).toBe('A useful skill')
    })

    it('should reject invalid skill ID format', () => {
      expect(() =>
        privateRegistryPublishInputSchema.parse({ skillId: 'no-slash', version: '1.0.0' })
      ).toThrow()
    })

    it('should reject invalid semver', () => {
      expect(() =>
        privateRegistryPublishInputSchema.parse({
          skillId: 'myteam/my-skill',
          version: 'not-semver',
        })
      ).toThrow()
    })
  })

  describe('privateRegistryManageInputSchema', () => {
    it('should accept list action', () => {
      const parsed = privateRegistryManageInputSchema.parse({ action: 'list' })
      expect(parsed.action).toBe('list')
    })

    it('should accept get action with skillId', () => {
      const parsed = privateRegistryManageInputSchema.parse({
        action: 'get',
        skillId: 'myteam/my-skill',
      })
      expect(parsed.action).toBe('get')
      expect(parsed.skillId).toBe('myteam/my-skill')
    })

    it('should reject invalid action', () => {
      expect(() => privateRegistryManageInputSchema.parse({ action: 'invalid' })).toThrow()
    })

    it('should accept optional version filter', () => {
      const parsed = privateRegistryManageInputSchema.parse({
        action: 'list',
        version: '1.0.0',
      })
      expect(parsed.version).toBe('1.0.0')
    })
  })

  // ==========================================================================
  // private_registry_publish handler
  // ==========================================================================

  describe('executePrivateRegistryPublish', () => {
    it('should publish a skill', async () => {
      const input: PrivateRegistryPublishInput = {
        skillId: 'myteam/my-skill',
        version: '1.0.0',
      }
      const result = await executePrivateRegistryPublish(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.skill).toBeDefined()
      expect(result.skill!.skillId).toBe('myteam/my-skill')
      expect(result.skill!.version).toBe('1.0.0')
      expect(result.skill!.deprecated).toBe(false)
      expect(result.skill!.registryUrl).toContain('myteam/my-skill@1.0.0')
      expect(result.message).toContain('Published')
    })

    it('should publish a skill with description', async () => {
      const input: PrivateRegistryPublishInput = {
        skillId: 'myteam/my-skill',
        version: '1.0.0',
        description: 'A skill for testing',
      }
      const result = await executePrivateRegistryPublish(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.skill!.description).toBe('A skill for testing')
    })
  })

  // ==========================================================================
  // private_registry_manage handler
  // ==========================================================================

  describe('executePrivateRegistryManage', () => {
    it('should list empty registry', async () => {
      const input: PrivateRegistryManageInput = { action: 'list' }
      const result = await executePrivateRegistryManage(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.skills).toHaveLength(0)
      expect(result.message).toContain('0 skill(s)')
    })

    it('should list published skills', async () => {
      // Publish a skill first
      await executePrivateRegistryPublish(
        { skillId: 'myteam/skill-a', version: '1.0.0' },
        mockContext
      )

      const result = await executePrivateRegistryManage({ action: 'list' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.skills).toHaveLength(1)
      expect(result.skills![0].skillId).toBe('myteam/skill-a')
    })

    it('should get a specific skill', async () => {
      await executePrivateRegistryPublish(
        { skillId: 'myteam/skill-a', version: '1.0.0' },
        mockContext
      )

      const result = await executePrivateRegistryManage(
        { action: 'get', skillId: 'myteam/skill-a' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.skill).toBeDefined()
      expect(result.skill!.skillId).toBe('myteam/skill-a')
    })

    it('should fail get without skillId', async () => {
      const result = await executePrivateRegistryManage({ action: 'get' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('skillId is required')
    })

    it('should fail get for nonexistent skill', async () => {
      const result = await executePrivateRegistryManage(
        { action: 'get', skillId: 'myteam/nonexistent' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should deprecate a skill', async () => {
      await executePrivateRegistryPublish(
        { skillId: 'myteam/old-skill', version: '1.0.0' },
        mockContext
      )

      const result = await executePrivateRegistryManage(
        { action: 'deprecate', skillId: 'myteam/old-skill' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('deprecated')

      // Verify it's marked deprecated
      const getResult = await executePrivateRegistryManage(
        { action: 'get', skillId: 'myteam/old-skill' },
        mockContext
      )
      expect(getResult.skill!.deprecated).toBe(true)
    })

    it('should fail deprecate without skillId', async () => {
      const result = await executePrivateRegistryManage({ action: 'deprecate' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('skillId is required')
    })

    it('should fail deprecate for nonexistent skill', async () => {
      const result = await executePrivateRegistryManage(
        { action: 'deprecate', skillId: 'myteam/nonexistent' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should undeprecate a skill', async () => {
      await executePrivateRegistryPublish(
        { skillId: 'myteam/revived', version: '2.0.0' },
        mockContext
      )
      await executePrivateRegistryManage(
        { action: 'deprecate', skillId: 'myteam/revived' },
        mockContext
      )

      const result = await executePrivateRegistryManage(
        { action: 'undeprecate', skillId: 'myteam/revived' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('undeprecated')

      // Verify it's no longer deprecated
      const getResult = await executePrivateRegistryManage(
        { action: 'get', skillId: 'myteam/revived' },
        mockContext
      )
      expect(getResult.skill!.deprecated).toBe(false)
    })

    it('should fail undeprecate without skillId', async () => {
      const result = await executePrivateRegistryManage({ action: 'undeprecate' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('skillId is required')
    })
  })
})
