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

import { z } from 'zod'
import {
  type MCPSkill as Skill,
  type MCPTrustTier as TrustTier,
  type ScoreBreakdown,
  SkillsmithError,
  ErrorCodes,
} from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { isValidSkillId, mapTrustTierFromDb, extractCategoryFromTags } from '../utils/validation.js'

/**
 * Zod schema for compare tool input validation
 */
export const compareInputSchema = z.object({
  /** First skill ID to compare */
  skill_a: z.string().min(1, 'skill_a is required'),
  /** Second skill ID to compare */
  skill_b: z.string().min(1, 'skill_b is required'),
})

/**
 * Input type derived from Zod schema
 */
export type CompareInput = z.infer<typeof compareInputSchema>

/**
 * Summary of a skill for comparison
 */
export interface SkillSummary {
  /** Skill identifier */
  id: string
  /** Skill name */
  name: string
  /** Brief description */
  description: string
  /** Author */
  author: string
  /** Quality score (0-100) */
  quality_score: number
  /** Score breakdown by category */
  score_breakdown: ScoreBreakdown | null
  /** Trust tier */
  trust_tier: TrustTier
  /** Category */
  category: string
  /** Tags */
  tags: string[]
  /** Version if available */
  version: string | null
  /** Dependencies */
  dependencies: string[]
}

/**
 * Difference between skills
 */
export interface SkillDifference {
  /** Field being compared */
  field: string
  /** Value from skill A */
  a_value: unknown
  /** Value from skill B */
  b_value: unknown
  /** Winner if applicable */
  winner?: 'a' | 'b' | 'tie'
}

/**
 * Comparison response
 */
export interface CompareResponse {
  /** Summaries of both skills */
  comparison: {
    a: SkillSummary
    b: SkillSummary
  }
  /** List of differences between skills */
  differences: SkillDifference[]
  /** Recommendation text */
  recommendation: string
  /** Overall winner if determinable */
  winner: 'a' | 'b' | 'tie'
  /** Performance timing */
  timing: {
    totalMs: number
  }
}

/**
 * MCP tool schema definition for skill_compare
 */
export const compareToolSchema = {
  name: 'skill_compare',
  description:
    'Compare two skills side-by-side. Analyzes quality scores, trust tiers, features, and dependencies to provide a recommendation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skill_a: {
        type: 'string',
        description: 'First skill ID to compare (e.g., "community/jest-helper")',
      },
      skill_b: {
        type: 'string',
        description: 'Second skill ID to compare (e.g., "community/vitest-helper")',
      },
    },
    required: ['skill_a', 'skill_b'],
  },
}

/**
 * Extended skill type with comparison metadata
 */
type ExtendedSkill = Skill & { dependencies: string[]; features: string[] }

// isValidSkillId imported from ../utils/validation.js

/**
 * Trust tier ranking for comparison
 */
const TRUST_TIER_RANK: Record<TrustTier, number> = {
  verified: 4,
  community: 3,
  standard: 2,
  unverified: 1,
}

/**
 * Convert skill to summary
 */
function toSummary(skill: ExtendedSkill): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    author: skill.author,
    quality_score: skill.score,
    score_breakdown: skill.scoreBreakdown ?? null,
    trust_tier: skill.trustTier,
    category: skill.category,
    tags: skill.tags,
    version: skill.version ?? null,
    dependencies: skill.dependencies,
  }
}

/**
 * Generate comparison differences
 */
function generateDifferences(skillA: ExtendedSkill, skillB: ExtendedSkill): SkillDifference[] {
  const differences: SkillDifference[] = []

  // Quality score comparison
  differences.push({
    field: 'quality_score',
    a_value: skillA.score,
    b_value: skillB.score,
    winner: skillA.score > skillB.score ? 'a' : skillA.score < skillB.score ? 'b' : 'tie',
  })

  // Trust tier comparison
  const trustRankA = TRUST_TIER_RANK[skillA.trustTier]
  const trustRankB = TRUST_TIER_RANK[skillB.trustTier]
  differences.push({
    field: 'trust_tier',
    a_value: skillA.trustTier,
    b_value: skillB.trustTier,
    winner: trustRankA > trustRankB ? 'a' : trustRankA < trustRankB ? 'b' : 'tie',
  })

  // Dependencies (fewer is usually better)
  differences.push({
    field: 'dependencies_count',
    a_value: skillA.dependencies.length,
    b_value: skillB.dependencies.length,
    winner:
      skillA.dependencies.length < skillB.dependencies.length
        ? 'a'
        : skillA.dependencies.length > skillB.dependencies.length
          ? 'b'
          : 'tie',
  })

  // Features (more is usually better)
  differences.push({
    field: 'features_count',
    a_value: skillA.features.length,
    b_value: skillB.features.length,
    winner:
      skillA.features.length > skillB.features.length
        ? 'a'
        : skillA.features.length < skillB.features.length
          ? 'b'
          : 'tie',
  })

  // Score breakdown comparison
  if (skillA.scoreBreakdown && skillB.scoreBreakdown) {
    for (const key of [
      'quality',
      'popularity',
      'maintenance',
      'security',
      'documentation',
    ] as const) {
      const aVal = skillA.scoreBreakdown[key]
      const bVal = skillB.scoreBreakdown[key]
      differences.push({
        field: `score_${key}`,
        a_value: aVal,
        b_value: bVal,
        winner: aVal > bVal ? 'a' : aVal < bVal ? 'b' : 'tie',
      })
    }
  }

  // Category
  if (skillA.category !== skillB.category) {
    differences.push({
      field: 'category',
      a_value: skillA.category,
      b_value: skillB.category,
    })
  }

  // Author
  if (skillA.author !== skillB.author) {
    differences.push({
      field: 'author',
      a_value: skillA.author,
      b_value: skillB.author,
    })
  }

  // Tags difference
  const tagsOnlyInA = skillA.tags.filter((t) => !skillB.tags.includes(t))
  const tagsOnlyInB = skillB.tags.filter((t) => !skillA.tags.includes(t))
  if (tagsOnlyInA.length > 0 || tagsOnlyInB.length > 0) {
    differences.push({
      field: 'unique_tags',
      a_value: tagsOnlyInA,
      b_value: tagsOnlyInB,
    })
  }

  return differences
}

