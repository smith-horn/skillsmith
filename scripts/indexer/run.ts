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
import type { IndexerRequest, IndexerResult } from './indexer-types.ts'
import type { SkillMdValidation } from './skill-processor.ts'

interface RunSummary {
  data: unknown
  meta: {
    request_id: string
    run_type: 'discovery' | 'maintenance'
    rate_limit_remaining_min: number
    secondary_rate_limit_hits: number
    retry_after_max_seconds: number
    concurrency: number
    kill_switch_engaged: boolean
    topics: string[]
    cron_slot: number | null
    rotation_source: RotationSource | 'maintenance'
  }
}

async function runDiscoveryBranch(
  env: IndexerEnv,
  requestId: string,
  telemetry: RateLimitTelemetry
): Promise<{ result: IndexerResult; topics: string[]; rotationSource: RotationSource }> {
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

  // SMI-4854: Prefetch repo_updated_at skip-gate map.
  const existingRepoUpdatedAt = new Map<string, string | null>()
  const { data: existingRows, error: prefetchError } = await supabase
    .from('skills')
    .select('repo_url, repo_updated_at')
    .not('repo_url', 'is', null)
  if (prefetchError) {
    console.error(
      JSON.stringify({
        event: 'repo_updated_at_prefetch_failed',
        error: prefetchError.message,
        request_id: requestId,
      })
    )
    // Non-fatal — empty map means no skip-gate hits this run; correctness preserved.
  } else {
    for (const row of (existingRows ?? []) as Array<{
      repo_url: string
      repo_updated_at: string | null
    }>) {
      if (row.repo_url) existingRepoUpdatedAt.set(row.repo_url, row.repo_updated_at ?? null)
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
    telemetry,
    concurrency: env.concurrency,
    killSwitchEngaged: env.kill_switch_engaged,
  })

  return { result, topics, rotationSource }
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
    process.exit(0)
  }

  let result: unknown = null
  let topics: string[] = []
  let rotationSource: RotationSource | 'maintenance' = 'maintenance'
  let runError: unknown = null

  try {
    if (env.RUN_TYPE === 'maintenance') {
      result = await runMaintenanceBranch(env, requestId, telemetry)
    } else {
      const discovery = await runDiscoveryBranch(env, requestId, telemetry)
      result = discovery.result
      topics = discovery.topics
      rotationSource = discovery.rotationSource
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

  const summary: RunSummary = {
    data: result,
    meta: {
      request_id: requestId,
      run_type: env.RUN_TYPE,
      concurrency: env.concurrency,
      kill_switch_engaged: env.kill_switch_engaged,
      topics,
      cron_slot: env.CRON_SLOT,
      rotation_source: rotationSource,
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
