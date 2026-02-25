/**
 * @fileoverview skill_audit MCP tool — check skills for security advisories
 * @module @skillsmith/mcp-server/tools/skill-audit
 * @see SMI-skill-version-tracking Wave 3
 *
 * Returns a summary of active security advisories for installed skills.
 * The advisory system is in early access — advisories are published by the
 * Skillsmith team as security issues are identified.
 *
 * Tier gate: Team (skill_security_audit feature flag).
 * Community and Individual users receive a graceful license error response.
 */

import { z } from 'zod'
import { AdvisoryRepository } from '@skillsmith/core'
import type { ToolContext } from '../context.js'

// ============================================================================
// Input / Output types
// ============================================================================

/**
 * Input schema for skill_audit tool
 */
export const skillAuditInputSchema = z.object({
  /** Optional filter — check only the specified skill IDs */
  skillIds: z
    .array(z.string().min(1))
    .optional()
    .describe('Specific skill IDs to audit (omit to audit all skills with advisories)'),
})

export type SkillAuditInput = z.infer<typeof skillAuditInputSchema>

/**
 * Per-advisory summary entry in the audit response
 */
export interface AdvisoryEntry {
  /** Registry skill identifier */
  skillName: string
  /** Advisory severity */
  severity: 'low' | 'medium' | 'high' | 'critical'
  /** Short advisory title */
  title: string
  /** Advisory identifier (SSA-YYYY-NNN format) */
  id: string
  /** Whether a patched version is available */
  fixAvailable: boolean
}

/**
 * Advisory count summary by severity
 */
export interface AdvisorySummary {
  critical: number
  high: number
  medium: number
  low: number
  total: number
}

/**
 * Response from skill_audit tool
 */
export interface SkillAuditResponse {
  /** Whether advisories data is available */
  advisoriesAvailable: boolean
  /** Early-access message when no advisories are in the database */
  message?: string
  /** Counts by severity (only present when advisoriesAvailable: true) */
  summary?: AdvisorySummary
  /** Per-advisory details (only present when advisoriesAvailable: true) */
  advisories?: AdvisoryEntry[]
}

// ============================================================================
// Tool schema (MCP tool definition)
// ============================================================================

/**
 * MCP tool definition for skill_audit
 */
export const skillAuditToolSchema = {
  name: 'skill_audit' as const,
  description:
    'Check installed skills for known security advisories. ' +
    'Requires Team tier or higher (skill_security_audit feature). ' +
    'The advisory system is in early access — the Skillsmith team publishes advisories ' +
    'as security issues are identified. Run `skillsmith sync` to fetch the latest advisories.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Specific skill IDs to audit (omit to return all skills with active advisories).',
      },
    },
    required: [],
  },
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Execute the skill_audit tool.
 *
 * Reads active advisories from skill_advisories table (migration v6).
 * When the table is empty, returns an early-access message instead of
 * an empty result so users understand the system is operational but
 * advisory data has not yet been synced.
 *
 * @param input   Validated tool input
 * @param context Tool context with database connection
 * @returns SkillAuditResponse with advisory data or early-access message
 */
export async function executeSkillAudit(
  input: SkillAuditInput,
  context: ToolContext
): Promise<SkillAuditResponse> {
  const advisoryRepo = new AdvisoryRepository(context.db)

  // Fetch advisories — filter by skillIds if provided
  let advisories
  if (input.skillIds && input.skillIds.length > 0) {
    advisories = input.skillIds.flatMap((id) => advisoryRepo.getAdvisoriesForSkill(id))
  } else {
    advisories = advisoryRepo.getActiveAdvisories()
  }

  // No advisories in DB — early-access message
  if (advisories.length === 0) {
    return {
      advisoriesAvailable: false,
      message:
        'Advisory system is in early access — the Skillsmith team publishes advisories as ' +
        'security issues are identified. Run `skillsmith sync` to fetch the latest.',
    }
  }

  // Build summary counts
  const summary: AdvisorySummary = { critical: 0, high: 0, medium: 0, low: 0, total: 0 }
  for (const adv of advisories) {
    summary[adv.severity]++
    summary.total++
  }

  // Build per-advisory entries
  const entries: AdvisoryEntry[] = advisories.map((adv) => ({
    skillName: adv.skillId,
    severity: adv.severity,
    title: adv.title,
    id: adv.id,
    fixAvailable: Boolean(adv.patchedVersions),
  }))

  return {
    advisoriesAvailable: true,
    summary,
    advisories: entries,
  }
}
