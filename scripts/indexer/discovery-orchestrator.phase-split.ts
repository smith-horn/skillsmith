/**
 * Per-phase discovery split helpers (SMI-4870)
 * @module scripts/indexer/discovery-orchestrator.phase-split
 *
 * SMI-4870 Wave 2: the single discovery cron is split into 3 hourly per-phase
 * sub-slots so the GitHub-API burst is redistributed. Each sub-slot is a
 * separate Node process running ONE phase (`discoveryPhase` 1/2/3). This
 * module owns the bits of `runDiscovery` that change shape when running a
 * sub-slot — kept out of `discovery-orchestrator.ts` so that file stays
 * under its < 350 LOC budget.
 *
 * Invariant: when `discoveryPhase` is unset (`workflow_dispatch` / maintenance
 * path) none of these helpers run — `runDiscovery` keeps its byte-identical
 * 7-phase-in-sequence behaviour over the shared in-memory accumulators.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { summarizeRateLimitTelemetry, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { writeIndexerAuditLog } from './indexer-runners.ts'
import type { ScoreDistribution } from './indexer-runners.ts'
import type { RotationSource } from './topic-rotation.ts'
import { reconcileStaleSkills } from './stale-reconciliation.ts'
import { notifyBulkQuarantine } from './_shared/notification.ts'

/**
 * SMI-4870: the per-phase sub-slot a discovery process is running.
 * `undefined` → legacy all-phases-in-sequence path (`workflow_dispatch` /
 * maintenance); 1 → high-trust, 2 → topic search, 3 → code search + finalize.
 */
export type DiscoveryPhase = 1 | 2 | 3

/**
 * SMI-4870 fix #8: source Phase 5 categorization from the `skills` table
 * rather than the in-memory `repositories[]`.
 *
 * In a phase-3 sub-slot the in-memory `repositories[]` holds only Phase 3's
 * repos (empty today — Phase 3 is env-gated off), so iterating it would
 * silently categorize nothing. Instead we query the `skills` table for rows
 * this cycle could have touched: `last_seen_at` within the cycle window.
 * Phase 4's upsert refreshes `last_seen_at` for every sighting (new and
 * unchanged), so this set covers every repo discovered in phases 1/2/3 of
 * the current cycle.
 *
 * The returned `repo_url`s are fed straight into the existing
 * `runCategorization(supabase, repoUrls)` — no change to its body.
 *
 * @param supabase - Supabase admin client
 * @param cycleWindowHours - how far back `last_seen_at` counts as "this cycle"
 *   (default 4h — the 3 hourly sub-slots plus headroom for slot skew)
 * @returns deduped `repo_url`s needing categorization, and any non-fatal errors
 */
export async function selectCategorizationRepoUrls(
  supabase: SupabaseClient,
  cycleWindowHours = 4
): Promise<{ repoUrls: string[]; errors: string[] }> {
  const errors: string[] = []
  const since = new Date(Date.now() - cycleWindowHours * 60 * 60 * 1000).toISOString()
  const urls = new Set<string>()

  // Rows touched this cycle (Phase 4 upsert refreshes `last_seen_at` for both
  // new and unchanged sightings — see indexer-runners.ts SMI-3540 touch path).
  const { data: recentRows, error: recentError } = await supabase
    .from('skills')
    .select('repo_url')
    .gte('last_seen_at', since)
  if (recentError) {
    errors.push(`[Phase5] recent-rows query failed: ${recentError.message}`)
  } else {
    for (const row of (recentRows ?? []) as Array<{ repo_url: string | null }>) {
      if (row.repo_url) urls.add(row.repo_url)
    }
  }

  return { repoUrls: [...urls], errors }
}

/**
 * SMI-4870: inputs for the Phase 7 discovery audit-log write. Extracted from
 * `runDiscovery` so `discovery-orchestrator.ts` stays under its LOC budget.
 */
export interface DiscoveryAuditLogInput {
  requestId: string
  topics: string[]
  dryRun: boolean
  found: number
  indexed: number
  updated: number
  failed: number
  stale: number
  quality_gate_filtered: number
  /** SMI-4842: Repos rejected as curated `awesome-*` link-lists (not skills). */
  meta_list_filtered: number
  unchanged: number
  quarantined: number
  github_skill_count: number
  code_search: Record<string, unknown> | undefined
  scoreDistribution: ScoreDistribution
  categorizedCount: number
  categoryAssignments: number
  wildcardExpansionCount: number
  subdirectory_search: Record<string, unknown> | undefined
  cronSlot: number | null
  rotationSource: RotationSource
  discoveryPathCounts: Record<string, number>
  highTrustFallbackHits: number
  telemetry: RateLimitTelemetry
  concurrency: number
  killSwitchEngaged: boolean
  treeHashCacheHits: number
  treeHashCacheMisses: number
  /** SMI-4870: per-phase sub-slot that wrote this row (null = legacy run). */
  discoveryPhase: DiscoveryPhase | null
}

