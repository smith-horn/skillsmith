/**
 * Core type definitions for Skillsmith
 */

/**
 * Trust tier levels for skill quality assessment
 * NOTE: Database tiers must match database schema (packages/core/src/database/schema.ts)
 * SMI-1809: Added 'local' for local skills from ~/.claude/skills/
 */
export type TrustTier =
  | 'verified' // Manually reviewed and verified
  | 'community' // High community ratings
  | 'experimental' // New or beta skills
  | 'unknown' // Not yet assessed
  | 'local' // SMI-1809: Local skills from ~/.claude/skills/

/**
 * Trust tier descriptions for user display
 */
export const TrustTierDescriptions: Record<TrustTier, string> = {
  verified: 'Manually reviewed by the Skillsmith team. High quality and safe to use.',
  community: 'Highly rated by the community. Generally reliable.',
  experimental: 'New or beta skill. Use with caution.',
  unknown: 'Not yet assessed. Review carefully before using.',
  local: 'Local skill from your ~/.claude/skills/ directory. You control this skill.',
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
 * SMI-825: Security scan summary for display
 */
export interface SecuritySummary {
  /** Whether the skill passed security scan (null = not scanned) */
  passed: boolean | null
  /** Risk score from 0-100 (lower is safer) */
  riskScore: number | null
  /** Number of security findings */
  findingsCount: number
  /** When the skill was last scanned */
  scannedAt: string | null
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
  /** SMI-825: Security scan summary */
  security?: SecuritySummary
  createdAt: string
  updatedAt: string
}

/**
 * Skill search result (subset of full skill)
 * SMI-1491: Added repository field for transparency about installation source
 * SMI-825: Added security summary
 * SMI-1809: Added source field to identify local vs registry skills
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
  /** SMI-825: Security scan summary */
  security?: SecuritySummary
  /** SMI-1809: Source of the skill ('local' for ~/.claude/skills/, 'registry' for API) */
  source?: 'local' | 'registry'
}

/**
 * Search filters
 */
export interface SearchFilters {
  category?: SkillCategory
  trustTier?: TrustTier
  minScore?: number
  /** SMI-825: Only show skills that passed security scan */
  safeOnly?: boolean
  /** SMI-825: Maximum risk score (0-100, lower is safer) */
  maxRiskScore?: number
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
