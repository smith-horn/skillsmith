/**
 * Discovery orchestrator (Node port)
 * @module scripts/indexer/discovery-orchestrator
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/discovery-orchestrator.ts`. Mechanical changes:
 * `Deno.env.get(...)` → `process.env.X`; npm `@supabase/supabase-js` import.
 * Plan issue #14 structural split: Phase-1 and Phase-2 loops extracted to
 * `./phases/{high-trust,topic-search}.ts` to stay under 350 LOC. Hard Rule 1
 * (`withRateLimitTracking`) is applied at each GitHub-fetch call site
 * (high-trust-indexer / topic-search / code-search / trees-search); this
 * orchestrator threads the run-scoped `RateLimitTelemetry` to Phase 1.
 *
 * Phases: 1 high-trust → 2 topic search → 3a code search → 3b subdir search
 *       → 4 upsert → 5 categorization → 6 stale reconciliation → 7 audit log
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { HIGH_TRUST_AUTHORS, type HighTrustAuthor } from './high-trust-authors.ts'
import { type GitHubRepository, countGitHubSkillFiles } from './topic-search.ts'
import {
  GITHUB_API_DELAY,
  delay,
  summarizeRateLimitTelemetry,
  type TokenBucket,
  type RateLimitTelemetry,
} from './_shared/rate-limit.ts'
import { type SkillMdValidation } from './skill-processor.ts'
import { reconcileStaleSkills } from './stale-reconciliation.ts'
import { notifyBulkQuarantine } from './_shared/notification.ts'
import { runSubdirectorySearch } from './subdirectory-search.ts'
import {
  runCategorization,
  runCodeSearch,
  runUpsertPhase,
  writeIndexerAuditLog,
} from './indexer-runners.ts'
import type { RotationSource } from './topic-rotation.ts'
import type { IndexerRequest, IndexerResult } from './indexer-types.ts'
import { runHighTrustPhase } from './phases/high-trust.ts'
import { runTopicSearchPhase } from './phases/topic-search.ts'
import type { TreeHashCache, TreeHashCacheCounters } from './high-trust-indexer.ts'

/**
 * Parameters for `runDiscovery`.
 *
 * The dispatcher (`run.ts`) resolves topics via `selectTopics` (SMI-4374) and
 * constructs this shape before invocation. Internal state (`seenUrls`,
 * `repositories`, `highTrustSkillMap`, `IndexerResult`) is created inside
 * `runDiscovery` and not threaded through the caller — the orchestrator owns
 * the accumulators for Phases 1-3 dedup and Phase 4 upsert.
 */
export interface RunDiscoveryParams {
  supabase: SupabaseClient
  requestId: string
  body: IndexerRequest
  topics: string[]
  rotationSource: RotationSource
  cronSlot: number | null
  maxPages: number
  maxTopicRepos: number
  codeSearchMaxPages: number
  dryRun: boolean
  validationOptions: { strictValidation: boolean; minContentLength: number }
  validationCache: Map<string, SkillMdValidation>
  /**
   * SMI-4846: Singleton token bucket pacing GitHub Search API (30 rpm).
   * Used by Phase 2; per-worker buckets would breach the cumulative quota.
   */
  searchApiTokenBucket: TokenBucket
  /**
   * SMI-4846: Singleton token bucket pacing GitHub Code Search API (10 rpm).
   * RESERVED — Phase 3a is serial in this PR; wired through here so the
   * follow-up parallelization PR has a stable seam.
   */
  codeSearchTokenBucket: TokenBucket
  /**
   * SMI-4854: Skip-gate map for upstream discovery phases. Maps `repo_url`
   * to its prior `repo_updated_at`; populated once at function entry from
   * the `skills` table.
   */
  existingRepoUpdatedAt: Map<string, string | null>
  /**
   * SMI-4861 Wave 1: per-skill tree-hash TTL cache, prefetched at run start
   * from the new `skills.tree_hash` + `last_tree_hash_check` columns. Maps
   * `${repo_url}:${skill_path}` to its prior tree_hash + last check timestamp.
   * Empty Map on cold cache (first cron after merge); populates naturally.
   */
  treeHashCache: TreeHashCache
  /**
   * SMI-4852: Run-scoped rate-limit telemetry. The entrypoint creates one
   * instance per run, threads it through every GitHub fetch via
   * `withRateLimitTracking`, and flushes the summary into
   * `audit_logs.metadata` at end-of-run.
   */
  telemetry: RateLimitTelemetry
  /**
   * SMI-4852: Worker concurrency for Phase 1. Resolved by `parseEnv()` in the
   * entrypoint (default 2; 1 if CONCURRENCY_KILL_SWITCH=1).
   */
  concurrency: number
  /**
   * SMI-4857: Kill-switch state from `parseEnv()` (`CONCURRENCY_KILL_SWITCH`).
   * Threaded through purely so the Phase 7 audit log can persist the stdout
   * `RunSummary.meta.kill_switch_engaged` value into `audit_logs.metadata.meta`.
   */
  killSwitchEngaged: boolean
}

