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
 * });
 *
 * @example
 * // Recommendation with project context
 * const results = await executeRecommend({
 *   installed_skills: ['anthropic/commit'],
 *   project_context: 'React frontend with Jest testing',
 *   limit: 10
 * });
 */

import { z } from 'zod'
import { type MCPTrustTier as TrustTier, SkillMatcher, OverlapDetector } from '@skillsmith/core'
import type { ToolContext } from '../context.js'

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
  /** Query context used for matching */
  context: {
    installed_count: number
    has_project_context: boolean
    using_semantic_matching: boolean
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
    'Recommend skills based on currently installed skills and optional project context. Uses semantic similarity to find relevant skills.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      installed_skills: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Currently installed skill IDs (e.g., ["anthropic/commit", "community/jest-helper"])',
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
    },
    required: [],
  },
}

/**
 * Skill database with trigger phrases and keywords for matching
 */
interface SkillData {
  /** Unique skill identifier */
  id: string
  /** Skill display name */
  name: string
  /** Skill description */
  description: string
  /** Trigger phrases for overlap detection */
  triggerPhrases: string[]
  /** Keywords for matching */
  keywords: string[]
  /** Quality score (0-100) */
  qualityScore: number
  /** Trust tier */
  trustTier: TrustTier
}

/**
 * Skill database for recommendations
 * In production, this would be loaded from the database
 */
const skillDatabase: SkillData[] = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages following conventional commits',
    triggerPhrases: ['commit changes', 'create commit', 'git commit', 'write commit message'],
    keywords: ['git', 'commit', 'conventional', 'version-control'],
    qualityScore: 95,
    trustTier: 'verified',
  },
  {
    id: 'anthropic/review-pr',
    name: 'review-pr',
    description: 'Review pull requests with detailed code analysis',
    triggerPhrases: ['review pr', 'review pull request', 'code review', 'check pr'],
    keywords: ['git', 'pull-request', 'code-review', 'quality'],
    qualityScore: 93,
    trustTier: 'verified',
  },
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components',
    triggerPhrases: ['write jest test', 'create test', 'test component', 'jest testing'],
    keywords: ['jest', 'testing', 'react', 'unit-tests', 'frontend'],
    qualityScore: 87,
    trustTier: 'community',
  },
  {
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations',
    triggerPhrases: ['docker compose', 'create docker', 'containerize', 'docker setup'],
    keywords: ['docker', 'devops', 'containers', 'infrastructure'],
    qualityScore: 84,
    trustTier: 'community',
  },
  {
    id: 'community/api-docs',
    name: 'api-docs',
    description: 'Generate OpenAPI documentation from code',
    triggerPhrases: ['generate api docs', 'openapi spec', 'swagger docs', 'document api'],
    keywords: ['api', 'documentation', 'openapi', 'swagger'],
    qualityScore: 78,
    trustTier: 'standard',
  },
  {
    id: 'community/eslint-config',
    name: 'eslint-config',
    description: 'Generate ESLint configurations for TypeScript projects',
    triggerPhrases: ['eslint config', 'setup linting', 'configure eslint', 'lint setup'],
    keywords: ['eslint', 'linting', 'typescript', 'code-quality'],
    qualityScore: 82,
    trustTier: 'community',
  },
  {
    id: 'community/vitest-helper',
    name: 'vitest-helper',
    description: 'Generate Vitest test cases with modern testing patterns',
    triggerPhrases: ['vitest test', 'create vitest', 'write test vitest', 'testing vitest'],
    keywords: ['vitest', 'testing', 'typescript', 'unit-tests'],
    qualityScore: 85,
    trustTier: 'community',
  },
  {
    id: 'community/react-component',
    name: 'react-component',
    description: 'Generate React components with TypeScript and hooks',
    triggerPhrases: ['create component', 'react component', 'new component', 'build component'],
    keywords: ['react', 'component', 'typescript', 'hooks', 'frontend'],
    qualityScore: 86,
    trustTier: 'community',
  },
  {
    id: 'community/github-actions',
    name: 'github-actions',
    description: 'Generate GitHub Actions workflows for CI/CD',
    triggerPhrases: ['github action', 'ci workflow', 'create workflow', 'setup ci'],
    keywords: ['github', 'ci-cd', 'actions', 'automation', 'devops'],
    qualityScore: 88,
    trustTier: 'community',
  },
  {
    id: 'community/prisma-schema',
    name: 'prisma-schema',
    description: 'Generate Prisma schema and migrations for databases',
    triggerPhrases: ['prisma schema', 'database model', 'create migration', 'prisma setup'],
    keywords: ['prisma', 'database', 'orm', 'migrations', 'postgresql'],
    qualityScore: 83,
    trustTier: 'community',
  },
]

/**
 * Execute skill recommendation based on installed skills and context.
 *
 * Uses semantic similarity to find skills that complement the user's
 * current installation. When project context is provided, it's used
 * to improve recommendation relevance. Overlap detection prevents
 * recommending skills that are too similar to installed ones.
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
 * });
 * console.log(response.recommendations[0].reason);
 */
export async function executeRecommend(
  input: RecommendInput,
  _context?: ToolContext
): Promise<RecommendResponse> {
  const startTime = performance.now()

  // Validate input with Zod
  const validated = recommendInputSchema.parse(input)
  const { installed_skills, project_context, limit, detect_overlap, min_similarity } = validated

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

  // Filter out already installed skills from candidates
  const candidates = skillDatabase.filter(
    (s) => !installed_skills.some((id) => id.toLowerCase() === s.id.toLowerCase())
  )

  let overlapFiltered = 0

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
  const recommendations: SkillRecommendation[] = matchResults.map((result) => {
    const skill = result.skill as SkillData
    return {
      skill_id: skill.id,
      name: skill.name,
      reason: result.matchReason,
      similarity_score: result.similarityScore,
      trust_tier: skill.trustTier,
      quality_score: skill.qualityScore ?? 50,
    }
  })

  const endTime = performance.now()

  matcher.close()

  return {
    recommendations,
    candidates_considered: candidates.length,
    overlap_filtered: overlapFiltered,
    context: {
      installed_count: installed_skills.length,
      has_project_context: !!project_context,
      using_semantic_matching: true,
    },
    timing: {
      totalMs: Math.round(endTime - startTime),
    },
  }
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
  } else {
    lines.push(`Found ${response.recommendations.length} recommendation(s):\n`)

    response.recommendations.forEach((rec, index) => {
      const trustBadge = getTrustBadge(rec.trust_tier)
      lines.push(`${index + 1}. ${rec.name} ${trustBadge}`)
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
  lines.push(
    `Semantic matching: ${response.context.using_semantic_matching ? 'enabled' : 'disabled'}`
  )
  lines.push(`Completed in ${response.timing.totalMs}ms`)

  return lines.join('\n')
}

/**
 * Get trust badge for display
 */
function getTrustBadge(tier: TrustTier): string {
  switch (tier) {
    case 'verified':
      return '[VERIFIED]'
    case 'community':
      return '[COMMUNITY]'
    case 'standard':
      return '[STANDARD]'
    case 'unverified':
      return '[UNVERIFIED]'
    default:
      return '[UNKNOWN]'
  }
}
