/**
 * Core type definitions for Skillsmith skills
 */

import type { DependencyDeclaration } from './dependencies.js'

/**
 * SMI-1809: Added 'local' for local skills from ~/.claude/skills/
 * SMI-4665: 'local' is now a first-class DB-backed tier — the skills.trust_tier
 *   CHECK constraint allows 'local' (migration v16) so filesystem-imported skills
 *   surface distinctly in search rather than being conflated with 'unknown'.
 *
 * Note: 'curated' is reserved on the type but not yet in the DB CHECK
 * (separate roadmap item — promotes high-quality community skills).
 */
export type TrustTier = 'verified' | 'curated' | 'community' | 'experimental' | 'unknown' | 'local'

/**
 * SMI-1631: Skill roles for role-based recommendations
 * Used to filter and prioritize skills based on their primary purpose
 */
export type SkillRole =
  | 'code-quality'
  | 'testing'
  | 'documentation'
  | 'workflow'
  | 'security'
  | 'development-partner'

/**
 * Valid skill roles array for validation
 */
export const SKILL_ROLES: readonly SkillRole[] = [
  'code-quality',
  'testing',
  'documentation',
  'workflow',
  'security',
  'development-partner',
] as const

/**
 * SMI-4665: Provenance marker for a skill row.
 * - `'registry'` — synced from the live Skillsmith registry (default for existing rows).
 * - `'local'` — imported from disk via `skillsmith import-local`. Sync ignores these.
 */
export type SkillSource = 'registry' | 'local'

export interface Skill {
  id: string
  name: string
  description: string | null
  author: string | null
  repoUrl: string | null
  qualityScore: number | null
  trustTier: TrustTier
  tags: string[]
  /** SMI-1631: Skill roles for role-based filtering */
  roles?: SkillRole[]
  installable: boolean
  // SMI-825: Security scan fields
  riskScore: number | null
  securityFindingsCount: number
  securityScannedAt: string | null
  securityPassed: boolean | null
  /** SMI-2760: Flat array of compatible IDE/LLM/platform slugs */
  compatibility?: string[]
  /** SMI-3135: Structured dependency declaration */
  dependencies?: DependencyDeclaration
  /**
   * SMI-4665: Provenance — `'registry'` (default) or `'local'` (filesystem import).
   * Optional on the type because many fixture/builder call sites predate the column;
   * `SkillRepository.rowToSkill()` always populates it from the DB.
   */
  source?: SkillSource
  createdAt: string
  updatedAt: string
  // SMI-skill-version-tracking Wave 1: version tracking fields
  /** SHA-256 hex of the most recently recorded content proxy (optional, populated by SkillVersionRepository) */
  latestContentHash?: string
  /** Number of distinct content hashes recorded for this skill */
  versionCount?: number
}

export interface SkillCreateInput {
  id?: string
  name: string
  description?: string | null
  author?: string | null
  repoUrl?: string | null
  qualityScore?: number | null
  trustTier?: TrustTier
  tags?: string[]
  /** SMI-1631: Skill roles for role-based filtering */
  roles?: SkillRole[]
  installable?: boolean
  // SMI-825: Security scan fields
  riskScore?: number | null
  securityFindingsCount?: number
  securityScannedAt?: string | null
  securityPassed?: boolean | null
  /** SMI-2760: Flat array of compatible IDE/LLM/platform slugs */
  compatibility?: string[]
  /** SMI-4665: Provenance — defaults to `'registry'` when omitted. */
  source?: SkillSource
}

export interface SkillUpdateInput {
  name?: string
  description?: string | null
  author?: string | null
  repoUrl?: string | null
  qualityScore?: number | null
  trustTier?: TrustTier
  tags?: string[]
  /** SMI-1631: Skill roles for role-based filtering */
  roles?: SkillRole[]
  installable?: boolean
  // SMI-825: Security scan fields
  riskScore?: number | null
  securityFindingsCount?: number
  securityScannedAt?: string | null
  securityPassed?: boolean | null
  /** SMI-2760: Flat array of compatible IDE/LLM/platform slugs */
  compatibility?: string[]
}

export interface SearchOptions {
  query: string
  limit?: number
  offset?: number
  trustTier?: TrustTier
  minQualityScore?: number
  category?: string
  // SMI-825: Security filters
  safeOnly?: boolean // Only show skills that passed security scan
  maxRiskScore?: number // Maximum risk score (0-100)
}

export interface SearchResult {
  skill: Skill
  rank: number
  highlights: {
    name?: string
    description?: string
  }
}

export interface PaginatedResults<T> {
  items: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export interface CacheEntry {
  key: string
  value: string
  expiresAt: number | null
  createdAt: string
}

export interface Source {
  id: string
  name: string
  type: 'github' | 'gitlab' | 'local' | 'registry'
  url: string
  lastSyncAt: string | null
  isActive: boolean
}

export interface Category {
  id: string
  name: string
  description: string | null
  parentId: string | null
  skillCount: number
}
