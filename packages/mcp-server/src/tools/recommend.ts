/**
 * @fileoverview MCP Skill Recommend Tool for suggesting relevant skills
 * @module @skillsmith/mcp-server/tools/recommend
 * @see SMI-741: Add MCP Tool skill_recommend
 * @see SMI-602: Integrate semantic matching with EmbeddingService
 * @see SMI-604: Add trigger phrase overlap detection
 *
 * Provides skill recommendations based on:
 * - Currently installed skills (semantic similarity)
 * - Optional project context (semantic matching)
 * - Codebase analysis (framework detection)
 * - Overlap detection (avoid similar skills)
 *
 * @example
 * // Basic recommendation
 * const results = await executeRecommend({
 *   installed_skills: ['anthropic/commit'],
 *   limit: 5
 * }, toolContext);
 *
 * @example
 * // Recommendation with project context
 * const results = await executeRecommend({
 *   installed_skills: ['anthropic/commit'],
 *   project_context: 'React frontend with Jest testing',
 *   limit: 10
 * }, toolContext);
 */

import { z } from 'zod'
import {
  type MCPTrustTier as TrustTier,
  type SkillRole,
  SKILL_ROLES,
  SkillMatcher,
  OverlapDetector,
  trackEvent,
} from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { getInstalledSkills } from '../utils/installed-skills.js'
import { mapTrustTierFromDb, getTrustBadge } from '../utils/validation.js'

/**
 * SMI-1631: Type-safe Zod schema for skill roles
 */
const skillRoleSchema = z.enum([
  'code-quality',
  'testing',
  'documentation',
  'workflow',
  'security',
  'development-partner',
] as const)

/**
 * Zod schema for recommend tool input validation
 */
export const recommendInputSchema = z.object({
  /** Currently installed skill IDs */
  installed_skills: z.array(z.string()).min(0).default([]),
  /** Optional project description for context-aware recommendations */
  project_context: z.string().optional(),
  /** Maximum recommendations to return (default 5) */
  limit: z.number().min(1).max(50).default(5),
  /** Enable overlap detection (default true) */
  detect_overlap: z.boolean().default(true),
  /** Minimum similarity threshold (0-1, default 0.3) */
  min_similarity: z.number().min(0).max(1).default(0.3),
  /** SMI-1631: Filter by skill role for targeted recommendations */
  role: skillRoleSchema.optional(),
})

/**
 * Input type (before parsing, allows optional fields)
 */
export type RecommendInput = z.input<typeof recommendInputSchema>

/**
 * Individual skill recommendation with reasoning
 */
export interface SkillRecommendation {
  /** Skill identifier */
  skill_id: string
  /** Skill name */
  name: string
  /** Why this skill is recommended */
  reason: string
  /** Semantic similarity score (0-1) */
  similarity_score: number
  /** Trust tier for user confidence */
  trust_tier: TrustTier
  /** Overall quality score */
  quality_score: number
  /** SMI-1631: Skill roles for role-based filtering */
  roles?: SkillRole[]
}

/**
 * Recommendation response with timing info
 */
export interface RecommendResponse {
  /** List of recommended skills */
  recommendations: SkillRecommendation[]
  /** Total candidates considered */
  candidates_considered: number
  /** Skills filtered due to overlap */
  overlap_filtered: number
  /** SMI-1631: Skills filtered due to role mismatch */
  role_filtered: number
  /** Query context used for matching */
  context: {
    installed_count: number
    has_project_context: boolean
    using_semantic_matching: boolean
    /** SMI-906: Whether installed skills were auto-detected from ~/.claude/skills/ */
    auto_detected: boolean
    /** SMI-1631: Role filter applied */
    role_filter?: SkillRole
  }
  /** Performance timing */
  timing: {
    totalMs: number
  }
}

/**
 * MCP tool schema definition for skill_recommend
 */
export const recommendToolSchema = {
  name: 'skill_recommend',
  description:
    'Recommend skills based on currently installed skills and optional project context. Uses semantic similarity to find relevant skills. Auto-detects installed skills from ~/.claude/skills/ if not provided. SMI-1631: Supports role-based filtering for targeted recommendations.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      installed_skills: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Currently installed skill IDs (e.g., ["anthropic/commit", "community/jest-helper"]). If empty, auto-detects from ~/.claude/skills/',
      },
      project_context: {
        type: 'string',
        description:
          'Optional project description for context-aware recommendations (e.g., "React frontend with Jest testing")',
      },
      limit: {
        type: 'number',
        description: 'Maximum recommendations to return (default 5, max 50)',
        minimum: 1,
        maximum: 50,
        default: 5,
      },
      detect_overlap: {
        type: 'boolean',
        description: 'Enable overlap detection to filter similar skills (default true)',
        default: true,
      },
      min_similarity: {
        type: 'number',
        description: 'Minimum similarity threshold (0-1, default 0.3)',
        minimum: 0,
        maximum: 1,
        default: 0.3,
      },
      role: {
        type: 'string',
        enum: [...SKILL_ROLES],
        description:
          'SMI-1631: Filter by skill role (code-quality, testing, documentation, workflow, security, development-partner). Skills matching the role get a +30 score boost.',
      },
    },
    required: [],
  },
}

/**
 * Skill data format for matching operations
 * Transformed from database Skill records
 */
interface SkillData {
  /** Unique skill identifier */
  id: string
  /** Skill display name */
  name: string
  /** Skill description */
  description: string
  /** Trigger phrases for overlap detection (derived from tags) */
  triggerPhrases: string[]
  /** Keywords for matching (from tags) */
  keywords: string[]
  /** Quality score (0-100) */
  qualityScore: number
  /** Trust tier */
  trustTier: TrustTier
  /** SMI-1631: Skill roles for role-based filtering */
  roles: SkillRole[]
}

