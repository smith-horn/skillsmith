/**
 * @fileoverview Live Supabase-backed TeamWorkspaceService
 * @module @skillsmith/mcp-server/tools/team-workspace.live
 * @see SMI-4292: Wave 5A — drops stub fallback when Supabase is configured.
 * @see SMI-6113 + SMI-6241 Wave 2: moved every method off the service-role client onto the
 *   caller's own JWT. Service-role bypassed RLS entirely, so any team member could create or
 *   delete a workspace — an action the product has always intended to be admin-only. RLS is now
 *   the actual authorization boundary: `team_workspaces_admin_insert`/`_update`/`_delete` gate on
 *   `team_ids_with_permission('workspace:manage')` (SMI-6241), `team_workspaces_member_read` and
 *   the three `workspace_skills_*` policies gate on plain team membership. The two named
 *   user-client getters that reach those policies live in `team-workspace.live.auth.ts`.
 *
 * `assertWorkspaceInTeam`/`fetchTeamScopedWorkspace`'s explicit team_id check is kept as
 * defense-in-depth alongside RLS, not as the primary boundary — a redundant app-layer check has a
 * track record of turning into the actual layer of protection if a future migration ever weakens
 * RLS, and removing it here would save little.
 *
 * License-key → team_id resolution still uses the anon client + RPC
 * (`resolve_team_from_license` is SECURITY DEFINER — see team-resolver.ts). It establishes *which*
 * team, not *who within it*, so it is unaffected by this change.
 *
 * All rows are returned in camelCase (Workspace shape); Supabase snake_case
 * columns are mapped at the boundary so handlers stay schema-agnostic.
 */

import { resolveLicenseTeamId } from './team-resolver.js'
import {
  getWorkspaceManageUserClient,
  getWorkspaceMemberUserClient,
} from './team-workspace.live.auth.js'
import type {
  TeamWorkspaceService,
  Workspace,
  WorkspaceSettings,
  SharedSkill,
} from './team-workspace.js'

interface WorkspaceRow {
  id: string
  team_id: string
  name: string
  description: string | null
  settings: WorkspaceSettings | null
  created_by: string | null
  created_at: string
  updated_at: string
}

interface WorkspaceSkillRow {
  workspace_id: string
  skill_id: string
  added_by: string | null
  added_at: string
}

interface SupabaseQueryResult<T> {
  data: T | null
  error: { message?: string; code?: string } | null
}

interface SupabaseTableQuery<T> {
  select: (columns?: string) => SupabaseTableQuery<T>
  eq: (column: string, value: unknown) => SupabaseTableQuery<T>
  single: () => Promise<SupabaseQueryResult<T>>
  insert: (row: Record<string, unknown>) => SupabaseTableQuery<T>
  delete: () => SupabaseTableQuery<T>
  then: <R>(onFulfilled: (value: SupabaseQueryResult<T[]>) => R) => Promise<R>
}

/** Exported so team-workspace.live.auth.ts's two user-client getters can type their return value
 *  against exactly the surface this file uses, without importing the admin-client module. */
export interface MinimalSupabaseClient {
  from: <T>(table: string) => SupabaseTableQuery<T>
}

/** Postgres/PostgREST code for an RLS `WITH CHECK` violation on INSERT — 42501,
 *  insufficient_privilege. INSERT (unlike UPDATE/DELETE's USING-clause silence) raises rather
 *  than silently affecting zero rows, so this lets createWorkspace() give a clear
 *  permission-denied message instead of surfacing the raw Postgres text. */
function isRlsDenied(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false
  if (error.code === '42501') return true
  return (error.message ?? '').toLowerCase().includes('row-level security policy')
}

/** PostgREST's code for "no rows" (or >1 rows) via `.single()` — a real absence, not a query
 *  failure. Matches registry-tools.live.ts's own `isNoRowsError` convention. Load-bearing for
 *  fetchTeamScopedWorkspace() below: only a CONFIRMED no-rows result may collapse to `null` —
 *  any other error must propagate, or a transient failure silently reads as "workspace has no
 *  sharing policy" (adversarial-review finding, SMI-6113/SMI-6241 Wave 2 round 2). */
