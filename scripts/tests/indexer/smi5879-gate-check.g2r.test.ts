/**
 * SMI-5879 Wave 3 item 4: G-2R reconciliation gate test suite (design doc
 * §8.3.2.5.7, §8.5, §12.2, §12.3). Split out of the main
 * smi5879-gate-check.test.ts / .dispositions.test.ts pair per CLAUDE.md's
 * 500-line-per-file convention — G-2R's three-phase logic alone is
 * materially larger than any other single gate.
 * @module scripts/tests/indexer/smi5879-gate-check.g2r
 */

import { describe, it, expect } from 'vitest'
import { evaluateG2R } from '../../indexer/smi5879-gate-check.g2r.ts'
import { MISSING_COHORT_DRIFT_CLASS } from '../../indexer/smi5879-gate-check.types.ts'
import {
  DECISION_RUN_ID,
  WINDOW_RUN_ID,
  WINDOW_STARTED_AT_OVER_BOUND,
  makeCountingFakeDb,
  makeDriftRow,
  makeRunSummary,
  makeWindowRunSummary,
} from './smi5879-gate-check.fixtures.ts'
import type { ResolvedLedger } from '../../indexer/smi5879-gate-check.helpers.ts'

function emptyLedger(): ResolvedLedger {
  return {
    validation: { valid: true, byId: new Map(), conflictingIds: [] },
    loadFailureReason: null,
  }
}

function ledgerWith(entries: [string, 'confirm' | 'exclude'][]): ResolvedLedger {
  return {
    validation: { valid: true, byId: new Map(entries), conflictingIds: [] },
    loadFailureReason: null,
  }
}

describe('evaluateG2R — mode gating', () => {
  it('is NOT_APPLICABLE in --mode=decision', async () => {
    const { db } = makeCountingFakeDb()
    const { gate, report } = await evaluateG2R('decision', db, DECISION_RUN_ID, null, emptyLedger())
    expect(gate.outcome).toBe('NOT_APPLICABLE')
    expect(report).toBeNull()
  })

  it('is INCONCLUSIVE when reconciliation mode is missing --window-run-id', async () => {
    const { db } = makeCountingFakeDb()
    const { gate } = await evaluateG2R('reconciliation', db, DECISION_RUN_ID, null, emptyLedger())
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/--window-run-id/)
  })
})

describe('evaluateG2R — phase (i) binding, and the three-phase short-circuit order', () => {
  it('rejects an unsealed window generation, and NEVER calls countFreezeLeak/enumerateDrift (phase ii/iii never run)', async () => {
    const { db, calls } = makeCountingFakeDb({
      async getRunSummary(runId) {
        if (runId === DECISION_RUN_ID) return makeRunSummary()
        if (runId === WINDOW_RUN_ID)
          return makeWindowRunSummary({ status: 'open', snapshot_sealed_at: null })
        return null
      },
    })
    const { gate, report } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/phase \(i\) binding failed/)
    expect(report?.binding.bound).toBe(false)
    // The short-circuit: phase (ii)/(iii) DB calls never fire when phase (i) fails.
    expect(calls.countFreezeLeak).toBe(0)
    expect(calls.enumerateDrift).toBe(0)
  })

  it('rejects a ruleset_epoch mismatch between decision and window', async () => {
    const { db } = makeCountingFakeDb({
      async getRunSummary(runId) {
        if (runId === DECISION_RUN_ID) return makeRunSummary()
        if (runId === WINDOW_RUN_ID)
          return makeWindowRunSummary({ ruleset_epoch: '2020-01-01T00:00:00.000000Z' })
        return null
      },
    })
    const { gate } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/ruleset_epoch mismatch/)
  })

  it('§12.3: a NEGATIVE delta_elapsed (window precedes decision — transposed run_ids) is its own distinct INCONCLUSIVE', async () => {
    const { db, calls } = makeCountingFakeDb({
      async getRunSummary(runId) {
        // decision/window run_ids passed to evaluateG2R in the NORMAL order,
        // but the window generation's own snapshot_started_at is EARLIER
        // than the decision's — simulating the exact mistake §12.3 guards
        // against (the run_ids were transposed on the command line).
        if (runId === DECISION_RUN_ID)
          return makeRunSummary({ snapshot_started_at: '2026-08-01T00:00:00.000000Z' })
        if (runId === WINDOW_RUN_ID)
          return makeWindowRunSummary({ snapshot_started_at: '2026-07-29T00:00:00.000000Z' })
        return null
      },
    })
    const { gate } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/negative/)
    expect(gate.reason).toMatch(/transposed/)
    expect(calls.countFreezeLeak).toBe(0)
  })

  it('rejects delta_elapsed exceeding the 3d6h upper bound', async () => {
    const { db } = makeCountingFakeDb({
      async getRunSummary(runId) {
        if (runId === DECISION_RUN_ID) return makeRunSummary()
        if (runId === WINDOW_RUN_ID) {
          return makeWindowRunSummary({ snapshot_started_at: WINDOW_STARTED_AT_OVER_BOUND })
        }
        return null
      },
    })
    const { gate } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/exceeds the 3d6h bound/)
  })

  it('rejects a failed digest re-verification on either generation', async () => {
    const { db } = makeCountingFakeDb({
      async verifyDigest(runId) {
        if (runId === WINDOW_RUN_ID) return { populationMatches: true, branchMatches: false }
        return { populationMatches: true, branchMatches: true }
      },
    })
    const { gate } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/window generation binding failed/)
  })
})

