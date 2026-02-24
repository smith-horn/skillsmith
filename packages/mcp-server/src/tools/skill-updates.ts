/**
 * @fileoverview skill_updates MCP tool — check for registry skill updates
 * @module @skillsmith/mcp-server/tools/skill-updates
 * @see SMI-skill-version-tracking Wave 1
 *
 * Compares the locally-recorded content hash of each installed skill
 * against the most-recent hash in the skill_versions table to determine
 * whether a newer version has been synced from the registry.
 *
 * Tier gate: Individual (version_tracking feature flag).
 * Community users see a graceful license error response, never a hard throw.
 *
 * Hash display: truncated to 8 chars for human readability (full hash stored).
 */

import { z } from 'zod'
import { SkillVersionRepository } from '@skillsmith/core'
import type { ToolContext } from '../context.js'

// ============================================================================
// Input / Output types
// ============================================================================

/**
 * Input schema for skill_updates tool
 */
export const skillUpdatesInputSchema = z.object({
  /** Optional filter — check only the specified skill IDs */
  skillIds: z
    .array(z.string().min(1))
    .optional()
    .describe('Specific skill IDs to check (omit for all tracked skills)'),
})

export type SkillUpdatesInput = z.infer<typeof skillUpdatesInputSchema>

/**
 * Per-skill update information returned by the tool
 */
export interface SkillUpdateInfo {
  /** Registry skill identifier (e.g. "author/skill-name") */
  skillId: string
  /** 8-char prefix of the oldest recorded hash (what the CLI installed with) */
  installedHash: string
  /** 8-char prefix of the most-recent recorded hash (current registry state) */
  latestHash: string
  /** Optional semver from the latest version record */
  semver: string | null
  /** Approximate age of the latest recorded version in days */
  ageDays: number
  /** Whether this skill is pinned (Wave 2 — always false in Wave 1) */
  pinned: boolean
  /** Whether an update is available (latestHash !== installedHash) */
  updateAvailable: boolean
}

/**
 * Response from skill_updates tool
 */
export interface CheckUpdatesResponse {
  /** Number of skills with updates available */
  updatesAvailable: number
  /** Per-skill details */
  skills: SkillUpdateInfo[]
}

// ============================================================================
// Tool schema (MCP tool definition)
// ============================================================================

/**
 * MCP tool definition for skill_updates
 */
export const skillUpdatesToolSchema = {
  name: 'skill_updates' as const,
  description:
    'Check installed skills for available updates by comparing locally-recorded content hashes ' +
    'against the current registry state. Requires Individual tier or higher. ' +
    'Returns a list of skills with their installed vs. latest hash and whether an update is available.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific skill IDs to check. Omit to check all tracked skills.',
      },
    },
    required: [],
  },
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute the skill_updates tool.
 *
 * Reads all tracked skills from skill_versions (or filters by skillIds),
 * gets the latest version record for each, and compares it to the oldest
 * recorded version (used as a proxy for "what was installed").
 *
 * @param input   Validated tool input
 * @param context Tool context with database connection
 * @returns CheckUpdatesResponse with per-skill update status
 */
export async function executeSkillUpdates(
  input: SkillUpdatesInput,
  context: ToolContext
): Promise<CheckUpdatesResponse> {
  const versionRepo = new SkillVersionRepository(context.db)

  // Determine which skill IDs to check
  let skillIds: string[]

  if (input.skillIds && input.skillIds.length > 0) {
    skillIds = input.skillIds
  } else {
    // Query all distinct skill_ids that have version records
    const rows = context.db
      .prepare(`SELECT DISTINCT skill_id FROM skill_versions ORDER BY skill_id`)
      .all() as Array<{ skill_id: string }>
    skillIds = rows.map((r) => r.skill_id)
  }

  const now = Math.floor(Date.now() / 1000) // Unix seconds
  const skillInfos: SkillUpdateInfo[] = []

  for (const skillId of skillIds) {
    // Get the full history to find both the oldest (installed proxy) and latest
    const history = await versionRepo.getVersionHistory(skillId, 50)

    if (history.length === 0) {
      continue
    }

    // Latest is history[0] (ordered DESC), oldest is history[history.length - 1]
    const latest = history[0]
    const oldest = history[history.length - 1]

    const installedHash = oldest.content_hash.slice(0, 8)
    const latestHash = latest.content_hash.slice(0, 8)

    const ageDays = Math.floor((now - latest.recorded_at) / 86400)

    skillInfos.push({
      skillId,
      installedHash,
      latestHash,
      semver: latest.semver,
      ageDays,
      pinned: false, // Wave 2: pinning support
      updateAvailable: oldest.content_hash !== latest.content_hash,
    })
  }

  const updatesAvailable = skillInfos.filter((s) => s.updateAvailable).length

  return {
    updatesAvailable,
    skills: skillInfos,
  }
}
