/**
 * Maintenance-run helpers (Node port)
 * @module scripts/indexer/maintenance-helpers
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/maintenance-helpers.ts`.
 * Pure logic + Supabase RPCs — no GitHub fetches. Byte-identical to the Deno
 * parent apart from the npm import for `@supabase/supabase-js` and the
 * relative imports landing inside `scripts/indexer/`.
 *
 * SMI-4241 + SMI-4376: Pure decision functions extracted from index.ts so
 * they can be unit-tested without invoking the Deno.serve handler. The
 * maintenance path short-circuits inside the outer try/finally lock envelope
 * and runs only Phase 6 (reconcileStaleSkills).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { reconcileStaleSkills } from './stale-reconciliation.ts'
import { notifyBulkQuarantine } from './_shared/notification.ts'
import { writeIndexerAuditLog } from './indexer-audit-log.ts'
import type { IndexerRequest } from './indexer-types.ts'

export interface StaleResult {
  staleQuarantined: number
  quarantinedIds: string[]
  errors: string[]
}

/**
 * Maintenance-run response payload.
 *
 * Every field is zero-filled except `stale`, `errors`, and `dryRun` — so
 * `.github/workflows/indexer.yml` `Parse Results` jq extracts the same keys
 * as a discovery run and its aggregations don't need to branch on run type.
 * `skipped: false` mirrors the lock-collision short-circuit shape.
 */
export interface MaintenanceResponseData {
  found: number
  indexed: number
  updated: number
  failed: number
  quarantined: number
  skipped: boolean
  stale: number
  quality_gate_filtered: number
  unchanged: number
  github_skill_count: number
  high_trust_wildcard: {
    authors_with_wildcards: number
    total_paths_expanded: number
    trees_api_calls: number
    truncated_responses: number
  }
  code_search: { repos_found: number; retries: number }
  errors: string[]
  dryRun: boolean
  repositories_found: number
}

/**
 * Resolve the maintenance stale-days threshold.
 *
 * Workflow always passes `staleThresholdDays: 7` explicitly (see
 * `.github/workflows/indexer.yml` "Configure Run" + heredoc — `$STALE_DAYS`
 * must stay unquoted so JSON renders numeric). The default here guards
 * ad-hoc curl/CLI callers who omit the field.
 *
 * Returns 7 by default (SMI-4203 production value). Any positive finite
 * numeric override is honored.
 */
export function resolveMaintenanceStaleThreshold(body: { staleThresholdDays?: unknown }): number {
  const raw = body.staleThresholdDays
  if (typeof raw === 'number' && !isNaN(raw) && isFinite(raw) && raw > 0) {
    return raw
  }
  return 7
}

/**
 * Build the maintenance-run response `data` payload.
 *
 * Zero-fills every field `.github/workflows/indexer.yml` Parse Results
 * reads via jq, plus `skipped: false` for symmetry with the lock-collision
 * short-circuit at index.ts:161-166.
 */
export function buildMaintenanceResponseData(
  staleResult: StaleResult,
  dryRun: boolean
): MaintenanceResponseData {
  return {
    found: 0,
    indexed: 0,
    updated: 0,
    failed: 0,
    quarantined: 0,
    skipped: false,
    stale: staleResult.staleQuarantined,
    quality_gate_filtered: 0,
    unchanged: 0,
    github_skill_count: 0,
    high_trust_wildcard: {
      authors_with_wildcards: 0,
      total_paths_expanded: 0,
      trees_api_calls: 0,
      truncated_responses: 0,
    },
    code_search: { repos_found: 0, retries: 0 },
    errors: [...staleResult.errors],
    dryRun,
    repositories_found: 0,
  }
}

/**
 * Classify the audit-log `result` field based on reconcile errors and
 * elapsed time.
 *
 * - `errors.length > 0` → 'partial'
 * - elapsed > 60 000 ms → 'partial' (reconcile took longer than expected;
 *   ops-report will surface the anomaly)
 * - otherwise → 'success'
 *
 * Returns the audit result plus a log level (`'warn' | 'error' | null`)
 * so callers can emit a human-readable console entry.
 */
