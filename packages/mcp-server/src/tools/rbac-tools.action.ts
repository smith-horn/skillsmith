/**
 * @fileoverview Enterprise RBAC MCP tools — action-handler implementations
 * @module @skillsmith/mcp-server/tools/rbac-tools.action
 * @see SMI-5127: the `*.action.ts` sibling convention for a tool/command file whose
 *      `withTelemetry`-wrapped action handlers push it over the 500-line audit:standards
 *      budget — this file holds the implementations, the wrapped exports, and the service
 *      singleton; `rbac-tools.ts` keeps the MCP tool registration, JSON schema, and
 *      re-exports (SMI-6200 Wave 4 Step 0 split, done mechanically ahead of Wave 4's new
 *      SSO surface landing in `sso-tools.ts` — the sibling this same split was applied to
 *      in the same pass). Precedent: `search.ts` / `search.action.ts` for CLI commands,
 *      and `supabase/functions/team-sso-manage/actions.config.ts` /
 *      `actions.config.query.ts` for the same shape one layer down (Wave 3).
 * @see SMI-3901: RBAC MCP Tools (the original shape)
 * @see SMI-6202 Wave 1: `team_permission_grants` + the five resolver functions
 * @see SMI-6203 Wave 2: the live service and these rewritten schemas
 *
 * RBAC enforcement is in the database, not here. `has_team_permission()` composes owner-exemption,
 * per-team `allow`/`deny` grants and the built-in default matrix, and every function these tools
 * call re-checks it server-side. This layer is a management interface: it resolves the team, hands
 * the caller's own JWT to the right function, and renders the result.
 *
 * TWO GATES, TWO QUESTIONS. The Enterprise tier gate (`toolFeatureMapping.ts`, unchanged) answers
 * "is this customer entitled to RBAC?". The `team:manage_rbac` permission answers "is this
 * particular person allowed to use it?". Neither replaces the other, and no new feature flag is
 * added for the second — issued Enterprise licenses carry a frozen `features` array, so a new flag
 * would deny every already-issued license (D-11 precedent).
 *
 * Tier gate: Enterprise (rbac feature flag).
 */

import type { ToolContext } from '../context.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { dataSourceFor } from './stub-data-source.js'
import { isSupabaseConfigured } from '../supabase-client.js'
import { readLicenseKey, resolveLicenseTeamId } from './team-resolver.js'
import { toPermissionDeniedError } from './team-permission-error.js'
import { createLiveRBACService } from './rbac-tools.live.js'
import { PERMISSION_LIST } from './rbac-tools.schemas.js'
import type {
  RbacAssignRoleInput,
  RbacCreatePolicyInput,
  RbacManageInput,
} from './rbac-tools.schemas.js'
import type {
  GrantableRole,
  RBACService,
  RbacAssignRoleResult,
  RbacCreatePolicyPermissionOutcome,
  RbacCreatePolicyResult,
  RbacManageResult,
  RbacToolError,
  TeamPermission,
} from './rbac-tools.types.js'
import { GRANTABLE_ROLES, MANAGE_RBAC_PERMISSION, TEAM_PERMISSIONS } from './rbac-tools.types.js'
import { createStubRBACService, STUB_TEAM_ID } from './rbac-tools.stub.js'

// Module-level singleton. Picks the live Supabase-backed service when SUPABASE_URL +
// SUPABASE_ANON_KEY are configured; otherwise the in-memory stub (local dev / tests) —
// same pattern as registry-tools.ts:196-198.
let service: RBACService = isSupabaseConfigured()
  ? createLiveRBACService()
  : createStubRBACService()

/** Replace the RBAC service implementation (for testing or production swap) */
export function setRBACService(svc: RBACService): void {
  service = svc
}

