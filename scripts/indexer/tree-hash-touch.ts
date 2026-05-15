/**
 * Tree-hash touch helper (SMI-4861 Wave 1 post-acceptance fix)
 * @module scripts/indexer/tree-hash-touch
 *
 * SMI-4861's tree-hash cache hit path does `continue` — it skips downstream
 * upsert entirely. That means `last_tree_hash_check` is never refreshed on a
 * hit. With a 24h TTL and a 6h cron, rows oscillate between hit (fresh, no
 * refresh) and miss (stale, refresh) — empirically capping the hit ratio at
 * ~50% in steady state (post-merge telemetry 2026-05-14).
 *
 * The fix: when a cache hit happens, record the row's identity in a touch
 * list. After Phase 1, batch-refresh `last_tree_hash_check` so cached rows
 * stay fresh as long as they're being seen. Matches the intent of the
 * SMI-4854 skip-gate (`repo_updated_at` is refreshed on every skip-gate hit
 * too, for the same self-refreshing reason).
 *
 * Cost: ~200 cheap UPDATEs per discovery cron (one per cache hit), run with
 * Promise.all so wall-clock is sub-second. No GitHub API calls.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** One touch entry — primary key of the skills row to refresh. */
export interface TreeHashTouchEntry {
  repo_url: string
  skill_path: string
}

export interface ApplyTouchesResult {
  /** Number of rows successfully touched. */
  ok: number
  /** Per-failure error messages; non-fatal — caller logs and continues. */
  errors: string[]
}

/**
 * Refresh `last_tree_hash_check = NOW()` for each entry. No-op if list is
 * empty. Errors are collected and returned; do not throw.
 */
export async function applyTreeHashTouches(
  supabase: SupabaseClient,
  touches: TreeHashTouchEntry[]
): Promise<ApplyTouchesResult> {
  if (touches.length === 0) return { ok: 0, errors: [] }
  const ts = new Date().toISOString()
  const errors: string[] = []
  let ok = 0
  await Promise.all(
    touches.map(async (t) => {
      const { error } = await supabase
        .from('skills')
        .update({ last_tree_hash_check: ts })
        .eq('repo_url', t.repo_url)
        .eq('skill_path', t.skill_path)
      if (error) {
        errors.push(`tree_hash touch failed (${t.repo_url}:${t.skill_path}): ${error.message}`)
      } else {
        ok++
      }
    })
  )
  return { ok, errors }
}
