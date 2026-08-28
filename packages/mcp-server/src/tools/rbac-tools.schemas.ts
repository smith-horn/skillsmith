/**
 * @fileoverview Schemas for the RBAC tools — Zod runtime-validation plus MCP registration
 * @module @skillsmith/mcp-server/tools/rbac-tools.schemas
 * @see SMI-6203 Wave 2 Step 3: the rewritten `rbac_manage` / `rbac_assign_role` /
 *      `rbac_create_policy` surfaces
 *
 * The `foo.schemas.ts` companion `registry-tools.schemas.ts` already establishes: both schema
 * families describe the same three tools' inputs from two angles (what the model sees vs what the
 * handler runtime-validates), neither depends on anything else `rbac-tools.ts` defines, and the
 * rewritten enums plus their decision comments pushed `rbac-tools.ts` past its 500-line
 * audit:standards budget.
 *
 * Re-exported from `rbac-tools.ts`, so `index.ts` (tool registration) and `tool-dispatch.ts` (Zod
 * validation) reach them through the same module they always did — only the contents moved.
 */

import { z } from 'zod'
import type { GrantableRole, TeamPermission } from './rbac-tools.types.js'
import { GRANTABLE_ROLES, TEAM_PERMISSIONS } from './rbac-tools.types.js'

// ============================================================================
// Input schemas
// ============================================================================

// Derived from the runtime source of truth rather than re-listed as literals — the SMI-5697
// precedent (`install.types.ts:25`): a `z.enum([...])` literal is not type-checked against the
// const it duplicates, so re-listing lets the two drift silently and rejects valid input.
const ROLE_ENUM_VALUES = GRANTABLE_ROLES as unknown as [GrantableRole, ...GrantableRole[]]
const PERMISSION_ENUM_VALUES = TEAM_PERMISSIONS as unknown as [TeamPermission, ...TeamPermission[]]

export const rbacManageInputSchema = z.object({
  action: z.enum(['list_roles', 'get_role', 'set_role_permission', 'reset_role_permission']),
  role: z
    .enum(ROLE_ENUM_VALUES)
    .optional()
    .describe('Role to inspect or configure (required except for list_roles)'),
  permission: z
    .enum(PERMISSION_ENUM_VALUES)
    .optional()
    .describe('Permission to allow/deny (required for set_role_permission/reset_role_permission)'),
  effect: z
    .enum(['allow', 'deny'])
    .optional()
    .describe('Override effect (required for set_role_permission)'),
})

export type RbacManageInput = z.infer<typeof rbacManageInputSchema>

/**
 * `memberId`, not `userId` — DECIDED, not inherited.
 *
 * `set_team_member_role(p_member_id TEXT, p_role TEXT)` takes `team_members.id`, matching every
 * sibling RPC (`remove_team_member`, `set_team_member_github_username`) and the website helper that
 * calls them (`team-invitations.ts`'s `removeTeamMember()`). Accepting a `userId` instead would
 * force this layer to resolve it to a member id first, and that lookup is not free of consequence:
 * it would have to read `team_members` itself (an application-side tenant filter of exactly the
 * kind ADR-116 documents as silently breakable), and its "no such user" answer would reopen the
 * cross-team existence oracle the migration's L1 fix deliberately closed by making not-found and
 * not-permitted raise the identical `42501`. `list_assignments` returns the very ids `assign` and
 * `revoke` accept, so the loop closes with no translation layer at all.
 */
export const rbacAssignRoleInputSchema = z.object({
  action: z.enum(['assign', 'revoke', 'list_assignments']),
  memberId: z
    .string()
    .min(1)
    .optional()
    .describe('team_members.id from list_assignments (required for assign/revoke)'),
  role: z.enum(ROLE_ENUM_VALUES).optional().describe('Role to assign, or revoke (assign/revoke)'),
})

export type RbacAssignRoleInput = z.infer<typeof rbacAssignRoleInputSchema>

