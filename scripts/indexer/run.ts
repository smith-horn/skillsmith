#!/usr/bin/env node
/**
 * Skillsmith indexer entrypoint (Node port — SMI-4852 Tier 2)
 * @module scripts/indexer/run
 *
 * Invoked from `.github/workflows/indexer.yml` as:
 *   npx tsx scripts/indexer/run.ts
 *
 * Reads env vars (see `parse-env.ts`), acquires the advisory lock,
 * dispatches to discovery or maintenance, writes a single audit_logs row
 * with rate-limit telemetry, releases the lock.
 *
 * Hard rules carried forward from retro 2026-05-10:
 *  - Every GitHub fetch wrapped in `withRateLimitTracking` (verified by grep
 *    against `scripts/indexer/_shared/rate-limit.ts:withRateLimitTracking`).
 *  - Phase 1 concurrency comes from `parseEnv().concurrency` (default 2;
 *    `CONCURRENCY_KILL_SWITCH=1` forces 1). Repo-var
 *    `INDEXER_CONCURRENCY_KILL_SWITCH` feeds the workflow's env block.
 *  - `request_id` terminology everywhere except the literal RPC parameter
 *    name `run_id` for `try_indexer_lock(run_id text)`.
 *  - Error-before-data ordering on every Supabase RPC result.
 */

import { createSupabaseAdminClient, getRequestId } from './_shared/supabase.ts'
import {
  createTokenBucket,
  newRateLimitTelemetry,
  summarizeRateLimitTelemetry,
  type RateLimitTelemetry,
} from './_shared/rate-limit.ts'
import { parseEnv, type IndexerEnv } from './parse-env.ts'
import { DEFAULT_TOPICS } from './topic-search.ts'
import { DEFAULT_MIN_CONTENT_LENGTH } from './skill-processor.ts'
import { selectTopics, type RotationSource } from './topic-rotation.ts'
import { runDiscovery } from './discovery-orchestrator.ts'
import { runMaintenanceReconciliation } from './maintenance-helpers.ts'
import { runRecheck } from './recheck.ts'
import type { RecheckResult } from './recheck.ts'
import type { IndexerRequest, IndexerResult } from './indexer-types.ts'
import type { SkillMdValidation } from './skill-processor.ts'
import { prefetchExistingSkills } from './prefetch-existing-skills.ts'
// SMI-5286 Wave 1b (§#5): resume cursor read on backfill dispatches.
// (§#2): token-source derivation + backfill summary sub-object emitted on stdout.
import {
  readLatestCheckpoint,
  writeCheckpoint,
  resolveTokenSource,
  type BackfillSummary,
} from './backfill-checkpoint.ts'
// SMI-5286 1c: the facet-crawl plan handed to the orchestrator's Phase 3b.
import type { BackfillFacetPlan } from './subdirectory-search.ts'
// SMI-4870: lock-skip observability — write an audit row even when the lock is
// already held so partial-cycle gaps are detectable in SQL.
import { writeIndexerAuditLog } from './indexer-audit-log.ts'

interface RunSummary {
  data: unknown
  meta: {
    request_id: string
    run_type: 'discovery' | 'maintenance' | 'recheck'
    rate_limit_remaining_min: number
    // SMI-4918: per-bucket GitHub rate-limit minimums (core/search/code_search).
    core_remaining_min: number
    search_remaining_min: number
    code_search_remaining_min: number
    secondary_rate_limit_hits: number
    retry_after_max_seconds: number
    concurrency: number
    kill_switch_engaged: boolean
    topics: string[]
    cron_slot: number | null
    rotation_source: RotationSource | 'maintenance'
    // SMI-4861 Wave 1 post-merge retro: surface cache counters in cron log line.
    tree_hash_cache_hits: number
    tree_hash_cache_misses: number
  }
}

