/**
 * Stale skill detection and quarantine (Node port)
 * @module scripts/indexer/stale-reconciliation
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/indexer/stale-reconciliation.ts`.
 * Pure Supabase RPC + table calls — no GitHub fetches. Byte-identical to the
 * Deno parent apart from the npm import + relative `_shared` paths.
 *
 * SMI-2379: Marks skills not seen for N consecutive days as stale-quarantined.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { quarantineSkillsBatch, FINDING_STALE } from './_shared/quarantine.ts'

/**
 * Result of stale reconciliation
 */
export interface StaleReconciliationResult {
  staleQuarantined: number
  // SMI-3347: IDs of quarantined skills for bulk-quarantine author notification
  quarantinedIds: string[]
  errors: string[]
}

/**
 * Reconcile stale skills by quarantining those not seen in recent indexer runs.
 *
 * @param supabase - Supabase admin client
 * @param staleThresholdDays - Days without sighting before quarantine (1-90)
 */
export async function reconcileStaleSkills(
  supabase: SupabaseClient,
  staleThresholdDays: number
): Promise<StaleReconciliationResult> {
  const result: StaleReconciliationResult = {
    staleQuarantined: 0,
    quarantinedIds: [],
    errors: [],
  }

  // SMI-2572: Defense-in-depth — guard against NaN from non-numeric input
  const safeDays =
    typeof staleThresholdDays === 'number' && !isNaN(staleThresholdDays) ? staleThresholdDays : 30
  const clampedDays = Math.max(1, Math.min(safeDays, 90))
  const staleThreshold = new Date()
  staleThreshold.setDate(staleThreshold.getDate() - clampedDays)

  const STALE_BATCH_LIMIT = 500
  const { data: staleSkills, error: staleError } = await supabase
    .from('skills')
    .select('id, name, repo_url, last_seen_at')
    .lt('last_seen_at', staleThreshold.toISOString())
    .eq('quarantined', false)
    .order('last_seen_at', { ascending: true })
    .limit(STALE_BATCH_LIMIT)

  if (staleError) {
    console.error('[StaleDetection] Failed to query stale skills:', staleError.message)
    return result
  }

  if (!staleSkills || staleSkills.length === 0) {
    console.log('[StaleDetection] No stale skills found')
    return result
  }

  console.log(
    `[StaleDetection] Found ${staleSkills.length} stale skills (not seen in ${clampedDays}+ days)`
  )

  const staleIds = (staleSkills as Array<{ id: string }>).map((s) => s.id)

  // Use shared quarantine batch helper (handles RPC + fallback)
  const { quarantined, errors: batchErrors } = await quarantineSkillsBatch(
    supabase,
    staleIds,
    FINDING_STALE
  )

  if (batchErrors > 0) {
    result.errors.push(`Stale skill quarantine had ${batchErrors} batch failures`)
  }
  result.staleQuarantined = quarantined
  // SMI-3347: Store quarantined IDs for bulk-quarantine notification
  result.quarantinedIds = staleIds.slice(0, quarantined)
  console.log(
    `[StaleDetection] Quarantined ${quarantined}/${staleSkills.length} stale skills (${batchErrors} errors)`
  )

  return result
}
