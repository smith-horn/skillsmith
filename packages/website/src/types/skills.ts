/**
 * Website-facing Skill types — canonical shapes for API responses and UI state.
 *
 * These types mirror the JSON returned by the Skillsmith edge functions
 * (snake_case, nullable fields) and are intentionally separate from the
 * ORM-layer `Skill` type in `@skillsmith/core`, which uses camelCase and
 * reflects the database schema.
 *
 * Also exports the `SearchState` discriminated union used by the search
 * page to drive conditional rendering (idle → loading → results/empty/error).
 */

export type { QualityTier } from '../utils/quality-tiers.js'

export interface AlsoInstalled {
  skillId: string
  name?: string
  description?: string
}

export interface Skill {
  id: string
  name: string
  author: string
  description: string
  trust_tier: 'verified' | 'curated' | 'community' | 'experimental' | 'unknown'
  categories: string[]
  version?: string
  stars?: number
  tags?: string[]
  repo_url?: string
  content?: string
  downloads?: number
  updated_at?: string
  also_installed?: AlsoInstalled[]
  related_skills?: string[]
  compatibility?: string[]
  metadata?: { topics?: string[] }
  _orgMatch?: string
}

export type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'results'; skills: Skill[]; total: number }
  | { status: 'empty' }
  | { status: 'error'; message: string; retryAfter?: number }
  | { status: 'featured' }