describe('evaluateG2R — phase (ii) freeze-leak hard fail and DR-0 cross-check', () => {
  it('§12.2: a NULL-cohort drift row is its own distinct INCONCLUSIVE, never silently "stable"', async () => {
    const { db } = makeCountingFakeDb({
      async countFreezeLeak() {
        return 0
      },
      async enumerateDrift() {
        return [makeDriftRow({ id: 'row-null-cohort', drift_class: MISSING_COHORT_DRIFT_CLASS })]
      },
    })
    const { gate, report } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/NULL-cohort guard/)
    expect(gate.reason).toContain('row-null-cohort')
    expect(report?.freeze_leak_cross_check_ok).toBeNull() // never reached the cross-check
  })

  it('cross-check: G-2R.1 DR-0 count disagreeing with G-2R.2 freeze_leak_rows is its own INCONCLUSIVE', async () => {
    const { db } = makeCountingFakeDb({
      async countFreezeLeak() {
        return 0 // G-2R.2 says clean...
      },
      async enumerateDrift() {
        // ...but G-2R.1 independently found a DR-0 row. The two measurements disagree.
        return [makeDriftRow({ id: 'row-dr0', drift_class: 'DR-0-new-row' })]
      },
    })
    const { gate, report } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/cross-check failed/)
    expect(report?.dr0_count).toBe(1)
    expect(report?.freeze_leak_rows).toBe(0)
  })

  it('freeze_leak_rows > 0 is a HARD FAIL — NOT curable by exclusion dispositions, even when every offending id is excluded', async () => {
    const { db, calls } = makeCountingFakeDb({
      async countFreezeLeak() {
        return 2
      },
      async enumerateDrift() {
        return [
          makeDriftRow({ id: 'leaked-1', drift_class: 'DR-0-new-row' }),
          makeDriftRow({ id: 'leaked-2', drift_class: 'DR-0-new-row' }),
        ]
      },
    })
    // The ledger EXCLUDES both leaked rows — this must NOT cure the hard fail.
    const ledger = ledgerWith([
      ['leaked-1', 'exclude'],
      ['leaked-2', 'exclude'],
    ])
    const { gate, report } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      ledger
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/HARD FAIL/)
    expect(gate.reason).toMatch(/NOT curable by exclusion/)
    expect(report?.freeze_leak_rows).toBe(2)
    // Phase (iii) — the ledger-consuming phase — is never reached; the
    // drift rows are enumerated (needed for the DR-0 cross-check itself),
    // but no undisposed/DR-5 accounting happens beyond what phase (ii) sets.
    expect(report?.undisposed_drift_ids).toEqual([])
    expect(calls.enumerateDrift).toBe(1)
  })
})

