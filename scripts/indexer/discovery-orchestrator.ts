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
  type TokenBucket,
  type RateLimitTelemetry,
} from './_shared/rate-limit.ts'
import { type SkillMdValidation } from './skill-processor.ts'
import { reconcileStaleSkills } from './stale-reconciliation.ts'
import { notifyBulkQuarantine } from './_shared/notification.ts'
import { runSubdirectorySearch } from './subdirectory-search.ts'
import { runCategorization, runCodeSearch, runUpsertPhase } from './indexer-runners.ts'
import { applyTreeHashTouches, type TreeHashTouchEntry } from './tree-hash-touch.ts'
import type { RotationSource } from './topic-rotation.ts'
import type { IndexerRequest, IndexerResult } from './indexer-types.ts'
import { runHighTrustPhase } from './phases/high-trust.ts'
import { runTopicSearchPhase } from './phases/topic-search.ts'
import type { TreeHashCache, TreeHashCacheCounters } from './high-trust-indexer.ts'
import {
  type DiscoveryPhase,
  selectCategorizationRepoUrls,
  writeDiscoveryAuditLog,
} from './discovery-orchestrator.phase-split.ts'

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
  /**
   * SMI-4870 Wave 2: per-phase sub-slot selector. The single discovery cron
   * is split into 3 hourly sub-slots, each a separate Node process running
   * ONE phase:
   *   1 → Phase 1 (high-trust) + Phase 4 upsert + Phase 7 audit.
   *   2 → Phase 2 (topic search) + Phase 4 upsert + Phase 7 audit.
   *   3 → Phase 3a/3b (code search) + Phase 4 upsert + finalize
   *       (Phase 5 categorize, Phase 6 stale) + Phase 7 audit.
   * UNSET (`undefined`) → legacy `workflow_dispatch` / maintenance path: all
   * 7 phases run in sequence over the shared in-memory accumulators,
   * byte-identical to pre-SMI-4870 behaviour.
   */
  discoveryPhase?: DiscoveryPhase
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
    discoveryPhase,
  } = params

  // SMI-4870: phase gates. When `discoveryPhase` is unset every gate is true,
  // so the legacy all-phases-in-sequence path is byte-identical. When a
  // sub-slot is selected only that phase's discovery work runs; Phase 4
  // upsert and Phase 7 audit always run; the FINALIZE phases (5 categorize,
  // 6 stale) run only in the phase-3 sub-slot (or the legacy path).
  const runPhase1 = discoveryPhase === undefined || discoveryPhase === 1
  const runPhase2 = discoveryPhase === undefined || discoveryPhase === 2
  const runPhase3 = discoveryPhase === undefined || discoveryPhase === 3
  const runFinalize = discoveryPhase === undefined || discoveryPhase === 3

  // SMI-4861 Wave 1: per-skill tree-hash cache counters. Accumulated by
  // Phase 1 only (blob SHAs require Trees API). Safe under pMapBounded
  // concurrency: `++` is synchronous and non-yielding, so JS's single-thread
  // event loop guarantees atomicity even across parallel author workers.
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
  // SMI-4861 cache-refresh-on-hit: collect per-hit touches; batch-refresh
  // last_tree_hash_check after Phase 1 so cached rows stay fresh.
  // SMI-4870: `highTrustSkillMap` + `wildcardExpansionCount` are consumed by
  // Phase 4 / Phase 7. They default empty/0 when Phase 1 is skipped so the
  // downstream phases stay shape-stable in the phase-2/3 sub-slots.
  const highTrustSkillMap: Map<string, HighTrustAuthor> = new Map()
  let wildcardExpansionCount = 0
  if (runPhase1) {
    const treeHashTouches: TreeHashTouchEntry[] = []
    const phase1 = await runHighTrustPhase({
      validationCache,
      validationOptions,
      telemetry,
      concurrency,
      treeHashCache,
      cacheCounters,
      treeHashTouches,
    })
    if (treeHashTouches.length > 0) {
      const touchResult = await applyTreeHashTouches(supabase, treeHashTouches)
      if (touchResult.errors.length > 0) {
        console.warn(
          `[Phase1] tree_hash touch errors (${touchResult.errors.length}/${treeHashTouches.length}): ${touchResult.errors.slice(0, 3).join('; ')}`
        )
      }
      console.log(
        `[Phase1] tree_hash touches: ${touchResult.ok}/${treeHashTouches.length} refreshed`
      )
    }
    for (const skill of phase1.repos) {
      if (!seenUrls.has(skill.url)) {
        seenUrls.add(skill.url)
        repositories.push(skill)
      }
    }
    result.errors.push(...phase1.errors)
    for (const [url, author] of phase1.highTrustSkillMap) {
      highTrustSkillMap.set(url, author)
    }
    wildcardExpansionCount = phase1.wildcardExpansionCount
    result.high_trust_wildcard = {
      authors_with_wildcards: phase1.authorsWithWildcards,
      total_paths_expanded: phase1.wildcardExpansionCount,
      trees_api_calls: phase1.treesApiCallCount,
      truncated_responses: phase1.truncatedResponseCount,
    }
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

  // SMI-4870: in a phase-2 sub-slot `seenUrls`/`repositories` start empty
  // (Phase 1 didn't run in this process). That is correct — cross-process
  // dedup of *unchanged* repos is handled by the `existingRepoUpdatedAt`
  // prefetch (process-independent), not by the in-memory accumulators.
  let topicSearchFound = 0
  if (runPhase2) {
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
    topicSearchFound = phase2.topicSearchFound
    console.log(
      `[Phase2] skip-gate hits: ${phase2.phase2SkipGateHits} of ${phase2.topicRepoCount} repos (skipped checkSkillMdExists)`
    )
  }
  result.found = highTrustSkillMap.size + topicSearchFound

  // ── Phase 3a: Code search for root-level SKILL.md ────────────────────
  // SMI-4861 Wave 1 / SMI-4859: env-gated default OFF. Phase 3a has produced
  // 0 new repos for 25+ consecutive days (RCA confirms Phase 1/2 dedup
  // already covers every candidate). Re-enable via
  // SKILLSMITH_ENABLE_CODE_SEARCH=true. Pattern mirrors Phase 3b at :230 —
  // direct process.env read, NOT threaded through IndexerEnv (would be a
  // separate refactor of parse-env.ts covering both phases).
  // SMI-4870: only the phase-3 sub-slot (or the legacy path) runs code search.
  if (runPhase3 && process.env.SKILLSMITH_ENABLE_CODE_SEARCH === 'true') {
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
      console.warn(
        `[CodeSearch] Phase 3a failed: ${err instanceof Error ? err.message : 'Unknown'}`
      )
      result.code_search = { repos_found: 0, retries: 0, error: 'phase_failed' }
    }
  } else {
    // Phase 3a disabled — surface as a zero-counter so audit telemetry is
    // unambiguous (vs. older crons where the phase ran but found 0).
    // SMI-4870: distinguish "not this sub-slot" from "env-disabled".
    result.code_search = {
      repos_found: 0,
      retries: 0,
      error: runPhase3 ? 'disabled_by_env' : 'skipped_phase_split',
    }
  }

  // ── Phase 3b: Subdirectory code search (SMI-2660) ────────────────────
  // Gated by env var — each path prefix costs 1 code search API call per run.
  // Enable with: SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH=true
  // SMI-4870: only the phase-3 sub-slot (or the legacy path) runs subdir search.
  if (runPhase3 && process.env.SKILLSMITH_ENABLE_SUBDIRECTORY_SEARCH === 'true') {
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

  // Count total SKILL.md files on GitHub for homepage stats display.
  // SMI-4870: this homepage-stats GitHub call runs once per cycle — in the
  // phase-3 sub-slot (or the legacy path) — so the 3-sub-slot split doesn't
  // triple the API cost. Phase-1/2 sub-slots leave `github_skill_count` at 0.
  if (runFinalize) {
    const {
      total: githubSkillCount,
      breakdown: githubSkillBreakdown,
      error: countError,
    } = await countGitHubSkillFiles(telemetry)
    result.github_skill_count = githubSkillCount
    result.github_skill_breakdown = githubSkillBreakdown
    if (countError) console.warn(`[SkillCount] ${countError}`)
    await delay(GITHUB_API_DELAY)
  }

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

  // SMI-4870: in the legacy (`discoveryPhase` unset) path the whole finalize
  // block is still gated on `repositories.length > 0`, byte-identical to
  // before. In a sub-slot we always reach Phase 7 (each sub-slot writes its
  // own audit row), and Phases 5/6 run only in the phase-3 sub-slot.
  const runFinalizeBlock = !dryRun && (discoveryPhase !== undefined || repositories.length > 0)

  if (runFinalizeBlock) {
    if (runFinalize) {
      // ── Phase 5: Categorization ──────────────────────────────────────
      // SMI-4870 fix #8: in a phase-3 sub-slot the in-memory `repositories[]`
      // holds only Phase 3's repos (empty — Phase 3 is env-gated off), so
      // iterating it would categorize nothing. Source the repo list from the
      // `skills` table instead (rows touched this cycle / never categorized).
      // The legacy path keeps its in-memory behaviour — no regression.
      const catRepoUrls = discoveryPhase === undefined ? repositories.map((r) => r.url) : undefined
      let repoUrlsForCategorization: string[]
      if (catRepoUrls !== undefined) {
        repoUrlsForCategorization = catRepoUrls
      } else {
        const selected = await selectCategorizationRepoUrls(supabase)
        repoUrlsForCategorization = selected.repoUrls
        result.errors.push(...selected.errors)
      }
      const catResult = await runCategorization(supabase, repoUrlsForCategorization)
      categorizedCount = catResult.categorizedCount
      categoryAssignments = catResult.categoryAssignments
      result.errors.push(...catResult.errors)

      // ── Phase 6: Stale reconciliation ────────────────────────────────
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
    }

    // ── Phase 7: Audit log ───────────────────────────────────────────────
    // SMI-4870: every sub-slot writes its own audit row; the payload assembly
    // lives in `writeDiscoveryAuditLog` (phase-split helper) so this file
    // stays under its LOC budget. `discovery_phase` is recorded in the meta
    // envelope so monitoring can `GROUP BY` cycle.
    await writeDiscoveryAuditLog(supabase, {
      requestId,
      topics,
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
      wildcardExpansionCount,
      subdirectory_search: result.subdirectory_search,
      cronSlot,
      rotationSource,
      discoveryPathCounts: upsertResult.discoveryPathCounts,
      highTrustFallbackHits: upsertResult.high_trust_fallback_hits,
      telemetry,
      concurrency,
      killSwitchEngaged,
      treeHashCacheHits: cacheCounters.hits,
      treeHashCacheMisses: cacheCounters.misses,
      discoveryPhase: discoveryPhase ?? null,
    })
  }

  result.repositories_found = repositories.length
  // SMI-4861 Wave 1 post-merge retro: also surface cache counters in stdout
  // RunSummary so cron logs show the hit ratio without a DB query.
  result.tree_hash_cache = { hits: cacheCounters.hits, misses: cacheCounters.misses }
  return result
}
