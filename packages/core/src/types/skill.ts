/**
 * Core type definitions for Skillsmith skills
 */

export type TrustTier = 'verified' | 'community' | 'experimental' | 'unknown'

export interface Skill {
  id: string
  name: string
  description: string | null
  author: string | null
  repoUrl: string | null
  qualityScore: number | null
  trustTier: TrustTier
  tags: string[]
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
}

export interface SkillUpdateInput {
  name?: string
  description?: string | null
  author?: string | null
  repoUrl?: string | null
  qualityScore?: number | null
  trustTier?: TrustTier
  tags?: string[]
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
