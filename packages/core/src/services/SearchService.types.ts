/**
 * SMI-579: SearchService Types
 *
 * Type definitions for FTS5 search with BM25 ranking.
 */

import type { TrustTier } from '../types/skill.js'

/**
 * Raw database row type for FTS search results
 * Used for type-safe parsing of search results from SQLite
 */
export interface FTSRow {
  id: string
  name: string
  description: string | null
  author: string | null
  repo_url: string | null
  quality_score: number | null
  trust_tier: string
  tags: string
  installable: boolean | null
  // SMI-825: Security scan columns
  risk_score: number | null
  security_findings_count: number | null
  security_scanned_at: string | null
  security_passed: number | null // SQLite uses 0/1 for boolean
  created_at: string
  updated_at: string
  rank: number
}

/**
 * Boolean search terms for advanced queries
 */
export interface BooleanSearchTerms {
  /** Terms that must appear */
  must?: string[]
  /** Terms where at least one should appear */
  should?: string[]
  /** Terms that must not appear */
  not?: string[]
}

/**
 * Search cache key options
 */
export interface SearchCacheOptions {
  query?: string
  limit?: number
  offset?: number
  trustTier?: TrustTier
  minQualityScore?: number
  category?: string
  safeOnly?: boolean
  maxRiskScore?: number
}
