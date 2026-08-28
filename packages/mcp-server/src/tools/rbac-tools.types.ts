/**
 * @fileoverview RBAC domain types — the real two-role / four-permission model
 * @module @skillsmith/mcp-server/tools/rbac-tools.types
 * @see SMI-3901: RBAC MCP Tools (the original in-memory shape this replaces)
 * @see SMI-6202 Wave 1: `team_permission_grants` + `default_role_permission` /
 *      `has_team_permission` / `team_ids_with_permission` / `get_effective_team_permissions` /
 *      `set_team_member_role` (`supabase/migrations/20260827000000_team_permission_grants.sql`)
 * @see SMI-6203 Wave 2: the live service these types describe
 * @see SMI-6242: security fix correcting `default_role_permission()`'s admin default — Wave 1
 *      shipped `team:manage_rbac`/`team:manage_sso` as admin-allow, contradicting the plan's
 *      owner-only design; fixed in `20260828000000_rbac_grant_writes.sql`
 *
 * WHAT CHANGED, AND WHY THE OLD MODEL HAD TO GO.
 *
 * The previous version of this file modelled arbitrary custom roles: `createRole`/`deleteRole`, a
 * `hierarchy: number`, and policies built from generic `resources[]`/`actions[]` patterns. None of
 * that exists anywhere in the database, and none of it ever persisted past a process restart —
 * `createStubRBACService()` was an in-memory `Map` and no live service was ever wired in. Its
 * `DEFAULT_ROLES` also published a fourth vocabulary (`admin`/`manager`/`member`/`viewer`) that
 * `team_members.role CHECK(role IN ('owner','admin','member'))` cannot express.
 *
 * The real model, as shipped in Wave 1:
 *
 *  - Base roles are FIXED at three (`owner`/`admin`/`member`) and stay in `team_members.role`.
 *    Only `admin` and `member` are configurable — `owner` is exempt from the grant table entirely
 *    (the no-lockout invariant, enforced by `team_permission_grants.role`'s CHECK and by
 *    `has_team_permission()` short-circuiting before it ever reads a grant row).
 *  - Permissions are a FIXED set of four strings, pinned by a CHECK constraint precisely so a
 *    grant cannot be settable-but-unenforced.
 *  - Per-team `allow`/`deny` overrides live in `team_permission_grants`; deny wins over allow, and
 *    an absent row falls through to the built-in default matrix.
 *
 * So an Enterprise admin does not invent roles — they reshape what `admin` and `member` MEAN
 * inside their own team, at permission granularity. `ReadOnly` is `member` with denies; `Manager`
 * is `member` with allows. That is the whole product surface, and these types now say so.
 */

import type { PermissionDeniedError } from './team-permission-error.js'

// ============================================================================
// Domain vocabulary — mirrors the SQL exactly
// ============================================================================

/** Every role `team_members.role` can hold (migration 011). */
export type TeamMemberRole = 'owner' | 'admin' | 'member'

/**
 * The roles a grant row may name. `owner` is deliberately absent: `team_permission_grants.role`
 * CHECKs `IN ('admin','member')`, and an owner is always allowed everything.
 */
export type GrantableRole = 'admin' | 'member'

export const GRANTABLE_ROLES: readonly GrantableRole[] = ['admin', 'member'] as const

/**
 * The four permissions Wave 1 both defines AND enforces. Widening this list requires a migration
 * (the CHECK constraint on `team_permission_grants.permission` is the contract), never an
 * application-level change here.
 */
export type TeamPermission =
  | 'registry:approve'
  | 'registry:deprecate'
  | 'team:manage_rbac'
  | 'team:manage_sso'

export const TEAM_PERMISSIONS: readonly TeamPermission[] = [
  'registry:approve',
  'registry:deprecate',
  'team:manage_rbac',
  'team:manage_sso',
] as const

/** The meta-permission every write in this module is gated on. */
export const MANAGE_RBAC_PERMISSION: TeamPermission = 'team:manage_rbac'

