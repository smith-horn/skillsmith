/**
 * Core type definitions for Skillsmith
 */

/**
 * Trust tier levels for skill quality assessment
 * NOTE: Database tiers must match database schema (packages/core/src/database/schema.ts)
 * SMI-1809: Added 'local' for local skills from ~/.claude/skills/
 * SMI-2381: Added 'curated' for third-party publishers opted into the registry
 * SMI-5205: Added 'official' and 'unverified' to align API wire format with public 5-tier model
 */
export type TrustTier =
  | 'official' // SMI-5205: Platform/partner skills, full security review
  | 'verified' // Manually reviewed and verified
  | 'curated' // SMI-2381: Third-party publisher, manually opted in
  | 'community' // High community ratings
  | 'experimental' // New or beta skills (internal only, not returned by public API)
  | 'unknown' // Not yet assessed (internal only, not returned by public API)
  | 'unverified' // SMI-5205: No verification performed (public alias for unknown)
  | 'local' // SMI-1809: Local skills from ~/.claude/skills/

/**
 * Trust tier descriptions for user display
 */
export const TrustTierDescriptions: Record<TrustTier, string> = {
  official:
    'Official or partner skill with full security review. Maintained by Skillsmith or verified partners.',
  verified: 'Manually reviewed by the Skillsmith team. High quality and safe to use.',
  curated: 'Third-party publisher. Manually opted into the registry.',
  community: 'Highly rated by the community. Generally reliable.',
  experimental: 'New or beta skill. Use with caution.',
  unknown: 'Not yet assessed. Review carefully before using.',
  unverified: 'No verification performed. Review carefully before installing.',
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
  | 'science'
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
  /**
   * SMI-4954: True when the skill has an installable source (registry `repo_url`
   * present). When false/undefined the skill is a discovery-only entry (SMI-2723)
   * and `install_skill` will not resolve it. Always populated by `get_skill`.
   */
  installable?: boolean
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
  /**
   * SMI-5327: SPDX license identifier (e.g. "MIT", "Apache-2.0"). Null means
   * "unknown / not detected" — NOT "no restrictions" or "freely usable".
   */
  license?: string | null
}

/**
 * Skill search result (subset of full skill)
 * SMI-1491: Added repository field for transparency about installation source
 * SMI-825: Added security summary
 * SMI-1809: Added source field to identify local vs registry skills
 * SMI-2734: Added installHint for ergonomic registry ID surfacing in search results
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
  /**
   * SMI-4954: True when the skill is installable (registry `repo_url` present).
   * When false the skill is a discovery-only entry (SMI-2723) and `install_skill`
   * will not resolve it. Always populated by `search`.
   */
  installable?: boolean
  /** SMI-825: Security scan summary */
  security?: SecuritySummary
  /** SMI-1809: Source of the skill ('local' for ~/.claude/skills/, 'registry' for API) */
  source?: 'local' | 'registry'
  /** SMI-2734: Registry install ID in 'author/skill-name' format. Only set for registry skills.
   *  Undefined for local skills since their author field is not a routable registry owner. */
  installHint?: string
  /** SMI-2760: Flat array of compatible IDE/LLM/platform slugs (e.g. ["claude-code", "cursor", "claude"]) */
  compatibility?: string[]
  /**
   * SMI-5327: SPDX license identifier (e.g. "MIT", "Apache-2.0"). Null means
   * "unknown / not detected" — NOT "no restrictions" or "freely usable".
   */
  license?: string | null
}

/**
 * SMI-2760: Compatibility filter for search
 */
export interface CompatibilityFilter {
  /** IDE slugs to match (e.g. ['cursor', 'claude-code']) */
  ides?: string[]
  /** LLM slugs to match (e.g. ['claude', 'gpt-4o']) */
  llms?: string[]
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
  /** SMI-2760: Filter by IDE/LLM compatibility */
  compatibleWith?: CompatibilityFilter
}

/**
 * Search response with timing
 */
export interface SearchResponse {
  results: SkillSearchResult[]
  total: number
  query: string
  filters: SearchFilters
  /**
   * SMI-5178: results on this page hidden by the compatibility filter — the
   * restrictive cross-tool default (explicit SKILLSMITH_CLIENT) or an explicit
   * `compatible_with`. 0 / absent when no compat filter applied. `[]`/unknown
   * rows are never hidden (they always surface).
   */
  compatibilityHidden?: number
  /**
   * SMI-5178: results on this page hidden by the default-ON installable filter.
   * Present when discovery-only entries were filtered out. Pass
   * `installable_only: false` to include them.
   */
  discoveryOnlyHidden?: number
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
  /** SMI-3672: Raw SKILL.md content (markdown), when available */
  content?: string
  timing: {
    totalMs: number
  }
  /** SMI-2761: Skills frequently installed alongside this one (≥5 co-installs) */
  also_installed?: AlsoInstalledSkill[]
  /** SMI-3137: Dependency intelligence data from skill_dependencies table */
  dependencies?: import('./types/dependencies.js').SkillDependencyRow[]
}

/**
 * SMI-2761: Minimal skill summary used in co-install recommendations
 */
export interface AlsoInstalledSkill {
  /** Skill ID (e.g. "anthropic/commit") */
  skillId: string
  /** Human-readable name */
  name: string
  /** Short description */
  description?: string
  /** Author slug */
  author?: string
  /** Co-install count */
  installCount: number
}
