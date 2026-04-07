/**
 * @fileoverview Tests for RBAC MCP tools
 * @see SMI-3901: RBAC MCP Tools
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  rbacManageInputSchema,
  rbacAssignRoleInputSchema,
  rbacCreatePolicyInputSchema,
  executeRbacManage,
  executeRbacAssignRole,
  executeRbacCreatePolicy,
  createStubRBACService,
  setRBACService,
  type RbacManageInput,
  type RbacAssignRoleInput,
  type RbacCreatePolicyInput,
} from './rbac-tools.js'

const mockContext = {} as ToolContext

describe('rbac-tools', () => {
  beforeEach(() => {
    setRBACService(createStubRBACService())
  })

  // ==========================================================================
  // Schema validation
  // ==========================================================================

  describe('rbacManageInputSchema', () => {
    it('should accept valid create_role input', () => {
      const input = { action: 'create_role', name: 'deployer', permissions: ['deploy:*'] }
      const parsed = rbacManageInputSchema.parse(input)
      expect(parsed.action).toBe('create_role')
      expect(parsed.name).toBe('deployer')
    })

    it('should accept list_roles without extra fields', () => {
      const parsed = rbacManageInputSchema.parse({ action: 'list_roles' })
      expect(parsed.action).toBe('list_roles')
    })

    it('should reject invalid action', () => {
      expect(() => rbacManageInputSchema.parse({ action: 'invalid' })).toThrow()
    })
  })

  describe('rbacAssignRoleInputSchema', () => {
    it('should accept assign action', () => {
      const parsed = rbacAssignRoleInputSchema.parse({
        action: 'assign',
        userId: 'user_1',
        roleId: 'role_admin',
      })
      expect(parsed.action).toBe('assign')
    })

    it('should accept list_assignments', () => {
      const parsed = rbacAssignRoleInputSchema.parse({ action: 'list_assignments' })
      expect(parsed.action).toBe('list_assignments')
    })

    it('should reject invalid action', () => {
      expect(() => rbacAssignRoleInputSchema.parse({ action: 'bad' })).toThrow()
    })
  })

  describe('rbacCreatePolicyInputSchema', () => {
    it('should accept create action with all fields', () => {
      const parsed = rbacCreatePolicyInputSchema.parse({
        action: 'create',
        name: 'allow-read',
        effect: 'allow',
        resources: ['skills:*'],
        actions: ['read'],
      })
      expect(parsed.action).toBe('create')
      expect(parsed.effect).toBe('allow')
    })

    it('should accept list action', () => {
      const parsed = rbacCreatePolicyInputSchema.parse({ action: 'list' })
      expect(parsed.action).toBe('list')
    })

    it('should reject invalid effect', () => {
      expect(() =>
        rbacCreatePolicyInputSchema.parse({
          action: 'create',
          name: 'bad',
          effect: 'maybe',
          resources: ['*'],
          actions: ['*'],
        })
      ).toThrow()
    })
  })

  // ==========================================================================
  // rbac_manage handler
  // ==========================================================================

  describe('executeRbacManage', () => {
    it('should create a custom role', async () => {
      const input: RbacManageInput = {
        action: 'create_role',
        name: 'deployer',
        permissions: ['deploy:*', 'skills:read'],
        description: 'Can deploy skills',
      }
      const result = await executeRbacManage(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.role).toBeDefined()
      expect(result.role!.name).toBe('deployer')
      expect(result.role!.permissions).toEqual(['deploy:*', 'skills:read'])
      expect(result.message).toContain('Role Created')
    })

    it('should fail create_role without name', async () => {
      const input: RbacManageInput = { action: 'create_role' }
      const result = await executeRbacManage(input, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('name is required')
    })

    it('should list default roles', async () => {
      const result = await executeRbacManage({ action: 'list_roles' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.roles).toBeDefined()
      expect(result.roles!.length).toBeGreaterThanOrEqual(4)
      const names = result.roles!.map((r) => r.name)
      expect(names).toContain('admin')
      expect(names).toContain('viewer')
    })

    it('should get a role by ID', async () => {
      const result = await executeRbacManage(
        { action: 'get_role', roleId: 'role_admin' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.role!.name).toBe('admin')
    })

    it('should fail get_role without roleId', async () => {
      const result = await executeRbacManage({ action: 'get_role' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('roleId is required')
    })

    it('should fail get_role for nonexistent role', async () => {
      const result = await executeRbacManage(
        { action: 'get_role', roleId: 'role_nonexistent' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should delete a custom role', async () => {
      // Create first
      await executeRbacManage({ action: 'create_role', name: 'temp-role' }, mockContext)

      // List to find the ID
      const listResult = await executeRbacManage({ action: 'list_roles' }, mockContext)
      const tempRole = listResult.roles!.find((r) => r.name === 'temp-role')
      expect(tempRole).toBeDefined()

      const result = await executeRbacManage(
        { action: 'delete_role', roleId: tempRole!.id },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('deleted')
    })

    it('should not delete built-in roles', async () => {
      const result = await executeRbacManage(
        { action: 'delete_role', roleId: 'role_admin' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('built-in role')
    })

    it('should fail delete_role without roleId', async () => {
      const result = await executeRbacManage({ action: 'delete_role' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('roleId is required')
    })
  })

  // ==========================================================================
  // rbac_assign_role handler
  // ==========================================================================

  describe('executeRbacAssignRole', () => {
    it('should assign a role to a user', async () => {
      const input: RbacAssignRoleInput = {
        action: 'assign',
        userId: 'user_123',
        roleId: 'role_member',
      }
      const result = await executeRbacAssignRole(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.assignment).toBeDefined()
      expect(result.assignment!.userId).toBe('user_123')
      expect(result.assignment!.roleName).toBe('member')
      expect(result.message).toContain('Role Assigned')
    })

    it('should fail assign without userId', async () => {
      const result = await executeRbacAssignRole(
        { action: 'assign', roleId: 'role_member' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('userId and roleId are required')
    })

    it('should fail assign without roleId', async () => {
      const result = await executeRbacAssignRole(
        { action: 'assign', userId: 'user_123' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('userId and roleId are required')
    })

    it('should revoke an assignment', async () => {
      await executeRbacAssignRole(
        { action: 'assign', userId: 'user_123', roleId: 'role_member' },
        mockContext
      )
      const result = await executeRbacAssignRole(
        { action: 'revoke', userId: 'user_123', roleId: 'role_member' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('revoked')
    })

    it('should fail revoke for nonexistent assignment', async () => {
      const result = await executeRbacAssignRole(
        { action: 'revoke', userId: 'user_999', roleId: 'role_admin' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('No assignment found')
    })

    it('should list assignments', async () => {
      await executeRbacAssignRole(
        { action: 'assign', userId: 'user_1', roleId: 'role_admin' },
        mockContext
      )
      await executeRbacAssignRole(
        { action: 'assign', userId: 'user_2', roleId: 'role_member' },
        mockContext
      )
      const result = await executeRbacAssignRole({ action: 'list_assignments' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.assignments).toHaveLength(2)
    })

    it('should list empty assignments', async () => {
      const result = await executeRbacAssignRole({ action: 'list_assignments' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.assignments).toHaveLength(0)
      expect(result.message).toContain('No role assignments')
    })
  })

  // ==========================================================================
  // rbac_create_policy handler
  // ==========================================================================

  describe('executeRbacCreatePolicy', () => {
    it('should create a policy', async () => {
      const input: RbacCreatePolicyInput = {
        action: 'create',
        name: 'allow-skill-read',
        effect: 'allow',
        resources: ['skills:*'],
        actions: ['read', 'search'],
      }
      const result = await executeRbacCreatePolicy(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.policy).toBeDefined()
      expect(result.policy!.name).toBe('allow-skill-read')
      expect(result.policy!.effect).toBe('allow')
      expect(result.message).toContain('Policy Created')
    })

    it('should fail create without name', async () => {
      const result = await executeRbacCreatePolicy(
        { action: 'create', effect: 'allow', resources: ['*'], actions: ['*'] },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('name is required')
    })

    it('should fail create without effect', async () => {
      const result = await executeRbacCreatePolicy(
        { action: 'create', name: 'test', resources: ['*'], actions: ['*'] },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('effect is required')
    })

    it('should fail create without resources', async () => {
      const result = await executeRbacCreatePolicy(
        { action: 'create', name: 'test', effect: 'deny', actions: ['*'] },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('resources is required')
    })

    it('should fail create without actions', async () => {
      const result = await executeRbacCreatePolicy(
        { action: 'create', name: 'test', effect: 'deny', resources: ['*'] },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('actions is required')
    })

    it('should list policies', async () => {
      await executeRbacCreatePolicy(
        {
          action: 'create',
          name: 'p1',
          effect: 'allow',
          resources: ['*'],
          actions: ['*'],
        },
        mockContext
      )
      const result = await executeRbacCreatePolicy({ action: 'list' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.policies).toHaveLength(1)
    })

    it('should list empty policies', async () => {
      const result = await executeRbacCreatePolicy({ action: 'list' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.policies).toHaveLength(0)
      expect(result.message).toContain('No policies')
    })

    it('should get a policy by ID', async () => {
      const createResult = await executeRbacCreatePolicy(
        {
          action: 'create',
          name: 'readable',
          effect: 'allow',
          resources: ['skills:*'],
          actions: ['read'],
        },
        mockContext
      )
      const policyId = createResult.policy!.id

      const result = await executeRbacCreatePolicy({ action: 'get', policyId }, mockContext)
      expect(result.success).toBe(true)
      expect(result.policy!.name).toBe('readable')
    })

    it('should fail get without policyId', async () => {
      const result = await executeRbacCreatePolicy({ action: 'get' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('policyId is required')
    })

    it('should fail get for nonexistent policy', async () => {
      const result = await executeRbacCreatePolicy(
        { action: 'get', policyId: 'policy_999' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should delete a policy', async () => {
      const createResult = await executeRbacCreatePolicy(
        {
          action: 'create',
          name: 'temp',
          effect: 'deny',
          resources: ['admin:*'],
          actions: ['*'],
        },
        mockContext
      )
      const result = await executeRbacCreatePolicy(
        { action: 'delete', policyId: createResult.policy!.id },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('deleted')
    })

    it('should fail delete without policyId', async () => {
      const result = await executeRbacCreatePolicy({ action: 'delete' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('policyId is required')
    })

    it('should fail delete for nonexistent policy', async () => {
      const result = await executeRbacCreatePolicy(
        { action: 'delete', policyId: 'policy_999' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })
  })
})
