/**
 * Audit-log meta envelope persistence test (SMI-4857)
 * @module scripts/tests/indexer/audit-log-persistence
 *
 * Pins the invariant that `writeIndexerAuditLog` persists the run-scoped
 * `meta` envelope (rate-limit telemetry, kill-switch state, concurrency,
 * topics, cron_slot, rotation_source) alongside the flat metadata keys.
 *
 * Regression context: 2026-05-11 18:23 UTC validation cron 25689025998
 * showed `rate_limit_remaining_min=0` and `secondary_rate_limit_hits=3` on
 * stdout but the SQL query
 *   SELECT metadata->'meta'->>'rate_limit_remaining_min'
 *   FROM audit_logs WHERE event_type='indexer:run'
 *   ORDER BY created_at DESC LIMIT 1
 * returned NULL — the meta envelope was being dropped before reaching the
 * `audit_logs.metadata` JSON column. Without it, SMI-4861 (P1 API-budget
 * exhaustion) can't be diagnosed via SQL.
 *
 * Both flat keys (found, indexed, run_type, etc.) AND the nested `meta`
 * envelope must be present so v_indexer_health / ops-report views stay
 * working AND budget queries hit a non-null path.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  writeIndexerAuditLog,
  type AuditLogParams,
  type AuditLogMeta,
} from '../../indexer/indexer-audit-log.ts'

function makeMeta(overrides: Partial<AuditLogMeta> = {}): AuditLogMeta {
  return {
    request_id: 'req-test-001',
    run_type: 'discovery',
    rate_limit_remaining_min: 4823,
    secondary_rate_limit_hits: 0,
    retry_after_max_seconds: 0,
    concurrency: 2,
    kill_switch_engaged: false,
    topics: ['claude-code-skill', 'claude-code'],
    cron_slot: 18,
    rotation_source: 'cron_slot',
    ...overrides,
  }
}

function makeParams(overrides: Partial<AuditLogParams> = {}): AuditLogParams {
  return {
    requestId: 'req-test-001',
    topics: ['claude-code-skill', 'claude-code'],
    runType: 'discovery',
    dryRun: false,
    found: 1989,
    indexed: 180,
    updated: 3,
    failed: 0,
    stale: 0,
    quality_gate_filtered: 87,
    unchanged: 369,
    quarantined: 20,
    github_skill_count: 109044,
    code_search: { repos_found: 0, retries: 0 },
    scoreDistribution: { highTrust: 100, community: 80 },
    categorizedCount: 50,
    categoryAssignments: 75,
    wildcard_expansion_count: 268,
    cron_slot: 18,
    rotation_source: 'cron_slot',
    discovery_path_counts: { high_trust: 100, topic_search: 80 },
    high_trust_fallback_hits: 0,
    meta: makeMeta(),
    ...overrides,
  }
}

interface CapturedInsert {
  table: string
  payload: Record<string, unknown>
}

function makeCapturingSupabase(captured: CapturedInsert[]): SupabaseClient {
  return {
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        captured.push({ table, payload })
        return Promise.resolve({ data: null, error: null })
      },
    }),
  } as unknown as SupabaseClient
}

describe('writeIndexerAuditLog — meta envelope persistence (SMI-4857)', () => {
  it('persists both flat metadata keys AND nested meta envelope', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeCapturingSupabase(captured)

    await writeIndexerAuditLog(supabase, 'success', makeParams())

    expect(captured).toHaveLength(1)
    expect(captured[0].table).toBe('audit_logs')

    const metadata = captured[0].payload.metadata as Record<string, unknown>
    // Flat keys preserved for v_indexer_health / ops-report views
    expect(metadata.indexed).toBe(180)
    expect(metadata.failed).toBe(0)
    expect(metadata.found).toBe(1989)
    expect(metadata.run_type).toBe('discovery')

    // SMI-4857: nested meta envelope must be present and populated
    expect(metadata.meta).toBeDefined()
    const meta = metadata.meta as AuditLogMeta
    expect(meta.rate_limit_remaining_min).toBe(4823)
    expect(meta.kill_switch_engaged).toBe(false)
    expect(meta.secondary_rate_limit_hits).toBe(0)
    expect(meta.concurrency).toBe(2)
    expect(meta.topics).toEqual(['claude-code-skill', 'claude-code'])
    expect(meta.run_type).toBe('discovery')
    expect(meta.cron_slot).toBe(18)
    expect(meta.rotation_source).toBe('cron_slot')
  })

  it('persists kill-switch-engaged state through meta envelope (the binding case)', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeCapturingSupabase(captured)

    // Models the 2026-05-11 18:23 UTC cron: rate_limit=0,
    // secondary_rate_limit_hits=3, kill switch ON
    await writeIndexerAuditLog(
      supabase,
      'success',
      makeParams({
        meta: makeMeta({
          rate_limit_remaining_min: 0,
          secondary_rate_limit_hits: 3,
          retry_after_max_seconds: 60,
          kill_switch_engaged: true,
          concurrency: 1,
        }),
      })
    )

    const metadata = captured[0].payload.metadata as Record<string, unknown>
    const meta = metadata.meta as AuditLogMeta
    // These three fields are the SQL contract for SMI-4861 budget monitoring
    expect(meta.rate_limit_remaining_min).toBe(0)
    expect(meta.secondary_rate_limit_hits).toBe(3)
    expect(meta.kill_switch_engaged).toBe(true)
    expect(meta.concurrency).toBe(1)
  })

  it('persists meta envelope on partial-result rows (failed > 0)', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeCapturingSupabase(captured)

    await writeIndexerAuditLog(
      supabase,
      'partial',
      makeParams({ failed: 5, meta: makeMeta({ rate_limit_remaining_min: 100 }) })
    )

    expect(captured[0].payload.result).toBe('partial')
    const metadata = captured[0].payload.metadata as Record<string, unknown>
    const meta = metadata.meta as AuditLogMeta
    expect(meta).toBeDefined()
    expect(meta.rate_limit_remaining_min).toBe(100)
  })

  it('persists maintenance-shaped meta (zeroed rate-limit, empty topics)', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeCapturingSupabase(captured)

    await writeIndexerAuditLog(
      supabase,
      'success',
      makeParams({
        runType: 'maintenance',
        topics: [],
        cron_slot: null,
        rotation_source: 'fallback',
        discovery_path_counts: {},
        meta: makeMeta({
          run_type: 'maintenance',
          rate_limit_remaining_min: 0,
          secondary_rate_limit_hits: 0,
          retry_after_max_seconds: 0,
          concurrency: 1,
          topics: [],
          cron_slot: null,
          rotation_source: 'fallback',
        }),
      })
    )

    const metadata = captured[0].payload.metadata as Record<string, unknown>
    const meta = metadata.meta as AuditLogMeta
    expect(meta.run_type).toBe('maintenance')
    expect(meta.topics).toEqual([])
    expect(meta.cron_slot).toBeNull()
    expect(meta.rotation_source).toBe('fallback')
  })

  it('omits meta key when params.meta is undefined (backward compat with pre-SMI-4857 callers)', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeCapturingSupabase(captured)

    await writeIndexerAuditLog(supabase, 'success', makeParams({ meta: undefined }))

    const metadata = captured[0].payload.metadata as Record<string, unknown>
    // Flat keys still present
    expect(metadata.indexed).toBe(180)
    // meta is undefined (or absent)
    expect(metadata.meta).toBeUndefined()
  })
})
