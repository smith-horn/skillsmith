/**
 * @fileoverview MCP Get Skill Tool for retrieving detailed skill information
 * @module @skillsmith/mcp-server/tools/get-skill
 * @see {@link https://github.com/wrsmith108/skillsmith|Skillsmith Repository}
 * @see SMI-790: Wire get-skill tool to SkillRepository
 *
 * Retrieves comprehensive details for a specific skill including:
 * - Basic metadata (name, author, version, category)
 * - Quality scores with breakdown (quality, popularity, maintenance, security, documentation)
 * - Trust tier with explanation
 * - Repository link and tags
 * - Installation command
 *
 * @example
 * // Get skill by ID with context
 * const response = await executeGetSkill({ id: 'anthropic/commit' }, context);
 * console.log(response.skill.description);
 *
 * @example
 * // Format for terminal display
 * const response = await executeGetSkill({ id: 'community/jest-helper' }, context);
 * console.log(formatSkillDetails(response));
 */

import { z } from 'zod'
import {
  type MCPSkill as Skill,
  type GetSkillResponse,
  type MCPTrustTier as TrustTier,
  TrustTierDescriptions,
  SkillsmithError,
  ErrorCodes,
} from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { isValidSkillId, mapTrustTierFromDb, extractCategoryFromTags } from '../utils/validation.js'

/**
 * Zod schema for get-skill input validation
 */
export const getSkillInputSchema = z.object({
  id: z.string().min(1, 'Skill ID is required'),
})

/**
 * Get skill tool schema for MCP
 */
export const getSkillToolSchema = {
  name: 'get_skill',
  description: 'Get full details for a specific skill by ID',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description: 'The skill ID (e.g., "anthropic/commit" or UUID)',
      },
    },
    required: ['id'],
  },
}

/**
 * Input parameters for the get skill operation
 * @interface GetSkillInput
 */
export interface GetSkillInput {
  /** Skill ID in format "author/skill-name" or UUID */
  id: string
}

// isValidSkillId imported from ../utils/validation.js

/**
 * Retrieve full details for a specific skill by ID.
 *
 * Uses SkillRepository to fetch skill from the SQLite database.
 *
 * @param input - Input containing the skill ID to retrieve
 * @param context - Tool context with database and services
 * @returns Promise resolving to skill details and install command
 * @throws {SkillsmithError} VALIDATION_REQUIRED_FIELD - When ID is empty
 * @throws {SkillsmithError} SKILL_INVALID_ID - When ID format is invalid
 * @throws {SkillsmithError} SKILL_NOT_FOUND - When skill doesn't exist
 *
 * @example
 * // Get a verified skill
 * const response = await executeGetSkill({ id: 'anthropic/commit' }, context);
 * console.log(response.skill.score); // 95
 * console.log(response.installCommand); // 'claude skill add anthropic/commit'
 *
 * @example
 * // Handle not found
 * try {
 *   await executeGetSkill({ id: 'unknown/skill' }, context);
 * } catch (error) {
 *   if (error.code === 'SKILL_NOT_FOUND') {
 *     console.log(error.suggestion); // 'Try searching for similar skills...'
 *   }
 * }
 */
export async function executeGetSkill(
  input: GetSkillInput,
  context: ToolContext
): Promise<GetSkillResponse> {
  const startTime = performance.now()

  // Validate input
  if (!input.id || input.id.trim().length === 0) {
    throw new SkillsmithError(ErrorCodes.VALIDATION_REQUIRED_FIELD, 'Skill ID is required', {
      details: { field: 'id' },
    })
  }

  const skillId = input.id.trim()

  // Validate ID format
  if (!isValidSkillId(skillId)) {
    throw new SkillsmithError(
      ErrorCodes.SKILL_INVALID_ID,
      'Invalid skill ID format: "' + input.id + '"',
      {
        details: { id: input.id },
        suggestion:
          'Skill IDs should be in format "author/skill-name" (e.g., "anthropic/commit") or a valid UUID',
      }
    )
  }

  // Look up skill from database using SkillRepository
  const dbSkill = context.skillRepository.findById(skillId)

  if (!dbSkill) {
    throw new SkillsmithError(ErrorCodes.SKILL_NOT_FOUND, 'Skill "' + input.id + '" not found', {
      details: { id: input.id },
      suggestion: 'Try searching for similar skills with the search tool',
    })
  }

  // Convert database skill to MCP skill format
  const skill: Skill = {
    id: dbSkill.id,
    name: dbSkill.name,
    description: dbSkill.description || '',
    author: dbSkill.author || 'unknown',
    repository: dbSkill.repoUrl || undefined,
    version: undefined, // Version not stored in current schema
    category: extractCategoryFromTags(dbSkill.tags),
    trustTier: mapTrustTierFromDb(dbSkill.trustTier as import('@skillsmith/core').TrustTier),
    score: Math.round((dbSkill.qualityScore ?? 0) * 100),
    scoreBreakdown: undefined, // Breakdown not stored in current schema
    tags: dbSkill.tags || [],
    installCommand: 'claude skill add ' + dbSkill.id,
    createdAt: dbSkill.createdAt,
    updatedAt: dbSkill.updatedAt,
  }

  const endTime = performance.now()

  return {
    skill,
    installCommand: skill.installCommand || 'claude skill add ' + skill.id,
    timing: {
      totalMs: Math.round(endTime - startTime),
    },
  }
}

