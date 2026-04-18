/**
 * @fileoverview Live Supabase-backed TeamWorkspaceService
 * @module @skillsmith/mcp-server/tools/team-workspace.live
 * @see SMI-4292: Wave 5A — drops stub fallback when Supabase is configured.
 *
 * Uses the Supabase anon-key client; all data access is RLS-gated via
 * migration 071 policies. License-key → team_id resolution goes through
 * the shared `resolve_team_from_license` RPC (finding C3).
 *
 * All rows are returned in camelCase (Workspace shape); Supabase snake_case
 * columns are mapped at the boundary so handlers stay schema-agnostic.
 */

import { getSupabaseClient } from '../supabase-client.js'
import { resolveLicenseTeamId } from './team-resolver.js'
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
  error: { message?: string } | null
}

interface SupabaseTableQuery<T> {
  select: (columns?: string) => SupabaseTableQuery<T>
  eq: (column: string, value: unknown) => SupabaseTableQuery<T>
  single: () => Promise<SupabaseQueryResult<T>>
  insert: (row: Record<string, unknown>) => SupabaseTableQuery<T>
  delete: () => SupabaseTableQuery<T>
  then: <R>(onFulfilled: (value: SupabaseQueryResult<T[]>) => R) => Promise<R>
}

interface MinimalSupabaseClient {
  from: <T>(table: string) => SupabaseTableQuery<T>
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

async function getClient(): Promise<MinimalSupabaseClient> {
  return (await getSupabaseClient()) as MinimalSupabaseClient
}

/**
 * Create a live Supabase-backed TeamWorkspaceService.
 * Call signals and teamId arguments from the handler are honoured; the
 * service does NOT re-resolve team_id internally.
 */
export function createLiveService(): TeamWorkspaceService {
  return {
    async resolveTeamId(licenseKey: string): Promise<string> {
      const teamId = await resolveLicenseTeamId(licenseKey)
      if (!teamId) {
        throw new Error(
          'Unable to resolve team from license key. Ensure SKILLSMITH_LICENSE_KEY is set and corresponds to an active Team-tier subscription.'
        )
      }
      return teamId
    },

    async createWorkspace(teamId, name, description): Promise<Workspace> {
      const client = await getClient()
      const resp = await client
        .from<WorkspaceRow>('team_workspaces')
        .insert({ team_id: teamId, name, description: description ?? null })
        .select()
        .single()
      if (resp.error || !resp.data) {
        throw new Error(`Failed to create workspace: ${resp.error?.message ?? 'unknown error'}`)
      }
      return mapWorkspace(resp.data)
    },

    async listWorkspaces(teamId): Promise<Workspace[]> {
      const client = await getClient()
      const resp = await client.from<WorkspaceRow>('team_workspaces').select().eq('team_id', teamId)
      if (resp.error) {
        throw new Error(`Failed to list workspaces: ${resp.error.message ?? 'unknown error'}`)
      }
      return (resp.data ?? []).map(mapWorkspace)
    },

    async getWorkspace(teamId, workspaceId): Promise<Workspace | null> {
      const client = await getClient()
      const resp = await client
        .from<WorkspaceRow>('team_workspaces')
        .select()
        .eq('id', workspaceId)
        .eq('team_id', teamId)
        .single()
      if (resp.error || !resp.data) return null
      return mapWorkspace(resp.data)
    },

    async deleteWorkspace(teamId, workspaceId): Promise<boolean> {
      const client = await getClient()
      const resp = await client
        .from<WorkspaceRow>('team_workspaces')
        .delete()
        .eq('id', workspaceId)
        .eq('team_id', teamId)
      if (resp.error) return false
      // PostgREST returns affected rows in `data` when `returning=representation` (default)
      return Array.isArray(resp.data) ? resp.data.length > 0 : true
    },

    async addSkill(_teamId, workspaceId, skillId): Promise<SharedSkill> {
      const client = await getClient()
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

    async removeSkill(_teamId, workspaceId, skillId): Promise<boolean> {
      const client = await getClient()
      const resp = await client
        .from<WorkspaceSkillRow>('workspace_skills')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('skill_id', skillId)
      if (resp.error) return false
      return Array.isArray(resp.data) ? resp.data.length > 0 : true
    },

    async listSkills(_teamId, workspaceId): Promise<SharedSkill[]> {
      const client = await getClient()
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
      const ws = await this.getWorkspace(teamId, workspaceId)
      return ws?.settings ?? {}
    },
  }
}
