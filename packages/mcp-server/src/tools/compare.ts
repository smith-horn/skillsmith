/**
 * @fileoverview MCP Skill Compare Tool for comparing two skills
 * @module @skillsmith/mcp-server/tools/compare
 * @see SMI-743: Add MCP Tool skill_compare
 * @see SMI-791: Wire compare tool to SkillRepository
 *
 * Compares two skills across multiple dimensions:
 * - Quality scores
 * - Trust tiers
 * - Features and capabilities
 * - Dependencies
 * - Size and complexity
 *
 * @example
 * // Compare two skills with context
 * const result = await executeCompare({
 *   skill_a: 'community/jest-helper',
 *   skill_b: 'community/vitest-helper'
 * }, context);
 * console.log(result.recommendation);
 */

import { SkillsmithError, ErrorCodes } from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { isValidSkillId } from '../utils/validation.js'

// Import types
import type { CompareInput, CompareResponse } from './compare.types.js'
import { compareInputSchema } from './compare.types.js'

// Import helpers
import {
  toSummary,
  generateDifferences,
  generateRecommendation,
  dbSkillToExtended,
  padEnd,
  formatScoreBar,
} from './compare.helpers.js'

// Re-export types for public API
export type {
  CompareInput,
  CompareResponse,
  SkillSummary,
  SkillDifference,
  ExtendedSkill,
  DbSkillRecord,
} from './compare.types.js'

export {
  compareInputSchema,
  compareToolSchema,
  TRUST_TIER_RANK,
} from './compare.types.js'

// Re-export helpers for testing/extension
export {
  toSummary,
  generateDifferences,
  generateRecommendation,
  dbSkillToExtended,
  formatScoreBar,
} from './compare.helpers.js'

/**
 * Execute skill comparison.
 *
 * Uses SkillRepository to fetch skills from the database and compares them
 * across multiple dimensions including quality scores, trust tiers, features,
 * and dependencies.
 *
 * @param input - Comparison parameters with two skill IDs
 * @param context - Tool context with database and services
 * @returns Promise resolving to comparison response
 * @throws {SkillsmithError} When skill IDs are invalid or not found
 *
 * @example
 * const response = await executeCompare({
 *   skill_a: 'community/jest-helper',
 *   skill_b: 'community/vitest-helper'
 * }, context);
 * console.log(response.recommendation);
 */
export async function executeCompare(
  input: CompareInput,
  context: ToolContext
): Promise<CompareResponse> {
  const startTime = performance.now()

  // Validate input with Zod
  const validated = compareInputSchema.parse(input)
  const { skill_a, skill_b } = validated

  // Validate skill ID formats
  if (!isValidSkillId(skill_a)) {
    throw new SkillsmithError(
      ErrorCodes.SKILL_INVALID_ID,
      `Invalid skill ID format: "${skill_a}"`,
      {
        details: { id: skill_a },
        suggestion: 'Skill IDs should be in format "author/skill-name" or a valid UUID',
      }
    )
  }

  if (!isValidSkillId(skill_b)) {
    throw new SkillsmithError(
      ErrorCodes.SKILL_INVALID_ID,
      `Invalid skill ID format: "${skill_b}"`,
      {
        details: { id: skill_b },
        suggestion: 'Skill IDs should be in format "author/skill-name" or a valid UUID',
      }
    )
  }

  // Check for same skill comparison
  if (skill_a.toLowerCase() === skill_b.toLowerCase()) {
    throw new SkillsmithError(
      ErrorCodes.VALIDATION_INVALID_TYPE,
      'Cannot compare a skill with itself',
      { details: { skill_a, skill_b } }
    )
  }

  // Look up skills from database
  const dbSkillA = context.skillRepository.findById(skill_a)
  const dbSkillB = context.skillRepository.findById(skill_b)

  if (!dbSkillA) {
    throw new SkillsmithError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${skill_a}" not found`, {
      details: { id: skill_a },
      suggestion: 'Try searching for similar skills with the search tool',
    })
  }

  if (!dbSkillB) {
    throw new SkillsmithError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${skill_b}" not found`, {
      details: { id: skill_b },
      suggestion: 'Try searching for similar skills with the search tool',
    })
  }

  // Convert to extended format
  const skillA = dbSkillToExtended(dbSkillA)
  const skillB = dbSkillToExtended(dbSkillB)

  // Generate differences
  const differences = generateDifferences(skillA, skillB)

  // Generate recommendation
  const { recommendation, winner } = generateRecommendation(skillA, skillB, differences)

  const endTime = performance.now()

  return {
    comparison: {
      a: toSummary(skillA),
      b: toSummary(skillB),
    },
    differences,
    recommendation,
    winner,
    timing: {
      totalMs: Math.round(endTime - startTime),
    },
  }
}

