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
 * paths (prehash-match or content_hash-match). SMI-4858: these rows are
 * processed via a direct UPDATE (NOT the batch upsert) because their payload
 * is `minimalSkillPayload` and mixing it with full payloads in a single
 * PostgREST upsert causes column-union NULL propagation, tripping
 * `skills.name NOT NULL`. They must NOT count toward `indexed`/`updated` —
 * the caller already incremented its own `unchanged` counter when pushing
 * them.
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

  // SMI-4858: Split skinny (unchanged-skip) vs full payloads BEFORE the batch
  // upsert. PostgREST unifies the column set across a heterogeneous array, so
  // mixing `minimalSkillPayload` (3 keys: repo_url, last_seen_at,
  // repo_updated_at) with full `repositoryToSkill` payloads (~20 keys) caused
  // PostgREST to send `name: null` for every skinny row. On ON CONFLICT UPDATE,
  // `excluded.name = null` propagated into the existing row and tripped the
  // `skills.name NOT NULL` constraint, failing the entire batch
  // (`null value in column "name" of relation "skills" violates not-null
  // constraint`). Discovered 2026-05-11 09:32 UTC cron run 25661917928 —
  // failed=376 with kill_switch_engaged=true blocking all upserts.
  //
  // Skinny rows are guaranteed-existing (matched prehash OR content_hash gate),
  // so a direct UPDATE is correct: no INSERT branch needed. `last_seen_at` is
  // refreshed by the post-batch unchangedIds touch in indexer-runners.ts; here
  // we only need to advance `repo_updated_at` so the next run's prehash gate
  // works (especially for content_hash-skip rows whose repo_updated_at moved).
  const skinnyItems = validUrlItems.filter((a) => a.unchangedSkip === true)
  const fullItems = validUrlItems.filter((a) => a.unchangedSkip !== true)

  for (const { skillData } of skinnyItems) {
    const url = skillData.repo_url as string
    upsertOkUrls.add(url)
    const update: Record<string, unknown> = {
      last_seen_at: skillData.last_seen_at,
      repo_updated_at: skillData.repo_updated_at,
    }
    const { error: skinnyError } = await supabase.from('skills').update(update).eq('repo_url', url)
    if (skinnyError) {
      // Don't count toward `failed` — the caller already booked these as
      // `unchanged`. Surface the error for visibility but keep the run viable.
      errors.push(`Skinny update failed (${url}): ${skinnyError.message}`)
    }
  }

  if (fullItems.length === 0) {
    return { indexed, updated, failed, quarantined, errors, upsertOkUrls }
  }

  // C-3: PostgREST batch upsert is NOT row-atomic. Behavior:
  //   • `error` non-null → entire batch failed (mark all rows as failed).
  //   • `error` null + `data.length < input.length` → partial failure;
  //     diff by repo_url to identify missing rows; mark each as failed.
  //   • `error` null + `data.length === input.length` → all rows succeeded.
  const payload = fullItems.map((a) => a.skillData)
  const { data, error } = await supabase
    .from('skills')
    .upsert(payload, { onConflict: 'repo_url', ignoreDuplicates: false })
    .select('repo_url')

  if (error) {
    failed += fullItems.length
    errors.push(`Batch upsert failed (${fullItems.length} rows): ${error.message}`)
    return { indexed, updated, failed, quarantined, errors, upsertOkUrls }
  }

  for (const row of (data ?? []) as { repo_url: string | null }[]) {
    if (row.repo_url) upsertOkUrls.add(row.repo_url)
  }

  for (const { repo, skillData } of fullItems) {
    const url = skillData.repo_url as string | null
    if (!url || !upsertOkUrls.has(url)) {
      failed++
      errors.push(`Batch upsert partial-fail: ${repo.fullName}`)
      continue
    }
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
