/**
 * Batch-upsert helpers for `runUpsertPhase` (Node port)
 * @module scripts/indexer/indexer-runners.batch
 *
 * SMI-4846: Extracted from `indexer-runners.ts` to keep that file under the
 * 500-line CI gate. SMI-4852 Node port: byte-identical body to the Deno parent
 * `supabase/functions/indexer/indexer-runners.batch.ts` modulo the SupabaseClient
 * import (npm vs esm.sh). Owns the post-loop batch-upsert step:
 *   1. Per-row audit-log writes for `repo_url == null` items (BEFORE batch —
 *      H-2: PostgREST batch upsert with `returning: 'representation'` filters
 *      null-url rows out of the returned `data`, silently dropping the
 *      `indexer_skill_md_missing` audit branch).
 *   2. Single batched upsert of `validUrlItems`.
 *   3. Partial-failure diff: PostgREST batch upsert is NOT row-atomic. If
 *      `data.length < input.length`, the missing rows count as `failed`
 *      and are surfaced in `errors[]` (C-3 review finding).
 *
 * No GitHub fetches issued here — Supabase-only. Telemetry threading is
 * therefore unnecessary in this module.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { GitHubRepository } from './topic-search.ts'

/**
 * One accumulator entry: the repo discovered in this run + the skill row
 * payload computed from it. Threaded into `flushUpsertAccumulator` so the
 * post-batch counter accumulation can reach back to per-repo metadata
 * (discovery path, fullName for error messages).
 *
 * `unchangedSkip` distinguishes items that came from one of the two skip
 * paths (prehash-match or content_hash-match) — those rows ARE batch-upserted
 * (to refresh last_seen_at + repo_updated_at) but must NOT count toward
 * `indexed`/`updated`. The caller already incremented its own `unchanged`
 * counter when pushing them.
 */
export interface UpsertAccumulatorItem {
  repo: GitHubRepository
  skillData: Record<string, unknown>
  unchangedSkip?: boolean
}

export interface FlushResult {
  indexed: number
  updated: number
  failed: number
  quarantined: number
  errors: string[]
  /** repo_urls that PostgREST confirmed via `returning: 'representation'`. */
  upsertOkUrls: Set<string>
}

/**
 * SMI-4846 + H-2 + C-3: Drain the upsert accumulator with one batched call,
 * preserving the per-row audit-log branch for null-url items and surfacing
 * partial failures.
 */
export async function flushUpsertAccumulator(
  supabase: SupabaseClient,
  accumulator: UpsertAccumulatorItem[],
  existingUrls: Set<string>
): Promise<FlushResult> {
  let indexed = 0
  let updated = 0
  let failed = 0
  let quarantined = 0
  const errors: string[] = []
  const upsertOkUrls = new Set<string>()

  // SMI-2731 + H-2: Quarantine audit-log writes for repos discovered without
  // a valid SKILL.md (repo_url === null). Must run BEFORE the batch — the
  // batch's `returning: 'representation'` filters these rows out of `data`.
  const nullUrlItems = accumulator.filter((a) => a.skillData.repo_url == null)
  for (const { repo } of nullUrlItems) {
    try {
      await supabase.from('audit_logs').insert({
        event_type: 'indexer_skill_md_missing',
        actor: 'indexer',
        resource: repo.fullName,
        action: 'set_repo_url_null',
        result: 'skill_md_missing',
        metadata: { repo: repo.fullName },
      })
    } catch (auditError) {
      console.error('[skill-processor] Failed to write audit log:', auditError)
    }
  }

  const validUrlItems = accumulator.filter((a) => a.skillData.repo_url != null)
  if (validUrlItems.length === 0) {
    return { indexed, updated, failed, quarantined, errors, upsertOkUrls }
  }

  // C-3: PostgREST batch upsert is NOT row-atomic. Behavior:
  //   • `error` non-null → entire batch failed (mark all rows as failed).
  //   • `error` null + `data.length < input.length` → partial failure;
  //     diff by repo_url to identify missing rows; mark each as failed.
  //   • `error` null + `data.length === input.length` → all rows succeeded.
  const payload = validUrlItems.map((a) => a.skillData)
  const { data, error } = await supabase
    .from('skills')
    .upsert(payload, { onConflict: 'repo_url', ignoreDuplicates: false })
    .select('repo_url')

  if (error) {
    failed += validUrlItems.length
    errors.push(`Batch upsert failed (${validUrlItems.length} rows): ${error.message}`)
    return { indexed, updated, failed, quarantined, errors, upsertOkUrls }
  }

  for (const row of (data ?? []) as { repo_url: string | null }[]) {
    if (row.repo_url) upsertOkUrls.add(row.repo_url)
  }

  for (const { repo, skillData, unchangedSkip } of validUrlItems) {
    const url = skillData.repo_url as string | null
    if (!url || !upsertOkUrls.has(url)) {
      failed++
      errors.push(`Batch upsert partial-fail: ${repo.fullName}`)
      continue
    }
    // Unchanged-skip items refresh last_seen_at + repo_updated_at via the
    // batch upsert but the caller has already counted them as `unchanged`.
    // Don't double-count as indexed/updated.
    if (unchangedSkip) continue
    if (existingUrls.has(url)) {
      updated++
    } else {
      indexed++
    }
    if (skillData.quarantined === true) {
      quarantined++
    }
  }

  return { indexed, updated, failed, quarantined, errors, upsertOkUrls }
}
