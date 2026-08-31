/**
 * @fileoverview SMI-6319 — the two META-permissions are owner-only and NON-DELEGABLE.
 * @see supabase/migrations/20260901000000_rbac_meta_permission_not_grantable.sql — the fix
 *      (table CHECK `team_permission_grants_meta_permission_not_grantable` + gate 4b in
 *      `set_team_role_permission()`)
 * @see supabase/migrations/20260828000000_rbac_grant_writes.sql — the shipped gate 4 this
 *      supersedes: it checks the CALLER and never the TARGET
 * @see SMI-6312 — the UAT round that confirmed the escalation live
 *
 * THE BUG THIS PINS. `set_team_role_permission()`'s gate 4 verified that the CALLER was the team
 * owner before permitting a meta-permission write, and never looked at `p_role` — the TARGET the
 * permission was being handed to. So, live: the owner calls the RPC with
 * `{p_role:"member", p_permission:"team:manage_rbac", p_effect:"allow"}` and gets a 204; a plain
 * member of that team then reads `has_team_permission(TEAM,'team:manage_rbac') -> true`. That is
 * the exact end state gate 4 exists to prevent, reached one call earlier by a caller who was
 * allowed to make it. `team:manage_rbac` gates every grant write and every role change;
 * `team:manage_sso` gates IdP registration and domain claims, so a non-owner holding it can
 * register an attacker-controlled IdP, claim the team's domain, and authenticate AS THE OWNER.
 *
 * Separate from `rbac-tools.test.ts` (already over the 500-line `audit:standards` budget), and
 * named for the invariant so it is findable when someone next touches the grant-write gates —
 * same split rationale as `registry-tools.live.review-rbac-widening.test.ts`.
 *
 * FOUR LAYERS, because any one alone is a single point of failure: (1) the stub's
 * `requireGrantWriteAuthority` rule 1b; (2) the `rbac_manage` and `rbac_create_policy` tool
 * surfaces; (3) error mapping, so the refusal reaches the customer as authored copy rather than
 * the generic sentence (`PASSTHROUGH_REFUSALS`); and (4) the shipped SQL itself. Layer 4 catches
 * the regression this schema is most exposed to — a future `CREATE OR REPLACE FUNCTION
 * set_team_role_permission(...)` reproducing an older body and silently dropping every
 * function-level gate, with no error and no table diff.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  executeRbacManage,
  executeRbacCreatePolicy,
  createStubRBACService,
  setRBACService,
} from './rbac-tools.js'
import { META_PERMISSIONS, MANAGE_RBAC_PERMISSION } from './rbac-tools.types.js'
import type { GrantableRole, PermissionEffect, TeamPermission } from './rbac-tools.types.js'
import { STUB_TEAM_ID, type StubRBACService } from './rbac-tools.stub.js'
import {
  isPermissionDeniedError,
  permissionErrorText,
  toPermissionDeniedError,
  permissionDeniedMessage,
} from './team-permission-error.js'

const mockContext = {} as ToolContext

/** The exact sentence gate 4b raises, parameterised the same way the SQL's `%` is. */
const notGrantable = (permission: TeamPermission): string =>
  `The "${permission}" permission is owner-only and cannot be granted to another role.`

const GRANTABLE_ROLES_UNDER_TEST: readonly GrantableRole[] = ['admin', 'member']
const ORDINARY_PERMISSIONS: readonly TeamPermission[] = ['registry:approve', 'registry:deprecate']