/**
 * SMI-1631: Infer skill roles from tags when not explicitly set
 * Maps common tags to skill roles for better filtering
 */
function inferRolesFromTags(tags: string[]): SkillRole[] {
  const roleMapping: Record<string, SkillRole> = {
    // Code quality
    lint: 'code-quality',
    linting: 'code-quality',
    format: 'code-quality',
    formatting: 'code-quality',
    prettier: 'code-quality',
    eslint: 'code-quality',
    'code-review': 'code-quality',
    review: 'code-quality',
    refactor: 'code-quality',
    refactoring: 'code-quality',
    'code-style': 'code-quality',
    // Testing
    test: 'testing',
    testing: 'testing',
    jest: 'testing',
    vitest: 'testing',
    mocha: 'testing',
    playwright: 'testing',
    cypress: 'testing',
    e2e: 'testing',
    unit: 'testing',
    integration: 'testing',
    tdd: 'testing',
    // Documentation
    docs: 'documentation',
    documentation: 'documentation',
    readme: 'documentation',
    jsdoc: 'documentation',
    typedoc: 'documentation',
    changelog: 'documentation',
    api: 'documentation',
    // Workflow
    git: 'workflow',
    commit: 'workflow',
    pr: 'workflow',
    'pull-request': 'workflow',
    ci: 'workflow',
    cd: 'workflow',
    'ci-cd': 'workflow',
    deploy: 'workflow',
    deployment: 'workflow',
    automation: 'workflow',
    workflow: 'workflow',
    // Security
    security: 'security',
    audit: 'security',
    vulnerability: 'security',
    cve: 'security',
    secrets: 'security',
    authentication: 'security',
    auth: 'security',
    // Development partner
    ai: 'development-partner',
    assistant: 'development-partner',
    helper: 'development-partner',
    copilot: 'development-partner',
    productivity: 'development-partner',
    scaffold: 'development-partner',
    generator: 'development-partner',
  }

  const inferredRoles = new Set<SkillRole>()
  for (const tag of tags) {
    const normalizedTag = tag.toLowerCase().replace(/[-_]/g, '')
    for (const [keyword, role] of Object.entries(roleMapping)) {
      if (normalizedTag.includes(keyword.replace(/[-_]/g, ''))) {
        inferredRoles.add(role)
      }
    }
  }

  return [...inferredRoles]
}

/**
 * Transform a database skill to SkillData format for matching
 */
function transformSkillToMatchData(skill: {
  id: string
  name: string
  description: string | null
  tags: string[]
  qualityScore: number | null
  trustTier: string
  roles?: SkillRole[]
}): SkillData {
  // Generate trigger phrases from name and first few tags
  const triggerPhrases = [
    skill.name,
    `use ${skill.name}`,
    `${skill.name} help`,
    ...skill.tags.slice(0, 3).map((tag) => `${tag} ${skill.name}`),
  ]

  // SMI-1631: Use explicit roles or infer from tags
  const roles = skill.roles?.length ? skill.roles : inferRolesFromTags(skill.tags)

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description || '',
    triggerPhrases,
    keywords: skill.tags,
    qualityScore: Math.round((skill.qualityScore ?? 0.5) * 100),
    trustTier: mapTrustTierFromDb(skill.trustTier),
    roles,
  }
}

/**
 * Load skills from database via ToolContext
 * Returns skills transformed to SkillData format for matching
 */
async function loadSkillsFromDatabase(
  context: ToolContext,
  limit: number = 500
): Promise<SkillData[]> {
  const result = context.skillRepository.findAll(limit, 0)
  return result.items.map(transformSkillToMatchData)
}

/**
 * Execute skill recommendation based on installed skills and context.
 *
 * SMI-1183: Uses API as primary source with local fallback.
 * - Tries live API first (api.skillsmith.app)
 * - Falls back to local semantic matching if API is offline or fails
 *
 * @param input - Recommendation parameters
 * @returns Promise resolving to recommendation response
 * @throws {SkillsmithError} When validation fails
 *
 * @example
 * const response = await executeRecommend({
 *   installed_skills: ['anthropic/commit'],
 *   project_context: 'React TypeScript frontend',
 *   limit: 5
 * }, toolContext);
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
        // Filter to only skills with matching role
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
  // Use 500 as default to balance coverage vs performance
  const skillDatabase = await loadSkillsFromDatabase(context, 500)

  // Initialize matcher with fallback mode for now (real embeddings in production)
  const matcher = new SkillMatcher({
    useFallback: true, // Use mock embeddings for consistent behavior
    minSimilarity: min_similarity,
    qualityWeight: 0.3,
  })

  // Get installed skill data
  const installedSkillData = skillDatabase.filter((s) =>
    installed_skills.some((id) => id.toLowerCase() === s.id.toLowerCase())
  )

  // SMI-907: Extract installed skill names for name-based overlap detection
  // This filters skills with semantically similar names (e.g., "docker" filters "docker-compose")
  const installedNames = installed_skills.map((id) => {
    // Extract the skill name from the ID (e.g., "community/docker" -> "docker")
    const idName = id.split('/').pop()?.toLowerCase() || ''
    // Also check if any installed skill data has a matching name
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

    // Exclude if exact ID match (case-insensitive)
    if (installed_skills.some((id) => id.toLowerCase() === s.id.toLowerCase())) {
      return false
    }

    // SMI-907: Exclude if name is contained in or contains installed skill name
    // This prevents recommending "docker-compose" when "docker" is installed
    for (const installed of installedNames) {
      const { idName, skillName: installedSkillName } = installed
      if (!idName && !installedSkillName) continue

      // Check name containment both ways
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
