/**
 * Core type definitions for Skillsmith skills
 */

export type TrustTier = 'verified' | 'community' | 'experimental' | 'unknown'

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
  createdAt: string
  updatedAt: string
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
}

export interface SearchOptions {
  query: string
  limit?: number
  offset?: number
  trustTier?: TrustTier
  minQualityScore?: number
  category?: string
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
