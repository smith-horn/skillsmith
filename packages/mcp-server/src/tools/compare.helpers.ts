/**
 * Compare Tool Helper Functions
 * @module @skillsmith/mcp-server/tools/compare.helpers
 */

import type { MCPTrustTier as TrustTier } from '@skillsmith/core'
import { mapTrustTierFromDb, extractCategoryFromTags } from '../utils/validation.js'
import type {
  ExtendedSkill,
  SkillSummary,
  SkillDifference,
  DbSkillRecord,
} from './compare.types.js'
import { TRUST_TIER_RANK } from './compare.types.js'

/**
 * Convert skill to summary
 */
export function toSummary(skill: ExtendedSkill): SkillSummary {
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
export function generateDifferences(
  skillA: ExtendedSkill,
  skillB: ExtendedSkill
): SkillDifference[] {
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
export function generateRecommendation(
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
export function dbSkillToExtended(dbSkill: DbSkillRecord): ExtendedSkill {
  const tags = dbSkill.tags || []
  return {
    id: dbSkill.id,
    name: dbSkill.name,
    description: dbSkill.description || '',
    author: dbSkill.author || 'unknown',
    repository: dbSkill.repoUrl || undefined,
    version: undefined,
    category: extractCategoryFromTags(tags),
    trustTier: mapTrustTierFromDb(dbSkill.trustTier as TrustTier),
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
 * Pad string to specified length
 */
export function padEnd(str: string, length: number): string {
  return str.padEnd(length)
}

/**
 * Format score as visual bar
 */
export function formatScoreBar(score: number, width: number): string {
  const filled = Math.round((score / 100) * 10)
  const bar = '='.repeat(filled) + '-'.repeat(10 - filled)
  return `[${bar}] ${score}`.padEnd(width)
}