async function runDiscoveryBranch(
  env: IndexerEnv,
  requestId: string,
  telemetry: RateLimitTelemetry
): Promise<{
  result: IndexerResult
  topics: string[]
  rotationSource: RotationSource
  // SMI-5286 Wave 1b (§#2): id of the checkpoint read this dispatch (null on cold
  // start / non-backfill), surfaced as `data.backfill.checkpoint_id`.
  checkpointId: string | null
}> {
  const supabase = createSupabaseAdminClient()
  const envRaw = process.env.SKILLSMITH_INDEX_TOPICS
  const envTopics = envRaw
    ? envRaw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : undefined

  const { topics, source: rotationSource } = selectTopics({
    bodyTopics: undefined,
    envTopics,
    cronSlot: env.CRON_SLOT,
    defaultTopics: DEFAULT_TOPICS as unknown as string[],
  })

  const body: IndexerRequest = {
    maxPages: env.MAX_PAGES,
    maxRepos: env.MAX_REPOS,
    codeSearchMaxPages: env.CODE_SEARCH_MAX_PAGES,
    dryRun: env.DRY_RUN,
    runType: 'discovery',
    cronSlot: env.CRON_SLOT ?? undefined,
  }

  // SMI-4846: Singleton token buckets pacing parallel callers against
  // GitHub upstream quotas. Search API = 30 rpm (0.5 tps); Code Search = 10 rpm.
  const searchApiTokenBucket = createTokenBucket(0.5, 1)
  const codeSearchTokenBucket = createTokenBucket(1 / 6, 1)

  // SMI-4854 + SMI-4861 Wave 1: Prefetch repo_updated_at + tree_hash maps so
  // Phase 1 can short-circuit the per-skill raw.* fetch when blob SHA +
  // freshness match. Paginated — an unbounded `.select()` is silently capped
  // by PostgREST's `max-rows` (1000), which previously starved both maps to
  // the first ~1000 of the ~8400-row corpus. See prefetch-existing-skills.ts.
  const { existingRepoUpdatedAt, treeHashCache, rowsScanned } = await prefetchExistingSkills(
    supabase,
    requestId
  )
  console.log(
    `[Prefetch] ${rowsScanned} skill rows scanned; tree-hash cache seeded with ${treeHashCache.size} entries`
  )

  // SMI-5286 1c (§#5): on a backfill dispatch, read the latest checkpoint cursor
  // and build the facet-crawl plan so a re-dispatch resumes mid-facet. The
  // advanced cursor returns on `result.backfill_crawl` and is checkpointed below.
  // `RESUME_FROM` ('latest' or a specific run_id) maps to the workflow's
  // `resume_from` input; the NEW checkpoint is keyed on GITHUB_RUN_ID.
  let checkpointId: string | null = null
  let backfillFacetPlan: BackfillFacetPlan | undefined
  const backfillRunId = process.env.GITHUB_RUN_ID ?? requestId
  if (env.BACKFILL_MODE) {
    const resumeFrom = process.env.RESUME_FROM
    const checkpoint = await readLatestCheckpoint(supabase, resumeFrom)
    if (checkpoint) {
      const { path, facet, last_page } = checkpoint.cursor
      console.log(
        `[Backfill] SMI-5286: resuming from checkpoint (run_id=${checkpoint.run_id}) ` +
          `cursor=(path=${path}, facet=${facet}, last_page=${last_page}); ` +
          `facets ${checkpoint.facets_completed}/${checkpoint.facets_total}`
      )
    } else {
      console.log('[Backfill] SMI-5286: no prior checkpoint — starting from the beginning')
    }
    backfillFacetPlan = {
      startCursor: checkpoint?.cursor ?? null,
      pathPrefix: env.BACKFILL_PATH_PREFIX,
      perPage: 100,
      maxPagesPerRange: env.CODE_SEARCH_MAX_PAGES,
      maxRangesPerDispatch: env.BACKFILL_MAX_RANGES,
    }
  }

  const result = await runDiscovery({
    supabase,
    requestId,
    body,
    topics,
    rotationSource,
    cronSlot: env.CRON_SLOT,
    maxPages: env.MAX_PAGES,
    maxTopicRepos: env.MAX_REPOS,
    codeSearchMaxPages: env.CODE_SEARCH_MAX_PAGES,
    dryRun: env.DRY_RUN,
    validationOptions: { strictValidation: true, minContentLength: DEFAULT_MIN_CONTENT_LENGTH },
    validationCache: new Map<string, SkillMdValidation>(),
    searchApiTokenBucket,
    codeSearchTokenBucket,
    existingRepoUpdatedAt,
    treeHashCache,
    telemetry,
    concurrency: env.concurrency,
    killSwitchEngaged: env.kill_switch_engaged,
    // SMI-4870: thread per-phase sub-slot identifier from env into orchestrator.
    discoveryPhase: env.DISCOVERY_PHASE,
    // SMI-5286 Wave 1b (§#2): drop the freshness window + skip Phase 6 in backfill.
    backfillMode: env.BACKFILL_MODE,
    // SMI-5286 1c: facet-crawl plan (undefined on the cron path).
    backfillFacetPlan,
  })

  // SMI-5286 1c (§#5): persist the advanced facet cursor so the next dispatch
  // (resume_from=latest) continues mid-facet. Written even in DRY_RUN so the
  // operator can verify the resume loop before flipping to a live write
  // (audit_logs is append-only telemetry, not the skills registry).
  if (env.BACKFILL_MODE && result.backfill_crawl) {
    const bc = result.backfill_crawl
    const wrote = await writeCheckpoint(supabase, {
      run_id: backfillRunId,
      cursor: bc.cursor,
      facets_completed: bc.facets_completed,
      facets_total: bc.facets_total,
      cap_saturated: bc.cap_saturated,
      truncated_repo_count: bc.truncated_repo_count,
    })
    if (wrote) checkpointId = backfillRunId
    console.log(
      `[Backfill] SMI-5286: checkpoint ${wrote ? 'written' : 'FAILED'} (run_id=${backfillRunId}) ` +
        `cursor.facet=${bc.cursor.facet} facets ${bc.facets_completed}/${bc.facets_total} done=${bc.done}`
    )
  }

  return { result, topics, rotationSource, checkpointId }
}

