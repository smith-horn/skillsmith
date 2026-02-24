/**
 * @fileoverview Recommendation Formatting and Deduplication Utilities
 * @module @skillsmith/mcp-server/tools/recommend.format
 * @see SMI-2741: Split from recommend.ts to meet 500-line standard
 *
 * Standalone utilities extracted from executeRecommend:
 * - mergeAndDeduplicateRecommendations: Merge API and local results, removing duplicates
 * - formatRecommendations: Format recommendation response for terminal display
 */

import { getTrustBadge } from '../utils/validation.js'
import type { SkillRecommendation, RecommendResponse } from './recommend.types.js'

/**
 * Merge and deduplicate API and local skill recommendations.
 * API results take priority over local results with the same name.
 *
 * @param apiResults - Results from API
 * @param localResults - Results from local skill search
 * @param limit - Maximum combined results
 * @returns Merged and deduplicated recommendations
 */
export function mergeAndDeduplicateRecommendations(
  apiResults: SkillRecommendation[],
  localResults: SkillRecommendation[],
  limit: number
): SkillRecommendation[] {
  // Build a Set of names from API results for deduplication
  const apiSkillNames = new Set(apiResults.map((r) => r.name.toLowerCase()))

  // Also track skill IDs (without the author prefix)
  const apiSkillIdNames = new Set(
    apiResults.map((r) => r.skill_id.split('/').pop()?.toLowerCase() || '')
  )

  // Filter local results to exclude duplicates
  const uniqueLocalResults = localResults.filter((local) => {
    const localName = local.name.toLowerCase()
    const localIdName = local.skill_id.split('/').pop()?.toLowerCase() || ''

    // Exclude if name matches an API result
    if (apiSkillNames.has(localName)) {
      return false
    }

    // Exclude if ID name matches an API result
    if (apiSkillIdNames.has(localIdName)) {
      return false
    }

    // Exclude if local name is contained in or contains an API skill name
    for (const apiName of apiSkillNames) {
      if (localName.includes(apiName) || apiName.includes(localName)) {
        return false
      }
    }

    return true
  })

  // Combine API results first (higher priority), then unique local results
  const combined = [...apiResults, ...uniqueLocalResults]

  // Sort by quality score descending, then by similarity score
  combined.sort((a, b) => {
    if (b.quality_score !== a.quality_score) {
      return b.quality_score - a.quality_score
    }
    return b.similarity_score - a.similarity_score
  })

  return combined.slice(0, limit)
}

/**
 * Format recommendations for terminal display
 *
 * @param response - Recommendation response to format
 * @returns Formatted string for terminal output
 */
export function formatRecommendations(response: RecommendResponse): string {
  const lines: string[] = []

  lines.push('\n=== Skill Recommendations ===\n')

  if (response.recommendations.length === 0) {
    lines.push('No recommendations found.')
    lines.push('')
    lines.push('Suggestions:')
    lines.push('  - Try adding more installed skills for better matching')
    lines.push('  - Provide a project context for more relevant results')
    // SMI-1631: Suggest removing role filter if one was applied
    if (response.context.role_filter) {
      lines.push(`  - Try removing the role filter (currently: ${response.context.role_filter})`)
    }
  } else {
    lines.push(`Found ${response.recommendations.length} recommendation(s):\n`)

    response.recommendations.forEach((rec, index) => {
      const trustBadge = getTrustBadge(rec.trust_tier)
      // SMI-1631: Show roles if present
      const rolesDisplay = rec.roles?.length ? ` [${rec.roles.join(', ')}]` : ''
      lines.push(`${index + 1}. ${rec.name} ${trustBadge}${rolesDisplay}`)
      lines.push(
        `   Score: ${rec.quality_score}/100 | Relevance: ${Math.round(rec.similarity_score * 100)}%`
      )
      lines.push(`   ${rec.reason}`)
      lines.push(`   ID: ${rec.skill_id}`)
      lines.push('')
    })
  }

  lines.push('---')
  lines.push(`Candidates considered: ${response.candidates_considered}`)
  if (response.overlap_filtered > 0) {
    lines.push(`Filtered for overlap: ${response.overlap_filtered}`)
  }
  // SMI-1631: Show role filter stats
  if (response.role_filtered > 0) {
    lines.push(`Filtered for role: ${response.role_filtered}`)
  }
  if (response.context.role_filter) {
    lines.push(`Role filter: ${response.context.role_filter}`)
  }
  if (response.context.auto_detected) {
    lines.push(
      `Installed skills: ${response.context.installed_count} (auto-detected from ~/.claude/skills/)`
    )
  } else {
    lines.push(`Installed skills: ${response.context.installed_count}`)
  }
  lines.push(
    `Semantic matching: ${response.context.using_semantic_matching ? 'enabled' : 'disabled'}`
  )
  lines.push(`Completed in ${response.timing.totalMs}ms`)

  return lines.join('\n')
}