/**
 * Generate recommendation based on comparison
 */
function generateRecommendation(
  skillA: ExtendedSkill,
  skillB: ExtendedSkill,
  differences: SkillDifference[]
): { recommendation: string; winner: 'a' | 'b' | 'tie' } {
  // Count wins
  let aWins = 0
  let bWins = 0

  for (const diff of differences) {
    if (diff.winner === 'a') aWins++
    else if (diff.winner === 'b') bWins++
  }

  // Weight certain factors more heavily
  const trustRankA = TRUST_TIER_RANK[skillA.trustTier]
  const trustRankB = TRUST_TIER_RANK[skillB.trustTier]

  // Verified trust tier gets big bonus
  if (trustRankA === 4) aWins += 2
  if (trustRankB === 4) bWins += 2

  // Higher quality score gets bonus
  if (skillA.score > skillB.score + 5) aWins += 1
  if (skillB.score > skillA.score + 5) bWins += 1

  let winner: 'a' | 'b' | 'tie'
  let recommendation: string

  if (aWins > bWins + 1) {
    winner = 'a'
    recommendation = `${skillA.name} is recommended. It has `
    const reasons: string[] = []

    if (skillA.score > skillB.score) {
      reasons.push(`higher quality score (${skillA.score} vs ${skillB.score})`)
    }
    if (trustRankA > trustRankB) {
      reasons.push(`better trust tier (${skillA.trustTier})`)
    }
    if (skillA.dependencies.length < skillB.dependencies.length) {
      reasons.push('fewer dependencies')
    }

    recommendation += reasons.length > 0 ? reasons.join(', ') + '.' : 'better overall metrics.'

    if (skillB.features.length > skillA.features.length) {
      recommendation += ` However, ${skillB.name} offers more features.`
    }
  } else if (bWins > aWins + 1) {
    winner = 'b'
    recommendation = `${skillB.name} is recommended. It has `
    const reasons: string[] = []

    if (skillB.score > skillA.score) {
      reasons.push(`higher quality score (${skillB.score} vs ${skillA.score})`)
    }
    if (trustRankB > trustRankA) {
      reasons.push(`better trust tier (${skillB.trustTier})`)
    }
    if (skillB.dependencies.length < skillA.dependencies.length) {
      reasons.push('fewer dependencies')
    }

    recommendation += reasons.length > 0 ? reasons.join(', ') + '.' : 'better overall metrics.'

    if (skillA.features.length > skillB.features.length) {
      recommendation += ` However, ${skillA.name} offers more features.`
    }
  } else {
    winner = 'tie'
    recommendation = `Both skills are comparable. `

    if (skillA.category === skillB.category) {
      recommendation += `Choose ${skillA.name} for ${skillA.tags
        .filter((t) => !skillB.tags.includes(t))
        .slice(0, 2)
        .join('/')} workflows, `
      recommendation += `or ${skillB.name} for ${skillB.tags
        .filter((t) => !skillA.tags.includes(t))
        .slice(0, 2)
        .join('/')} workflows.`
    } else {
      recommendation += `${skillA.name} is better for ${skillA.category}, while ${skillB.name} excels at ${skillB.category}.`
    }
  }

  return { recommendation, winner }
}

/**
 * Convert database skill to extended skill format
 *
 * Note: Dependencies are not currently stored in the database schema.
 * Features are inferred from tags for now.
 */
function dbSkillToExtended(dbSkill: {
  id: string
  name: string
  description: string | null
  author: string | null
  repoUrl: string | null
  qualityScore: number | null
  trustTier: string
  tags: string[]
  createdAt: string
  updatedAt: string
}): ExtendedSkill {
  const tags = dbSkill.tags || []
  return {
    id: dbSkill.id,
    name: dbSkill.name,
    description: dbSkill.description || '',
    author: dbSkill.author || 'unknown',
    repository: dbSkill.repoUrl || undefined,
    version: undefined,
    category: extractCategoryFromTags(tags),
    trustTier: mapTrustTierFromDb(dbSkill.trustTier as import('@skillsmith/core').TrustTier),
    score: Math.round((dbSkill.qualityScore ?? 0) * 100),
    scoreBreakdown: undefined,
    tags,
    installCommand: 'claude skill add ' + dbSkill.id,
    createdAt: dbSkill.createdAt,
    updatedAt: dbSkill.updatedAt,
    // Note: Dependencies not yet stored in database - field reserved for future use
    dependencies: [],
    // Use non-category tags as feature indicators
    features: tags.filter(
      (t) =>
        ![
          'development',
          'testing',
          'documentation',
          'devops',
          'database',
          'security',
          'productivity',
          'integration',
          'ai-ml',
          'other',
        ].includes(t.toLowerCase())
    ),
  }
}

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

/**
 * Pad string to specified length
 */
function padEnd(str: string, length: number): string {
  return str.padEnd(length)
}

/**
 * Format score as visual bar
 */
function formatScoreBar(score: number, width: number): string {
  const filled = Math.round((score / 100) * 10)
  const bar = '='.repeat(filled) + '-'.repeat(10 - filled)
  return `[${bar}] ${score}`.padEnd(width)
}