async function runMaintenanceBranch(
  env: IndexerEnv,
  requestId: string,
  telemetry: RateLimitTelemetry
): Promise<unknown> {
  const supabase = createSupabaseAdminClient()
  return await runMaintenanceReconciliation({
    supabase,
    requestId,
    body: {
      runType: 'maintenance',
      dryRun: env.DRY_RUN,
      staleThresholdDays: env.STALE_DAYS,
    },
    dryRun: env.DRY_RUN,
    // SMI-4857: thread telemetry + concurrency + kill-switch through so the
    // maintenance audit_logs row carries the same meta envelope shape as
    // discovery (zeroed rate-limit fields since maintenance makes no GitHub
    // calls).
    telemetry,
    concurrency: env.concurrency,
    killSwitchEngaged: env.kill_switch_engaged,
  })
}

async function runRecheckBranch(
  env: IndexerEnv,
  requestId: string,
  telemetry: RateLimitTelemetry
): Promise<RecheckResult> {
  const supabase = createSupabaseAdminClient()
  // RECHECK_DRY_RUN is the enforceable dry-run-first gate (SMI-5166 E6):
  // a scheduled cron has no inputs.dry_run, so the workflow DRY_RUN resolves
  // to false (live) on night 1; recheck reads its own RECHECK_DRY_RUN repo-var
  // instead. apply = !dryRun.
  return await runRecheck({
    supabase,
    requestId,
    apply: !env.RECHECK_DRY_RUN,
    thresholdDays: env.RECHECK_THRESHOLD_DAYS,
    cap: env.RECHECK_MAX_CANDIDATES,
    batch: env.RECHECK_BATCH,
    telemetry,
  })
}