/**
 * The two META-permissions: the ones that decide who may reconfigure authority itself, rather than
 * who may do ordinary registry work. Both carry the identical owner-only default in the plan's
 * design table (`owner ✓ / admin ✗ / member ✗`), and per gate 4 of `set_team_role_permission()` /
 * `reset_team_role_permission()` (`20260828000000_rbac_grant_writes.sql`) only an `owner`-role
 * caller may write OR clear a grant row for either. `team:manage_sso` belongs here on merit rather
 * than symmetry — it gates IdP registration and domain claims, so a non-owner able to self-grant
 * it could authenticate as the owner. Full three-part rationale: that migration's header, gate 4.
 */
export const META_PERMISSIONS: readonly TeamPermission[] = [
  'team:manage_rbac',
  'team:manage_sso',
] as const

export type PermissionEffect = 'allow' | 'deny'

/** Whether an explicit grant row decided this cell, or it fell through to the default matrix. */
export type PermissionSource = 'grant' | 'default'

/**
 * The built-in matrix, byte-equivalent to `default_role_permission(p_role, p_permission)` as
 * corrected in Wave 2 (SMI-6242): `admin` allows the two registry permissions only, `member`
 * allows none, and any unknown pair resolves `false` (never NULL — the SQL's outer COALESCE
 * guarantees that, because callers do `IF NOT has_team_permission(...)` and `NOT NULL` would fail
 * OPEN).
 *
 * SMI-6242 SECURITY FIX (Wave 2): Wave 1's shipped `default_role_permission()` granted `admin`
 * ALL FOUR permissions, including `team:manage_rbac` and `team:manage_sso` — the two
 * meta-permissions that decide who may grant/deny every other permission. The plan's own design
 * table (docs/internal/implementation/smi-6200-enterprise-rbac-sso-real-implementation.md lines
 * 268-280) defines both as owner-only by default (owner yes / admin no / member no), and the
 * whole security model depends on that — an admin who can freely rewrite `team:manage_rbac` can
 * mint itself (or any other admin) permanent RBAC authority with no owner involved. Wave 2's
 * migration (`20260828000000_rbac_grant_writes.sql`) corrects `default_role_permission()` via
 * `CREATE OR REPLACE`, removing the `('admin', 'team:manage_rbac')` and
 * `('admin', 'team:manage_sso')` rows — `admin` now allows only the two registry permissions.
 * The SQL is the source of truth and this table matches it — if this default is ever revisited
 * again, it changes in the migration first and here second, never the other way round.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<
  Record<GrantableRole, Readonly<Record<TeamPermission, PermissionEffect>>>
> = {
  admin: {
    'registry:approve': 'allow',
    'registry:deprecate': 'allow',
    'team:manage_rbac': 'deny',
    'team:manage_sso': 'deny',
  },
  member: {
    'registry:approve': 'deny',
    'registry:deprecate': 'deny',
    'team:manage_rbac': 'deny',
    'team:manage_sso': 'deny',
  },
} as const

// ============================================================================
// Service types
// ============================================================================

/** One resolved cell of the (role x permission) matrix — one of the 8 rows the RPC returns. */
export interface EffectivePermission {
  role: GrantableRole
  permission: TeamPermission
  effect: PermissionEffect
  source: PermissionSource
}

/** One fixed role plus its resolved permissions — what `list_roles`/`get_role` now return. */
export interface RolePermissionsView {
  role: GrantableRole
  permissions: EffectivePermission[]
}

/**
 * One row of the team roster, from `list_team_members_with_profile(p_team_id)`.
 *
 * `memberId` is `team_members.id` — the join-row PK, and the ONLY identifier
 * `set_team_member_role(p_member_id, p_role)` accepts. `userId` is carried alongside it for
 * display and correlation, never as an input to a write.
 */
export interface TeamMemberAssignment {
  memberId: string
  userId: string
  role: TeamMemberRole
  fullName: string | null
  email: string | null
  joinedAt: string | null
  invitedAt: string | null
}

/**
 * The RBAC management surface. Every method here is a thin projection of one Wave 1 SQL function —
 * the authorization decision lives in the database, never in this layer.
 *
 * | Method                  | Backing SQL                                        |
 * |-------------------------|----------------------------------------------------|
 * | `listPermissions`       | `get_effective_team_permissions(p_team_id)`        |
 * | `setRolePermission`     | `set_team_role_permission(...)` (Wave 2 RPC)       |
 * | `resetRolePermission`   | `reset_team_role_permission(...)` (Wave 2 RPC)     |
 * | `listMembers`           | `list_team_members_with_profile(p_team_id)`        |
 * | `setMemberRole`         | `set_team_member_role(p_member_id, p_role)`        |
 *
 * Permission refusals are thrown as {@link TeamPermissionDeniedError}, never returned as `null` —
 * "denied" and "empty" must not be indistinguishable at a call site.
 */
