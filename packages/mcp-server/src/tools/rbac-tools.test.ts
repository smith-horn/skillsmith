/**
 * @fileoverview Tests for RBAC MCP tools
 * @see SMI-3901: RBAC MCP Tools (original shape, superseded)
 * @see SMI-6202 Wave 1 / SMI-6203 Wave 2: the real two-role / four-permission model these tests
 *      now cover — `RolePermissionsView` / `TeamMemberAssignment` / `RbacCreatePolicyResult.grants`,
 *      not the old `create_role`/`delete_role`/roleId/userId/policyId shapes.
 * @see SMI-6242: the corrected default matrix (`admin` denies `team:manage_rbac`/`team:manage_sso`)
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
  DEFAULT_ROLE_PERMISSIONS,
} from './rbac-tools.js'
import { MANAGE_RBAC_PERMISSION } from './rbac-tools.types.js'
import { STUB_TEAM_ID, type StubRBACService } from './rbac-tools.stub.js'
import { isPermissionDeniedError, permissionErrorText } from './team-permission-error.js'

const mockContext = {} as ToolContext

describe('rbac-tools', () => {
  let stub: StubRBACService

  beforeEach(() => {
    stub = createStubRBACService()
    setRBACService(stub)
  })

  // ==========================================================================
  // Schema validation
  // ==========================================================================

  describe('rbacManageInputSchema', () => {
    it('accepts list_roles without extra fields', () => {
      const parsed = rbacManageInputSchema.parse({ action: 'list_roles' })
      expect(parsed.action).toBe('list_roles')
    })

    it('accepts get_role with role', () => {
      const parsed = rbacManageInputSchema.parse({ action: 'get_role', role: 'admin' })
      expect(parsed.role).toBe('admin')
    })

    it('accepts set_role_permission with role/permission/effect', () => {
      const parsed = rbacManageInputSchema.parse({
        action: 'set_role_permission',
        role: 'member',
        permission: 'registry:approve',
        effect: 'allow',
      })
      expect(parsed.effect).toBe('allow')
    })

    it('rejects an invalid action', () => {
      expect(() => rbacManageInputSchema.parse({ action: 'create_role' })).toThrow()
    })

    it('rejects an invalid role', () => {
      expect(() => rbacManageInputSchema.parse({ action: 'get_role', role: 'owner' })).toThrow()
    })

    it('rejects an invalid permission', () => {
      expect(() =>
        rbacManageInputSchema.parse({
          action: 'set_role_permission',
          role: 'admin',
          permission: 'audit:read',
          effect: 'allow',
        })
      ).toThrow()
    })

    it('rejects an invalid effect', () => {
      expect(() =>
        rbacManageInputSchema.parse({
          action: 'set_role_permission',
          role: 'admin',
          permission: 'registry:approve',
          effect: 'maybe',
        })
      ).toThrow()
    })
  })

  describe('rbacAssignRoleInputSchema', () => {
    it('accepts assign with memberId + role', () => {
      const parsed = rbacAssignRoleInputSchema.parse({
        action: 'assign',
        memberId: 'tm_1',
        role: 'admin',
      })
      expect(parsed.action).toBe('assign')
    })

    it('accepts list_assignments', () => {
      const parsed = rbacAssignRoleInputSchema.parse({ action: 'list_assignments' })
      expect(parsed.action).toBe('list_assignments')
    })

    it('rejects an invalid action', () => {
      expect(() => rbacAssignRoleInputSchema.parse({ action: 'bad' })).toThrow()
    })

    it('rejects role="owner" (never assignable through this schema)', () => {
      expect(() =>
        rbacAssignRoleInputSchema.parse({ action: 'assign', memberId: 'tm_1', role: 'owner' })
      ).toThrow()
    })
  })

  describe('rbacCreatePolicyInputSchema', () => {
    it('accepts create with all fields', () => {
      const parsed = rbacCreatePolicyInputSchema.parse({
        action: 'create',
        role: 'member',
        effect: 'deny',
        resources: ['registry'],
        actions: ['approve'],
      })
      expect(parsed.action).toBe('create')
    })

    it('accepts list action', () => {
      const parsed = rbacCreatePolicyInputSchema.parse({ action: 'list' })
      expect(parsed.action).toBe('list')
    })

    it('rejects an invalid effect', () => {
      expect(() =>
        rbacCreatePolicyInputSchema.parse({
          action: 'create',
          role: 'admin',
          effect: 'maybe',
          resources: ['registry'],
          actions: ['approve'],
        })
      ).toThrow()
    })
  })

  // ==========================================================================
  // executeRbacManage
  // ==========================================================================

  describe('executeRbacManage: list_roles / get_role', () => {
    it('SMI-6242: list_roles reflects the corrected default matrix', async () => {
      const result = await executeRbacManage({ action: 'list_roles' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.roles).toHaveLength(2)
      expect(result.roles!.map((r) => r.role)).toEqual(['admin', 'member'])

      const admin = result.roles!.find((r) => r.role === 'admin')!
      const effectFor = (perms: typeof admin.permissions, p: string) =>
        perms.find((x) => x.permission === p)
      expect(effectFor(admin.permissions, 'registry:approve')).toMatchObject({
        effect: 'allow',
        source: 'default',
      })
      expect(effectFor(admin.permissions, 'registry:deprecate')).toMatchObject({
        effect: 'allow',
        source: 'default',
      })
      expect(effectFor(admin.permissions, 'team:manage_rbac')).toMatchObject({
        effect: 'deny',
        source: 'default',
      })
      expect(effectFor(admin.permissions, 'team:manage_sso')).toMatchObject({
        effect: 'deny',
        source: 'default',
      })

      const member = result.roles!.find((r) => r.role === 'member')!
      expect(member.permissions.every((p) => p.effect === 'deny')).toBe(true)
    })

    it('DEFAULT_ROLE_PERMISSIONS constant matches the SMI-6242 fix', () => {
      expect(DEFAULT_ROLE_PERMISSIONS.admin['registry:approve']).toBe('allow')
      expect(DEFAULT_ROLE_PERMISSIONS.admin['registry:deprecate']).toBe('allow')
      expect(DEFAULT_ROLE_PERMISSIONS.admin['team:manage_rbac']).toBe('deny')
      expect(DEFAULT_ROLE_PERMISSIONS.admin['team:manage_sso']).toBe('deny')
      expect(Object.values(DEFAULT_ROLE_PERMISSIONS.member).every((v) => v === 'deny')).toBe(true)
    })

    it('get_role returns the 4-row slice for one role', async () => {
      const result = await executeRbacManage({ action: 'get_role', role: 'admin' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.role!.role).toBe('admin')
      expect(result.role!.permissions).toHaveLength(4)
    })

    it('fails get_role without role', async () => {
      const result = await executeRbacManage({ action: 'get_role' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toBe('role is required for action "get_role".')
    })
  })

  describe('executeRbacManage: set_role_permission / reset_role_permission', () => {
    it('fails set_role_permission without role/permission/effect', async () => {
      const result = await executeRbacManage({ action: 'set_role_permission' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('role, permission and effect are required')
    })

    it('owner can set a role permission', async () => {
      const result = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'member',
          permission: 'registry:approve',
          effect: 'allow',
        },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('Set **allow**')

      const after = await executeRbacManage({ action: 'get_role', role: 'member' }, mockContext)
      const cell = after.role!.permissions.find((p) => p.permission === 'registry:approve')
      expect(cell).toMatchObject({ effect: 'allow', source: 'grant' })
    })

    it('fails reset_role_permission without role/permission', async () => {
      const result = await executeRbacManage({ action: 'reset_role_permission' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('role and permission are required')
    })

    it('reset_role_permission reports false when there was nothing to clear', async () => {
      const result = await executeRbacManage(
        { action: 'reset_role_permission', role: 'admin', permission: 'registry:approve' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('already at the built-in default')
    })

    it('reset_role_permission clears a real override', async () => {
      await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'registry:approve',
          effect: 'deny',
        },
        mockContext
      )
      const result = await executeRbacManage(
        { action: 'reset_role_permission', role: 'admin', permission: 'registry:approve' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('Cleared the override')
    })
  })

  describe('executeRbacManage: gate 3 (no team:manage_rbac) and gate 4/5 (owner-anchored writes)', () => {
    it('gate 3: a plain member with no grant cannot read or write the matrix', async () => {
      stub.setActor({ userId: 'stub-member', teamId: STUB_TEAM_ID, role: 'member' })
      const result = await executeRbacManage({ action: 'list_roles' }, mockContext)
      expect(result.success).toBe(false)
      expect(isPermissionDeniedError(result.error)).toBe(true)
      expect(permissionErrorText(result.error)).toContain(MANAGE_RBAC_PERMISSION)
    })

    it('SMI-6242: a plain admin with no explicit grant ALSO cannot write (default is now deny)', async () => {
      stub.setActor({ userId: 'stub-admin', teamId: STUB_TEAM_ID, role: 'admin' })
      const result = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'registry:approve',
          effect: 'deny',
        },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(isPermissionDeniedError(result.error)).toBe(true)
    })

    it('gate 4: once elevated, a non-owner admin still cannot rewrite team:manage_rbac itself', async () => {
      // Owner elevates admin first (the real setRolePermission-succeeding-for-an-owner path).
      const elevate = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_rbac',
          effect: 'allow',
        },
        mockContext
      )
      expect(elevate.success).toBe(true)

      stub.setActor({ userId: 'stub-admin', teamId: STUB_TEAM_ID, role: 'admin' })
      const result = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_rbac',
          effect: 'deny',
        },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(isPermissionDeniedError(result.error)).toBe(true)
      expect(permissionErrorText(result.error)).toBe(
        'Only the team owner can change who holds the "team:manage_rbac" permission.'
      )

      const resetResult = await executeRbacManage(
        { action: 'reset_role_permission', role: 'admin', permission: 'team:manage_rbac' },
        mockContext
      )
      expect(resetResult.success).toBe(false)
      expect(isPermissionDeniedError(resetResult.error)).toBe(true)
    })

    it('gate 4 scope: an elevated admin CAN write registry:* grants (the gate is not over-broad)', async () => {
      await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_rbac',
          effect: 'allow',
        },
        mockContext
      )
      stub.setActor({ userId: 'stub-admin', teamId: STUB_TEAM_ID, role: 'admin' })

      const approve = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'registry:approve',
          effect: 'deny',
        },
        mockContext
      )
      expect(approve.success).toBe(true)

      const deprecate = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'registry:deprecate',
          effect: 'deny',
        },
        mockContext
      )
      expect(deprecate.success).toBe(true)
    })

    // Adversarial-review fix (SMI-6203 security round): gate 4 originally covered
    // `team:manage_rbac` only, so an admin the owner elevated for registry work could grant
    // itself `team:manage_sso` — IdP registration + domain claims, i.e. the ability to
    // authenticate as the owner. Both meta-permissions are now owner-only, on write AND reset.
    it('gate 4 scope: an elevated admin CANNOT write or clear team:manage_sso', async () => {
      await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_rbac',
          effect: 'allow',
        },
        mockContext
      )
      stub.setActor({ userId: 'stub-admin', teamId: STUB_TEAM_ID, role: 'admin' })

      const sso = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_sso',
          effect: 'allow',
        },
        mockContext
      )
      expect(sso.success).toBe(false)
      expect(isPermissionDeniedError(sso.error)).toBe(true)
      // Names the permission actually attempted, not the one that gates the operation.
      expect(permissionErrorText(sso.error)).toBe(
        'Only the team owner can change who holds the "team:manage_sso" permission.'
      )

      const reset = await executeRbacManage(
        { action: 'reset_role_permission', role: 'admin', permission: 'team:manage_sso' },
        mockContext
      )
      expect(reset.success).toBe(false)
      expect(isPermissionDeniedError(reset.error)).toBe(true)
    })

    it('gate 4 scope: the OWNER can still write and clear team:manage_sso', async () => {
      const grant = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_sso',
          effect: 'allow',
        },
        mockContext
      )
      expect(grant.success).toBe(true)

      const cleared = await executeRbacManage(
        { action: 'reset_role_permission', role: 'admin', permission: 'team:manage_sso' },
        mockContext
      )
      expect(cleared.success).toBe(true)
      expect(cleared.message).toContain('Cleared the override')
    })

    it('gate 5: a granted member cannot self-widen via effect=allow, but can narrow via deny', async () => {
      const elevate = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'member',
          permission: 'team:manage_rbac',
          effect: 'allow',
        },
        mockContext
      )
      expect(elevate.success).toBe(true)

      stub.setActor({ userId: 'stub-member', teamId: STUB_TEAM_ID, role: 'member' })

      const widen = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'member',
          permission: 'registry:approve',
          effect: 'allow',
        },
        mockContext
      )
      expect(widen.success).toBe(false)
      expect(isPermissionDeniedError(widen.error)).toBe(true)
      expect(permissionErrorText(widen.error)).toContain('Only owners and admins can widen')

      const narrow = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'member',
          permission: 'registry:approve',
          effect: 'deny',
        },
        mockContext
      )
      expect(narrow.success).toBe(true)
    })

    it('gate 5 (confirmation-round fix): a granted member cannot self-widen via a two-call set-then-reset either', async () => {
      // admin x registry:approve defaults to allow (SMI-6242), so clearing an owner-written
      // deny on it restores that allow -- the same forbidden state a direct effect='allow'
      // write is blocked from creating. Elevate c_member with team:manage_rbac, have the
      // OWNER write the deny, then prove the granted member cannot clear it back.
      const elevate = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'member',
          permission: 'team:manage_rbac',
          effect: 'allow',
        },
        mockContext
      )
      expect(elevate.success).toBe(true)

      const denyAdminApprove = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'registry:approve',
          effect: 'deny',
        },
        mockContext
      )
      expect(denyAdminApprove.success).toBe(true)

      stub.setActor({ userId: 'stub-member', teamId: STUB_TEAM_ID, role: 'member' })

      const bypassAttempt = await executeRbacManage(
        { action: 'reset_role_permission', role: 'admin', permission: 'registry:approve' },
        mockContext
      )
      expect(bypassAttempt.success).toBe(false)
      expect(isPermissionDeniedError(bypassAttempt.error)).toBe(true)
      expect(permissionErrorText(bypassAttempt.error)).toContain('Only owners and admins can widen')

      // The deny row must still be there -- the refused reset must not have partially applied.
      // (The granted member still holds team:manage_rbac from the elevation above, so this
      // read itself succeeds -- only the widening reset was refused.)
      const stillDenied = await executeRbacManage(
        { action: 'get_role', role: 'admin' },
        mockContext
      )
      expect(stillDenied.success).toBe(true)
      expect(
        stillDenied.role!.permissions.find((p) => p.permission === 'registry:approve')
      ).toMatchObject({ effect: 'deny', source: 'grant' })

      // A narrowing reset (clearing a cell whose default is deny) is still fine for the same
      // granted member -- confirms this fix only blocks the widening direction.
      const narrowingReset = await executeRbacManage(
        { action: 'reset_role_permission', role: 'member', permission: 'registry:approve' },
        mockContext
      )
      expect(narrowingReset.success).toBe(true)
    })
  })

  // ==========================================================================
  // executeRbacAssignRole
  // ==========================================================================

  describe('executeRbacAssignRole', () => {
    it('lists the default stub roster (membership-gated only, not team:manage_rbac)', async () => {
      stub.setActor({ userId: 'stub-member', teamId: STUB_TEAM_ID, role: 'member' })
      const result = await executeRbacAssignRole({ action: 'list_assignments' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.assignments).toHaveLength(3)
      expect(result.assignments!.map((a) => a.role).sort()).toEqual(['admin', 'member', 'owner'])
    })

    it('fails list_assignments for a non-member (plain error, not a PermissionDeniedError)', async () => {
      stub.setActor({ userId: 'not-a-member', teamId: STUB_TEAM_ID, role: null })
      const result = await executeRbacAssignRole({ action: 'list_assignments' }, mockContext)
      expect(result.success).toBe(false)
      expect(isPermissionDeniedError(result.error)).toBe(false)
      expect(result.error).toContain('not a member of this team')
    })

    it('fails assign without memberId/role', async () => {
      const result = await executeRbacAssignRole({ action: 'assign' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('memberId and role are required')
    })

    it('owner assigns admin to the default member', async () => {
      const result = await executeRbacAssignRole(
        { action: 'assign', memberId: 'tm_stub_member', role: 'admin' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('now `admin`')
    })

    it('revoke rejects role="member" (removal is a separate operation)', async () => {
      const result = await executeRbacAssignRole(
        { action: 'revoke', memberId: 'tm_stub_admin', role: 'member' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('Only "admin" can be revoked')
    })

    it('revoke demotes an admin back to member', async () => {
      const result = await executeRbacAssignRole(
        { action: 'revoke', memberId: 'tm_stub_admin', role: 'admin' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('now `member`')
    })

    it("owner protection: the owner's own role can never be changed", async () => {
      const result = await executeRbacAssignRole(
        { action: 'assign', memberId: 'tm_stub_owner', role: 'member' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(permissionErrorText(result.error)).toContain("cannot change the team owner's role")
    })

    it('not-found member id is refused the same way as no-permission (no existence oracle)', async () => {
      const result = await executeRbacAssignRole(
        { action: 'assign', memberId: 'tm_does_not_exist', role: 'admin' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(isPermissionDeniedError(result.error)).toBe(true)
    })
  })

  // ==========================================================================
  // executeRbacCreatePolicy
  // ==========================================================================

  describe('executeRbacCreatePolicy', () => {
    it('lists no overrides by default', async () => {
      const result = await executeRbacCreatePolicy({ action: 'list' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.grants).toHaveLength(0)
      expect(result.message).toContain('No overrides set')
    })

    it('fails create without role', async () => {
      const result = await executeRbacCreatePolicy(
        { action: 'create', effect: 'deny', resources: ['registry'], actions: ['approve'] },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('role is required')
    })

    it('fails create without resources/actions', async () => {
      const result = await executeRbacCreatePolicy(
        { action: 'create', role: 'admin', effect: 'deny' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('resources and actions are required')
    })

    it('fails create without effect', async () => {
      const result = await executeRbacCreatePolicy(
        { action: 'create', role: 'admin', resources: ['registry'], actions: ['approve'] },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('effect is required')
    })

    it('refuses an unsupported resource:action expansion before writing anything', async () => {
      const result = await executeRbacCreatePolicy(
        {
          action: 'create',
          role: 'admin',
          effect: 'allow',
          resources: ['audit'],
          actions: ['read'],
        },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('Not a configurable permission')

      const list = await executeRbacCreatePolicy({ action: 'list' }, mockContext)
      expect(list.grants).toHaveLength(0)
    })

    it('create expands resources x actions into grant rows', async () => {
      const result = await executeRbacCreatePolicy(
        {
          action: 'create',
          name: 'no-registry-writes',
          role: 'member',
          effect: 'deny',
          resources: ['registry'],
          actions: ['approve', 'deprecate'],
        },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.grants).toHaveLength(2)
      expect(result.message).toContain('Policy Applied: no-registry-writes')

      const list = await executeRbacCreatePolicy({ action: 'list' }, mockContext)
      expect(list.grants).toHaveLength(2)
    })

    it('delete clears grants written by create', async () => {
      await executeRbacCreatePolicy(
        {
          action: 'create',
          role: 'member',
          effect: 'deny',
          resources: ['registry'],
          actions: ['approve'],
        },
        mockContext
      )
      const result = await executeRbacCreatePolicy(
        { action: 'delete', role: 'member', resources: ['registry'], actions: ['approve'] },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('Cleared 1 of 1 override(s)')

      const list = await executeRbacCreatePolicy({ action: 'list' }, mockContext)
      expect(list.grants).toHaveLength(0)
    })
  })

  // ==========================================================================
  // SMI-6184: dataSource must reflect the actual service, not Supabase config
  // ==========================================================================

  describe('SMI-6184: dataSource reflects the actual service', () => {
    it('reports dataSource "stub" across all three RBAC tools even when Supabase env vars are set', async () => {
      const prevUrl = process.env.SUPABASE_URL
      const prevKey = process.env.SUPABASE_ANON_KEY
      process.env.SUPABASE_URL = 'https://example.supabase.co'
      process.env.SUPABASE_ANON_KEY = 'anon-key'
      try {
        const manage = await executeRbacManage({ action: 'list_roles' }, mockContext)
        const assign = await executeRbacAssignRole({ action: 'list_assignments' }, mockContext)
        const policy = await executeRbacCreatePolicy({ action: 'list' }, mockContext)
        expect(manage.dataSource).toBe('stub')
        expect(assign.dataSource).toBe('stub')
        expect(policy.dataSource).toBe('stub')
      } finally {
        if (prevUrl === undefined) delete process.env.SUPABASE_URL
        else process.env.SUPABASE_URL = prevUrl
        if (prevKey === undefined) delete process.env.SUPABASE_ANON_KEY
        else process.env.SUPABASE_ANON_KEY = prevKey
      }
    })
  })
})
