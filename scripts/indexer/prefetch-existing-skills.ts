/**
 * Paginated prefetch of existing skill rows — skip-gate + tree-hash cache seed.
 * @module scripts/indexer/prefetch-existing-skills
 *
 * SMI-4861: a single unbounded `.select()` is silently capped by PostgREST's
 * `max-rows` (1000). The indexer prefetch feeds two maps from one query — the
 * SMI-4854 `repo_updated_at` skip-gate and the SMI-4861 tree-hash cache — so
 * the cap meant both only ever saw the first 1000 of ~8400 eligible rows,
 * structurally pinning the tree-hash cache hit ratio near ~30% regardless of
 * TTL. This walks the table in `max-rows`-sized pages instead.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  treeHashCacheKey,
  type TreeHashCache,
  type TreeHashCacheEntry,
} from './high-trust-indexer.ts'

/** PostgREST `max-rows` cap — also the page size for the paginated walk. */
export const PREFETCH_PAGE_SIZE = 1000
/** Safety bound: ~8400 eligible rows today; 1000 pages = 1M-row headroom. */
const MAX_PREFETCH_PAGES = 1000

interface SkillPrefetchRow {
  repo_url: string
  repo_updated_at: string | null
  skill_path: string | null
  tree_hash: string | null
  last_tree_hash_check: string | null
}

export interface PrefetchResult {
  /** repo_url → repo_updated_at, consumed by the SMI-4854 skip-gate. */
  existingRepoUpdatedAt: Map<string, string | null>
  /** (bareRepoUrl, skill_path) → tree-hash entry, consumed by Phase 1. */
  treeHashCache: TreeHashCache
  /** Rows scanned across all pages — surfaced for telemetry. */
  rowsScanned: number
}

/**
 * Load every skill row with a non-null `repo_url`, paging past PostgREST's
 * `max-rows` cap. Ordered by `repo_url` (the upsert conflict key, so unique
 * for non-null rows) to keep `.range()` page boundaries stable.
 *
 * Prefetch failure is non-fatal: a partial result just means fewer skip-gate
 * and cache hits this run — correctness is preserved by the downstream fetch.
 */
export async function prefetchExistingSkills(
  supabase: SupabaseClient,
  requestId: string
): Promise<PrefetchResult> {
  const existingRepoUpdatedAt = new Map<string, string | null>()
  const treeHashCache: TreeHashCache = new Map<string, TreeHashCacheEntry>()
  let rowsScanned = 0

  for (let page = 0; page < MAX_PREFETCH_PAGES; page++) {
    const from = page * PREFETCH_PAGE_SIZE
    const { data, error } = await supabase
      .from('skills')
      .select('repo_url, repo_updated_at, skill_path, tree_hash, last_tree_hash_check')
      .not('repo_url', 'is', null)
      .order('repo_url', { ascending: true })
      .range(from, from + PREFETCH_PAGE_SIZE - 1)

    if (error) {
      console.error(
        JSON.stringify({
          event: 'repo_updated_at_prefetch_failed',
          error: error.message,
          request_id: requestId,
          page,
        })
      )
      break
    }

    const rows = (data ?? []) as SkillPrefetchRow[]
    for (const row of rows) {
      if (!row.repo_url) continue
      existingRepoUpdatedAt.set(row.repo_url, row.repo_updated_at ?? null)
      if (row.tree_hash) {
        // skills.repo_url stores the per-skill URL `…/tree/<branch>/<skillPath>`
        // for multi-skill repos; Phase 1 lookups key on the bare repo URL +
        // skill_path tuple, so strip the suffix here for round-trip parity.
        const bareRepoUrl = row.repo_url.split('/tree/')[0]
        treeHashCache.set(treeHashCacheKey(bareRepoUrl, row.skill_path ?? ''), {
          tree_hash: row.tree_hash,
          last_tree_hash_check: row.last_tree_hash_check,
        })
      }
    }
    rowsScanned += rows.length
    if (rows.length < PREFETCH_PAGE_SIZE) break
  }

  return { existingRepoUpdatedAt, treeHashCache, rowsScanned }
}
