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
 *   2. Chunked upsert of `validUrlItems` (SMI-5934: was a single unchunked
 *      call that silently discarded an entire batch — up to ~21K rows — on a
 *      Postgres statement timeout; now issued in `chunkSize`-row slices so a
 *      timeout only costs that one chunk).
 *   3. Partial-failure diff: PostgREST batch upsert is NOT row-atomic. If
 *      `data.length < input.length`, the missing rows count as `failed`
 *      and are surfaced in `errors[]` (C-3 review finding). Applies per
 *      chunk since SMI-5934.
 *
 * No GitHub fetches issued here — Supabase-only. Telemetry threading is
 * therefore unnecessary in this module.
 *
 * Prior incidents in this file: SMI-4846/H-2 (null-url audit log dropped by
 * `returning: 'representation'`), SMI-4858/SMI-5491 (skinny/full column-union
 * NULL propagation tripped `skills.name NOT NULL`), SMI-5934 (unchunked
 * upsert silently discarded whole batches on an 8s statement timeout for
 * ~10 days, SMI-5334 rollout).
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
 * SMI-5934: Default upsert chunk size. A live dispatch admitting ~9,170 rows
 * completed with NO 8s statement timeout (docs/internal/runbooks/
 * indexer-backfill.md §3.6, run 27918147798) -- `fullItems` (post
 * skinny/null-url filtering) is always <=admitted, so the demonstrated
 * no-timeout ceiling is <=9,170 rows; 2000 keeps meaningful headroom under
 * that without a byte-accounting layer this data doesn't justify. Exported
 * + accepted as a parameter (not inlined) so tests can exercise multi-chunk
 * behavior with a small `chunkSize` instead of a 2000+-row fixture.
 */
export const UPSERT_CHUNK_SIZE = 2000

/**
 * SMI-4846 + H-2 + C-3 + SMI-5934: Drain the upsert accumulator with a
 * chunked upsert, preserving the per-row audit-log branch for null-url items
 * and surfacing partial failures.
 */
export async function flushUpsertAccumulator(
  supabase: SupabaseClient,
  accumulator: UpsertAccumulatorItem[],
  existingUrls: Set<string>,
  chunkSize: number = UPSERT_CHUNK_SIZE
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
  // mixing `minimalSkillPayload` (2 base keys: repo_url, repo_updated_at
  // (+ optional tree_hash pair)) with full `repositoryToSkill` payloads
  // (~20 keys) caused
  // PostgREST to send `name: null` for every skinny row. On ON CONFLICT UPDATE,
  // `excluded.name = null` propagated into the existing row and tripped the
  // `skills.name NOT NULL` constraint, failing the entire batch
  // (`null value in column "name" of relation "skills" violates not-null
  // constraint`). Discovered 2026-05-11 09:32 UTC cron run 25661917928 —
  // failed=376 with kill_switch_engaged=true blocking all upserts.
  //
  // Skinny rows are guaranteed-existing (matched prehash OR content_hash gate),
  // so a direct UPDATE is correct: no INSERT branch needed. As of SMI-5491,
  // `last_seen_at` is written EXCLUSIVELY by the 12h-gated post-batch
  // unchangedIds touch in indexer-runners.ts; the skinny update here
  // deliberately touches only unindexed columns (`repo_updated_at` + optional
  // tree_hash pair) so it is a HOT update that rewrites no indexes — advancing
  // `repo_updated_at` keeps the next run's prehash gate working (especially for
  // content_hash-skip rows whose repo_updated_at moved).
  const skinnyItems = validUrlItems.filter((a) => a.unchangedSkip === true)
  const fullItems = validUrlItems.filter((a) => a.unchangedSkip !== true)

  for (const { skillData } of skinnyItems) {
    const url = skillData.repo_url as string
    upsertOkUrls.add(url)
    const update: Record<string, unknown> = {
      repo_updated_at: skillData.repo_updated_at,
    }
    // SMI-4861 Wave 1 (SMI-4887 follow-up): when minimalSkillPayload carried a
    // fresh tree_hash from the wildcard Trees fetch, propagate it. Without this,
    // the cache never warms for skip-gate skills (verified prod 2026-05-12 cron
    // 25758038618: 2 of 8344 rows had tree_hash after 3 crons).
    const treeHash = (skillData as { tree_hash?: string }).tree_hash
    const treeHashCheck = (skillData as { last_tree_hash_check?: string }).last_tree_hash_check
    if (treeHash && treeHashCheck) {
      update.tree_hash = treeHash
      update.last_tree_hash_check = treeHashCheck
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

  // C-3 + SMI-5934: PostgREST batch upsert is NOT row-atomic, and (since
  // SMI-5934) is issued in `chunkSize`-row chunks rather than one call for
  // all of `fullItems`, so a statement timeout only costs one chunk instead
  // of the whole dispatch. Per chunk:
  //   • `error` non-null → that chunk failed (its rows go in `chunkErrorUrls`,
  //     one summarized `errors[]` entry per failed chunk -- not one per row).
  //   • `error` null + `data.length < chunk.length` → partial failure within
  //     an otherwise-successful chunk; the post-loop walk below diffs by
  //     repo_url and marks each missing row failed individually (rare C-3 case).
  //   • `error` null + `data.length === chunk.length` → all rows in the chunk
  //     succeeded.
  // The chunk loop itself never touches `failed`/`indexed`/`updated` -- the
  // post-loop walk over all of `fullItems` is the single source of truth for
  // counting, so a row is never booked failed both inside the chunk loop and
  // again in the per-row walk.
  const chunkErrorUrls = new Set<string>()
  for (let i = 0; i < fullItems.length; i += chunkSize) {
    const chunk = fullItems.slice(i, i + chunkSize)
    const payload = chunk.map((a) => a.skillData)
    const { data, error } = await supabase
      .from('skills')
      .upsert(payload, { onConflict: 'repo_url', ignoreDuplicates: false })
      .select('repo_url')

    if (error) {
      const chunkNum = Math.floor(i / chunkSize) + 1
      errors.push(
        `Batch upsert failed (chunk ${chunkNum}, rows ${i}-${i + chunk.length - 1} of ${fullItems.length}): ${error.message}`
      )
      for (const { skillData } of chunk) {
        const url = skillData.repo_url as string | null
        if (url) chunkErrorUrls.add(url)
      }
      continue
    }

    for (const row of (data ?? []) as { repo_url: string | null }[]) {
      if (row.repo_url) upsertOkUrls.add(row.repo_url)
    }
  }

  for (const { repo, skillData } of fullItems) {
    const url = skillData.repo_url as string | null
    if (!url || !upsertOkUrls.has(url)) {
      failed++
      if (!url || !chunkErrorUrls.has(url)) {
        errors.push(`Batch upsert partial-fail: ${repo.fullName}`)
      }
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
