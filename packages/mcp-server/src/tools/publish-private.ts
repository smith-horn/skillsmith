/**
 * @fileoverview publish_private MCP tool -- mark a skill as team-private
 * @module @skillsmith/mcp-server/tools/publish-private
 * @see SMI-3896: Private Skills Publishing
 *
 * Sets `visibility = 'private'` and `team_id` on a skill record in the
 * local SQLite database. Private skills are excluded from community search
 * results and only visible to members of the owning team.
 *
 * Tier gate: Team (private_skills feature flag).
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { getTeamWorkspaceService } from './team-workspace.js'

// ============================================================================
// Input / Output types
// ============================================================================

export const publishPrivateInputSchema = z.object({
  /** Skill identifier in author/name format */
  skillId: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be author/name format'),
  /** Team ID to assign (resolved from license if not provided) */
  teamId: z.string().optional(),
})

export type PublishPrivateInput = z.infer<typeof publishPrivateInputSchema>

export interface PublishPrivateResult {
  success: boolean
  skillId: string
  visibility: 'private' | 'public'
  teamId: string | null
  message?: string
  error?: string
}

// ============================================================================
// Tool schema for MCP registration
// ============================================================================

export const publishPrivateToolSchema = {
  name: 'publish_private',
  description:
    'Mark a skill as private to your team. Private skills are hidden from community search. Requires Team tier license.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillId: {
        type: 'string',
        description: 'Skill ID in author/name format',
      },
      teamId: {
        type: 'string',
        description: 'Team ID (resolved from license if not provided)',
      },
    },
    required: ['skillId'],
  },
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Execute publish_private: sets visibility = 'private' and team_id on the skill.
 *
 * @param input - Validated publish-private input
 * @param context - Tool context with database access
 */
export async function executePublishPrivate(
  input: PublishPrivateInput,
  context: ToolContext
): Promise<PublishPrivateResult> {
  const { skillId } = input

  // Resolve team_id: explicit param or from license
  let teamId = input.teamId ?? null
  if (!teamId) {
    const licenseKey = process.env.SKILLSMITH_LICENSE_KEY ?? ''
    const svc = getTeamWorkspaceService()
    teamId = await svc.resolveTeamId(licenseKey)
  }

  // Check skill exists in local DB
  const skill = context.db.prepare('SELECT id FROM skills WHERE id = ?').get(skillId) as
    | { id: string }
    | undefined

  if (!skill) {
    return {
      success: false,
      skillId,
      visibility: 'public',
      teamId: null,
      error: `Skill "${skillId}" not found in local database. Index or install it first.`,
    }
  }

  // Update visibility and team_id
  context.db
    .prepare(
      "UPDATE skills SET visibility = ?, team_id = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run('private', teamId, skillId)

  return {
    success: true,
    skillId,
    visibility: 'private',
    teamId,
    message: `Skill "${skillId}" is now private (team: ${teamId}).`,
  }
}
