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
 *   skill_a: 'getsentry/commit',
 *   skill_b: 'microsoft/playwright-cli'
 * }, context);
 * console.log(result.recommendation);
 */

import { SkillsmithError, ErrorCodes, resolveSkillApiFirst } from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import type { ToolContext } from '../context.js'
import { isValidSkillId } from '../utils/validation.js'

// Import types
import type { CompareInput, CompareResponse, ExtendedSkill } from './compare.types.js'
import { compareInputSchema } from './compare.types.js'

// Import helpers
import {
  toSummary,
  generateDifferences,
  generateRecommendation,
  dbSkillToExtended,
  apiSkillToExtended,
  padEnd,
  formatScoreBar,
} from './compare.helpers.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export type {
  CompareInput,
  CompareResponse,
  SkillSummary,
  SkillDifference,
} from './compare.types.js'
export { compareInputSchema, compareToolSchema } from './compare.types.js'

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
 *   skill_a: 'getsentry/commit',
 *   skill_b: 'microsoft/playwright-cli'
 * }, context);
 * console.log(response.recommendation);
 */
async function executeCompareImpl(
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

  // SMI-5896: resolve both skills via the shared API-first / local-fallback
  // resolver (packages/core/src/services/skill-resolution.ts) — previously
  // compare only ever queried the local cache via skillRepository.findById(),
  // which (per SMI-5427) is no longer kept in sync in the remote-first search
  // world, so a real, searchable registry skill was often simply absent
  // locally. Resolved sequentially (not Promise.all) so a not-found error
  // deterministically names skill_a first when both are missing, matching
  // this tool's prior behavior.
  const resolvedA = await resolveSkillApiFirst(skill_a, context.apiClient, context.skillRepository)
  const resolvedB = await resolveSkillApiFirst(skill_b, context.apiClient, context.skillRepository)

  // Convert to extended format
  const skillA: ExtendedSkill =
    resolvedA.source === 'api'
      ? apiSkillToExtended(resolvedA.apiSkill)
      : dbSkillToExtended(resolvedA.dbSkill)
  const skillB: ExtendedSkill =
    resolvedB.source === 'api'
      ? apiSkillToExtended(resolvedB.apiSkill)
      : dbSkillToExtended(resolvedB.dbSkill)

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

// SMI-5017 W2.S2: wrap at export boundary
export const executeCompare = withTelemetry(executeCompareImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'skill_compare',
  extractFramework: () => 'unknown',
})

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