/**
 * Phase 7: write the discovery run's audit-log row.
 *
 * SMI-4857: the `meta` envelope mirrors the stdout `RunSummary.meta` shape so
 * SQL monitors read rate-limit + kill-switch state without re-deriving from
 * views. SMI-4870: every per-phase sub-slot writes its own row, and the
 * sub-slot index is recorded under `meta.discovery_phase` so monitoring can
 * `GROUP BY` cycle.
 */
export async function writeDiscoveryAuditLog(
  supabase: SupabaseClient,
  input: DiscoveryAuditLogInput
): Promise<void> {
  const rateLimitSummary = summarizeRateLimitTelemetry(input.telemetry)
  // Assign the meta to a typed variable first so the extra `discovery_phase`
  // key isn't rejected by TS excess-property checks on a fresh call literal.
  const auditMeta = {
    request_id: input.requestId,
    run_type: 'discovery' as const,
    rate_limit_remaining_min: rateLimitSummary.rate_limit_remaining_min,
    // SMI-4918: per-bucket minimums so monitoring can tell which GitHub
    // budget a sub-slot exhausted (core vs search vs code_search).
    core_remaining_min: rateLimitSummary.core_remaining_min,
    search_remaining_min: rateLimitSummary.search_remaining_min,
    code_search_remaining_min: rateLimitSummary.code_search_remaining_min,
    secondary_rate_limit_hits: rateLimitSummary.secondary_rate_limit_hits,
    retry_after_max_seconds: rateLimitSummary.retry_after_max_seconds,
    concurrency: input.concurrency,
    kill_switch_engaged: input.killSwitchEngaged,
    topics: input.topics,
    cron_slot: input.cronSlot,
    rotation_source: input.rotationSource,
    tree_hash_cache_hits: input.treeHashCacheHits,
    tree_hash_cache_misses: input.treeHashCacheMisses,
    discovery_phase: input.discoveryPhase,
  }
  await writeIndexerAuditLog(supabase, input.failed === 0 ? 'success' : 'partial', {
    requestId: input.requestId,
    topics: input.topics,
    runType: 'discovery',
    dryRun: input.dryRun,
    found: input.found,
    indexed: input.indexed,
    updated: input.updated,
    failed: input.failed,
    stale: input.stale,
    quality_gate_filtered: input.quality_gate_filtered,
    meta_list_filtered: input.meta_list_filtered,
    unchanged: input.unchanged,
    quarantined: input.quarantined,
    github_skill_count: input.github_skill_count,
    code_search: input.code_search,
    scoreDistribution: input.scoreDistribution,
    categorizedCount: input.categorizedCount,
    categoryAssignments: input.categoryAssignments,
    wildcard_expansion_count: input.wildcardExpansionCount,
    subdirectory_search: input.subdirectory_search,
    cron_slot: input.cronSlot,
    rotation_source: input.rotationSource,
    discovery_path_counts: input.discoveryPathCounts,
    high_trust_fallback_hits: input.highTrustFallbackHits,
    meta: auditMeta,
  })
}

/**
 * Phase 6 (stale reconciliation) extracted from `runDiscovery` to keep
 * `discovery-orchestrator.ts` under the 500-line CI gate (SMI-5286 Wave 1b).
 *
 * Quarantines skills whose `last_seen_at` is older than the stale threshold,
 * then bulk-notifies authors with ≥3 quarantines (SMI-3347). **Skipped entirely
 * in backfill mode** (SMI-5286 §#5): a backfill enriches against a PARTIALLY
 * crawled set, so a stale sweep mid-backfill would age-out + quarantine real
 * skills the crawl simply hasn't re-touched. The cron owns the stale sweep, and
 * backfilled rows stamp a fresh `last_seen_at` at insert so the next cron leaves
 * them be.
 *
 * @param supabase - Supabase admin client.
 * @param staleThresholdDays - raw `body.staleThresholdDays`; coerced to 30 when
 *   not a finite number.
 * @param dryRun - when true, suppresses the bulk-quarantine notification.
 * @param backfillMode - when true, the whole phase is a no-op (returns zeros).
 * @returns `{ stale, errors }` for the caller to fold into the run result.
 */
export async function runStaleReconciliationPhase(
  supabase: SupabaseClient,
  staleThresholdDays: number | undefined,
  dryRun: boolean,
  backfillMode: boolean
): Promise<{ stale: number; errors: string[] }> {
  if (backfillMode) {
    console.log('[Backfill] SMI-5286: skipping Phase 6 stale reconciliation (backfill mode)')
    return { stale: 0, errors: [] }
  }
  const threshold =
    typeof staleThresholdDays === 'number' && !isNaN(staleThresholdDays) ? staleThresholdDays : 30
  const staleResult = await reconcileStaleSkills(supabase, threshold)
  // SMI-3347: Notify if any author had >= 3 skills quarantined in this run.
  if (staleResult.quarantinedIds.length > 0 && !dryRun) {
    await notifyBulkQuarantine(supabase, staleResult.quarantinedIds)
  }
  return { stale: staleResult.staleQuarantined, errors: staleResult.errors }
}
