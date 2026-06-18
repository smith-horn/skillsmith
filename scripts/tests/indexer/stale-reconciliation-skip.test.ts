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
vi.mock('../../indexer/stale-reconciliation.ts', () => ({
  reconcileStaleSkills: vi.fn(),
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

  it('returns stale=0 and an empty errors array', async () => {
    const result = await runStaleReconciliationPhase(noop, 30, false, true)

    expect(result).toEqual({ stale: 0, errors: [] })
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
    mockReconcileStaleSkills.mockResolvedValueOnce({
      staleQuarantined: 0,
      quarantinedIds: [],
      errors: [],
    })

    await runStaleReconciliationPhase(noop, 30, true, false)

    expect(mockReconcileStaleSkills).toHaveBeenCalledOnce()
  })

  it('passes the supabase client and stale threshold to reconcileStaleSkills', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce({
      staleQuarantined: 0,
      quarantinedIds: [],
      errors: [],
    })

    await runStaleReconciliationPhase(noop, 14, true, false)

    expect(mockReconcileStaleSkills).toHaveBeenCalledWith(noop, 14)
  })

  it('forwards staleQuarantined count from reconcileStaleSkills', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce({
      staleQuarantined: 7,
      quarantinedIds: ['id-1', 'id-2', 'id-3', 'id-4', 'id-5', 'id-6', 'id-7'],
      errors: [],
    })

    const result = await runStaleReconciliationPhase(noop, 30, true, false)

    expect(result.stale).toBe(7)
  })

  it('forwards errors from reconcileStaleSkills', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce({
      staleQuarantined: 0,
      quarantinedIds: [],
      errors: ['some error'],
    })

    const result = await runStaleReconciliationPhase(noop, 30, true, false)

    expect(result.errors).toEqual(['some error'])
  })

  it('calls notifyBulkQuarantine when quarantinedIds is non-empty and dryRun=false', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce({
      staleQuarantined: 2,
      quarantinedIds: ['id-a', 'id-b'],
      errors: [],
    })
    mockNotifyBulkQuarantine.mockResolvedValueOnce(undefined)

    await runStaleReconciliationPhase(noop, 30, false, false)

    expect(mockNotifyBulkQuarantine).toHaveBeenCalledOnce()
    expect(mockNotifyBulkQuarantine).toHaveBeenCalledWith(noop, ['id-a', 'id-b'])
  })

  it('does NOT call notifyBulkQuarantine when dryRun=true', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce({
      staleQuarantined: 2,
      quarantinedIds: ['id-a', 'id-b'],
      errors: [],
    })

    await runStaleReconciliationPhase(noop, 30, true, false)

    expect(mockNotifyBulkQuarantine).not.toHaveBeenCalled()
  })

  it('coerces undefined staleThresholdDays to 30', async () => {
    mockReconcileStaleSkills.mockResolvedValueOnce({
      staleQuarantined: 0,
      quarantinedIds: [],
      errors: [],
    })

    await runStaleReconciliationPhase(noop, undefined, true, false)

    expect(mockReconcileStaleSkills).toHaveBeenCalledWith(noop, 30)
  })
})
