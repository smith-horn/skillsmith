/**
 * @fileoverview publish_private MCP tool -- mark a skill as team-private
 * @module @skillsmith/mcp-server/tools/publish-private
 * @see SMI-3896: Private Skills Publishing
 *
 * Sets `visibility = 'private'` and `team_id` on a skill record in the
 * caller's own local SQLite database. This hides the skill from local
 * community-search results on this machine only -- today there is no
 * server-side team record or cross-teammate sync (see SMI-5882). For a
 * real shared team registry, see the Enterprise-tier
 * `private_registry_publish`/`private_registry_manage` tools.
 *
 * Tier gate: Team (private_skills feature flag).
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { getTeamWorkspaceService } from './team-workspace.js'
import { readLicenseKey } from './team-resolver.js'
import { withTelemetry } from '@skillsmith/core/telemetry'

// ============================================================================
// Input / Output types
// ============================================================================

export const publishPrivateInputSchema = z.object({
  /** Skill identifier in author/name format */
  skillId: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be author/name format'),
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
    'Mark a skill as private on this machine: hides it from local community-search results. ' +
    'This is a local-only setting today -- it does not sync or share the skill with your ' +
    'teammates. For a real shared team registry, see the Enterprise-tier private_registry_publish ' +
    'tool. Requires Team tier license.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillId: {
        type: 'string',
        description: 'Skill ID in author/name format',
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
async function executePublishPrivateImpl(
  input: PublishPrivateInput,
  context: ToolContext
): Promise<PublishPrivateResult> {
  const { skillId } = input

  // Resolve team_id from the team credential only -- never accept it from tool
  // input (ADR-116; matches the Enterprise registry-tools.ts path, which
  // never accepts teamId from input either). SMI-5882 W2.S5.
  // SMI-6080: read it through the shared `readLicenseKey()` resolver rather than
  // `process.env.SKILLSMITH_LICENSE_KEY` directly, so this path picks up the
  // SKILLSMITH_API_KEY fallback like every other team-resolution call site.
  const licenseKey = readLicenseKey() ?? ''
  const svc = getTeamWorkspaceService()
  const teamId = await svc.resolveTeamId(licenseKey)

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

// SMI-5017 W2.S2: wrap at export boundary
export const executePublishPrivate = withTelemetry(executePublishPrivateImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'publish_private',
  extractFramework: () => 'unknown',
})