export interface RBACService {
  /**
   * The full resolved (role x permission) picture: 8 rows, 2 roles x 4 permissions.
   * Requires `team:manage_rbac` — the RPC self-gates, and that gate IS the authorization decision.
   */
  listPermissions(teamId: string): Promise<EffectivePermission[]>

  /** Write (or overwrite) one explicit grant row. Requires `team:manage_rbac`. */
  setRolePermission(
    teamId: string,
    role: GrantableRole,
    permission: TeamPermission,
    effect: PermissionEffect
  ): Promise<void>

  /**
   * Clear one explicit grant row, restoring the built-in default for that cell.
   *
   * Returns whether a grant row actually existed — deliberately NOT `void`. Clearing an override
   * that was never set and clearing a real one leave the same effective state, so the caller
   * cannot tell them apart from the resulting matrix, and "no override was set" is materially
   * different feedback from "the deny you configured is gone". Same precedent as
   * `PrivateRegistryService.deprecate()`, which returns a boolean for exactly this reason.
   */
  resetRolePermission(
    teamId: string,
    role: GrantableRole,
    permission: TeamPermission
  ): Promise<boolean>

  /** The team roster. Membership-gated only (any member may read it), not `team:manage_rbac`. */
  listMembers(teamId: string): Promise<TeamMemberAssignment[]>

  /**
   * Change one member's base role. `memberId` is `team_members.id`, matching the site-wide
   * convention (`remove_team_member`, `set_team_member_github_username`). `role` can never be
   * `owner` — promoting to owner is a separate, more guarded mechanism, out of scope here.
   */
  setMemberRole(memberId: string, role: GrantableRole): Promise<void>
}

// ============================================================================
// Result types
// ============================================================================

/**
 * `error` is a plain string for input-validation failures (unchanged) and the structured
 * {@link PermissionDeniedError} for a permission refusal — the shape the Wave 2 plan specifies
 * once, so the CLI and website can render `error.message` verbatim. Narrow with
 * `isPermissionDeniedError()` or render either with `permissionErrorText()`.
 */
export type RbacToolError = string | PermissionDeniedError

export interface RbacManageResult {
  success: boolean
  dataSource: 'stub' | 'live'
  role?: RolePermissionsView
  roles?: RolePermissionsView[]
  permissions?: EffectivePermission[]
  message?: string
  error?: RbacToolError
}

export interface RbacAssignRoleResult {
  success: boolean
  dataSource: 'stub' | 'live'
  assignment?: TeamMemberAssignment
  assignments?: TeamMemberAssignment[]
  message?: string
  error?: RbacToolError
}

export interface RbacCreatePolicyResult {
  success: boolean
  dataSource: 'stub' | 'live'
  /** The grant rows a `create`/`delete` expansion wrote or cleared. */
  grants?: EffectivePermission[]
  message?: string
  error?: RbacToolError
}

// ============================================================================
// Shared resolution logic (mirrors has_team_permission / default_role_permission)
// ============================================================================

/**
 * Resolve one cell the way `get_effective_team_permissions()` does: an explicit grant wins
 * (deny beats allow), otherwise the default matrix.
 *
 * Exported so a test can assert stub and live agree on resolution without reaching for Postgres.
 */
export function resolveEffectivePermission(
  role: GrantableRole,
  permission: TeamPermission,
  grant: PermissionEffect | undefined
): EffectivePermission {
  if (grant !== undefined) return { role, permission, effect: grant, source: 'grant' }
  return { role, permission, effect: DEFAULT_ROLE_PERMISSIONS[role][permission], source: 'default' }
}

// The stub RBACService (StubRbacActor, StubRBACService, STUB_TEAM_ID, createStubRBACService())
// lives in its own file, rbac-tools.stub.ts — split out to stay under the 500-line gate, the same
// split registry-tools.stub.ts and rbac-tools.schemas.ts already made for their sibling files.