/**
 * Format comparison results for terminal display
 */
export function formatComparisonResults(response: CompareResponse): string {
  const lines: string[] = []
  const { a, b } = response.comparison

  lines.push('\n=== Skill Comparison ===\n')
  lines.push(`${a.name} vs ${b.name}`)
  lines.push('')

  // Side by side comparison
  lines.push('                           | ' + padEnd(a.name, 20) + ' | ' + padEnd(b.name, 20))
  lines.push('-'.repeat(70))
  lines.push(
    '  Quality Score            | ' +
      padEnd(String(a.quality_score) + '/100', 20) +
      ' | ' +
      padEnd(String(b.quality_score) + '/100', 20)
  )
  lines.push(
    '  Trust Tier               | ' +
      padEnd(a.trust_tier.toUpperCase(), 20) +
      ' | ' +
      padEnd(b.trust_tier.toUpperCase(), 20)
  )
  lines.push(
    '  Category                 | ' + padEnd(a.category, 20) + ' | ' + padEnd(b.category, 20)
  )
  lines.push(
    '  Dependencies             | ' +
      padEnd(String(a.dependencies.length), 20) +
      ' | ' +
      padEnd(String(b.dependencies.length), 20)
  )

  if (a.version || b.version) {
    lines.push(
      '  Version                  | ' +
        padEnd(a.version ?? 'N/A', 20) +
        ' | ' +
        padEnd(b.version ?? 'N/A', 20)
    )
  }

  lines.push('')

  // Score breakdown if available
  if (a.score_breakdown && b.score_breakdown) {
    lines.push('Score Breakdown:')
    lines.push(
      '  Quality                  | ' +
        formatScoreBar(a.score_breakdown.quality, 14) +
        ' | ' +
        formatScoreBar(b.score_breakdown.quality, 14)
    )
    lines.push(
      '  Popularity               | ' +
        formatScoreBar(a.score_breakdown.popularity, 14) +
        ' | ' +
        formatScoreBar(b.score_breakdown.popularity, 14)
    )
    lines.push(
      '  Maintenance              | ' +
        formatScoreBar(a.score_breakdown.maintenance, 14) +
        ' | ' +
        formatScoreBar(b.score_breakdown.maintenance, 14)
    )
    lines.push(
      '  Security                 | ' +
        formatScoreBar(a.score_breakdown.security, 14) +
        ' | ' +
        formatScoreBar(b.score_breakdown.security, 14)
    )
    lines.push(
      '  Documentation            | ' +
        formatScoreBar(a.score_breakdown.documentation, 14) +
        ' | ' +
        formatScoreBar(b.score_breakdown.documentation, 14)
    )
    lines.push('')
  }

  // Winner indicator
  lines.push('---')
  if (response.winner === 'a') {
    lines.push(`Winner: ${a.name}`)
  } else if (response.winner === 'b') {
    lines.push(`Winner: ${b.name}`)
  } else {
    lines.push('Winner: TIE')
  }
  lines.push('')

  // Recommendation
  lines.push('Recommendation:')
  lines.push('  ' + response.recommendation)
  lines.push('')

  lines.push('---')
  lines.push(`Completed in ${response.timing.totalMs}ms`)

  return lines.join('\n')
}
