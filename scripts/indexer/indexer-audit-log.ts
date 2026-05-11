/**
 * Indexer Phase 7 audit-log writer (Node port)
 * @module scripts/indexer/indexer-audit-log
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/indexer-audit-log.ts`. Body is byte-identical
 * — only the `@supabase/supabase-js` import switches from the `esm.sh` URL
 * to the npm package. Drift guarded by the SMI-4852 cluster-A port.
 *
 * Original docblock:
 *
 * Extracted from indexer-runners.ts (SMI-4387) to keep that file under the
 * 500-line CI gate. No behavioural changes from the extraction itself — only
 * the new `discovery_path_counts` + `subdirectory_search` fields added in
 * the same change set.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { QUARANTINE_THRESHOLD } from './_shared/security-scanner-edge.ts'
import type { ScoreDistribution } from './indexer-runners.ts'

/**
 * Phase 7 audit log parameters
 */
export interface AuditLogParams {
  requestId: string
  topics: string[]
  runType: string
  dryRun: boolean
  found: number
  indexed: number
  updated: number
  failed: number
  stale: number
  quality_gate_filtered: number
  unchanged: number
  quarantined: number
  github_skill_count: number
  code_search: Record<string, unknown> | undefined
  scoreDistribution: ScoreDistribution
  categorizedCount: number
  categoryAssignments: number
  /** Phase 1: Total paths resolved via Trees API wildcard expansion (SMI-2672) */
  wildcard_expansion_count: number
  /** SMI-4374: UTC cron slot that triggered this run (6, 12, 18 for discovery; null for maintenance / ad-hoc). */
  cron_slot?: number | null
  /** SMI-4374: Provenance of the resolved `topics` array — surfaces operator overrides. */
  rotation_source?: 'body_topics' | 'env' | 'cron_slot' | 'fallback'
  /** SMI-4387: Per-discovery-path yield counts (indexed + updated only). Empty `{}` on maintenance. */
  discovery_path_counts: Record<string, number>
  /** SMI-4387 (H3): Subdirectory-search stats — pre-existing index.ts:526 call passed this but it was missing from the interface. Optional to match runtime. */
  subdirectory_search?: Record<string, unknown>
  /** SMI-4386: Count of high-trust repos resolved via registry fallback when the Phase-1 highTrustSkillMap missed. 0 on maintenance. Non-zero on discovery when Phase-2/3 surfaced a high-trust repo. */
  high_trust_fallback_hits: number
}

/**
 * Phase 7: Write indexer run audit log entry.
 * Logs errors internally — never throws.
 *
 * @param supabase - Supabase admin client
 * @param eventResult - 'success' (0 failures) or 'partial'
 * @param params - Structured audit log parameters
 */
export async function writeIndexerAuditLog(
  supabase: SupabaseClient,
  eventResult: 'success' | 'partial',
  params: AuditLogParams
): Promise<void> {
  try {
    const { error: auditError } = await supabase.from('audit_logs').insert({
      event_type: 'indexer:run',
      actor: 'system',
      action: 'index',
      result: eventResult,
      metadata: {
        request_id: params.requestId,
        topics: params.topics,
        run_type: params.runType,
        found: params.found,
        indexed: params.indexed,
        updated: params.updated,
        failed: params.failed,
        stale: params.stale,
        quality_gate_filtered: params.quality_gate_filtered,
        unchanged: params.unchanged,
        dry_run: params.dryRun,
        score_distribution: {
          high_trust: params.scoreDistribution.highTrust,
          community: params.scoreDistribution.community,
        },
        categorization: {
          skills_categorized: params.categorizedCount,
          category_assignments: params.categoryAssignments,
        },
        github_skill_count: params.github_skill_count,
        code_search: params.code_search,
        security: { quarantined: params.quarantined, threshold: QUARANTINE_THRESHOLD },
        wildcard_expansion_count: params.wildcard_expansion_count,
        // SMI-4374: Slot-rotation observability — ops-report / v_indexer_health
        // slice by these when diagnosing a slow slot.
        cron_slot: params.cron_slot ?? null,
        rotation_source: params.rotation_source ?? 'fallback',
        // SMI-4387: Per-run yield by discovery path. Empty `{}` on maintenance.
        discovery_path_counts: params.discovery_path_counts,
        // SMI-4387 H3: Emit subdirectory_search stats (pre-existing index.ts call
        // was feeding this through AuditLogParams but it was never written to DB).
        subdirectory_search: params.subdirectory_search,
        // SMI-4425: SMI-4386 counter was declared in AuditLogParams but never
        // persisted — 2026-04-22 prod query showed the key absent on all rows.
        // Non-zero = Phase-2/3 high-trust registry fallback fired; sustained
        // zero = Phase-1 emission covers everything OR discovery paused.
        high_trust_fallback_hits: params.high_trust_fallback_hits,
      },
    })
    if (auditError) {
      console.error(`[AuditLog] Failed: ${auditError.message}`)
    }
  } catch (auditErr) {
    console.error(
      `[AuditLog] Unexpected: ${auditErr instanceof Error ? auditErr.message : 'Unknown'}`
    )
  }
}
