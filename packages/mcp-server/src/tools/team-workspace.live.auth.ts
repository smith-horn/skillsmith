/**
 * @fileoverview The two named user-client getters for team workspace management
 * @module @skillsmith/mcp-server/tools/team-workspace.live.auth
 * @see SMI-6113: `team-workspace.live.ts` used the service-role client for all 8 methods,
 *   bypassing RLS entirely — any team member could create or delete a workspace, an
 *   admin-only action by product design.
 * @see SMI-6241: widened `team_permission_grants` with `workspace:manage` so this table can be
 *   gated the same way the private registry and RBAC already are, instead of a role-literal check.
 * @see SMI-5905 Wave 3 (`registry-tools.live.auth.ts`) / SMI-6203 (`rbac-tools.live.auth.ts`): the
 *   precedent this file follows, including its central constraint below.
 *
 * ONE FILE, TWO NAMES, NO DEFAULT.
 *
 * This mirrors `registry-tools.live.auth.ts` and `rbac-tools.live.auth.ts` deliberately, including
 * their shared constraint: no getter here takes a defaulted authorization argument. Both files
 * record a cross-provider plan-review finding that rejected a defaulted `requiresAdmin: boolean`
 * because "a defaulted authorization boolean is default-preserving today and silently wrong the
 * first time someone adds a call site and omits it — the failure is invisible at the call site,
 * which is exactly where an authorization decision must be visible." Two names cannot be omitted
 * or defaulted.
 *
 * WHY A JWT AND NOT THE TEAM LICENSE KEY.
 *
 * A shared team license key identifies a TEAM, not a PERSON — `resolve_team_from_license` never
 * reads `team_members`. Every gate this file exists to reach asks a question only a person can
 * answer: *may YOU create or delete a workspace on this team?* / *are YOU still a member of this
 * team?* `team_workspaces_admin_insert/_update/_delete` resolve `team_ids_with_permission(...)`
 * against `auth.uid()`, and `team_workspaces_member_read` / the three `workspace_skills_*`
 * policies resolve team membership the same way. Under a service-role or license-key client
 * `auth.uid()` is NULL, so every one of those gates fails closed and the operation is
 * unauthorizable rather than merely unauthorized.
 *
 * Neither getter falls back to the service-role client when nobody is signed in. That fallback
 * would restore precisely the SMI-6113 escalation this path exists to remove. Both throw an
 * actionable "run `skillsmith login`" error instead.
 *
 * WHY TWO GETTERS.
 *
 * `createWorkspace`/`deleteWorkspace` are gated on `workspace:manage`
 * (`team_workspaces_admin_insert`/`_delete`, SMI-6241). Every other method —
 * `listWorkspaces`/`getWorkspace`/`addSkill`/`removeSkill`/`listSkills`/`getWorkspaceSettings` —
 * is gated on plain team membership (`team_workspaces_member_read`, the three
 * `workspace_skills_*` policies). Routing a membership-only read through the manage-gated getter
 * would compile and work, and would then tell a plain member "you need workspace:manage" for an
 * operation that never required it — the precise inaccuracy `getMemberUserClient()`'s own header
 * calls out (plan-review finding H5) and `rbac-tools.live.auth.ts` repeats. Two getters, two
 * accurate refusals.
 */

import { getSupabaseUserClient } from '../supabase-client.js'
import { resolveUserAccessToken } from './team-resolver.js'
import { accessTokenSubject } from './registry-tools.live.audit.js'
import type { MinimalSupabaseClient } from './team-workspace.live.js'

/** A user-bound client plus the identity that client presents, for future audit use. */
export interface WorkspaceUserClientBinding {
  client: MinimalSupabaseClient
  /** JWT `sub` — the principal RLS evaluates. Null when the token is not decodable. */
  actorUserId: string | null
  /**
   * Which getter produced this binding — `workspace_manage` for the `workspace:manage`-gated
   * operations, `workspace_member` for the membership-gated ones. Mirrors the `role`/`gate` field
   * `registry-tools.live.auth.ts`/`rbac-tools.live.auth.ts` carry for their own audit trails.
   *
   * HONEST SCOPE (adversarial-review round 2 correction): `team-workspace.live.ts` has no
   * `audit_logs` write path today, so nothing currently reads this field — it does NOT, by
   * itself, catch a call site using the wrong getter (that would still compile and run; the
   * field would just accurately describe whichever getter was actually called). It exists so a
   * future audit trail for this module can attribute rows the same way the two sibling modules
   * already do, without another interface change.
   */
  gate: 'workspace_manage' | 'workspace_member'
}

/**
 * Shared body of {@link getWorkspaceManageUserClient} and {@link getWorkspaceMemberUserClient}.
 *
 * Deliberately NOT exported, and deliberately not reachable with a defaulted gate — every caller
 * goes through one of the two named wrappers below.
 */
async function bindUserClient(
  gate: 'workspace_manage' | 'workspace_member',
  operation: string,
  noUserMessage: string
): Promise<WorkspaceUserClientBinding> {
  const token = await resolveUserAccessToken()
  if (!token) throw new Error(noUserMessage)
  try {
    const client = (await getSupabaseUserClient(token)) as MinimalSupabaseClient
    return { client, actorUserId: accessTokenSubject(token), gate }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    throw new Error(`Failed to ${operation}: ${message}`)
  }
}

/**
 * A user-bound client for operations the database gates on `workspace:manage`
 * (`createWorkspace`/`deleteWorkspace`).
 *
 * The permission check itself is NOT re-implemented here. `team_workspaces_admin_insert`/`_delete`
 * already resolve `team_ids_with_permission('workspace:manage')` against `auth.uid()`;
 * re-checking it in TypeScript would duplicate a policy that already exists and can silently drift
 * from it. This getter's entire job is making sure a real person's token is what reaches that
 * check.
 *
 * @param operation - a verb phrase for the failure message, e.g. `'create a workspace'`
 */
export async function getWorkspaceManageUserClient(
  operation: string
): Promise<WorkspaceUserClientBinding> {
  return bindUserClient(
    'workspace_manage',
    operation,
    `Only team admins can ${operation}, which requires the "workspace:manage" permission — ` +
      'checked against your own account, so this operation needs a signed-in user. A shared ' +
      'team license key identifies a team, not a person, and can never authorize a workspace ' +
      'management change. Run `skillsmith login` on this machine and retry.'
  )
}

/**
 * A user-bound client for the membership-gated operations —
 * `listWorkspaces`/`getWorkspace`/`addSkill`/`removeSkill`/`listSkills`/`getWorkspaceSettings`.
 *
 * This is NOT a `workspace:manage` gate and must not claim to be one: `team_workspaces_member_read`
 * and the three `workspace_skills_*` policies let ANY team member read or share into an existing
 * workspace. It still runs as a person, because those policies gate on "is `auth.uid()` a member
 * of this team" — a license key would resolve the team while proving nothing about whether the
 * caller is still in it, which is precisely the check being made.
 */
export async function getWorkspaceMemberUserClient(
  operation: string
): Promise<WorkspaceUserClientBinding> {
  return bindUserClient(
    'workspace_member',
    operation,
    `To ${operation}, you must run as yourself, not as your team's shared license key — a ` +
      'license key identifies a team, not a person, so it cannot prove you are still a member. ' +
      'Any team member can do this once signed in — it does not require the "workspace:manage" ' +
      'permission. Run `skillsmith login` on this machine and retry.'
  )
}
