/**
 * Indexer types (Node port)
 * @module scripts/indexer/indexer-types
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/indexer-types.ts`.
 * Interface declarations only (no env, no fetches). NOTE (SMI-5286 1c): this file
 * is NOT in the `parity.test.ts` guarded set, so the Node copy may diverge from
 * the Deno parent — the `backfill_crawl` field + its type import below are
 * Node-only (the backfill engine is the Node GHA runner, never the Deno cron).
 *
 * Original SMI-4376: Shared interfaces extracted from `index.ts` to keep the
 * orchestrator thin.
 */

import type { BackfillCrawlOutcome } from './backfill-checkpoint.ts'

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
  /** SMI-4842: Repos rejected as curated `awesome-*` link-lists (not skills). */
  meta_list_filtered: number
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
    /** SMI-5319: ~0 by default; only the SKILLSMITH_INDEXER_LICENSE_GATE kill-switch excludes repos */
    license_filtered: number
    /** Repos whose repo-metadata API call failed — skipped (no resolvable branch), retried next run (SMI-5319) */
    license_fetch_failed: number
    /** SMI-5319: skills admitted (indexed) this run */
    admitted?: number
    /** SMI-5319: admitted skills whose resolved SPDX is null (the null-license rate) */
    license_null?: number
    /** SMI-5319: repos skipped because no default branch could be resolved (code search omits it); retried next run */
    no_default_branch?: number
    /** Number of pages where GitHub returned incomplete_results (query timeout) */
    incomplete_results?: number
    /** Which search strategy was used: 'broad' (single query) or 'prefix-fallback' (3 scoped queries) */
    search_mode?: 'broad' | 'prefix-fallback'
    error?: string
  }
  /**
   * SMI-5286 1c: the facet driver's advanced cursor + counters for this backfill
   * dispatch. Present only when `BACKFILL_MODE` is set and Phase 3b ran the
   * size-facet crawl; `run.ts` reads it to write the checkpoint + step summary.
   */
  backfill_crawl?: BackfillCrawlOutcome
  /** Phase 1: High-trust wildcard expansion stats (SMI-2672). Always present; zero values when no wildcards ran. */
  high_trust_wildcard: {
    authors_with_wildcards: number
    total_paths_expanded: number
    trees_api_calls: number
    truncated_responses: number
  }
  /** SMI-4861 Wave 1: tree-hash TTL cache hit/miss counters. Surfaces in stdout RunSummary so cron logs show ratio without DB query. */
  tree_hash_cache?: {
    hits: number
    misses: number
  }
  errors: string[]
  dryRun: boolean
  /** SMI-4376: Populated by `runDiscovery`; equals `repositories.length` at end of Phase 3. */
  repositories_found?: number
  /**
   * SMI-5311: set true when `runDiscovery` skipped the Phase-4 upsert + finalize
   * because the lock-heartbeat abort signal fired (lock stolen / unrefreshable).
   * Upsert counters are all zero on an aborted result. Absent on normal runs.
   */
  aborted?: boolean
}