/** The service instance currently wired in. */
export function getRBACService(): RBACService {
  return service
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Resolve the team from the team credential (license key, or API key — SMI-6080), exactly as
 * `registry-tools.ts` does, including the static stub id when Supabase is unconfigured.
 *
 * Team resolution ONLY. Which team is never the same question as which person: every RBAC
 * operation additionally needs `skillsmith login` (see `rbac-tools.live.auth.ts`).
 */
async function resolveTeamId(): Promise<string> {
  if (!isSupabaseConfigured()) return STUB_TEAM_ID
  const licenseKey = readLicenseKey()
  if (!licenseKey) {
    throw new Error(
      'SKILLSMITH_LICENSE_KEY or SKILLSMITH_API_KEY is required for RBAC operations. Set one in ' +
        'your MCP server config — shell exports do not reach MCP subprocesses. Managing roles and ' +
        'permissions additionally requires `skillsmith login`.'
    )
  }
  const teamId = await resolveLicenseTeamId(licenseKey)
  if (!teamId) {
    throw new Error(
      'Unable to resolve team from the configured key. Ensure SKILLSMITH_LICENSE_KEY or ' +
        'SKILLSMITH_API_KEY is active and attached to an Enterprise-tier subscription.'
    )
  }
  return teamId
}

/** Map a thrown service error to the tool's `error` field: structured refusal, or plain text. */
function toToolError(err: unknown, requiredPermission: TeamPermission): RbacToolError {
  const denied = toPermissionDeniedError(err, requiredPermission)
  if (denied) return denied
  return err instanceof Error ? err.message : 'Unexpected RBAC error.'
}

const effectRow = (p: {
  role: string
  permission: string
  effect: string
  source: string
}): string => `| ${p.role} | ${p.permission} | ${p.effect} | ${p.source} |`

const PERMISSION_TABLE_HEAD =
  '| Role | Permission | Effect | Source |\n|------|------------|--------|--------|'

/** Expand `resources x actions` into `resource:action` strings, preserving input order. */
function expandPermissions(resources: string[], actions: string[]): string[] {
  return resources.flatMap((resource) => actions.map((action) => `${resource}:${action}`))
}

async function executeRbacManageImpl(
  input: RbacManageInput,
  _context: ToolContext
): Promise<RbacManageResult> {
  // One read of the module-level singleton, so provenance and data can never come from two
  // different instances if `setRBACService()` lands between them (Wave 2 Step 2).
  const svc = service
  const dataSource: 'stub' | 'live' = dataSourceFor(svc)

  let teamId: string
  try {
    teamId = await resolveTeamId()
  } catch (err) {
    return { success: false, dataSource, error: toToolError(err, MANAGE_RBAC_PERMISSION) }
  }

  try {
    switch (input.action) {
      case 'list_roles': {
        const permissions = await svc.listPermissions(teamId)
        const roles = GRANTABLE_ROLES.map((role) => ({
          role,
          permissions: permissions.filter((p) => p.role === role),
        }))
        return {
          success: true,
          dataSource,
          roles,
          permissions,
          message:
            `## Team Roles (${roles.length} configurable + owner)\n\n` +
            'Owners always hold every permission and are never narrowable.\n\n' +
            `${PERMISSION_TABLE_HEAD}\n${permissions.map(effectRow).join('\n')}`,
        }
      }
      case 'get_role': {
        if (!input.role)
          return { success: false, dataSource, error: 'role is required for action "get_role".' }
        const permissions = (await svc.listPermissions(teamId)).filter((p) => p.role === input.role)
        return {
          success: true,
          dataSource,
          role: { role: input.role, permissions },
          message:
            `## Role: ${input.role}\n\n` +
            `${PERMISSION_TABLE_HEAD}\n${permissions.map(effectRow).join('\n')}`,
        }
      }
      case 'set_role_permission': {
        if (!input.role || !input.permission || !input.effect)
          return {
            success: false,
            dataSource,
            error: 'role, permission and effect are required for action "set_role_permission".',
          }
        await svc.setRolePermission(teamId, input.role, input.permission, input.effect)
        return {
          success: true,
          dataSource,
          message: `Set **${input.effect}** on \`${input.permission}\` for role \`${input.role}\`.`,
        }
      }
      case 'reset_role_permission': {
        if (!input.role || !input.permission)
          return {
            success: false,
            dataSource,
            error: 'role and permission are required for action "reset_role_permission".',
          }
        const cleared = await svc.resetRolePermission(teamId, input.role, input.permission)
        return {
          success: true,
          dataSource,
          message: cleared
            ? `Cleared the override on \`${input.permission}\` for role \`${input.role}\` — it now follows the built-in default.`
            : `No override was set on \`${input.permission}\` for role \`${input.role}\` — already at the built-in default.`,
        }
      }
    }
  } catch (err) {
    return { success: false, dataSource, error: toToolError(err, MANAGE_RBAC_PERMISSION) }
  }
}

async function executeRbacAssignRoleImpl(
  input: RbacAssignRoleInput,
  _context: ToolContext
): Promise<RbacAssignRoleResult> {
  const svc = service
  const dataSource: 'stub' | 'live' = dataSourceFor(svc)

  let teamId: string
  try {
    teamId = await resolveTeamId()
  } catch (err) {
    return { success: false, dataSource, error: toToolError(err, MANAGE_RBAC_PERMISSION) }
  }

  try {
    switch (input.action) {
      case 'assign': {
        if (!input.memberId || !input.role)
          return {
            success: false,
            dataSource,
            error: 'memberId and role are required for action "assign".',
          }
        await svc.setMemberRole(input.memberId, input.role)
        return {
          success: true,
          dataSource,
          message: `Member \`${input.memberId}\` is now \`${input.role}\`.`,
        }
      }
      case 'revoke': {
        if (!input.memberId || !input.role)
          return {
            success: false,
            dataSource,
            error: 'memberId and role are required for action "revoke".',
          }
        // Roles are exclusive, not additive: "revoke" means "drop back to the baseline role".
        // Revoking `member` would mean removing them from the team, which is a different
        // operation (`remove_team_member`) with its own gates — say so instead of silently
        // doing nothing.
        if (input.role === 'member')
          return {
            success: false,
            dataSource,
            error:
              'Only "admin" can be revoked — that demotes the member to "member". Removing ' +
              'someone from the team entirely is a separate operation (team member removal).',
          }
        await svc.setMemberRole(input.memberId, 'member')
        return {
          success: true,
          dataSource,
          message: `Revoked \`admin\` from member \`${input.memberId}\` — they are now \`member\`.`,
        }
      }
      case 'list_assignments': {
        const assignments = await svc.listMembers(teamId)
        return {
          success: true,
          dataSource,
          assignments,
          message:
            `## Team Members (${assignments.length})\n\n` +
            (assignments.length === 0
              ? 'No members found.'
              : '| Member ID | Role | Name | Email |\n|-----------|------|------|-------|\n' +
                assignments
                  .map(
                    (a) =>
                      `| ${a.memberId} | ${a.role} | ${a.fullName ?? '—'} | ${a.email ?? '—'} |`
                  )
                  .join('\n')),
        }
      }
    }
  } catch (err) {
    return { success: false, dataSource, error: toToolError(err, MANAGE_RBAC_PERMISSION) }
  }
}

async function executeRbacCreatePolicyImpl(
  input: RbacCreatePolicyInput,
  _context: ToolContext
): Promise<RbacCreatePolicyResult> {
  const svc = service
  const dataSource: 'stub' | 'live' = dataSourceFor(svc)

  let teamId: string
  try {
    teamId = await resolveTeamId()
  } catch (err) {
    return { success: false, dataSource, error: toToolError(err, MANAGE_RBAC_PERMISSION) }
  }

  try {
    if (input.action === 'list') {
      const grants = (await svc.listPermissions(teamId)).filter((p) => p.source === 'grant')
      return {
        success: true,
        dataSource,
        grants,
        message:
          `## Permission Overrides (${grants.length})\n\n` +
          (grants.length === 0
            ? 'No overrides set — every role follows the built-in defaults.'
            : `${PERMISSION_TABLE_HEAD}\n${grants.map(effectRow).join('\n')}`),
      }
    }

    if (!input.role)
      return { success: false, dataSource, error: `role is required for action "${input.action}".` }
    if (!input.resources?.length || !input.actions?.length)
      return {
        success: false,
        dataSource,
        error: `resources and actions are required for action "${input.action}".`,
      }
    if (input.action === 'create' && !input.effect)
      return { success: false, dataSource, error: 'effect is required for action "create".' }

    const expanded = expandPermissions(input.resources, input.actions)
    // Refuse the whole batch by name before writing any of it: the CHECK constraint would
    // otherwise surface as a raw 23514 after a partial apply.
    const unsupported = expanded.filter((p) => !(TEAM_PERMISSIONS as readonly string[]).includes(p))
    if (unsupported.length > 0)
      return {
        success: false,
        dataSource,
        error:
          `Not a configurable permission: ${unsupported.join(', ')}. ` +
          `Valid resource:action expansions are ${PERMISSION_LIST}. Nothing was written.`,
      }

    const permissions = expanded as TeamPermission[]
    const role: GrantableRole = input.role

    if (input.action === 'create') {
      const effect = input.effect ?? 'deny'
      // SMI-6267 UAT finding F3: each expanded permission is a SEPARATE RPC call — there is no
      // shared transaction across them (see RbacCreatePolicyPermissionOutcome's doc comment for
      // why). Catch per-iteration so a mid-batch failure reports exactly which permissions were
      // already written, rather than losing that information to the outer catch below.
      const outcomes: RbacCreatePolicyPermissionOutcome[] = []
      let firstError: unknown
      for (const permission of permissions) {
        try {
          await svc.setRolePermission(teamId, role, permission, effect)
          outcomes.push({ permission, succeeded: true })
        } catch (err) {
          firstError ??= err
          outcomes.push({
            permission,
            succeeded: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const failed = outcomes.filter((o) => !o.succeeded)
      if (failed.length > 0) {
        const succeeded = outcomes.filter((o) => o.succeeded)
        return {
          success: false,
          dataSource,
          partialResults: outcomes,
          error: toToolError(firstError, MANAGE_RBAC_PERMISSION),
          message:
            `## Policy Write Failed Partway Through${input.name ? `: ${input.name}` : ''}\n\n` +
            `- **Role:** ${role}\n- **Effect:** ${effect}\n` +
            `- **Succeeded (${succeeded.length}/${outcomes.length}), already in effect:** ` +
            `${succeeded.map((o) => o.permission).join(', ') || 'none'}\n` +
            `- **Failed (${failed.length}/${outcomes.length}):** ` +
            `${failed.map((o) => o.permission).join(', ')}\n\n` +
            'Retry with only the failed permissions listed above to finish the batch, or reset ' +
            'the succeeded ones to return to a clean state.',
        }
      }
      return {
        success: true,
        dataSource,
        grants: permissions.map((permission) => ({
          role,
          permission,
          effect,
          source: 'grant' as const,
        })),
        message:
          `## Policy Applied${input.name ? `: ${input.name}` : ''}\n\n` +
          `- **Role:** ${role}\n- **Effect:** ${effect}\n` +
          `- **Permissions:** ${permissions.join(', ')}`,
      }
    }

    // action === 'delete': same per-iteration reporting as 'create' above, for the same reason —
    // resetRolePermission is likewise one independent RPC call per permission.
    const resetOutcomes: RbacCreatePolicyPermissionOutcome[] = []
    let firstResetError: unknown
    let cleared = 0
    for (const permission of permissions) {
      try {
        if (await svc.resetRolePermission(teamId, role, permission)) cleared += 1
        resetOutcomes.push({ permission, succeeded: true })
      } catch (err) {
        firstResetError ??= err
        resetOutcomes.push({
          permission,
          succeeded: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const resetFailed = resetOutcomes.filter((o) => !o.succeeded)
    if (resetFailed.length > 0) {
      const resetSucceeded = resetOutcomes.filter((o) => o.succeeded)
      return {
        success: false,
        dataSource,
        partialResults: resetOutcomes,
        error: toToolError(firstResetError, MANAGE_RBAC_PERMISSION),
        message:
          `Cleared ${cleared} of ${resetSucceeded.length} attempted override(s) for role ` +
          `\`${role}\` before a failure.\n\n` +
          `- **Succeeded (${resetSucceeded.length}/${resetOutcomes.length}):** ` +
          `${resetSucceeded.map((o) => o.permission).join(', ') || 'none'}\n` +
          `- **Failed (${resetFailed.length}/${resetOutcomes.length}):** ` +
          `${resetFailed.map((o) => o.permission).join(', ')}\n\n` +
          'Retry with only the failed permissions listed above to finish clearing the batch.',
      }
    }
    return {
      success: true,
      dataSource,
      message:
        `Cleared ${cleared} of ${permissions.length} override(s) for role \`${role}\` ` +
        `(${permissions.join(', ')}). Any not listed here had no override set.`,
    }
  } catch (err) {
    return { success: false, dataSource, error: toToolError(err, MANAGE_RBAC_PERMISSION) }
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const executeRbacManage = withTelemetry(executeRbacManageImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'rbac_manage',
  extractFramework: () => 'unknown',
})
export const executeRbacAssignRole = withTelemetry(executeRbacAssignRoleImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'rbac_assign_role',
  extractFramework: () => 'unknown',
})
export const executeRbacCreatePolicy = withTelemetry(executeRbacCreatePolicyImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'rbac_create_policy',
  extractFramework: () => 'unknown',
})
