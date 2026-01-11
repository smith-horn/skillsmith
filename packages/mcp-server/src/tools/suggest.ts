/**
 * @fileoverview MCP Skill Suggest Tool for proactive skill recommendations
 * @module @skillsmith/mcp-server/tools/suggest
 * @see Phase 4: Trigger System Architecture
 *
 * Provides proactive skill suggestions based on user context including:
 * - Current file being edited
 * - Recent terminal commands
 * - Error messages
 * - Project structure analysis
 *
 * Features:
 * - Rate limiting (max 1 suggestion per 5 minutes per session)
 * - Context scoring to filter low-relevance suggestions
 * - Integration with CodebaseAnalyzer
 * - Semantic skill matching
 *
 * @example
 * // Client calls suggest when user is working
 * const result = await executeSuggest({
 *   project_path: '/path/to/project',
 *   current_file: 'src/App.test.tsx',
 *   recent_commands: ['npm test'],
 *   installed_skills: ['anthropic/commit']
 * }, toolContext);
 */

import { z } from 'zod'
import { TriggerDetector, ContextScorer } from '@skillsmith/core'
import { CodebaseAnalyzer } from '@skillsmith/core'
import { SkillMatcher } from '@skillsmith/core'
import { RateLimiter } from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import type { MCPTrustTier as TrustTier } from '@skillsmith/core'
import { mapTrustTierFromDb, getTrustBadge } from '../utils/validation.js'

/**
 * Zod schema for suggest tool input validation
 */
export const suggestInputSchema = z.object({
  /** Root path of the project */
  project_path: z.string().min(1),
  /** Current file being edited (optional) */
  current_file: z.string().optional(),
  /** Recent terminal commands (last 5) */
  recent_commands: z.array(z.string()).max(10).default([]),
  /** Recent error message if any */
  error_message: z.string().optional(),
  /** Currently installed skill IDs */
  installed_skills: z.array(z.string()).default([]),
  /** Maximum suggestions to return (default 3) */
  limit: z.number().min(1).max(10).default(3),
  /** Session ID for rate limiting */
  session_id: z.string().default('default'),
})

/**
 * Input type (before parsing)
 */
export type SuggestInput = z.input<typeof suggestInputSchema>

/**
 * Individual skill suggestion
 */
export interface SkillSuggestion {
  /** Skill identifier */
  skill_id: string
  /** Skill name */
  name: string
  /** Why this skill is being suggested */
  reason: string
  /** Confidence in this suggestion (0-1) */
  confidence: number
  /** Trigger types that fired */
  trigger_types: string[]
  /** Trust tier */
  trust_tier: TrustTier
  /** Quality score */
  quality_score: number
}

/**
 * Suggest response with metadata
 */
export interface SuggestResponse {
  /** List of suggested skills */
  suggestions: SkillSuggestion[]
  /** Overall context relevance score (0-1) */
  context_score: number
  /** Whether request was rate limited */
  rate_limited: boolean
  /** When next suggestion is allowed (ISO timestamp) */
  next_suggestion_at?: string
  /** Which triggers fired */
  triggers_fired: string[]
  /** Performance timing */
  timing: {
    totalMs: number
    analysisMs?: number
    matchingMs?: number
  }
}

/**
 * MCP tool schema definition for skill_suggest
 */
