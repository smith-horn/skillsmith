/**
 * Indexer types (Node port)
 * @module scripts/indexer/indexer-types
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/indexer-types.ts`.
 * Pure interface declarations — byte-identical to the Deno parent (no env, no
 * imports, no fetches). Parity guarded by `scripts/indexer/tests/parity.test.ts`.
 *
 * Original SMI-4376: Shared interfaces extracted from `index.ts` to keep the
 * orchestrator thin.
 */

/**
 * Indexer request body
 */
export interface IndexerRequest {
  topics?: string[]
  maxPages?: number
  dryRun?: boolean
  strictValidation?: boolean
  minContentLength?: number
  maxRepos?: number
  staleThresholdDays?: number
  /** Run type: 'maintenance' (stale cleanup) or 'discovery' (new skills) */
  runType?: 'maintenance' | 'discovery'
  /** Max pages for GitHub code search (default: 3, max: 5) */
  codeSearchMaxPages?: number
  /** SMI-4374: UTC cron slot (6/12/18) — selects discovery topic subset; absent / unknown falls back to full DEFAULT_TOPICS. */
  cronSlot?: number
}

/**
 * Indexer result
 */
export interface IndexerResult {
  found: number
  indexed: number
  updated: number
  failed: number
  quarantined: number
  stale: number
  quality_gate_filtered: number
  unchanged: number
  github_skill_count: number
  github_skill_breakdown?: Record<string, number>
  /** Phase 2b: Root-level code search stats */
  code_search?: {
    repos_found: number
    retries: number
    error?: string
  }
  /** Phase 3b (SMI-2660): Subdirectory / broad code search stats */
  subdirectory_search?: {
    repos_found: number
    total_found: number
    retries: number
    /** Repos excluded because license is confirmed non-permissive */
    license_filtered: number
    /** Repos skipped because the license API call failed — will retry next run */
    license_fetch_failed: number
    /** Number of pages where GitHub returned incomplete_results (query timeout) */
    incomplete_results?: number
    /** Which search strategy was used: 'broad' (single query) or 'prefix-fallback' (3 scoped queries) */
    search_mode?: 'broad' | 'prefix-fallback'
    error?: string
  }
  /** Phase 1: High-trust wildcard expansion stats (SMI-2672). Always present; zero values when no wildcards ran. */
  high_trust_wildcard: {
    authors_with_wildcards: number
    total_paths_expanded: number
    trees_api_calls: number
    truncated_responses: number
  }
  errors: string[]
  dryRun: boolean
  /** SMI-4376: Populated by `runDiscovery`; equals `repositories.length` at end of Phase 3. */
  repositories_found?: number
}
