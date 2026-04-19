/**
 * @fileoverview Stub service for team workspace MCP tools
 * @module @skillsmith/mcp-server/tools/team-workspace.stub
 * @see SMI-3895: Team Workspace + Share Skill MCP Tools
 * @see SMI-3914: Wave 0 stub extraction
 *
 * Extracted from team-workspace.ts for file-size compliance.
 * Provides in-memory stub implementation for workspace CRUD and skill sharing.
 */

import type {
  TeamWorkspaceService,
  Workspace,
  WorkspaceSettings,
  SharedSkill,
} from './team-workspace.js'

// ============================================================================
// Stub service factory
// ============================================================================

/** @internal Exported for testing */
export function createStubService(): TeamWorkspaceService {
  // In-memory store for stub data
  const workspaces = new Map<string, Workspace>()
  const skills = new Map<string, SharedSkill[]>()

  return {
    async resolveTeamId(_licenseKey: string): Promise<string> {
      // SMI-4292: Live resolution lives in team-workspace.live.ts via
      // resolve_team_from_license RPC (migration 071). This stub returns a
      // static team id for unit tests and unauthenticated environments.
      return 'team_stub_00000000-0000-0000-0000-000000000000'
    },

    async createWorkspace(teamId: string, name: string, description?: string): Promise<Workspace> {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const ws: Workspace = {
        id,
        name,
        description: description ?? null,
        teamId,
        settings: {},
        createdAt: now,
        updatedAt: now,
      }
      workspaces.set(id, ws)
      return ws
    },

    async listWorkspaces(teamId: string): Promise<Workspace[]> {
      return [...workspaces.values()].filter((ws) => ws.teamId === teamId)
    },

    async getWorkspace(_teamId: string, workspaceId: string): Promise<Workspace | null> {
      return workspaces.get(workspaceId) ?? null
    },

    async deleteWorkspace(_teamId: string, workspaceId: string): Promise<boolean> {
      const existed = workspaces.has(workspaceId)
      workspaces.delete(workspaceId)
      skills.delete(workspaceId)
      return existed
    },

    async addSkill(_teamId: string, workspaceId: string, skillId: string): Promise<SharedSkill> {
      const entry: SharedSkill = {
        skillId,
        addedBy: 'current-user',
        addedAt: new Date().toISOString(),
      }
      const list = skills.get(workspaceId) ?? []
      list.push(entry)
      skills.set(workspaceId, list)
      return entry
    },

    async removeSkill(_teamId: string, workspaceId: string, skillId: string): Promise<boolean> {
      const list = skills.get(workspaceId) ?? []
      const filtered = list.filter((s) => s.skillId !== skillId)
      skills.set(workspaceId, filtered)
      return filtered.length < list.length
    },

    async listSkills(_teamId: string, workspaceId: string): Promise<SharedSkill[]> {
      return skills.get(workspaceId) ?? []
    },

    async getWorkspaceSettings(_teamId: string, workspaceId: string): Promise<WorkspaceSettings> {
      const ws = workspaces.get(workspaceId)
      return ws?.settings ?? {}
    },
  }
}
