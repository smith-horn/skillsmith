/**
 * @fileoverview MCP Skill Recommend Tool for suggesting relevant skills
 * @module @skillsmith/mcp-server/tools/recommend
 * @see SMI-741: Add MCP Tool skill_recommend
 *
 * Provides skill recommendations based on:
 * - Currently installed skills (semantic similarity)
 * - Optional project context (semantic matching)
 * - Quality and trust tier filtering
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
import {
  type SkillSearchResult,
  type MCPTrustTier as TrustTier,
  SkillsmithError,
  ErrorCodes,
} from '@skillsmith/core'

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
})

/**
 * Input type (before parsing, allows optional fields)
 */
export type RecommendInput = z.input<typeof recommendInputSchema>

/**
 * Output type (after parsing, with defaults applied)
 */
type RecommendParsed = z.output<typeof recommendInputSchema>

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
  /** Query context used for matching */
  context: {
    installed_count: number
    has_project_context: boolean
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
    },
    required: [],
  },
}

/**
 * Mock skill database for development
 * In production, this would use EmbeddingService for semantic search
 */
const mockSkillDatabase: Array<SkillSearchResult & { keywords: string[] }> = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages following conventional commits',
    author: 'anthropic',
    category: 'development',
    trustTier: 'verified',
    score: 95,
    keywords: ['git', 'commit', 'conventional', 'version-control'],
  },
  {
    id: 'anthropic/review-pr',
    name: 'review-pr',
    description: 'Review pull requests with detailed code analysis',
    author: 'anthropic',
    category: 'development',
    trustTier: 'verified',
    score: 93,
    keywords: ['git', 'pull-request', 'code-review', 'quality'],
  },
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components',
    author: 'community',
    category: 'testing',
    trustTier: 'community',
    score: 87,
    keywords: ['jest', 'testing', 'react', 'unit-tests', 'frontend'],
  },
  {
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations',
    author: 'community',
    category: 'devops',
    trustTier: 'community',
    score: 84,
    keywords: ['docker', 'devops', 'containers', 'infrastructure'],
  },
  {
    id: 'community/api-docs',
    name: 'api-docs',
    description: 'Generate OpenAPI documentation from code',
    author: 'community',
    category: 'documentation',
    trustTier: 'standard',
    score: 78,
    keywords: ['api', 'documentation', 'openapi', 'swagger'],
  },
  {
    id: 'community/eslint-config',
    name: 'eslint-config',
    description: 'Generate ESLint configurations for TypeScript projects',
    author: 'community',
    category: 'development',
    trustTier: 'community',
    score: 82,
    keywords: ['eslint', 'linting', 'typescript', 'code-quality'],
  },
  {
    id: 'community/vitest-helper',
    name: 'vitest-helper',
    description: 'Generate Vitest test cases with modern testing patterns',
    author: 'community',
    category: 'testing',
    trustTier: 'community',
    score: 85,
    keywords: ['vitest', 'testing', 'typescript', 'unit-tests'],
  },
  {
    id: 'community/react-component',
    name: 'react-component',
    description: 'Generate React components with TypeScript and hooks',
    author: 'community',
    category: 'development',
    trustTier: 'community',
    score: 86,
    keywords: ['react', 'component', 'typescript', 'hooks', 'frontend'],
  },
  {
    id: 'community/github-actions',
    name: 'github-actions',
    description: 'Generate GitHub Actions workflows for CI/CD',
    author: 'community',
    category: 'devops',
    trustTier: 'community',
    score: 88,
    keywords: ['github', 'ci-cd', 'actions', 'automation', 'devops'],
  },
  {
    id: 'community/prisma-schema',
    name: 'prisma-schema',
    description: 'Generate Prisma schema and migrations for databases',
    author: 'community',
    category: 'database',
    trustTier: 'community',
    score: 83,
    keywords: ['prisma', 'database', 'orm', 'migrations', 'postgresql'],
  },
]

/**
 * Calculate keyword similarity between two sets of keywords
 * Simple Jaccard similarity for mock implementation
 * Production would use EmbeddingService for semantic similarity
 */
function calculateKeywordSimilarity(keywords1: string[], keywords2: string[]): number {
  if (keywords1.length === 0 || keywords2.length === 0) {
    return 0
  }

  const set1 = new Set(keywords1.map((k) => k.toLowerCase()))
  const set2 = new Set(keywords2.map((k) => k.toLowerCase()))

  let intersection = 0
  for (const k of set1) {
    if (set2.has(k)) {
      intersection++
    }
  }

  const union = new Set([...set1, ...set2]).size
  return union > 0 ? intersection / union : 0
}

