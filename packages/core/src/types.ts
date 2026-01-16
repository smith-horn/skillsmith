/**
 * Core type definitions for Skillsmith
 */

/**
 * Trust tier levels for skill quality assessment
 * NOTE: Must match database schema (packages/core/src/database/schema.ts)
 */
export type TrustTier =
  | 'verified' // Manually reviewed and verified
  | 'community' // High community ratings
  | 'experimental' // New or beta skills
  | 'unknown' // Not yet assessed

/**
 * Trust tier descriptions for user display
 */
export const TrustTierDescriptions: Record<TrustTier, string> = {
  verified: 'Manually reviewed by the Skillsmith team. High quality and safe to use.',
  community: 'Highly rated by the community. Generally reliable.',
  experimental: 'New or beta skill. Use with caution.',
  unknown: 'Not yet assessed. Review carefully before using.',
}

/**
 * Skill categories
 */
export type SkillCategory =
  | 'development'
  | 'testing'
  | 'documentation'
  | 'devops'
  | 'database'
  | 'security'
  | 'productivity'
  | 'integration'
  | 'ai-ml'
  | 'other'

/**
 * Score breakdown for skill quality assessment
 */
export interface ScoreBreakdown {
  quality: number // Code quality score (0-100)
  popularity: number // Usage/stars score (0-100)
  maintenance: number // Update frequency score (0-100)
  security: number // Security assessment score (0-100)
  documentation: number // Docs quality score (0-100)
}

/**
 * Full skill definition
 */
export interface Skill {
  id: string
  name: string
  description: string
  author: string
  repository?: string
  version?: string
  category: SkillCategory
  trustTier: TrustTier
  score: number // Overall score (0-100)
  scoreBreakdown?: ScoreBreakdown
  tags: string[]
  installCommand?: string
  createdAt: string
  updatedAt: string
}

/**
 * Skill search result (subset of full skill)
 * SMI-1491: Added repository field for transparency about installation source
 */
export interface SkillSearchResult {
  id: string
  name: string
  description: string
  author: string
  category: SkillCategory
  trustTier: TrustTier
  score: number
  /** GitHub repository URL (may be undefined for seed data/metadata-only skills) */
  repository?: string
}

/**
 * Search filters
 */
export interface SearchFilters {
  category?: SkillCategory
  trustTier?: TrustTier
  minScore?: number
}

/**
 * Search response with timing
 */
export interface SearchResponse {
  results: SkillSearchResult[]
  total: number
  query: string
  filters: SearchFilters
  timing: {
    searchMs: number
    totalMs: number
  }
}

/**
 * Get skill response
 */
export interface GetSkillResponse {
  skill: Skill
  installCommand: string
  timing: {
    totalMs: number
  }
}
