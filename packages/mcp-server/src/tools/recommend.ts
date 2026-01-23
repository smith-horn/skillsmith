/**
 * @fileoverview MCP Skill Recommend Tool for suggesting relevant skills
 * @module @skillsmith/mcp-server/tools/recommend
 * @see SMI-741: Add MCP Tool skill_recommend
 * @see SMI-602: Integrate semantic matching with EmbeddingService
 * @see SMI-604: Add trigger phrase overlap detection
 */

import { SkillMatcher, OverlapDetector, trackEvent } from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { getInstalledSkills } from '../utils/installed-skills.js'
import { mapTrustTierFromDb, getTrustBadge } from '../utils/validation.js'

// Import types
import {
  recommendInputSchema,
  type RecommendInput,
  type RecommendResponse,
  type SkillRecommendation,
  type SkillData,
} from './recommend.types.js'

// Import helpers
import {
  inferRolesFromTags,
  loadSkillsFromDatabase,
  isSkillCollection,
} from './recommend.helpers.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export {
  recommendInputSchema,
  recommendToolSchema,
  type RecommendInput,
  type RecommendResponse,
  type SkillRecommendation,
} from './recommend.types.js'

/**
 * Execute skill recommendation based on installed skills and context.
 *
 * SMI-1183: Uses API as primary source with local fallback.
 * - Tries live API first (api.skillsmith.app)
 * - Falls back to local semantic matching if API is offline or fails
 */