describe('evaluateG2R — phase (iii) drift disposition', () => {
  it('rejects DR-1..DR-4 rows lacking a recorded exclude', async () => {
    const { db } = makeCountingFakeDb({
      async enumerateDrift() {
        return [makeDriftRow({ id: 'drifted-1', drift_class: 'DR-2-content-drift' })]
      },
    })
    const { gate, report } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/lack a recorded exclude/)
    expect(report?.undisposed_drift_ids).toEqual(['drifted-1'])
  })

  it('a missing disposition ledger in reconciliation mode is its own distinct INCONCLUSIVE reason', async () => {
    const { db } = makeCountingFakeDb({
      async enumerateDrift() {
        return [makeDriftRow({ id: 'drifted-1', drift_class: 'DR-1-deleted-row' })]
      },
    })
    const missingLedger: ResolvedLedger = {
      validation: { valid: true, byId: new Map(), conflictingIds: [] },
      loadFailureReason: 'dispositions file not found at /nowhere.json',
    }
    const { gate } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      missingLedger
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/disposition ledger unavailable/)
  })

  it('a ledger with conflicting verdicts blocks G-2R too, not just G-1', async () => {
    const { db } = makeCountingFakeDb({
      async enumerateDrift() {
        return [makeDriftRow({ id: 'drifted-1', drift_class: 'DR-1-deleted-row' })]
      },
    })
    const conflicting: ResolvedLedger = {
      validation: {
        valid: false,
        byId: new Map([['drifted-1', 'confirm']]),
        conflictingIds: ['drifted-1'],
      },
      loadFailureReason: null,
    }
    const { gate } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      conflicting
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/conflicting verdicts/)
  })

  it('DR-5 rows are reported, never required — a DR-5 row WITH an exclude is "improperly excluded", non-blocking', async () => {
    const { db } = makeCountingFakeDb({
      async enumerateDrift() {
        return [makeDriftRow({ id: 'moved-out-1', drift_class: 'DR-5-cohort-move-out' })]
      },
    })
    const ledger = ledgerWith([['moved-out-1', 'exclude']])
    const { gate, report } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      ledger
    )
    expect(gate.outcome).toBe('PASS')
    expect(report?.improperly_excluded_dr5_ids).toEqual(['moved-out-1'])
    expect(report?.undisposed_drift_ids).toEqual([])
  })

  it('a DR-5 row WITHOUT an exclude never blocks — reported only', async () => {
    const { db } = makeCountingFakeDb({
      async enumerateDrift() {
        return [makeDriftRow({ id: 'moved-out-1', drift_class: 'DR-5-cohort-move-out' })]
      },
    })
    const { gate, report } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('PASS')
    expect(report?.improperly_excluded_dr5_ids).toEqual([])
  })

  it('PASSes end-to-end with a correctly-disposed DR-1..DR-4 set, and computes drift_rate over decision_rows', async () => {
    const { db } = makeCountingFakeDb({
      async enumerateDrift() {
        return [
          makeDriftRow({ id: 'd1', drift_class: 'DR-1-deleted-row' }),
          makeDriftRow({ id: 'd2', drift_class: 'DR-2-content-drift' }),
        ]
      },
    })
    const ledger = ledgerWith([
      ['d1', 'exclude'],
      ['d2', 'exclude'],
    ])
    const { gate, report } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      ledger
    )
    expect(gate.outcome).toBe('PASS')
    // makeRunSummary() defaults row_count to 100 — 2 drift rows / 100 = 0.02.
    expect(report?.drift_rate).toBeCloseTo(0.02, 6)
  })
})

describe('evaluateG2R — a rehearsal generation offered as decision or window is rejected', () => {
  it('rejects when the decision run_id actually resolves to a rehearsal generation', async () => {
    const { db } = makeCountingFakeDb({
      async getRunSummary(runId) {
        if (runId === DECISION_RUN_ID) return makeRunSummary({ purpose: 'rehearsal' })
        if (runId === WINDOW_RUN_ID) return makeWindowRunSummary()
        return null
      },
    })
    const { gate } = await evaluateG2R(
      'reconciliation',
      db,
      DECISION_RUN_ID,
      WINDOW_RUN_ID,
      emptyLedger()
    )
    expect(gate.outcome).toBe('INCONCLUSIVE')
    expect(gate.reason).toMatch(/rehearsal generation can never satisfy a gate/)
  })
})
