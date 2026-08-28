/**
 * @fileoverview In-memory stub RBACService — the real two-role / four-permission model
 * @module @skillsmith/mcp-server/tools/rbac-tools.stub
 * @see SMI-6202 Wave 1: `team_permission_grants` + the five resolver/read functions
 * @see SMI-6203 Wave 2: the live service this stub mirrors
 *      (`rbac-tools.live.ts`, `20260828000000_rbac_grant_writes.sql`)
 *
 * Extracted from `rbac-tools.types.ts` to stay under the 500-line file-size gate — the same split
 * `registry-tools.stub.ts` and `rbac-tools.schemas.ts` already made for their sibling files. This
 * file holds ONLY the stub factory and its private helpers; every domain type/interface it depends
 * on still lives in `rbac-tools.types.ts` and is imported from there.
 */

import { markAsStub } from './stub-data-source.js'
import { TeamPermissionDeniedError } from './team-permission-error.js'
import {
  DEFAULT_ROLE_PERMISSIONS,
  GRANTABLE_ROLES,
  MANAGE_RBAC_PERMISSION,
  META_PERMISSIONS,
  TEAM_PERMISSIONS,
  resolveEffectivePermission,
} from './rbac-tools.types.js'
import type {
  GrantableRole,
  PermissionEffect,
  RBACService,
  TeamMemberAssignment,
  TeamMemberRole,
  TeamPermission,
} from './rbac-tools.types.js'

/**
 * The simulated caller — the stub's stand-in for `auth.uid()` plus the `team_members` row
 * `has_team_permission()` reads. There is no JWT and no RLS behind this stub, so every gate it
 * mirrors keys off this instead.
 */
export interface StubRbacActor {
  /** Simulated `auth.uid()`. `null` means "not signed in" — every gate then fails closed. */
  userId: string | null
  /** The team the caller belongs to. A call for any other team resolves as "not a member". */
  teamId: string
  /** The caller's own `team_members.role`, or `null` to simulate "not a member of this team". */
  role: TeamMemberRole | null
}

/** `RBACService` plus the stub-only seams. NOT part of the shared interface. */
export interface StubRBACService extends RBACService {
  setActor(actor: StubRbacActor): void
  setMembers(members: TeamMemberAssignment[]): void
}

/**
 * The team id stub mode resolves to. Exported because `rbac-tools.ts`'s `resolveTeamId()` returns
 * this same value when Supabase is unconfigured (mirroring `registry-tools.ts`) — if the two ever
 * disagreed, every stub call would fail the stub's own membership check as "not a member of this
 * team", which is a confusing way to discover a constant drifted.
 */
export const STUB_TEAM_ID = 'team_stub_00000000-0000-0000-0000-000000000000'

const DEFAULT_STUB_ACTOR: StubRbacActor = {
  userId: 'stub-owner',
  teamId: STUB_TEAM_ID,
  role: 'owner',
}

const DEFAULT_STUB_MEMBERS: readonly TeamMemberAssignment[] = [
  {
    memberId: 'tm_stub_owner',
    userId: 'stub-owner',
    role: 'owner',
    fullName: 'Stub Owner',
    email: 'owner@example.test',
    joinedAt: '2026-01-01T00:00:00.000Z',
    invitedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    memberId: 'tm_stub_admin',
    userId: 'stub-admin',
    role: 'admin',
    fullName: 'Stub Admin',
    email: 'admin@example.test',
    joinedAt: '2026-01-02T00:00:00.000Z',
    invitedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    memberId: 'tm_stub_member',
    userId: 'stub-member',
    role: 'member',
    fullName: 'Stub Member',
    email: 'member@example.test',
    joinedAt: '2026-01-03T00:00:00.000Z',
    invitedAt: '2026-01-03T00:00:00.000Z',
  },
]