/**
 * Format skill details for terminal/CLI display.
 *
 * Produces a comprehensive human-readable string including:
 * - Basic info (ID, author, version, category)
 * - Full description
 * - Trust tier with explanation
 * - Visual score breakdown bars
 * - Repository and tags
 * - Installation command
 *
 * @param response - Get skill response from executeGetSkill
 * @returns Formatted string suitable for terminal output
 *
 * @example
 * const response = await executeGetSkill({ id: 'anthropic/commit' });
 * console.log(formatSkillDetails(response));
 * // Output:
 * // === commit ===
 * // ID: anthropic/commit
 * // Author: anthropic
 * // Version: 1.2.0
 * // ...
 */
export function formatSkillDetails(response: GetSkillResponse): string {
  const skill = response.skill
  const lines: string[] = []

  lines.push('\n=== ' + skill.name + ' ===\n')

  // Basic info
  lines.push('ID: ' + skill.id)
  lines.push('Author: ' + skill.author)
  lines.push('Version: ' + (skill.version || 'N/A'))
  lines.push('Category: ' + skill.category)
  lines.push('')

  // Description
  lines.push('Description:')
  lines.push('  ' + skill.description)
  lines.push('')

  // Trust tier with explanation
  lines.push('Trust Tier: ' + formatTrustTier(skill.trustTier))
  lines.push('  ' + TrustTierDescriptions[skill.trustTier])
  lines.push('')

  // Score breakdown
  lines.push('Overall Score: ' + skill.score + '/100')
  if (skill.scoreBreakdown) {
    lines.push('Score Breakdown:')
    lines.push('  Quality:       ' + formatScoreBar(skill.scoreBreakdown.quality))
    lines.push('  Popularity:    ' + formatScoreBar(skill.scoreBreakdown.popularity))
    lines.push('  Maintenance:   ' + formatScoreBar(skill.scoreBreakdown.maintenance))
    lines.push('  Security:      ' + formatScoreBar(skill.scoreBreakdown.security))
    lines.push('  Documentation: ' + formatScoreBar(skill.scoreBreakdown.documentation))
  }
  lines.push('')

  // Repository
  if (skill.repository) {
    lines.push('Repository: ' + skill.repository)
  }

  // Tags
  if (skill.tags && skill.tags.length > 0) {
    lines.push('Tags: ' + skill.tags.join(', '))
  }
  lines.push('')

  // Installation
  lines.push('--- Installation ---')
  lines.push('  ' + response.installCommand)
  lines.push('')

  // Timing
  lines.push('---')
  lines.push('Retrieved in ' + response.timing.totalMs + 'ms')

  return lines.join('\n')
}

/**
 * Format trust tier with visual indicator
 */
function formatTrustTier(tier: TrustTier): string {
  switch (tier) {
    case 'verified':
      return '[*] VERIFIED'
    case 'community':
      return '[+] COMMUNITY'
    case 'standard':
      return '[=] STANDARD'
    case 'unverified':
      return '[?] UNVERIFIED'
  }
}

/**
 * Format score as a visual bar
 */
function formatScoreBar(score: number): string {
  const filled = Math.round(score / 10)
  const empty = 10 - filled
  const bar = '='.repeat(filled) + '-'.repeat(empty)
  return '[' + bar + '] ' + score + '/100'
}
