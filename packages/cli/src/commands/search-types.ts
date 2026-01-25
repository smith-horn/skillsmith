/**
 * SMI-744: Search Command Types
 *
 * Type definitions for the interactive search command.
 *
 * @module @skillsmith/cli/commands/search-types
 */

import type { TrustTier } from '@skillsmith/core'

/**
 * Color functions for trust tier display
 */
export type TrustTierColorFn = (text: string) => string

/**
 * Trust tier color configuration
 */
export type TrustTierColors = Record<TrustTier, TrustTierColorFn>

/**
 * Interactive search state machine state
 */
export interface InteractiveSearchState {
  query: string
  trustTiers: TrustTier[]
  minQualityScore: number
  offset: number
}

/**
 * State machine phases for interactive search
 */
export type SearchPhase = 'collect_query' | 'searching' | 'exit'

/**
 * Search options for non-interactive mode
 */
export interface SearchCommandOptions {
  db: string
  limit: number
  tier?: TrustTier
  category?: string
  minScore?: number
  // SMI-825: Security filters
  safeOnly?: boolean
  maxRisk?: number
}

/**
 * Page size for interactive search results
 */
export const PAGE_SIZE = 10