export async function runDiscovery(params: RunDiscoveryParams): Promise<IndexerResult> {
  const {
    supabase,
    requestId,
    body,
    topics,
    rotationSource,
    cronSlot,
    maxPages,
    maxTopicRepos,
    codeSearchMaxPages,
    dryRun,
    validationOptions,
    validationCache,
    searchApiTokenBucket,
    existingRepoUpdatedAt,
    treeHashCache,
    telemetry,
    concurrency,
    killSwitchEngaged,
  } = params

  // SMI-4861 Wave 1: per-skill tree-hash cache counters. Accumulated by
  // Phase 1 (high-trust) where blob SHAs are available from the Trees API.
  // Phase 2 + Phase 3a do not benefit in Wave 1 (no blob SHAs threaded).
  const cacheCounters: TreeHashCacheCounters = { hits: 0, misses: 0 }
  // codeSearchTokenBucket is reserved for the follow-up Phase 3a parallelization PR.
  // Reference it once so unused-vars doesn't flag the param.
  void params.codeSearchTokenBucket

  const result: IndexerResult = {
    found: 0,
    indexed: 0,
    updated: 0,
    failed: 0,
    quarantined: 0,
    stale: 0,
    quality_gate_filtered: 0,
    unchanged: 0,
    github_skill_count: 0,
    high_trust_wildcard: {
      authors_with_wildcards: 0,
      total_paths_expanded: 0,
      trees_api_calls: 0,
      truncated_responses: 0,
    },
    errors: [],
    dryRun,
  }

  const seenUrls = new Set<string>()
  const repositories: GitHubRepository[] = []

  // ── Phase 1: High-trust authors ──────────────────────────────────────
  // Plan issue #14: extracted to phases/high-trust.ts to keep this file < 350 LOC.
  const phase1 = await runHighTrustPhase({
    validationCache,
    validationOptions,
    telemetry,
    concurrency,
    treeHashCache,
    cacheCounters,
  })
  for (const skill of phase1.repos) {
    if (!seenUrls.has(skill.url)) {
      seenUrls.add(skill.url)
      repositories.push(skill)
    }
  }
  result.errors.push(...phase1.errors)
  const highTrustSkillMap: Map<string, HighTrustAuthor> = phase1.highTrustSkillMap
  result.high_trust_wildcard = {
    authors_with_wildcards: phase1.authorsWithWildcards,
    total_paths_expanded: phase1.wildcardExpansionCount,
    trees_api_calls: phase1.treesApiCallCount,
    truncated_responses: phase1.truncatedResponseCount,
  }
  // Reference HIGH_TRUST_AUTHORS to preserve the import surface used by the
  // Phase-1 logging contract — the parent orchestrator owns the audit-log
  // payload that downstream consumers expect even though the loop body now
  // lives in phases/high-trust.ts.
  void HIGH_TRUST_AUTHORS

  // ── Phase 2: Topic search ────────────────────────────────────────────
  // Freshness targeting on discovery runs (always enabled here — maintenance
  // branch never reaches this path).
  const freshnessDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const phase2 = await runTopicSearchPhase({
    topics,
    maxPages,
    maxTopicRepos,
    freshnessDate,
    seenUrls,
    repositories,
    validationCache,
    validationOptions,
    searchApiTokenBucket,
    existingRepoUpdatedAt,
    telemetry,
  })
  result.errors.push(...phase2.errors)
  result.failed += phase2.failed
  result.found = highTrustSkillMap.size + phase2.topicSearchFound
  console.log(
    `[Phase2] skip-gate hits: ${phase2.phase2SkipGateHits} of ${phase2.topicRepoCount} repos (skipped checkSkillMdExists)`
  )

  // ── Phase 3a: Code search for root-level SKILL.md ────────────────────
  // SMI-4861 Wave 1 / SMI-4859: env-gated default OFF. Phase 3a has produced
  // 0 new repos for 25+ consecutive days (RCA confirms Phase 1/2 dedup
  // already covers every candidate). Re-enable via
  // SKILLSMITH_ENABLE_CODE_SEARCH=true. Pattern mirrors Phase 3b at :230 —
  // direct process.env read, NOT threaded through IndexerEnv (would be a
  // separate refactor of parse-env.ts covering both phases).
  if (process.env.SKILLSMITH_ENABLE_CODE_SEARCH === 'true') {
    try {
      const {
        repos: codeRepos,
        repos_found,
        retries,
        error,
        skipGateHits,
      } = await runCodeSearch(
        seenUrls,
        freshnessDate,
        validationCache,
        validationOptions,
        codeSearchMaxPages,
        telemetry,
        existingRepoUpdatedAt
      )
      for (const repo of codeRepos) repositories.push(repo)
      result.code_search = { repos_found, retries, error }
      console.log(`[Phase3a] skip-gate hits: ${skipGateHits ?? 0} of ${repos_found} repos`)
    } catch (err) {
      console.warn(`[CodeSearch] Phase 3a failed: ${err instanceof Error ? err.message : 'Unknown'}`)
      result.code_search = { repos_found: 0, retries: 0, error: 'phase_failed' }
    }
  } else {
    // Phase 3a disabled — surface as a zero-counter so audit telemetry is
    // unambiguous (vs. older crons where the phase ran but found 0).
    result.code_search = { repos_found: 0, retries: 0, error: 'disabled_by_env' }
  }

  // ── Phase 3b: Subdirectory code search (SMI-2660) ────────────────────
  // Gated by env var — each path prefix costs 1 code search API call per run.
  // Enable with: SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH=true
  if (process.env.SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH === 'true') {
    try {
      const subdirResult = await runSubdirectorySearch(
        seenUrls,
        freshnessDate,
        validationCache,
        validationOptions,
        codeSearchMaxPages,
        telemetry
      )
      for (const repo of subdirResult.repos) {
        repositories.push(repo)
      }
      result.errors.push(...subdirResult.errors)
      result.subdirectory_search = {
        repos_found: subdirResult.repos.length,
        total_found: subdirResult.totalFound,
        retries: subdirResult.retries,
        license_filtered: subdirResult.licenseFiltered,
        license_fetch_failed: subdirResult.licenseFetchFailed,
        incomplete_results: subdirResult.incompleteResults,
        search_mode: subdirResult.searchMode,
      }
    } catch (err) {
      console.warn(
        `[CodeSearch] Phase 3b failed: ${err instanceof Error ? err.message : 'Unknown'}`
      )
      result.subdirectory_search = {
        repos_found: 0,
        total_found: 0,
        retries: 0,
        license_filtered: 0,
        license_fetch_failed: 0,
        error: 'phase_failed',
      }
    }
  }

  // Count total SKILL.md files on GitHub for homepage stats display
  const {
    total: githubSkillCount,
    breakdown: githubSkillBreakdown,
    error: countError,
  } = await countGitHubSkillFiles(telemetry)
  result.github_skill_count = githubSkillCount
  result.github_skill_breakdown = githubSkillBreakdown
  if (countError) console.warn(`[SkillCount] ${countError}`)
  await delay(GITHUB_API_DELAY)

  // ── Phase 4: Database upsert ─────────────────────────────────────────
  const upsertResult = await runUpsertPhase(
    supabase,
    repositories,
    highTrustSkillMap,
    validationCache,
    dryRun,
    telemetry
  )
  result.indexed = upsertResult.indexed
  result.updated = upsertResult.updated
  result.failed = upsertResult.failed
  result.quarantined = upsertResult.quarantined
  result.unchanged = upsertResult.unchanged
  result.quality_gate_filtered = upsertResult.quality_gate_filtered
  result.errors.push(...upsertResult.errors)

  let categorizedCount = 0
  let categoryAssignments = 0

  if (!dryRun && repositories.length > 0) {
    // ── Phase 5: Categorization ────────────────────────────────────────
    const catResult = await runCategorization(
      supabase,
      repositories.map((r) => r.url)
    )
    categorizedCount = catResult.categorizedCount
    categoryAssignments = catResult.categoryAssignments
    result.errors.push(...catResult.errors)

    // ── Phase 6: Stale reconciliation ──────────────────────────────────
    const rawStaleThreshold = body.staleThresholdDays
    const staleThresholdDays =
      typeof rawStaleThreshold === 'number' && !isNaN(rawStaleThreshold) ? rawStaleThreshold : 30
    const staleResult = await reconcileStaleSkills(supabase, staleThresholdDays)
    result.stale = staleResult.staleQuarantined
    result.errors.push(...staleResult.errors)

    // SMI-3347: Notify if any author had >= 3 skills quarantined in this run
    if (staleResult.quarantinedIds.length > 0 && !dryRun) {
      await notifyBulkQuarantine(supabase, staleResult.quarantinedIds)
    }

    // ── Phase 7: Audit log ─────────────────────────────────────────────
    // SMI-4857: Build the run-scoped meta envelope mirroring the stdout
    // `RunSummary.meta` shape from `run.ts`. Persisted under
    // `audit_logs.metadata.meta` so SQL monitors (SMI-4861 API-budget tracking)
    // can read rate-limit + kill-switch state without re-deriving from views.
    const rateLimitSummary = summarizeRateLimitTelemetry(telemetry)
    await writeIndexerAuditLog(supabase, result.failed === 0 ? 'success' : 'partial', {
      requestId,
      topics,
      runType: 'discovery',
      dryRun,
      found: result.found,
      indexed: result.indexed,
      updated: result.updated,
      failed: result.failed,
      stale: result.stale,
      quality_gate_filtered: result.quality_gate_filtered,
      unchanged: result.unchanged,
      quarantined: result.quarantined,
      github_skill_count: result.github_skill_count,
      code_search: result.code_search,
      scoreDistribution: upsertResult.scoreDistribution,
      categorizedCount,
      categoryAssignments,
      wildcard_expansion_count: phase1.wildcardExpansionCount,
      subdirectory_search: result.subdirectory_search,
      cron_slot: cronSlot,
      rotation_source: rotationSource,
      discovery_path_counts: upsertResult.discoveryPathCounts,
      high_trust_fallback_hits: upsertResult.high_trust_fallback_hits,
      meta: {
        request_id: requestId,
        run_type: 'discovery',
        rate_limit_remaining_min: rateLimitSummary.rate_limit_remaining_min,
        secondary_rate_limit_hits: rateLimitSummary.secondary_rate_limit_hits,
        retry_after_max_seconds: rateLimitSummary.retry_after_max_seconds,
        concurrency,
        kill_switch_engaged: killSwitchEngaged,
        topics,
        cron_slot: cronSlot,
        rotation_source: rotationSource,
        // SMI-4861 Wave 1: tree-hash cache observability. Phase 1 sole
        // contributor in this wave; Wave 4 may extend to Phase 2 / 3a.
        tree_hash_cache_hits: cacheCounters.hits,
        tree_hash_cache_misses: cacheCounters.misses,
      },
    })
  }

  result.repositories_found = repositories.length
  return result
}
