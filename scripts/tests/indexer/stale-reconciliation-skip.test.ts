/**
 * runStaleReconciliationPhase — backfill-mode skip gate (SMI-5286 Wave 1b §#5)
 * @module scripts/tests/indexer/stale-reconciliation-skip
 *
 * Two branches:
 *  - backfillMode=true  → reconcileStaleSkills is NOT called; returns {stale:0, errors:[]}
 *  - backfillMode=false → reconcileStaleSkills IS called; result is forwarded
 *
 * reconcileStaleSkills and notifyBulkQuarantine are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// vi.mock is hoisted before imports — mock the two dependencies that
// runStaleReconciliationPhase imports from its siblings.
// SMI-5551 item 3: phase-split now also imports the canonical threshold
// resolver + discovery default from stale-reconciliation.ts, so the factory
// must provide them (real logic — it's a pure function).
// SMI-5551 follow-up: also provide ZERO_STALE_VERIFICATION — the
// backfill-mode skip branch returns it directly (real logic, not mockable).
vi.mock('../../indexer/stale-reconciliation.ts', () => ({
  reconcileStaleSkills: vi.fn(),
  DISCOVERY_STALE_DEFAULT_DAYS: 30,
  resolveStaleThresholdDays: (raw: unknown, defaultDays: number) =>
    typeof raw === 'number' && !isNaN(raw) && isFinite(raw) && raw > 0 ? raw : defaultDays,
  ZERO_STALE_VERIFICATION: {
    verifiedLive: 0,
    transientSkipped: 0,
    maliciousQuarantined: 0,
    errors: 0,
  },
}))

vi.mock('../../indexer/_shared/notification.ts', () => ({
  notifyBulkQuarantine: vi.fn(),
}))

// Import AFTER vi.mock declarations
import { runStaleReconciliationPhase } from '../../indexer/discovery-orchestrator.phase-split.ts'
import { reconcileStaleSkills } from '../../indexer/stale-reconciliation.ts'
import { notifyBulkQuarantine } from '../../indexer/_shared/notification.ts'

// Typed mock references so TypeScript is happy
const mockReconcileStaleSkills = vi.mocked(reconcileStaleSkills)
const mockNotifyBulkQuarantine = vi.mocked(notifyBulkQuarantine)

// SMI-5551: StaleReconciliationResult grew verification counters — build
// fixtures through one helper so future shape growth lands in one place.
function staleResult(
  overrides: Partial<Awaited<ReturnType<typeof reconcileStaleSkills>>> = {}
): Awaited<ReturnType<typeof reconcileStaleSkills>> {
  return {
    staleQuarantined: 0,
    quarantinedIds: [],
    errors: [],
    verifiedLive: 0,
    transientSkipped: 0,
    maliciousQuarantined: 0,
    ...overrides,
  }
}

// Minimal no-op Supabase client (the skip path never touches it)
const noop = {} as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runStaleReconciliationPhase — backfillMode=true (skip gate)', () => {
  it('does not call reconcileStaleSkills', async () => {
    await runStaleReconciliationPhase(noop, 30, false, true)

    expect(mockReconcileStaleSkills).not.toHaveBeenCalled()
  })

  it('does not call notifyBulkQuarantine', async () => {
    await runStaleReconciliationPhase(noop, 30, false, true)

    expect(mockNotifyBulkQuarantine).not.toHaveBeenCalled()
  })

  it('returns stale=0, zeroed staleVerification, and an empty errors array', async () => {
    const result = await runStaleReconciliationPhase(noop, 30, false, true)

    expect(result).toEqual({
      stale: 0,
      staleVerification: {
        verifiedLive: 0,
        transientSkipped: 0,
        maliciousQuarantined: 0,
        errors: 0,
      },
      errors: [],
    })
  })

  it('returns zeros regardless of staleThresholdDays value', async () => {
    const result = await runStaleReconciliationPhase(noop, 90, true, true)

    expect(result.stale).toBe(0)
    expect(result.errors).toHaveLength(0)
    expect(mockReconcileStaleSkills).not.toHaveBeenCalled()
  })
})

describe('runStaleReconciliationPhase — backfillMode=false (normal path)', () => {
  it('calls reconcileStaleSkills when backfillMode is false', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce(staleResult())

    await runStaleReconciliationPhase(noop, 30, true, false)

    expect(mockReconcileStaleSkills).toHaveBeenCalledOnce()
  })

  it('passes the supabase client and stale threshold to reconcileStaleSkills', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce(staleResult())

    await runStaleReconciliationPhase(noop, 14, true, false)

    expect(mockReconcileStaleSkills).toHaveBeenCalledWith(noop, 14)
  })

  it('forwards staleQuarantined count from reconcileStaleSkills', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce(
      staleResult({
        staleQuarantined: 7,
        quarantinedIds: ['id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6', 'id-7'],
      })
    )

    const result = await runStaleReconciliationPhase(noop, 30, true, false)

    expect(result.stale).toBe(7)
  })

  it('forwards errors from reconcileStaleSkills', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce(staleResult({ errors: ['some error'] }))

    const result = await runStaleReconciliationPhase(noop, 30, true, false)

    expect(result.errors).toEqual(['some error'])
  })

  // SMI-5551 follow-up (SMI-5926): staleVerification was computed by
  // reconcileStaleSkills all along but silently dropped before reaching
  // audit_logs — this pins the forwarding contract at the phase-fn boundary.
  it('forwards verifiedLive/transientSkipped/maliciousQuarantined as staleVerification', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce(
      staleResult({
        verifiedLive: 12,
        transientSkipped: 3,
        maliciousQuarantined: 2,
        errors: ['fetch failed', 'parse failed'],
      })
    )

    const result = await runStaleReconciliationPhase(noop, 30, true, false)

    expect(result.staleVerification).toEqual({
      verifiedLive: 12,
      transientSkipped: 3,
      maliciousQuarantined: 2,
      errors: 2,
    })
  })

  it('calls notifyBulkQuarantine when quarantinedIds is non-empty and dryRun=false', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce(
      staleResult({ staleQuarantined: 2, quarantinedIds: ['id-a', 'id-b'] })
    )
    mockNotifyBulkQuarantine.mockResolvedValueOnce(undefined)

    await runStaleReconciliationPhase(noop, 30, false, false)

    expect(mockNotifyBulkQuarantine).toHaveBeenCalledOnce()
    expect(mockNotifyBulkQuarantine).toHaveBeenCalledWith(noop, ['id-a', 'id-b'])
  })

  it('does NOT call notifyBulkQuarantine when dryRun=true', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce(
      staleResult({ staleQuarantined: 2, quarantinedIds: ['id-a', 'id-b'] })
    )

    await runStaleReconciliationPhase(noop, 30, true, false)

    expect(mockNotifyBulkQuarantine).not.toHaveBeenCalled()
  })

  it('coerces undefined staleThresholdDays to 30', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce(staleResult())

    await runStaleReconciliationPhase(noop, undefined, true, false)

    expect(mockReconcileStaleSkills).toHaveBeenCalledWith(noop, 30)
  })
})