async function main(): Promise<void> {
  const env = parseEnv()
  const requestId = getRequestId()
  const supabase = createSupabaseAdminClient()
  const telemetry = newRateLimitTelemetry()

  // Issue #16: check error BEFORE data on the RPC result.
  // - lockResult.error  -> hard failure, exit 1
  // - lockResult.data=false -> benign skip, exit 0
  // Note: `run_id` is the literal RPC parameter name in try_indexer_lock(run_id text).
  // Everywhere else we use `request_id` terminology.
  const lockResult = await supabase.rpc('try_indexer_lock', { run_id: requestId })

  if (lockResult.error) {
    console.error(
      JSON.stringify({
        event: 'lock_rpc_error',
        error: lockResult.error.message,
        request_id: requestId,
      })
    )
    process.exit(1)
  }

  if (!lockResult.data) {
    console.log(
      JSON.stringify({
        event: 'lock_held_by_other_run',
        request_id: requestId,
      })
    )
    // SMI-4870 issue #1: write a minimal audit_logs row so per-phase sub-slot
    // skips are observable via SQL (GROUP BY discovery_phase, status).
    // The meta shape mirrors the Phase 7 row written by writeDiscoveryAuditLog
    // — only fields available without running any phase are populated.
    // Assign to a typed intermediate so the extra `status` and `discovery_phase`
    // keys survive the excess-property check (same pattern as writeDiscoveryAuditLog
    // uses for its `auditMeta` local).
    const skipMeta = {
      request_id: requestId,
      run_type: env.RUN_TYPE,
      rate_limit_remaining_min: 0,
      // SMI-4918: lock-skipped runs make no GitHub calls — zero every bucket.
      core_remaining_min: 0,
      search_remaining_min: 0,
      code_search_remaining_min: 0,
      secondary_rate_limit_hits: 0,
      retry_after_max_seconds: 0,
      concurrency: env.concurrency,
      kill_switch_engaged: env.kill_switch_engaged,
      topics: [],
      cron_slot: env.CRON_SLOT,
      rotation_source: 'fallback' as const,
      tree_hash_cache_hits: 0,
      tree_hash_cache_misses: 0,
      // SMI-4870: observability keys — status marks the skip; discovery_phase
      // identifies which per-phase sub-slot was blocked.
      status: 'skipped_lock' as const,
      discovery_phase: env.DISCOVERY_PHASE ?? null,
    }
    await writeIndexerAuditLog(supabase, 'partial', {
      requestId,
      topics: [],
      runType: env.RUN_TYPE,
      dryRun: env.DRY_RUN,
      found: 0,
      indexed: 0,
      updated: 0,
      failed: 0,
      stale: 0,
      quality_gate_filtered: 0,
      unchanged: 0,
      quarantined: 0,
      github_skill_count: 0,
      code_search: undefined,
      scoreDistribution: { highTrust: 0, community: 0, scores: [] },
      categorizedCount: 0,
      categoryAssignments: 0,
      wildcard_expansion_count: 0,
      cron_slot: env.CRON_SLOT,
      rotation_source: 'fallback',
      discovery_path_counts: {},
      subdirectory_search: undefined,
      high_trust_fallback_hits: 0,
      meta: skipMeta,
    })
    process.exit(0)
  }

  let result: unknown = null
  let topics: string[] = []
  let rotationSource: RotationSource | 'maintenance' = 'maintenance'
  let checkpointId: string | null = null
  let runError: unknown = null

  try {
    if (env.RUN_TYPE === 'maintenance') {
      result = await runMaintenanceBranch(env, requestId, telemetry)
    } else if (env.RUN_TYPE === 'recheck') {
      result = await runRecheckBranch(env, requestId, telemetry)
    } else {
      const discovery = await runDiscoveryBranch(env, requestId, telemetry)
      result = discovery.result
      topics = discovery.topics
      rotationSource = discovery.rotationSource
      checkpointId = discovery.checkpointId
    }
  } catch (err) {
    runError = err
  } finally {
    const releaseResult = await supabase.rpc('release_indexer_lock', { run_id: requestId })
    if (releaseResult.error) {
      console.error(
        JSON.stringify({
          event: 'lock_release_error',
          error: releaseResult.error.message,
          request_id: requestId,
        })
      )
    }
  }

  // tree_hash_cache is only present on discovery results; cast narrowly to read
  // the optional counters without widening the `result` type elsewhere.
  const treeHashCache = (result as { tree_hash_cache?: { hits?: number; misses?: number } } | null)
    ?.tree_hash_cache

  // SMI-5286 (§#2): on a backfill dispatch, attach a `backfill` sub-object onto
  // `data` so `indexer-backfill.yml` can read `data.backfill.token_source` (its
  // guardian fails the run if it reads 'app', proving PAT-bucket isolation).
  // 1c: the facet counters are sourced from `result.backfill_crawl` (the advanced
  // cursor outcome from Phase 3b); `facets_remaining == 0` is the terminal
  // condition the operator loop watches. Spread keeps the existing IndexerResult
  // fields under `data` intact. Only emitted when BACKFILL_MODE is true.
  let data: unknown = result
  if (env.BACKFILL_MODE && result && typeof result === 'object') {
    const crawl = (result as { backfill_crawl?: IndexerResult['backfill_crawl'] }).backfill_crawl
    const backfill: BackfillSummary = {
      token_source: resolveTokenSource(),
      checkpoint_id: checkpointId,
      facets_total: crawl?.facets_total ?? 0,
      facets_completed: crawl?.facets_completed ?? 0,
      facets_remaining: crawl ? crawl.facets_total - crawl.facets_completed : 0,
      cap_saturated: crawl?.cap_saturated ?? false,
      truncated_repo_count: crawl?.truncated_repo_count ?? 0,
    }
    data = { ...(result as Record<string, unknown>), backfill }
  }

  const summary: RunSummary = {
    data,
    meta: {
      request_id: requestId,
      run_type: env.RUN_TYPE,
      concurrency: env.concurrency,
      kill_switch_engaged: env.kill_switch_engaged,
      topics,
      cron_slot: env.CRON_SLOT,
      rotation_source: rotationSource,
      tree_hash_cache_hits: treeHashCache?.hits ?? 0,
      tree_hash_cache_misses: treeHashCache?.misses ?? 0,
      ...summarizeRateLimitTelemetry(telemetry),
    },
  }

  if (runError) {
    console.error(JSON.stringify({ event: 'run_error', error: String(runError), ...summary }))
    process.exit(1)
  }

  console.log(JSON.stringify(summary))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'unhandled_error', error: String(err) }))
  process.exit(1)
})