export const suggestToolSchema = {
  name: 'skill_suggest',
  description:
    'Proactively suggest relevant skills based on current context (files, commands, errors, project structure). Rate-limited to max 1 per 5 minutes per session.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_path: {
        type: 'string',
        description: 'Root path of the project to analyze',
      },
      current_file: {
        type: 'string',
        description: 'Current file being edited (e.g., "src/App.test.tsx")',
      },
      recent_commands: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recent terminal commands (last 5, e.g., ["npm test", "git commit"])',
      },
      error_message: {
        type: 'string',
        description: 'Recent error message if any',
      },
      installed_skills: {
        type: 'array',
        items: { type: 'string' },
        description: 'Currently installed skill IDs (for filtering)',
      },
      limit: {
        type: 'number',
        description: 'Maximum suggestions to return (default 3, max 10)',
        minimum: 1,
        maximum: 10,
        default: 3,
      },
      session_id: {
        type: 'string',
        description: 'Session ID for rate limiting (default: "default")',
        default: 'default',
      },
    },
    required: ['project_path'],
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
  /** Trigger phrases for matching (derived from tags) */
  triggerPhrases: string[]
  /** Keywords for matching (from tags) */
  keywords: string[]
  /** Quality score (0-100) */
  qualityScore: number
  /** Trust tier */
  trustTier: TrustTier
  /** Categories for filtering (from tags) */
  categories: string[]
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
}): SkillData {
  // Generate trigger phrases from name and first few tags
  const triggerPhrases = [
    skill.name,
    `use ${skill.name}`,
    `${skill.name} help`,
    ...skill.tags.slice(0, 3).map((tag) => `${tag} ${skill.name}`),
  ]

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description || '',
    triggerPhrases,
    keywords: skill.tags,
    qualityScore: Math.round((skill.qualityScore ?? 0.5) * 100),
    trustTier: mapTrustTierFromDb(skill.trustTier),
    // Use tags as categories for filtering
    categories: skill.tags,
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

// Rate limiter instance (singleton)
let rateLimiter: RateLimiter | null = null

/**
 * Get or create the rate limiter
 */
function getRateLimiter(): RateLimiter {
  if (!rateLimiter) {
    // Use STRICT preset: 10 requests per minute = ~1 per 6 seconds
    // For suggestions, we want max 1 per 5 minutes, so we'll use custom config
    rateLimiter = new RateLimiter({
      maxTokens: 1, // Only 1 suggestion at a time
      refillRate: 1 / 300, // 1 token per 300 seconds (5 minutes)
      windowMs: 300000, // 5 minute window
      keyPrefix: 'suggest',
      failMode: 'open', // Allow on errors (graceful degradation)
    })
  }
  return rateLimiter
}

/**
 * Execute skill suggestion based on context.
 *
 * @param input - Suggestion parameters
 * @param context - Tool context with database access
 * @returns Promise resolving to suggestion response
 *
 * @example
 * const response = await executeSuggest({
 *   project_path: '/path/to/project',
 *   current_file: 'src/App.test.tsx',
 *   recent_commands: ['npm test'],
 *   installed_skills: ['anthropic/commit'],
 *   limit: 3
 * }, toolContext);
 */
export async function executeSuggest(
  input: SuggestInput,
  context: ToolContext
): Promise<SuggestResponse> {
  const startTime = performance.now()

  // Validate input
  const validated = suggestInputSchema.parse(input)
  const {
    project_path,
    current_file,
    recent_commands,
    error_message,
    installed_skills,
    limit,
    session_id,
  } = validated

  // Check rate limit
  const limiter = getRateLimiter()
  const rateLimitResult = await limiter.checkLimit(session_id)

  if (!rateLimitResult.allowed) {
    return {
      suggestions: [],
      context_score: 0,
      rate_limited: true,
      next_suggestion_at: rateLimitResult.resetAt,
      triggers_fired: [],
      timing: {
        totalMs: Math.round(performance.now() - startTime),
      },
    }
  }

  const analysisStart = performance.now()

  // Analyze codebase (with timeout and caching)
  let codebaseContext = null
  try {
    const analyzer = new CodebaseAnalyzer()
    codebaseContext = await analyzer.analyze(project_path, {
      maxFiles: 500,
      includeDevDeps: true,
    })
  } catch (error) {
    // Log error but continue with trigger detection
    console.warn('CodebaseAnalyzer failed:', error)
  }

  const analysisMs = Math.round(performance.now() - analysisStart)

  // Detect triggers
  const detector = new TriggerDetector()
  const triggers = detector.detectTriggers(codebaseContext, {
    currentFile: current_file,
    recentCommands: recent_commands,
    errorMessage: error_message,
    minConfidence: 0.5,
  })

  // Score context
  const scorer = new ContextScorer()
  const contextScore = scorer.scoreContext(triggers, codebaseContext)

  // Check if we should suggest
  if (!scorer.shouldSuggest(contextScore)) {
    return {
      suggestions: [],
      context_score: contextScore.score,
      rate_limited: false,
      triggers_fired: contextScore.triggers,
      timing: {
        totalMs: Math.round(performance.now() - startTime),
        analysisMs,
      },
    }
  }

  const matchingStart = performance.now()

  // Load skills from database
  const skillDatabase = await loadSkillsFromDatabase(context, 500)

  // Filter skills by detected categories
  const relevantCategories = new Set(contextScore.recommendedCategories)
  const candidateSkills = skillDatabase.filter((skill) => {
    // Skip already installed skills
    if (installed_skills.some((id) => id.toLowerCase() === skill.id.toLowerCase())) {
      return false
    }

    // Check if skill matches any detected category
    return skill.categories.some((cat) => relevantCategories.has(cat))
  })

  // Use SkillMatcher for semantic ranking
  const matcher = new SkillMatcher({
    useFallback: true,
    minSimilarity: 0.3,
    qualityWeight: 0.3,
  })

  // Build query from triggered categories
  const query = contextScore.recommendedCategories.join(' ')
  const matchResults = await matcher.findSimilarSkills(query, candidateSkills, limit)

  const matchingMs = Math.round(performance.now() - matchingStart)

  // Transform to response format
  const suggestions: SkillSuggestion[] = matchResults.map((result) => {
    const skill = result.skill as SkillData
    return {
      skill_id: skill.id,
      name: skill.name,
      reason: result.matchReason,
      confidence: contextScore.confidence,
      trigger_types: contextScore.triggers,
      trust_tier: skill.trustTier,
      quality_score: skill.qualityScore,
    }
  })

  matcher.close()

  const totalMs = Math.round(performance.now() - startTime)

  return {
    suggestions,
    context_score: contextScore.score,
    rate_limited: false,
    triggers_fired: contextScore.triggers,
    timing: {
      totalMs,
      analysisMs,
      matchingMs,
    },
  }
}

/**
 * Format suggestions for terminal display
 */
export function formatSuggestions(response: SuggestResponse): string {
  const lines: string[] = []

  lines.push('\n=== Skill Suggestions ===\n')

  if (response.rate_limited) {
    lines.push('Rate limited. Please wait before requesting more suggestions.')
    if (response.next_suggestion_at) {
      lines.push(`Next suggestion available at: ${response.next_suggestion_at}`)
    }
    return lines.join('\n')
  }

  if (response.suggestions.length === 0) {
    lines.push('No relevant suggestions at this time.')
    lines.push('')
    lines.push(`Context score: ${Math.round(response.context_score * 100)}%`)
    lines.push(`Triggers: ${response.triggers_fired.join(', ') || 'none'}`)
    return lines.join('\n')
  }

  lines.push(`Found ${response.suggestions.length} suggestion(s):\n`)

  response.suggestions.forEach((sug, index) => {
    const trustBadge = getTrustBadge(sug.trust_tier)
    lines.push(`${index + 1}. ${sug.name} ${trustBadge}`)
    lines.push(`   Confidence: ${Math.round(sug.confidence * 100)}%`)
    lines.push(`   ${sug.reason}`)
    lines.push(`   Triggers: ${sug.trigger_types.join(', ')}`)
    lines.push(`   ID: ${sug.skill_id}`)
    lines.push('')
  })

  lines.push('---')
  lines.push(`Context score: ${Math.round(response.context_score * 100)}%`)
  lines.push(`Triggers fired: ${response.triggers_fired.join(', ')}`)
  lines.push(`Completed in ${response.timing.totalMs}ms`)

  return lines.join('\n')
}
