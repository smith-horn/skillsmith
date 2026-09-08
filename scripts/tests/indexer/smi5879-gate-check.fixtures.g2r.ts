/**
 * G-2R-only fixtures: drift rows and the call-counting fake DB that proves
 * G-2R's three phases short-circuit in order. Split out of
 * `smi5879-gate-check.fixtures.ts` alongside the disposition/attestation
 * split, once SMI-6444's additions pushed that file past the 500-line policy
 * cap. Both helpers below have exactly one consumer
 * (`smi5879-gate-check.g2r.test.ts`), so keeping them in the module every
 * other suite imports was coupling without benefit.
 * @module scripts/tests/indexer/smi5879-gate-check.fixtures.g2r
 *
 * IMPORT DIRECTION IS ONE-WAY: this file imports `makeFakeDb` from the base
 * fixtures module; the base module imports nothing back.
 */

import type { DriftRow, Smi5879GateCheckDbDeps } from '../../indexer/smi5879-gate-check.types.ts'
import { makeFakeDb } from './smi5879-gate-check.fixtures.ts'

export function makeDriftRow(overrides: Partial<DriftRow> = {}): DriftRow {
  return {
    id: 'row-1',
    drift_class: 'DR-1-deleted-row',
    decision_content_hash: 'hash-a',
    window_content_hash: null,
    decision_score: 3,
    window_score: null,
    decision_quarantined: false,
    window_quarantined: null,
    decision_cohort: 'E',
    window_cohort: null,
    repo_url: 'https://github.com/acme/row-1',
    author: 'acme',
    name: 'row-1',
    ...overrides,
  }
}

/** A count-tracking wrapper — asserts phase short-circuiting by call counts. */
export function makeCountingFakeDb(overrides: Partial<Smi5879GateCheckDbDeps> = {}): {
  db: Smi5879GateCheckDbDeps
  calls: { countFreezeLeak: number; enumerateDrift: number }
} {
  const calls = { countFreezeLeak: 0, enumerateDrift: 0 }
  const base = makeFakeDb(overrides)
  const db: Smi5879GateCheckDbDeps = {
    ...base,
    async countFreezeLeak(decisionRunId, windowRunId) {
      calls.countFreezeLeak++
      return base.countFreezeLeak(decisionRunId, windowRunId)
    },
    async enumerateDrift(decisionRunId, windowRunId) {
      calls.enumerateDrift++
      return base.enumerateDrift(decisionRunId, windowRunId)
    },
  }
  return { db, calls }
}