describe('SMI-6319: meta-permissions are non-delegable', () => {
  let stub: StubRBACService

  beforeEach(() => {
    stub = createStubRBACService()
    setRBACService(stub)
    // The default stub actor is the team OWNER — deliberately, because the owner is the ONLY
    // principal that reaches this gate at all. Gate 3 (`team:manage_rbac`) already stops every
    // non-owner, and post-fix no non-owner can ever hold that permission. A test that used a
    // non-owner here would pass for the wrong reason.
    stub.setActor({ userId: 'stub-owner', teamId: STUB_TEAM_ID, role: 'owner' })
  })

  // ==========================================================================
  // Layer 1+2: the refusal itself — REQUIREMENT 1 (the exact UAT repro)
  // ==========================================================================

  describe('the owner cannot grant either meta-permission to any role', () => {
    for (const permission of META_PERMISSIONS) {
      for (const role of GRANTABLE_ROLES_UNDER_TEST) {
        it(`refuses set_role_permission(${role}, ${permission}, allow) — the SMI-6312 repro`, async () => {
          const result = await executeRbacManage(
            { action: 'set_role_permission', role, permission, effect: 'allow' },
            mockContext
          )

          expect(result.success).toBe(false)
          // Structured refusal, not a bare validation string: the CLI and website both branch
          // on this shape, and a raw 23514 from the table CHECK would NOT produce it.
          expect(isPermissionDeniedError(result.error)).toBe(true)
          expect(permissionErrorText(result.error)).toBe(notGrantable(permission))
          // `permission` names what the OPERATION required, not what was attempted — matching
          // the live path, where `toPermissionDeniedError(err, MANAGE_RBAC_PERMISSION)` is
          // called with the statically-known required permission.
          expect(result.error).toMatchObject({ permission: MANAGE_RBAC_PERMISSION })

          // ...and nothing was written. A refusal that still persisted the row would pass every
          // assertion above while leaving the escalation in place.
          const listed = await executeRbacManage({ action: 'list_roles' }, mockContext)
          expect(listed.success).toBe(true)
          // Still the built-in default (deny, source 'default'), NOT a written grant row.
          expect(
            listed.permissions?.find((p) => p.role === role && p.permission === permission)
          ).toMatchObject({ effect: 'deny', source: 'default' })
        })
      }
    }

    it('the refusal names the permission actually attempted, so SSO is not reported as RBAC', async () => {
      const sso = await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'admin',
          permission: 'team:manage_sso',
          effect: 'allow',
        },
        mockContext
      )
      expect(permissionErrorText(sso.error)).toContain('team:manage_sso')
      expect(permissionErrorText(sso.error)).not.toContain('team:manage_rbac')
    })
  })

  // ==========================================================================
  // Layer 1+2: NOT over-broad — REQUIREMENT 2
  // ==========================================================================

  describe('every other grant is completely unaffected', () => {
    for (const role of GRANTABLE_ROLES_UNDER_TEST) {
      for (const permission of ORDINARY_PERMISSIONS) {
        for (const effect of ['allow', 'deny'] as PermissionEffect[]) {
          it(`still writes ${effect} on ${permission} for ${role}`, async () => {
            const result = await executeRbacManage(
              { action: 'set_role_permission', role, permission, effect },
              mockContext
            )
            expect(result.success).toBe(true)

            const listed = await executeRbacManage({ action: 'list_roles' }, mockContext)
            expect(
              listed.permissions?.find((p) => p.role === role && p.permission === permission)
            ).toMatchObject({ effect, source: 'grant' })
          })
        }
      }
    }

    it('still clears an ordinary override with reset_role_permission', async () => {
      await executeRbacManage(
        {
          action: 'set_role_permission',
          role: 'member',
          permission: 'registry:approve',
          effect: 'allow',
        },
        mockContext
      )
      const cleared = await executeRbacManage(
        { action: 'reset_role_permission', role: 'member', permission: 'registry:approve' },
        mockContext
      )
      expect(cleared.success).toBe(true)
      expect(cleared.message).toContain('Cleared the override')
    })

    // The deliberate scope boundary. A DENY on a meta-permission can only narrow: the owner is
    // exempt via `has_team_permission()`'s owner short-circuit, and both roles already default
    // to deny post-SMI-6242 — so blocking it would buy zero security and remove the owner's
    // ability to pin intent explicitly (it surfaces as source 'grant' rather than 'default').
    // If a future change tightens gate 4b to cover deny as well, these fail rather than
    // silently shipping an over-broad refusal (the s10b lesson).
    for (const permission of META_PERMISSIONS) {
      it(`still allows the OWNER to write a DENY row for ${permission}`, async () => {
        const result = await executeRbacManage(
          { action: 'set_role_permission', role: 'admin', permission, effect: 'deny' },
          mockContext
        )
        expect(result.success).toBe(true)

        const listed = await executeRbacManage({ action: 'list_roles' }, mockContext)
        expect(
          listed.permissions?.find((p) => p.role === 'admin' && p.permission === permission)
        ).toMatchObject({ effect: 'deny', source: 'grant' })
      })

      it(`still allows the OWNER to clear a ${permission} deny row`, async () => {
        await executeRbacManage(
          { action: 'set_role_permission', role: 'admin', permission, effect: 'deny' },
          mockContext
        )
        const cleared = await executeRbacManage(
          { action: 'reset_role_permission', role: 'admin', permission },
          mockContext
        )
        expect(cleared.success).toBe(true)
      })

      // The ON CONFLICT DO UPDATE branch: a legal deny row already exists, and the write is an
      // UPDATE rather than an INSERT. The all-fresh-cell cases above never reach it.
      it(`refuses upgrading an existing ${permission} deny row to allow`, async () => {
        await executeRbacManage(
          { action: 'set_role_permission', role: 'admin', permission, effect: 'deny' },
          mockContext
        )
        const upgrade = await executeRbacManage(
          { action: 'set_role_permission', role: 'admin', permission, effect: 'allow' },
          mockContext
        )
        expect(upgrade.success).toBe(false)
        expect(permissionErrorText(upgrade.error)).toBe(notGrantable(permission))

        const listed = await executeRbacManage({ action: 'list_roles' }, mockContext)
        expect(
          listed.permissions?.find((p) => p.role === 'admin' && p.permission === permission)
        ).toMatchObject({ effect: 'deny' })
      })
    }
  })

  // ==========================================================================
  // Layer 2: the BULK / WILDCARD path — REQUIREMENT 3
  // ==========================================================================

  describe('rbac_create_policy (the bulk/wildcard writer) is covered too', () => {
    // `rbac_create_policy` has no bulk SQL writer of its own: `executeRbacCreatePolicy` expands
    // `resources x actions` into N INDEPENDENT `setRolePermission` calls, one PostgREST request
    // each (rbac-tools.action.ts, and the SMI-6267 F3 note on
    // `RbacCreatePolicyPermissionOutcome`). So it inherits gate 4b per call rather than needing
    // an equivalent guard of its own — these tests are what proves that inheritance, and would
    // fail loudly if a future batched RPC were introduced without carrying the invariant.
    it('refuses a wildcard expansion that resolves to both meta-permissions', async () => {
      const result = await executeRbacCreatePolicy(
        {
          action: 'create',
          role: 'admin',
          resources: ['team'],
          actions: ['manage_rbac', 'manage_sso'],
          effect: 'allow',
        },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(isPermissionDeniedError(result.error)).toBe(true)
      expect(permissionErrorText(result.error)).toBe(notGrantable('team:manage_rbac'))

      // partialResults names every permission and its outcome, so a caller can see that NOTHING
      // was written rather than guessing at the batch's end state.
      expect(result.partialResults).toHaveLength(2)
      expect(result.partialResults?.every((o) => !o.succeeded)).toBe(true)
      expect(result.partialResults?.map((o) => o.permission)).toEqual([
        'team:manage_rbac',
        'team:manage_sso',
      ])
      expect(result.grants).toBeUndefined()
    })

    it('a refused bulk expansion writes no grant rows at all', async () => {
      await executeRbacCreatePolicy(
        {
          action: 'create',
          role: 'member',
          resources: ['team'],
          actions: ['manage_rbac', 'manage_sso'],
          effect: 'allow',
        },
        mockContext
      )

      const listed = await executeRbacManage({ action: 'list_roles' }, mockContext)
      const written = listed.permissions?.filter(
        (p) => META_PERMISSIONS.includes(p.permission) && p.source === 'grant'
      )
      expect(written).toEqual([])
    })

    it('the bulk path still applies an ordinary registry policy (not over-broad)', async () => {
      const result = await executeRbacCreatePolicy(
        {
          action: 'create',
          role: 'member',
          resources: ['registry'],
          actions: ['approve', 'deprecate'],
          effect: 'allow',
        },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.grants).toHaveLength(2)
      expect(result.partialResults).toBeUndefined()
    })

    it('the bulk DELETE path still clears an ordinary registry policy', async () => {
      await executeRbacCreatePolicy(
        {
          action: 'create',
          role: 'member',
          resources: ['registry'],
          actions: ['approve'],
          effect: 'deny',
        },
        mockContext
      )
      const removed = await executeRbacCreatePolicy(
        { action: 'delete', role: 'member', resources: ['registry'], actions: ['approve'] },
        mockContext
      )
      expect(removed.success).toBe(true)
    })
  })

  // ==========================================================================
  // Layer 3: the refusal survives the live PostgREST -> tool-layer mapping
  // ==========================================================================

  describe('the live 42501 renders as authored copy, not the generic sentence', () => {
    // Regression pin for the exact failure mode the SMI-6203 security round found on the
    // sibling refusals: `toPermissionDeniedError` matches `PASSTHROUGH_REFUSALS` by full string,
    // so a sentence added to the SQL but not to that allowlist silently degrades to the generic
    // "You don't have the ... permission" copy. These assert the round trip a real PostgREST
    // error takes, without needing Postgres.
    for (const permission of META_PERMISSIONS) {
      it(`maps gate 4b's ${permission} refusal to its own authored text`, () => {
        const mapped = toPermissionDeniedError(
          { code: '42501', message: notGrantable(permission) },
          MANAGE_RBAC_PERMISSION
        )
        expect(mapped).toEqual({
          code: 'permission_denied',
          permission: MANAGE_RBAC_PERMISSION,
          message: notGrantable(permission),
        })
        expect(mapped?.message).not.toBe(permissionDeniedMessage(MANAGE_RBAC_PERMISSION))
      })
    }

    it('still falls back to the generic sentence for an unrecognised 42501', () => {
      // Postgres itself raises 42501 with messages naming internal schema objects. The
      // allowlist must stay an allowlist — widening it to a prefix match while adding SMI-6319's
      // sentences would leak those verbatim.
      const mapped = toPermissionDeniedError(
        { code: '42501', message: 'permission denied for table team_permission_grants' },
        MANAGE_RBAC_PERMISSION
      )
      expect(mapped?.message).toBe(permissionDeniedMessage(MANAGE_RBAC_PERMISSION))
    })

    it('does not classify the table CHECK violation (23514) as a permission denial', () => {
      // The CHECK is the backstop, never the customer-facing path: a 23514 is not a denial, so
      // if it ever reached a customer it would surface as an ordinary error naming the
      // constraint. That is precisely why gate 4b exists alongside the constraint.
      expect(
        toPermissionDeniedError(
          {
            code: '23514',
            message:
              'new row for relation "team_permission_grants" violates check constraint ' +
              '"team_permission_grants_meta_permission_not_grantable"',
          },
          MANAGE_RBAC_PERMISSION
        )
      ).toBeNull()
    })
  })
})
