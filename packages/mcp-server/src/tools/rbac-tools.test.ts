/**
 * @fileoverview Tests for RBAC MCP tools
 * @see SMI-3901: RBAC MCP Tools (original shape, superseded)
 * @see SMI-6202 Wave 1 / SMI-6203 Wave 2: the real two-role / four-permission model these tests
 *      now cover — `RolePermissionsView` / `TeamMemberAssignment` / `RbacCreatePolicyResult.grants`,
 *      not the old `create_role`/`delete_role`/roleId/userId/policyId shapes.
 * @see SMI-6242: the corrected default matrix (`admin` denies `team:manage_rbac`/`team:manage_sso`)
 * @see SMI-6319 (`supabase/migrations/20260901000000_rbac_meta_permission_not_grantable.sql`):
 *      neither meta-permission may ever be GRANTED (`effect: 'allow'`) to a role by ANY caller,
 *      including the owner (stub gate 1b, `rbac-tools.stub.ts`'s `requireGrantWriteAuthority`).
 *      This makes every "owner elevates a non-owner with `team:manage_rbac`" setup step used by
 *      the old gate 4/5 tests below unconstructible — those tests are rewritten in place to
 *      assert the new refusal directly rather than deleted; see the comments at each site.
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
import type { RBACService } from './rbac-tools.types.js'
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

    // SMI-6319 (`20260901000000_rbac_meta_permission_not_grantable.sql`): this test used to prove
    // that once the OWNER elevated a non-owner `admin` with an explicit `team:manage_rbac` grant,
    // that elevated admin still could not rewrite `team:manage_rbac` itself (gate 1's non-owner
    // branch). SMI-6319 removes the ability to construct that principal at all -- no grant row may
    // ever set `team:manage_rbac` to `allow`, for ANY role, including by the owner -- so the
    // elevation step itself now fails before the original assertion is ever reached. Rewritten to
    // assert that unreachability directly, and that the refused write left no partial state.
    it('SMI-6319: the owner cannot elevate `admin` with team:manage_rbac (was gate 4, now unreachable)', async () => {
      const elevate = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_rbac',
          effect: 'allow',
        },
        mockContext
      )
      expect(elevate.success).toBe(false)
      expect(isPermissionDeniedError(elevate.error)).toBe(true)
      expect(permissionErrorText(elevate.error)).toBe(
        'The "team:manage_rbac" permission is owner-only and cannot be granted to another role.'
      )

      const after = await executeRbacManage({ action: 'get_role', role: 'admin' }, mockContext)
      expect(
        after.role!.permissions.find((p) => p.permission === 'team:manage_rbac')
      ).toMatchObject({ effect: 'deny', source: 'default' })
    })

    // SMI-6319: this test used to prove that an admin the owner had elevated with
    // `team:manage_rbac` could still freely write registry:* grants -- i.e. that gate 4's
    // meta-only restriction was not over-broad. That elevation is now unreachable (see the test
    // above), so a non-owner can no longer reach `set_role_permission` at all, for any
    // permission (see the gate-3 test earlier in this block -- that is now the permanent state
    // for every non-owner). Rewritten as the equivalent scope check for the NEW rule 1b: it
    // fires only for the two META_PERMISSIONS, so an ordinary registry:* `allow` write -- the
    // one write path a caller (now only ever the owner) can still make -- is untouched by it.
    it('SMI-6319 scope: rule 1b only blocks the two meta-permissions -- registry:* allow writes are unaffected', async () => {
      const approve = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'registry:approve',
          effect: 'allow',
        },
        mockContext
      )
      expect(approve.success).toBe(true)

      const deprecate = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'member',
          permission: 'registry:deprecate',
          effect: 'allow',
        },
        mockContext
      )
      expect(deprecate.success).toBe(true)
    })

    // Adversarial-review fix (SMI-6203 security round): gate 4 originally covered
    // `team:manage_rbac` only, so an admin the owner elevated for registry work could grant
    // itself `team:manage_sso` — IdP registration + domain claims, i.e. the ability to
    // authenticate as the owner. Both meta-permissions became owner-only, on write AND reset.
    //
    // SMI-6319 update: this test used to prove that an elevated (non-owner) admin could not
    // write or clear team:manage_sso. Elevation is now unreachable, so the scenario collapses
    // one step earlier — rewritten to prove team:manage_sso gets the SAME rule-1b refusal as
    // team:manage_rbac (the first test above), this time against the `member` role, completing
    // the (role x meta-permission) coverage matrix across this describe block.
    it('SMI-6319: the owner cannot elevate `member` with team:manage_sso either (was gate 4 scope, now unreachable)', async () => {
      const elevate = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'member',
          permission: 'team:manage_sso',
          effect: 'allow',
        },
        mockContext
      )
      expect(elevate.success).toBe(false)
      expect(isPermissionDeniedError(elevate.error)).toBe(true)
      // Names the permission actually attempted, not the one that gates the operation.
      expect(permissionErrorText(elevate.error)).toBe(
        'The "team:manage_sso" permission is owner-only and cannot be granted to another role.'
      )
    })

    // SMI-6319: this test used to prove the OWNER could still write and clear team:manage_sso —
    // true before SMI-6319, but the WRITE half is now the exact case rule 1b exists to refuse
    // (the owner is not exempt from rule 1b; only `hasPermission`'s unconditional owner
    // short-circuit is, and the owner never loses that). Split in two: the write half below now
    // asserts the refusal, and a second test confirms the owner can still write a DENY and clear
    // the row — `deny` can only narrow, so rule 1b never applies to it.
    it('gate 4 scope (SMI-6319): the OWNER cannot write an allow to team:manage_sso either', async () => {
      const grant = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_sso',
          effect: 'allow',
        },
        mockContext
      )
      expect(grant.success).toBe(false)
      expect(isPermissionDeniedError(grant.error)).toBe(true)
      expect(permissionErrorText(grant.error)).toBe(
        'The "team:manage_sso" permission is owner-only and cannot be granted to another role.'
      )
    })

    it('gate 4 scope: the OWNER can still write a deny and clear team:manage_sso', async () => {
      const denied = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_sso',
          effect: 'deny',
        },
        mockContext
      )
      expect(denied.success).toBe(true)
      expect(denied.message).toContain('Set **deny**')

      const cleared = await executeRbacManage(
        { action: 'reset_role_permission', role: 'admin', permission: 'team:manage_sso' },
        mockContext
      )
      expect(cleared.success).toBe(true)
      expect(cleared.message).toContain('Cleared the override')
    })

    // SMI-6319: this test used to prove that a MEMBER the owner had elevated with
    // `team:manage_rbac` could not self-widen its own registry:approve grant via a direct
    // effect='allow' write (gate 5's no-self-widening rule), though it COULD narrow via deny.
    // Elevation of `member` is now unreachable for the same reason as `admin` above — rewritten
    // to assert that unreachability for the `member` role target, completing the last of the
    // four (role x meta-permission) combinations this describe block now covers.
    it('SMI-6319: the owner cannot elevate `member` with team:manage_rbac either (was gate 5, now unreachable)', async () => {
      const elevate = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'member',
          permission: 'team:manage_rbac',
          effect: 'allow',
        },
        mockContext
      )
      expect(elevate.success).toBe(false)
      expect(isPermissionDeniedError(elevate.error)).toBe(true)
      expect(permissionErrorText(elevate.error)).toBe(
        'The "team:manage_rbac" permission is owner-only and cannot be granted to another role.'
      )
    })

    // SMI-6319 (confirmation-round fix, was gate 5): this test used to prove a granted member
    // could not bypass no-self-widening via set(deny)-then-reset on registry:approve (whose
    // admin default is `allow`). That bypass shape needed a "granted member" principal SMI-6319
    // makes unreachable (see the two tests above) — and it was specific to a permission whose
    // DEFAULT is `allow`. For team:manage_rbac/team:manage_sso, DEFAULT_ROLE_PERMISSIONS is
    // `deny` for every (role, permission) pair, so a reset can never restore a meta cell to
    // `allow`, and rule 1b (which only inspects effect === 'allow') needs no separate reset-side
    // twin. This proves that directly: the owner clearing a never-granted meta cell reports
    // "nothing to clear", not a refusal.
    it('SMI-6319: reset on a meta-permission needs no reset-side twin of rule 1b -- the default is always deny', async () => {
      const result = await executeRbacManage(
        { action: 'reset_role_permission', role: 'admin', permission: 'team:manage_rbac' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('already at the built-in default')
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

    // SMI-6267 UAT finding F3: each expanded permission in a create/delete batch is a SEPARATE
    // RPC call with no shared transaction — a mid-batch failure must report exactly which
    // permissions succeeded and which failed, not a bare success:false.
    it('create reports partial results (F3) when a mid-batch permission write fails', async () => {
      const calls: string[] = []
      const failingAfterFirst: RBACService = {
        listPermissions: async () => [],
        setRolePermission: async (_teamId, _role, permission) => {
          calls.push(permission)
          if (permission === 'registry:deprecate') {
            throw new Error('simulated RPC failure')
          }
        },
        resetRolePermission: async () => false,
        listMembers: async () => [],
        setMemberRole: async () => {},
      }
      setRBACService(failingAfterFirst)

      const result = await executeRbacCreatePolicy(
        {
          action: 'create',
          role: 'member',
          effect: 'deny',
          resources: ['registry'],
          actions: ['approve', 'deprecate'],
        },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(calls).toEqual(['registry:approve', 'registry:deprecate'])
      expect(result.grants).toBeUndefined()
      expect(result.partialResults).toEqual([
        { permission: 'registry:approve', succeeded: true },
        { permission: 'registry:deprecate', succeeded: false, error: 'simulated RPC failure' },
      ])
      expect(result.error).toBeTruthy()
      expect(result.message).toContain('registry:approve')
      expect(result.message).toContain('registry:deprecate')
    })

    it('delete reports partial results (F3) when a mid-batch reset fails', async () => {
      const failingAfterFirst: RBACService = {
        listPermissions: async () => [],
        setRolePermission: async () => {},
        resetRolePermission: async (_teamId, _role, permission) => {
          if (permission === 'registry:deprecate') {
            throw new Error('simulated reset failure')
          }
          return true
        },
        listMembers: async () => [],
        setMemberRole: async () => {},
      }
      setRBACService(failingAfterFirst)

      const result = await executeRbacCreatePolicy(
        {
          action: 'delete',
          role: 'member',
          resources: ['registry'],
          actions: ['approve', 'deprecate'],
        },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(result.partialResults).toEqual([
        { permission: 'registry:approve', succeeded: true },
        { permission: 'registry:deprecate', succeeded: false, error: 'simulated reset failure' },
      ])
      expect(result.error).toBeTruthy()
      expect(result.message).toContain('Cleared 1')
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