/**
 * Calculate text similarity using simple word overlap
 * Production would use EmbeddingService for semantic similarity
 */
function calculateTextSimilarity(text1: string, text2: string): number {
  const words1 = text1
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
  const words2 = text2
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)

  return calculateKeywordSimilarity(words1, words2)
}

/**
 * Generate recommendation reason based on similarity factors
 */
function generateReason(
  skill: (typeof mockSkillDatabase)[0],
  installedKeywords: string[],
  projectContext?: string
): string {
  const reasons: string[] = []

  // Check for keyword matches
  const matchingKeywords = skill.keywords.filter((k) =>
    installedKeywords.some((ik) => ik.toLowerCase() === k.toLowerCase())
  )

  if (matchingKeywords.length > 0) {
    reasons.push(`Complements your ${matchingKeywords.slice(0, 2).join(' and ')} skills`)
  }

  // Check category relevance
  if (projectContext) {
    const contextLower = projectContext.toLowerCase()
    if (contextLower.includes('react') && skill.keywords.includes('react')) {
      reasons.push('Matches your React project')
    }
    if (contextLower.includes('test') && skill.category === 'testing') {
      reasons.push('Supports your testing needs')
    }
    if (contextLower.includes('docker') && skill.keywords.includes('docker')) {
      reasons.push('Helps with containerization')
    }
    if (contextLower.includes('api') && skill.keywords.includes('api')) {
      reasons.push('Useful for API development')
    }
  }

  // Default reasons by category
  if (reasons.length === 0) {
    switch (skill.category) {
      case 'testing':
        reasons.push('Adds testing capabilities to your toolkit')
        break
      case 'devops':
        reasons.push('Enhances your DevOps workflow')
        break
      case 'documentation':
        reasons.push('Improves documentation coverage')
        break
      case 'development':
        reasons.push('Boosts development productivity')
        break
      default:
        reasons.push(`High-quality ${skill.category} skill`)
    }
  }

  return reasons[0]
}

/**
 * Execute skill recommendation based on installed skills and context.
 *
 * Uses semantic similarity to find skills that complement the user's
 * current installation. When project context is provided, it's used
 * to improve recommendation relevance.
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
export async function executeRecommend(input: RecommendInput): Promise<RecommendResponse> {
  const startTime = performance.now()

  // Validate input with Zod
  const validated = recommendInputSchema.parse(input)
  const { installed_skills, project_context, limit } = validated

  // Get keywords from installed skills
  const installedSkillData = mockSkillDatabase.filter((s) =>
    installed_skills.some((id) => id.toLowerCase() === s.id.toLowerCase())
  )
  const installedKeywords = installedSkillData.flatMap((s) => s.keywords)

  // Filter out already installed skills
  const candidates = mockSkillDatabase.filter(
    (s) => !installed_skills.some((id) => id.toLowerCase() === s.id.toLowerCase())
  )

  // Score each candidate
  const scored = candidates.map((skill) => {
    let similarity = 0

    // Calculate keyword similarity with installed skills
    if (installedKeywords.length > 0) {
      similarity = calculateKeywordSimilarity(skill.keywords, installedKeywords)
    }

    // Boost similarity if project context matches
    if (project_context) {
      const contextSimilarity = calculateTextSimilarity(
        project_context,
        `${skill.name} ${skill.description} ${skill.keywords.join(' ')}`
      )
      similarity = Math.max(similarity, contextSimilarity)
      // Blend both scores
      similarity = similarity * 0.6 + contextSimilarity * 0.4
    }

    // Boost by quality score (normalized)
    const qualityBoost = skill.score / 200 // 0 to 0.5 boost
    similarity = Math.min(1, similarity + qualityBoost)

    return {
      skill,
      similarity,
    }
  })

  // Sort by similarity score
  scored.sort((a, b) => b.similarity - a.similarity)

  // Take top N recommendations
  const topRecommendations = scored.slice(0, limit)

  // Build response
  const recommendations: SkillRecommendation[] = topRecommendations.map(
    ({ skill, similarity }) => ({
      skill_id: skill.id,
      name: skill.name,
      reason: generateReason(skill, installedKeywords, project_context),
      similarity_score: Math.round(similarity * 100) / 100, // Round to 2 decimals
      trust_tier: skill.trustTier,
      quality_score: skill.score,
    })
  )

  const endTime = performance.now()

  return {
    recommendations,
    candidates_considered: candidates.length,
    context: {
      installed_count: installed_skills.length,
      has_project_context: !!project_context,
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