export async function executeRecommend(
  input: RecommendInput,
  context: ToolContext
): Promise<RecommendResponse> {
  const startTime = performance.now()

  // Validate input with Zod
  const validated = recommendInputSchema.parse(input)
  let { installed_skills } = validated
  const { project_context, limit, detect_overlap, min_similarity, role } = validated

  // SMI-906: Auto-detect installed skills from ~/.claude/skills/ if not provided
  const autoDetected = installed_skills.length === 0
  if (autoDetected) {
    installed_skills = await getInstalledSkills()
  }

  // SMI-1183: Try API first, fall back to local semantic matching
  if (!context.apiClient.isOffline()) {
    try {
      // Build stack from installed skill names and project context keywords
      const stack = [...installed_skills.map((id) => id.split('/').pop() || id)]
      if (project_context) {
        // Extract key terms from project context (simple word split)
        const contextWords = project_context
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .slice(0, 5)
        stack.push(...contextWords)
      }

      const apiResponse = await context.apiClient.getRecommendations({
        stack: stack.slice(0, 10), // API limits to 10 stack items
        limit,
      })

      const endTime = performance.now()

      // Convert API results to response format
      // SMI-1631: Infer roles and apply role filtering for API results
      let recommendations: SkillRecommendation[] = apiResponse.data.map((skill) => {
        const skillRoles = inferRolesFromTags(skill.tags || [])
        return {
          skill_id: skill.id,
          name: skill.name,
          reason: `Matches your stack: ${stack.slice(0, 3).join(', ')}`,
          similarity_score: 0.8, // API doesn't return similarity score, use default
          trust_tier: mapTrustTierFromDb(skill.trust_tier),
          quality_score: Math.round((skill.quality_score ?? 0.5) * 100),
          roles: skillRoles,
        }
      })

      // SMI-1631: Apply role filtering and score boosting for API results
      let roleFiltered = 0
      if (role) {
        const originalCount = recommendations.length
        recommendations = recommendations.filter((rec) => rec.roles?.includes(role))
        roleFiltered = originalCount - recommendations.length

        // Apply +30 score boost for role matches and re-sort
        recommendations = recommendations.map((rec) => ({
          ...rec,
          quality_score: Math.min(100, rec.quality_score + 30),
          reason: `${rec.reason} (role: ${role})`,
        }))
        recommendations.sort((a, b) => b.quality_score - a.quality_score)
      }

      const response: RecommendResponse = {
        recommendations,
        candidates_considered: apiResponse.data.length,
        overlap_filtered: 0,
        role_filtered: roleFiltered,
        context: {
          installed_count: installed_skills.length,
          has_project_context: !!project_context,
          using_semantic_matching: true,
          auto_detected: autoDetected,
          role_filter: role,
        },
        timing: {
          totalMs: Math.round(endTime - startTime),
        },
      }

      // SMI-1184: Track recommend event (silent on failure)
      if (context.distinctId) {
        trackEvent(context.distinctId, 'skill_recommend', {
          result_count: response.recommendations.length,
          duration_ms: response.timing.totalMs,
          source: 'mcp',
        })
      }

      return response
    } catch (error) {
      // Log and fall through to local semantic matching
      console.warn(
        '[skillsmith] API recommend failed, using local matching:',
        (error as Error).message
      )
    }
  }

  // Fallback: Load skills from database and use local semantic matching
  const skillDatabase = await loadSkillsFromDatabase(context, 500)

  // Initialize matcher with fallback mode for now
  const matcher = new SkillMatcher({
    useFallback: true,
    minSimilarity: min_similarity,
    qualityWeight: 0.3,
  })

  // Get installed skill data
  const installedSkillData = skillDatabase.filter((s) =>
    installed_skills.some((id) => id.toLowerCase() === s.id.toLowerCase())
  )

  // SMI-907: Extract installed skill names for name-based overlap detection
  const installedNames = installed_skills.map((id) => {
    const idName = id.split('/').pop()?.toLowerCase() || ''
    const skillData = installedSkillData.find((s) => s.id.toLowerCase() === id.toLowerCase())
    return {
      idName,
      skillName: skillData?.name.toLowerCase() || idName,
    }
  })

  // Filter out already installed skills AND semantically similar names from candidates
  const candidates = skillDatabase.filter((s) => {
    const skillName = s.name.toLowerCase()
    const skillIdName = s.id.split('/').pop()?.toLowerCase() || ''

    // SMI-1632: Exclude skill collections based on naming patterns
    if (isSkillCollection(skillIdName, s.description)) {
      return false
    }

    // Exclude if exact ID match (case-insensitive)
    if (installed_skills.some((id) => id.toLowerCase() === s.id.toLowerCase())) {
      return false
    }

    // SMI-907: Exclude if name is contained in or contains installed skill name
    for (const installed of installedNames) {
      const { idName, skillName: installedSkillName } = installed
      if (!idName && !installedSkillName) continue

      if (
        (installedSkillName && skillName.includes(installedSkillName)) ||
        (installedSkillName && installedSkillName.includes(skillName)) ||
        (idName && skillIdName.includes(idName)) ||
        (idName && idName.includes(skillIdName))
      ) {
        return false
      }
    }

    return true
  })

  let overlapFiltered = 0
  let roleFiltered = 0

  // Apply overlap detection if enabled and there are installed skills
  let filteredCandidates = candidates
  if (detect_overlap && installedSkillData.length > 0) {
    const overlapDetector = new OverlapDetector({
      useFallback: true,
      overlapThreshold: 0.6,
      phraseThreshold: 0.75,
    })

    const filterResult = await overlapDetector.filterByOverlap(candidates, installedSkillData)

    filteredCandidates = filterResult.accepted as SkillData[]
    overlapFiltered = filterResult.rejected.length

    overlapDetector.close()
  }

  // SMI-1631: Apply role-based filtering if role is specified
  if (role) {
    const beforeRoleFilter = filteredCandidates.length
    filteredCandidates = filteredCandidates.filter((s) => s.roles.includes(role))
    roleFiltered = beforeRoleFilter - filteredCandidates.length
  }

  // Build query from installed skills and project context
  let query = ''
  if (installedSkillData.length > 0) {
    query = installedSkillData
      .map((s) => `${s.name} ${s.description} ${s.keywords?.join(' ') || ''}`)
      .join(' ')
  }
  if (project_context) {
    query = query ? `${query} ${project_context}` : project_context
  }
  if (!query) {
    query = 'general development productivity tools'
  }

  // Find similar skills using semantic matching
  const matchResults = await matcher.findSimilarSkills(query, filteredCandidates, limit)

  // Transform to response format
  // SMI-1631: Include roles and apply +30 score boost for role matches
  const recommendations: SkillRecommendation[] = matchResults.map((result) => {
    const skill = result.skill as SkillData
    const hasRoleMatch = role && skill.roles.includes(role)
    const boostedScore = hasRoleMatch
      ? Math.min(100, (skill.qualityScore ?? 50) + 30)
      : (skill.qualityScore ?? 50)

    return {
      skill_id: skill.id,
      name: skill.name,
      reason: hasRoleMatch ? `${result.matchReason} (role: ${role})` : result.matchReason,
      similarity_score: result.similarityScore,
      trust_tier: skill.trustTier,
      quality_score: boostedScore,
      roles: skill.roles,
    }
  })

  const endTime = performance.now()

  matcher.close()

  const response: RecommendResponse = {
    recommendations,
    candidates_considered: candidates.length,
    overlap_filtered: overlapFiltered,
    role_filtered: roleFiltered,
    context: {
      installed_count: installed_skills.length,
      has_project_context: !!project_context,
      using_semantic_matching: true,
      auto_detected: autoDetected,
      role_filter: role,
    },
    timing: {
      totalMs: Math.round(endTime - startTime),
    },
  }

  // SMI-1184: Track recommend event (silent on failure)
  if (context.distinctId) {
    trackEvent(context.distinctId, 'skill_recommend', {
      result_count: response.recommendations.length,
      duration_ms: response.timing.totalMs,
      source: 'mcp',
    })
  }

  return response
}

/**
 * Format recommendations for terminal display
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