export function classifyMaintenanceResult(
  staleResult: Pick<StaleResult, 'errors'>,
  elapsedMs: number
): {
  auditResult: 'success' | 'partial'
  logLevel: 'warn' | 'error' | null
  logMessage: string | null
} {
  if (elapsedMs > 60_000) {
    return {
      auditResult: 'partial',
      logLevel: 'error',
      logMessage: `[indexer:maintenance] reconcile took ${elapsedMs}ms — downgrading to partial`,
    }
  }
  if (elapsedMs > 30_000) {
    return {
      auditResult: staleResult.errors.length === 0 ? 'success' : 'partial',
      logLevel: 'warn',
      logMessage: `[indexer:maintenance] reconcile took ${elapsedMs}ms`,
    }
  }
  return {
    auditResult: staleResult.errors.length === 0 ? 'success' : 'partial',
    logLevel: null,
    logMessage: null,
  }
}

/**
 * SMI-4376: Maintenance-run orchestrator. Extracted from `index.ts` to
 * keep the outer handler thin. Runs reconcile + classify + quarantine
 * notifications + audit log emission, then returns the response payload.
 *
 * Must preserve:
 * - SMI-4374: `cron_slot: null`, `rotation_source: 'fallback'` (maintenance
 *   has no discovery slot)
 * - SMI-4387: `discovery_path_counts: {}` (key present, zero buckets;
 *   dashboards distinguish "maintenance ran" from "discovery yielded nothing")
 * - SMI-4386: `high_trust_fallback_hits: 0` hardcoded (maintenance never
 *   invokes `runUpsertPhase`)
 */
export async function runMaintenanceReconciliation(params: {
  supabase: SupabaseClient
  requestId: string
  body: IndexerRequest
  dryRun: boolean
}): Promise<MaintenanceResponseData> {
  const { supabase, requestId, body, dryRun } = params

  const staleThresholdDays = resolveMaintenanceStaleThreshold(body)

  const startedAt = Date.now()
  const staleResult = await reconcileStaleSkills(supabase, staleThresholdDays)
  const elapsedMs = Date.now() - startedAt

  // Timing guards: soft warn at 30s, hard error + downgrade to partial at 60s.
  const { auditResult, logLevel, logMessage } = classifyMaintenanceResult(staleResult, elapsedMs)
  if (logLevel === 'error' && logMessage) {
    console.error(logMessage)
  } else if (logLevel === 'warn' && logMessage) {
    console.warn(logMessage)
  }

  if (staleResult.quarantinedIds.length > 0 && !dryRun) {
    await notifyBulkQuarantine(supabase, staleResult.quarantinedIds)
  }

  // event_type stays 'indexer:run' — load-bearing across v_indexer_health
  // (migration 051), ops-report, stats, and migration 059 views. Use
  // metadata.run_type = 'maintenance' to distinguish maintenance rows.
  await writeIndexerAuditLog(supabase, auditResult, {
    requestId,
    topics: [],
    runType: 'maintenance',
    dryRun,
    found: 0,
    indexed: 0,
    updated: 0,
    failed: 0,
    stale: staleResult.staleQuarantined,
    quality_gate_filtered: 0,
    unchanged: 0,
    quarantined: 0,
    github_skill_count: 0,
    code_search: { repos_found: 0, retries: 0 },
    scoreDistribution: { highTrust: 0, community: 0, scores: [] },
    categorizedCount: 0,
    categoryAssignments: 0,
    wildcard_expansion_count: 0,
    // SMI-4374: maintenance has no slot rotation — record nulls for ops-report slicing.
    cron_slot: null,
    rotation_source: 'fallback',
    // SMI-4387: maintenance never runs discovery — emit empty `{}` (key present,
    // zero buckets) so dashboards can distinguish "maintenance ran" from
    // "discovery ran, yielded nothing".
    discovery_path_counts: {},
    // SMI-4386: maintenance never runs runUpsertPhase — hardcode zero so the
    // field is present in every audit_logs row and dashboards don't need COALESCE.
    high_trust_fallback_hits: 0,
  })

  return buildMaintenanceResponseData(staleResult, dryRun)
}
