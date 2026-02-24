/**
 * @fileoverview MCP Skill Recommend Tool for suggesting relevant skills
 * @module @skillsmith/mcp-server/tools/recommend
 * @see SMI-741: Add MCP Tool skill_recommend
 * @see SMI-602: Integrate semantic matching with EmbeddingService
 * @see SMI-604: Add trigger phrase overlap detection
 * @see SMI-1837: Include local skills in recommendations (parallel search)
 * @see SMI-2741: Split to meet 500-line standard
 */

import { SkillMatcher, OverlapDetector, trackEvent } from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { getInstalledSkills } from '../utils/installed-skills.js'
import { mapTrustTierFromDb } from '../utils/validation.js'

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

// SMI-2741: Formatting and deduplication extracted to companion file
import { mergeAndDeduplicateRecommendations } from './recommend.format.js'

// SMI-1837: Import local skill search for parallel querying
import { getLocalIndexer } from './LocalSkillSearch.js'
import type { LocalSkill } from '../indexer/LocalIndexer.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export {
  recommendInputSchema,
  recommendToolSchema,
  type RecommendInput,
  type RecommendResponse,
  type SkillRecommendation,
} from './recommend.types.js'

// Re-export formatting utilities (SMI-2741)
export { formatRecommendations, mergeAndDeduplicateRecommendations } from './recommend.format.js'

/**
 * SMI-1837: Convert a LocalSkill to SkillRecommendation format
 * @param skill - The local skill to convert
 * @param matchReason - Reason for the recommendation
 * @returns SkillRecommendation object
 */
function localSkillToRecommendation(skill: LocalSkill, matchReason: string): SkillRecommendation {
  const roles = inferRolesFromTags(skill.tags)
  return {
    skill_id: skill.id,
    name: skill.name,
    reason: matchReason,
    similarity_score: 0.7, // Local skills get a default similarity score
    trust_tier: 'local',
    quality_score: skill.qualityScore,
    roles,
  }
}

/**
 * SMI-1837: Search local skills for recommendations
 * @param query - Search query based on context and installed skills
 * @param limit - Maximum number of results
 * @returns Array of matching local skills as SkillRecommendation
 */
async function searchLocalSkillsForRecommend(
  query: string,
  limit: number
): Promise<SkillRecommendation[]> {
  try {
    const indexer = getLocalIndexer()
    const localSkills = await indexer.index()

    if (localSkills.length === 0) {
      return []
    }

    // Search local skills using the query
    const matchingSkills = query ? indexer.search(query, localSkills) : localSkills

    // Convert to recommendations and limit
    return matchingSkills
      .slice(0, limit)
      .map((skill) =>
        localSkillToRecommendation(
          skill,
          `Local skill matching: ${query.split(' ').slice(0, 3).join(', ')}`
        )
      )
  } catch (error) {
    // Log and return empty on error - don't break the main flow
    console.warn('[skillsmith] Local skill search for recommend failed:', (error as Error).message)
    return []
  }
}

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

  // Build search query from installed skill names and project context keywords
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

  // Build query string for local skill search
  const localSearchQuery = stack.join(' ') || 'development productivity tools'

  // SMI-1183/SMI-1837: Try API and local skills in parallel
  if (!context.apiClient.isOffline()) {
    try {
      // SMI-1837: Query API and local skills in parallel
      const [apiResultSettled, localResultSettled] = await Promise.allSettled([
        context.apiClient.getRecommendations({
          stack: stack.slice(0, 10), // API limits to 10 stack items
          limit,
        }),
        searchLocalSkillsForRecommend(localSearchQuery, limit),
      ])

      // Extract API results (may have failed)
      let apiRecommendations: SkillRecommendation[] = []
      if (apiResultSettled.status === 'fulfilled') {
        apiRecommendations = apiResultSettled.value.data.map((skill) => {
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
      } else {
        console.warn(
          '[skillsmith] API recommend failed:',
          (apiResultSettled.reason as Error).message
        )
      }

      // Extract local results (may have failed)
      let localRecommendations: SkillRecommendation[] = []
      if (localResultSettled.status === 'fulfilled') {
        localRecommendations = localResultSettled.value
      }

      // SMI-1837: Merge and deduplicate results
      let recommendations = mergeAndDeduplicateRecommendations(
        apiRecommendations,
        localRecommendations,
        limit
      )

      const endTime = performance.now()

      // Filter out already installed skills
      recommendations = recommendations.filter(
        (rec) => !installed_skills.some((id) => id.toLowerCase() === rec.skill_id.toLowerCase())
      )

      // SMI-1631: Apply role filtering and score boosting
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

      // Calculate total candidates considered
      const apiCandidates =
        apiResultSettled.status === 'fulfilled' ? apiResultSettled.value.data.length : 0
      const localCandidates = localRecommendations.length

      const response: RecommendResponse = {
        recommendations: recommendations.slice(0, limit),
        candidates_considered: apiCandidates + localCandidates,
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

  // SMI-1837: Fallback - Load skills from database AND local skills in parallel
  const [skillDatabaseResult, localSkillsResult] = await Promise.allSettled([
    loadSkillsFromDatabase(context, 500),
    searchLocalSkillsForRecommend(localSearchQuery, limit),
  ])

  const skillDatabase = skillDatabaseResult.status === 'fulfilled' ? skillDatabaseResult.value : []
  const localRecommendations =
    localSkillsResult.status === 'fulfilled' ? localSkillsResult.value : []

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

  // Transform database results to response format
  // SMI-1631: Include roles and apply +30 score boost for role matches
  const dbRecommendations: SkillRecommendation[] = matchResults.map((result) => {
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

  // SMI-1837: Merge database and local results
  let recommendations = mergeAndDeduplicateRecommendations(
    dbRecommendations,
    localRecommendations,
    limit
  )

  // Apply role filtering to merged results if not already done
  if (role && localRecommendations.length > 0) {
    const beforeRoleFilter = recommendations.length
    recommendations = recommendations.filter((rec) => rec.roles?.includes(role))
    roleFiltered = beforeRoleFilter - recommendations.length
  }

  const endTime = performance.now()

  matcher.close()

  const response: RecommendResponse = {
    recommendations: recommendations.slice(0, limit),
    candidates_considered: candidates.length + localRecommendations.length,
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