function isNoRowsError(error: { message?: string; code?: string } | null): boolean {
  return error?.code === 'PGRST116'
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    teamId: row.team_id,
    settings: row.settings ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSharedSkill(row: WorkspaceSkillRow): SharedSkill {
  return {
    skillId: row.skill_id,
    addedBy: row.added_by ?? 'unknown',
    addedAt: row.added_at,
  }
}

/**
 * Fetch a workspace by (teamId, workspaceId) and verify tenant scope.
 * Returns null on a CONFIRMED miss (including cross-team access, which the `team_id` filter turns
 * into an ordinary no-rows result) — never on a query failure. `getWorkspaceSettings()` collapses
 * this method's null into `{}` (no sharing policy), so a failure that were silently mapped to
 * null here would fail the sharing-policy allow/deny gate OPEN on a transient error (adversarial-
 * review finding, SMI-6113/SMI-6241 Wave 2 round 2) — the same "confirmed absence only" discipline
 * registry-tools.live.ts's probe reads already use. Shared helper so sibling methods don't depend
 * on a correctly-bound `this`.
 */
async function fetchTeamScopedWorkspace(
  client: MinimalSupabaseClient,
  teamId: string,
  workspaceId: string
): Promise<Workspace | null> {
  const resp = await client
    .from<WorkspaceRow>('team_workspaces')
    .select()
    .eq('id', workspaceId)
    .eq('team_id', teamId)
    .single()
  if (resp.error) {
    if (isNoRowsError(resp.error)) return null
    throw new Error(`Failed to look up workspace: ${resp.error.message ?? 'unknown error'}`)
  }
  if (!resp.data) return null
  return mapWorkspace(resp.data)
}

/**
 * Assert the workspace exists AND belongs to the resolved `teamId`, as defense-in-depth ahead of
 * every `workspace_skills` CRUD — RLS (the `workspace_skills_*` policies) is the real boundary,
 * but this app-layer check stays so a future RLS regression doesn't silently become the only one.
 */
async function assertWorkspaceInTeam(
  client: MinimalSupabaseClient,
  teamId: string,
  workspaceId: string
): Promise<void> {
  const workspace = await fetchTeamScopedWorkspace(client, teamId, workspaceId)
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} not found in team ${teamId}.`)
  }
}

/**
 * Create a live Supabase-backed TeamWorkspaceService.
 * Call signals and teamId arguments from the handler are honoured; the
 * service does NOT re-resolve team_id internally.
 *
 * Every DB call explicitly filters by `team_id = <resolved>` (for
 * `team_workspaces`) or asserts workspace membership (for
 * `workspace_skills`), as defense-in-depth. The real authorization boundary
 * is now RLS, reached via the caller's own JWT — see the file header and
 * team-workspace.live.auth.ts.
 */
export function createLiveService(): TeamWorkspaceService {
  return {
    async resolveTeamId(licenseKey: string): Promise<string> {
      const teamId = await resolveLicenseTeamId(licenseKey)
      if (!teamId) {
        throw new Error(
          'Unable to resolve team from the configured key. Ensure SKILLSMITH_LICENSE_KEY or SKILLSMITH_API_KEY (SMI-6080) is set and corresponds to an active Team-tier subscription.'
        )
      }
      return teamId
    },

    async createWorkspace(teamId, name, description): Promise<Workspace> {
      const { client } = await getWorkspaceManageUserClient('create a workspace')
      const resp = await client
        .from<WorkspaceRow>('team_workspaces')
        .insert({ team_id: teamId, name, description: description ?? null })
        .select()
        .single()
      if (resp.error || !resp.data) {
        if (isRlsDenied(resp.error)) {
          throw new Error(
            // Deliberately not "you are not an admin": an admin whose SSO session has gone
            // stale also fails this check (has_team_permission()'s freshness gate), and telling
            // them to ask an admin to grant workspace:manage would not fix it — round-2
            // adversarial-review correction.
            'Creating a workspace requires the "workspace:manage" permission — team admins ' +
              'have it by default. If you are an admin and still see this, your SSO session ' +
              'may need re-verification; otherwise ask a team admin to grant you ' +
              'workspace:manage.'
          )
        }
        throw new Error(`Failed to create workspace: ${resp.error?.message ?? 'unknown error'}`)
      }
      return mapWorkspace(resp.data)
    },

    async listWorkspaces(teamId): Promise<Workspace[]> {
      const { client } = await getWorkspaceMemberUserClient('list workspaces')
      const resp = await client.from<WorkspaceRow>('team_workspaces').select().eq('team_id', teamId)
      if (resp.error) {
        throw new Error(`Failed to list workspaces: ${resp.error.message ?? 'unknown error'}`)
      }
      return (resp.data ?? []).map(mapWorkspace)
    },

    async getWorkspace(teamId, workspaceId): Promise<Workspace | null> {
      const { client } = await getWorkspaceMemberUserClient('get a workspace')
      return fetchTeamScopedWorkspace(client, teamId, workspaceId)
    },

    async deleteWorkspace(teamId, workspaceId): Promise<boolean> {
      const { client } = await getWorkspaceManageUserClient('delete a workspace')
      const resp = await client
        .from<WorkspaceRow>('team_workspaces')
        .delete()
        .eq('id', workspaceId)
        .eq('team_id', teamId)
        .select()
      if (resp.error) {
        throw new Error(`Failed to delete workspace: ${resp.error.message ?? 'unknown error'}`)
      }
      if (Array.isArray(resp.data) && resp.data.length > 0) return true

      // RLS denials on DELETE do not raise — a row failing team_workspaces_admin_delete's USING
      // clause is simply invisible to the statement, so it affects zero rows exactly like a
      // genuine miss. Probe with the SAME client via team_workspaces_member_read (any team member
      // can see the row) to disambiguate "no such workspace" from "you lack workspace:manage" —
      // mirrors registry-tools.live.ts's setDeprecated() probe pattern.
      //
      // Accepted TOCTOU (adversarial-review round 2): the DELETE and this probe are two separate
      // statements, not one snapshot. If another caller deletes the SAME row between them, a
      // permission-denied attempt reports "not found" instead of "workspace:manage required" —
      // this is the safe direction (never fabricates success, never leaks existence to a
      // non-member) and is accepted rather than closed with a single-statement RPC.
      const probe = await client
        .from<{ id: string }>('team_workspaces')
        .select('id')
        .eq('id', workspaceId)
        .eq('team_id', teamId)
      if (probe.error) {
        throw new Error(
          `Failed to delete workspace: the delete matched no rows and the follow-up check also ` +
            `failed, so we cannot tell whether it is missing or you lack the "workspace:manage" ` +
            `permission: ${probe.error.message ?? 'unknown error'}`
        )
      }
      if (Array.isArray(probe.data) && probe.data.length > 0) {
        throw new Error(
          // Same wording rationale as createWorkspace()'s RLS-denial message: not "you are not
          // an admin", since a stale-SSO admin fails this gate too and granting them
          // workspace:manage would not help.
          'Deleting a workspace requires the "workspace:manage" permission — team admins have ' +
            'it by default. If you are an admin and still see this, your SSO session may need ' +
            're-verification; otherwise ask a team admin to grant you workspace:manage.'
        )
      }
      return false
    },

    async addSkill(teamId, workspaceId, skillId): Promise<SharedSkill> {
      const { client } = await getWorkspaceMemberUserClient('add a skill to a workspace')
      await assertWorkspaceInTeam(client, teamId, workspaceId)
      const resp = await client
        .from<WorkspaceSkillRow>('workspace_skills')
        .insert({ workspace_id: workspaceId, skill_id: skillId })
        .select()
        .single()
      if (resp.error || !resp.data) {
        throw new Error(`Failed to add skill: ${resp.error?.message ?? 'unknown error'}`)
      }
      return mapSharedSkill(resp.data)
    },

    async removeSkill(teamId, workspaceId, skillId): Promise<boolean> {
      const { client } = await getWorkspaceMemberUserClient('remove a skill from a workspace')
      await assertWorkspaceInTeam(client, teamId, workspaceId)
      const resp = await client
        .from<WorkspaceSkillRow>('workspace_skills')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('skill_id', skillId)
        .select()
      if (resp.error) {
        throw new Error(`Failed to remove skill: ${resp.error.message ?? 'unknown error'}`)
      }
      if (Array.isArray(resp.data) && resp.data.length > 0) return true

      // Mirrors deleteWorkspace()'s probe. workspace_skills_* is membership-gated, and
      // assertWorkspaceInTeam already confirmed membership moments earlier, so a denial here
      // would mean membership changed mid-request rather than a normal "not shared" case —
      // still worth telling apart from a plain not-found rather than fabricating success.
      const probe = await client
        .from<{ workspace_id: string }>('workspace_skills')
        .select('workspace_id')
        .eq('workspace_id', workspaceId)
        .eq('skill_id', skillId)
      if (probe.error) {
        throw new Error(
          `Failed to remove skill: the delete matched no rows and the follow-up check also ` +
            `failed, so we cannot tell whether it was already removed or you lost access: ` +
            `${probe.error.message ?? 'unknown error'}`
        )
      }
      if (Array.isArray(probe.data) && probe.data.length > 0) {
        throw new Error(
          `Could not remove "${skillId}" from this workspace even though it is shared there — ` +
            'you may no longer be a member of this team. Retry after confirming your membership.'
        )
      }
      return false
    },

    async listSkills(teamId, workspaceId): Promise<SharedSkill[]> {
      const { client } = await getWorkspaceMemberUserClient('list workspace skills')
      await assertWorkspaceInTeam(client, teamId, workspaceId)
      const resp = await client
        .from<WorkspaceSkillRow>('workspace_skills')
        .select()
        .eq('workspace_id', workspaceId)
      if (resp.error) {
        throw new Error(`Failed to list skills: ${resp.error.message ?? 'unknown error'}`)
      }
      return (resp.data ?? []).map(mapSharedSkill)
    },

    async getWorkspaceSettings(teamId, workspaceId): Promise<WorkspaceSettings> {
      const { client } = await getWorkspaceMemberUserClient('get workspace settings')
      const ws = await fetchTeamScopedWorkspace(client, teamId, workspaceId)
      return ws?.settings ?? {}
    },
  }
}
