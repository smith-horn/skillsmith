/**
 * Tree-hash TTL cache helpers (SMI-4861 Wave 1)
 * @module scripts/indexer/tree-hash-cache
 *
 * Per-skill cache that lets Phase 1 skip the raw.githubusercontent.com
 * SKILL.md fetch when the prior cron's stored `tree_hash` matches the
 * current Trees API blob SHA AND the cached check is < TTL.
 *
 * Persisted in the `skills` table via migration 20260512000001:
 *   - `tree_hash TEXT` — git blob SHA of SKILL.md
 *   - `last_tree_hash_check TIMESTAMPTZ` — when we last verified the SHA
 *
 * TTL A/B follow-up tracked in SMI-4872.
 */

/** Cached row for one (repo_url, skill_path) tuple. */
export type TreeHashCacheEntry = { tree_hash: string; last_tree_hash_check: string | null }

/** Run-scoped map keyed by `treeHashCacheKey(repo_url, skill_path)`. */
export type TreeHashCache = Map<string, TreeHashCacheEntry>

/** Hit/miss counters threaded through Phase 1 callers; surfaced in audit meta. */
export interface TreeHashCacheCounters {
  hits: number
  misses: number
}

/** Default TTL: 24 hours. SMI-4872 will A/B 7d. */
export const TREE_HASH_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Cache key tuple. Mirrors the `COALESCE(skill_path, '')` convention used by
 * migration 055's CHECK constraint and `skill-processor.ts:496`.
 */
export function treeHashCacheKey(repoUrl: string, skillPath: string | undefined): string {
  return `${repoUrl}:${skillPath ?? ''}`
}

/**
 * Returns true when the cache holds a non-stale entry whose blob SHA matches.
 * Callers increment `counters` accordingly (hits on match, misses on fall-through).
 */
export function treeHashCacheHit(
  cache: TreeHashCache | undefined,
  cacheKey: string,
  currentBlobSha: string | undefined,
  now: number = Date.now()
): boolean {
  if (!cache || !currentBlobSha) return false
  const entry = cache.get(cacheKey)
  if (!entry || entry.tree_hash !== currentBlobSha || !entry.last_tree_hash_check) return false
  const lastMs = Date.parse(entry.last_tree_hash_check)
  if (!Number.isFinite(lastMs)) return false
  return now - lastMs < TREE_HASH_CACHE_TTL_MS
}