/**
 * In-memory RBAC service for local dev and stub-mode tests.
 *
 * WHAT IT MIRRORS FAITHFULLY (so a permission-resolution test proves the same thing on both
 * paths): owner exemption checked BEFORE any grant lookup, deny-wins-over-allow, fallthrough to
 * the default matrix, `get_effective_team_permissions`'s own `team:manage_rbac` self-gate, and
 * `set_team_member_role`'s four refusals — not-found masked as `permission_denied` (no cross-team
 * existence oracle), owner's role untouchable, only the owner may change an existing admin's role,
 * and only owners/admins may promote a member to admin.
 *
 * WHAT IT CANNOT MIRROR, and must never be read as evidence about: RLS itself. Every gate below is
 * an application-level `if`, which a future new method can simply forget; the live policies and
 * SECURITY DEFINER bodies cannot be forgotten at a new call site. Cross-team isolation is
 * approximated by the single-team actor, not enforced by a policy engine.
 */
export function createStubRBACService(): StubRBACService {
  const grants = new Map<string, PermissionEffect>()
  let actor: StubRbacActor = { ...DEFAULT_STUB_ACTOR }
  let members: TeamMemberAssignment[] = DEFAULT_STUB_MEMBERS.map((m) => ({ ...m }))

  const grantKey = (teamId: string, role: GrantableRole, permission: TeamPermission): string =>
    `${teamId}::${role}::${permission}`

  /** `has_team_permission(p_team_id, p_permission)` in miniature. Never returns undefined. */
  const hasPermission = (teamId: string, permission: TeamPermission): boolean => {
    if (actor.userId === null || actor.role === null || actor.teamId !== teamId) return false
    if (actor.role === 'owner') return true
    const grant = grants.get(grantKey(teamId, actor.role, permission))
    return resolveEffectivePermission(actor.role, permission, grant).effect === 'allow'
  }

  const requirePermission = (teamId: string, permission: TeamPermission): void => {
    if (!hasPermission(teamId, permission)) throw new TeamPermissionDeniedError(permission)
  }

  /**
   * The two owner-anchored write gates, mirroring `set_team_member_role`'s F-2/H1 fixes into the
   * grant-write path. Byte-for-byte the same rules and the same refusal copy as gates 4 and 5 of
   * `set_team_role_permission()` / `reset_team_role_permission()`
   * (`20260828000000_rbac_grant_writes.sql`) — if either side moves, both move:
   *
   *  1. Only the OWNER may write or clear a grant for EITHER {@link META_PERMISSIONS} entry.
   *     (Adversarial-review fix: this originally covered `team:manage_rbac` only, leaving an
   *     elevated non-owner free to self-grant SSO control and reach owner authority in two hops.)
   *  2. Only an `owner`- or `admin`-role caller may create an `allow` STATE for `(role,
   *     permission)` — whether by writing `effect:'allow'` directly, or by CLEARING an explicit
   *     `deny` on a cell whose built-in default is `allow` (today: `admin` x `registry:approve` /
   *     `registry:deprecate`, per {@link DEFAULT_ROLE_PERMISSIONS}). Confirmation-review fix: the
   *     first draft of this gate only checked `effect === 'allow'`, so a `member`-role caller
   *     blocked from `setRolePermission(teamId,'admin','registry:approve','allow')` could reach
   *     the IDENTICAL forbidden state via `setRolePermission(...,'deny')` (to write a row) then
   *     `resetRolePermission(...)` (to clear it back to the allow default) — two calls landing on
   *     the one state gate 5 exists to keep out of a member-role caller's reach. `wouldWiden`
   *     below evaluates the SAME "does this call end in an allow state" question for both
   *     operations, not just `effect==='allow'`. A `member`-role caller — reaching this only via
   *     an explicit `team:manage_rbac` allow grant — may still review the matrix and remove any
   *     grant that does NOT widen (clearing a cell whose default is `deny`, which is every
   *     `member` cell and, post-SMI-6242, every meta cell). Written as "not owner and not admin"
   *     rather than "is member" so a `null` role also fails closed, matching the SQL's NULL-closed
   *     form.
   *
   * The refusal names the permission actually attempted, so an SSO denial does not claim to be
   * about RBAC; the `permission` field stays {@link MANAGE_RBAC_PERMISSION} because that is the
   * permission the OPERATION required, which is also what the live path reports.
   */
  const requireGrantWriteAuthority = (
    role: GrantableRole,
    permission: TeamPermission,
    effect: PermissionEffect | 'reset'
  ): void => {
    if (META_PERMISSIONS.includes(permission) && actor.role !== 'owner') {
      throw new TeamPermissionDeniedError(
        MANAGE_RBAC_PERMISSION,
        `Only the team owner can change who holds the "${permission}" permission.`
      )
    }
    const wouldWiden =
      effect === 'allow' ||
      (effect === 'reset' && DEFAULT_ROLE_PERMISSIONS[role][permission] === 'allow')
    if (wouldWiden && actor.role !== 'owner' && actor.role !== 'admin') {
      throw new TeamPermissionDeniedError(
        MANAGE_RBAC_PERMISSION,
        "Only owners and admins can widen a role's permissions. You can review permissions and " +
          'remove grants, but not add an allow.'
      )
    }
  }

  return markAsStub<StubRBACService>({
    async listPermissions(teamId) {
      requirePermission(teamId, MANAGE_RBAC_PERMISSION)
      return GRANTABLE_ROLES.flatMap((role) =>
        TEAM_PERMISSIONS.map((permission) =>
          resolveEffectivePermission(
            role,
            permission,
            grants.get(grantKey(teamId, role, permission))
          )
        )
      )
    },

    async setRolePermission(teamId, role, permission, effect) {
      requirePermission(teamId, MANAGE_RBAC_PERMISSION)
      requireGrantWriteAuthority(role, permission, effect)
      grants.set(grantKey(teamId, role, permission), effect)
    },

    async resetRolePermission(teamId, role, permission) {
      requirePermission(teamId, MANAGE_RBAC_PERMISSION)
      requireGrantWriteAuthority(role, permission, 'reset')
      return grants.delete(grantKey(teamId, role, permission))
    },

    async listMembers(teamId) {
      // `list_team_members_with_profile` gates on MEMBERSHIP, not on any permission — so this is
      // not a TeamPermissionDeniedError, and must not be dressed up as one.
      if (actor.userId === null || actor.role === null || actor.teamId !== teamId) {
        throw new Error('You are not a member of this team.')
      }
      return members.map((m) => ({ ...m }))
    },

    async setMemberRole(memberId, role) {
      const target = members.find((m) => m.memberId === memberId)
      // Not-found raises the SAME refusal as no-permission (migration fix L1): otherwise any
      // caller could probe arbitrary member ids for existence across teams.
      if (!target) throw new TeamPermissionDeniedError(MANAGE_RBAC_PERMISSION)
      requirePermission(actor.teamId, MANAGE_RBAC_PERMISSION)
      if (target.role === 'owner') {
        throw new TeamPermissionDeniedError(
          MANAGE_RBAC_PERMISSION,
          "cannot change the team owner's role"
        )
      }
      if (target.role === 'admin' && actor.role !== 'owner') {
        throw new TeamPermissionDeniedError(
          MANAGE_RBAC_PERMISSION,
          "forbidden: only the team owner can change an admin's role"
        )
      }
      if (role === 'admin' && actor.role !== 'owner' && actor.role !== 'admin') {
        throw new TeamPermissionDeniedError(
          MANAGE_RBAC_PERMISSION,
          'forbidden: only owners and admins can promote a member to admin'
        )
      }
      target.role = role
    },

    setActor(next) {
      actor = { ...next }
    },

    setMembers(next) {
      members = next.map((m) => ({ ...m }))
    },
  })
}