/**
 * HOW `{effect, resources[], actions[]}` MAPS ONTO `(team_id, role, permission, effect)` — and the
 * two shape changes that mapping forces.
 *
 * `rbac_create_policy` is retained as the bulk/wildcard writer into `team_permission_grants`: each
 * `resource` x `action` pair expands to one `resource:action` permission string, and each expanded
 * permission becomes one grant row. `{resources: ['registry'], actions: ['approve','deprecate']}`
 * with `effect: 'deny'` writes two deny rows. Any expanded pair outside the four permissions Wave 1
 * enforces is refused by name BEFORE any write — the `permission` CHECK constraint would otherwise
 * surface as a raw `23514`, and a partially-applied bulk write is worse than a refused one.
 *
 * Two things could not be preserved, because the grant table has no column for them:
 *
 *  1. `role` is now REQUIRED. A grant row is keyed `(team_id, role, permission)`; a policy with no
 *     role is not representable at all, so the tool would have had to invent one.
 *  2. `get` is gone and `policyId` with it. Grants have no stable policy identity — the same two
 *     rows can be written by any number of different `resources`/`actions` shapes — so `get` could
 *     only ever have been a second spelling of `list`. `list` returns the explicit grants (the
 *     `source: 'grant'` rows), which is what "show me my policies" actually means here.
 *
 * `name` is kept, optional, and NOT persisted (there is no column for it) — it is echoed back in
 * the result as a label for the operation. Making it required-but-discarded would be exactly the
 * "settable but unenforced" trap the permission CHECK exists to prevent.
 */
export const rbacCreatePolicyInputSchema = z.object({
  action: z.enum(['create', 'list', 'delete']),
  name: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Display-only label for this write; not persisted (grants are keyed team+role+perm)'),
  role: z.enum(ROLE_ENUM_VALUES).optional().describe('Role the policy applies to (create/delete)'),
  effect: z.enum(['allow', 'deny']).optional().describe('Policy effect (required for create)'),
  resources: z
    .array(z.string().min(1))
    .optional()
    .describe('Resource segments, e.g. ["registry"] (required for create/delete)'),
  actions: z
    .array(z.string().min(1))
    .optional()
    .describe('Action segments, e.g. ["approve"] (required for create/delete)'),
})

export type RbacCreatePolicyInput = z.infer<typeof rbacCreatePolicyInputSchema>

// ============================================================================
// Tool schemas for MCP registration
// ============================================================================

/** Human-readable list of the configurable permissions, for tool descriptions and refusals. */
export const PERMISSION_LIST = TEAM_PERMISSIONS.join(', ')

export const rbacManageToolSchema = {
  name: 'rbac_manage' as const,
  description:
    'Inspect and configure team role permissions: list_roles, get_role, set_role_permission, ' +
    'reset_role_permission. Roles are fixed (owner, admin, member) — owners always hold every ' +
    `permission and cannot be narrowed. Configurable permissions: ${PERMISSION_LIST}. ` +
    'Requires the team:manage_rbac permission and Enterprise tier (rbac feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list_roles', 'get_role', 'set_role_permission', 'reset_role_permission'],
        description: 'RBAC permission operation',
      },
      role: {
        type: 'string',
        enum: [...GRANTABLE_ROLES],
        description: 'Role to inspect or configure (required except for list_roles)',
      },
      permission: {
        type: 'string',
        enum: [...TEAM_PERMISSIONS],
        description: 'Permission to configure (required for set/reset_role_permission)',
      },
      effect: {
        type: 'string',
        enum: ['allow', 'deny'],
        description: 'Override effect (required for set_role_permission)',
      },
    },
    required: ['action'],
  },
}

export const rbacAssignRoleToolSchema = {
  name: 'rbac_assign_role' as const,
  description:
    "Assign or revoke a team member's role, or list current members and their roles. Roles are " +
    'fixed: admin or member (owner is managed separately and can never be changed here). ' +
    'Requires the team:manage_rbac permission and Enterprise tier (rbac feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['assign', 'revoke', 'list_assignments'],
        description: 'Assignment operation',
      },
      memberId: {
        type: 'string',
        description: 'team_members.id from list_assignments (required for assign/revoke)',
      },
      role: {
        type: 'string',
        enum: [...GRANTABLE_ROLES],
        description: 'Role to assign, or the role to revoke (required for assign/revoke)',
      },
    },
    required: ['action'],
  },
}

export const rbacCreatePolicyToolSchema = {
  name: 'rbac_create_policy' as const,
  description:
    'Bulk-write or clear permission overrides: create expands resources x actions into ' +
    `"resource:action" permission grants for one role, delete clears them, list shows the ` +
    `overrides currently set. Valid expansions: ${PERMISSION_LIST}. ` +
    'Requires the team:manage_rbac permission and Enterprise tier (rbac feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'delete'],
        description: 'Policy operation',
      },
      name: { type: 'string', description: 'Display-only label; not persisted' },
      role: {
        type: 'string',
        enum: [...GRANTABLE_ROLES],
        description: 'Role the policy applies to (required for create/delete)',
      },
      effect: {
        type: 'string',
        enum: ['allow', 'deny'],
        description: 'Policy effect (required for create)',
      },
      resources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Resource segments, e.g. ["registry"] (required for create/delete)',
      },
      actions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Action segments, e.g. ["approve"] (required for create/delete)',
      },
    },
    required: ['action'],
  },
}
