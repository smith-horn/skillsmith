/**
 * SMI-1299: CLI Recommend Command Types
 * @module @skillsmith/cli/commands/recommend.types
 */

import type { TrustTier, SkillRole } from '@skillsmith/core'

/**
 * Valid trust tier values
 */
export const VALID_TRUST_TIERS: readonly TrustTier[] = [
  'verified',
  'community',
  'experimental',
  'unknown',
] as const

/**
 * Skill recommendation from API
 */
export interface SkillRecommendation {
  skill_id: string
  name: string
  reason: string
  similarity_score: number
  trust_tier: TrustTier
  quality_score: number
  /** SMI-1631: Skill roles for role-based filtering */
  roles?: SkillRole[]
}

/**
 * Recommendation response
 */
export interface RecommendResponse {
  recommendations: SkillRecommendation[]
  candidates_considered: number
  overlap_filtered: number
  /** SMI-1631: Skills filtered due to role mismatch */
  role_filtered: number
  context: {
    installed_count: number
    has_project_context: boolean
    using_semantic_matching: boolean
    auto_detected: boolean
    /** SMI-1631: Role filter applied */
    role_filter?: SkillRole
  }
  timing: {
    totalMs: number
  }
}

/**
 * Installed skill metadata (SMI-1358)
 */
export interface InstalledSkill {
  name: string
  directory: string
  tags: string[]
  category: string | null
}

/**
 * Recommend command options
 */
export interface RecommendOptions {
  limit: number
  json: boolean
  context: string | undefined
  installed: string[] | undefined
  noOverlap: boolean
  maxFiles: number
  /** SMI-1631: Filter by skill role */
  role: SkillRole | undefined
}
