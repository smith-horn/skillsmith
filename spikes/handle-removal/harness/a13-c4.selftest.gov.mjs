// Final-governance cases for harness/a13-c4.selftest.mjs (run through that
// file). F1: the caller-hash-race record and the shared tally must agree, so
// those records are run THROUGH makeRecord -> classifyRecord -> tallyCell, the
// path every verdict takes. F3: only an origin-tree reason counts as evidence
// the tree changed after the caller hashed, and a clock/hash contradiction is
// a counted harness-error. Each rule has a positive case and a control.

import {
  recordForRunError,
  landingFromRacer,
  windowEnds,
  CALLER_HASH_FAILED_PREFIX,
} from './attacks/a13-c4.classify.mjs'
import { decideRecord, treeChangedAfterCallerHash } from './attacks/a13-c4.record.mjs'
import { makeRecord, classifyRecord } from './result-schema.mjs'
import { tallyCell } from './cell-tally.mjs'

const CELL = {
  attack: 'A13-C4',
  variant: 'racer/by-timestamp',
  candidate: 'C4',
  fs: 'darwin',
  target: 300,
  targetScope: 'across-a13-labels',
}
/** One raw module record through the real record and tally path. */
function tally(raw) {
  const record = makeRecord({
    cell: CELL,
    run: 0,
    precondition: raw.precondition,
    outcome: raw.outcome,
    userFiles: raw.userFiles,
    durationMs: raw.durationMs,
  })
  return { record, t: tallyCell([record], (r) => classifyRecord(r)) }
}

export function runGovCases(check) {
  // --- F1: caller-hash race, producer and tally agree --------------------------
  {
    const racer = {
      mutation: 'a5',
      steps: [{ op: 'unlink', path: '/fx/tree/target/orig-f1', startAt: 5, endAt: 6 }],
      failedStep: null,
      complete: true,
    }
    const args = (scored) => ({
      err: new Error(`${CALLER_HASH_FAILED_PREFIX} on the fixture: {"ok":false}`),
      candidate: 'C4',
      racer,
      markerObservedAt: 1,
      durationMs: 2,
      quarantineLeft: { dirs: null },
      callerHashWindow: { startAt: 4, endAt: 7 },
      scored,
    })
    const clean = { checked: 1, lost: 0, changed: 0, displaced: 0, deleted: 0 }

    const raw = recordForRunError(args(clean))
    check(
      "F1: clean caller-hash race is a non-error non-landing (status 'not-run', mutationApplied false)",
      raw.outcome.status === 'not-run' && raw.precondition.mutationApplied === false,
      { status: raw.outcome.status, pre: raw.precondition }
    )
    let { t } = tally(raw)
    check(
      'F1 through the tally: clean caller-hash race leaves the denominator (neverRan 1, otherNeverRan 0)',
      t.neverRan === 1 && t.otherNeverRan === 0 && t.passed === 0 && t.failed === 0,
      t
    )

    const lossy = recordForRunError(args({ ...clean, lost: 1, deleted: 1 }))
    ;({ t } = tally(lossy))
    // The tally's policy: a C4 harness-error that MEASURED a loss counts failed
    // (failures beat everything), so this cell cannot pass.
    check(
      'F1 through the tally: caller-hash race with an observed loss counts against the cell (failed 1)',
      lossy.outcome.status === 'harness-error' && t.failed === 1 && t.passed === 0,
      { status: lossy.outcome.status, t }
    )
    const unsc = recordForRunError(args(null))
    ;({ t } = tally(unsc))
    check(
      'F1 through the tally: unscorable caller-hash race counts against the cell (otherNeverRan 1)',
      unsc.outcome.status === 'harness-error' && t.otherNeverRan === 1,
      { status: unsc.outcome.status, t }
    )
    // Control: the tally's own policy -- a C4 harness-error is counted even
    // with mutationApplied false, which is why the clean case must not be one.
    ;({ t } = tally({ ...raw, outcome: { ...raw.outcome, status: 'harness-error' } }))
    check(
      'F1 control: a C4 harness-error with mutationApplied false is still counted (otherNeverRan 1)',
      t.otherNeverRan === 1,
      t
    )
  }

  // --- F3: only origin-tree reasons are evidence -------------------------------
  {
    const t = (o) =>
      treeChangedAfterCallerHash({ destPath: null, movedTreeMatchesCallerHash: false, ...o })
    check(
      'F3: C4 kept/quarantine-destination-changed is NOT evidence the origin tree changed',
      t({ c4Status: 'kept', c4Reason: 'quarantine-destination-changed' }) === false
    )
    check(
      'F3 control: C4 kept/identity-changed IS evidence',
      t({ c4Status: 'kept', c4Reason: 'identity-changed' }) === true
    )

    // Contradiction: timestamps say the racer finished before the caller hash
    // began, but C4 reports the tree changed after it.
    const T = {
      callerHashStartAt: 6,
      callerHashAt: 10,
      recheckAt: 20,
      renameAt: 21,
      renameReturnedAt: 22,
      callEndAt: 25,
    }
    const F = '/fx/tree/target/orig-f1'
    const racer = (endWrite) => ({
      mutation: 'a7',
      steps: [
        { op: 'unlink', path: F, startAt: 4, endAt: 4.1 },
        { op: 'write', path: F, startAt: 4.2, endAt: endWrite, content: 'u' },
      ],
      failedStep: null,
    })
    const L = (r) =>
      landingFromRacer({
        racer: r,
        callerHashStartAt: T.callerHashStartAt,
        callerHashAt: T.callerHashAt,
        ...windowEnds('C4', T),
        provenPreCallerHash: false,
        movedTreeDiffersFromCallerHash: true,
      })
    const contra = L(racer(5.9))
    const base = {
      c4Status: 'kept',
      traceMatched: true,
      clockOrderOk: true,
      clockSkewCheckMs: 0.1,
      markerObservedAt: 1,
      callerHashStartAt: 6,
      unscorable: null,
      routed: { mutationApplied: true, label: 'A13-C4' },
      scored: { lost: 0, changed: 0, vacuous: false },
    }
    let d = decideRecord({ ...base, landings: contra })
    check(
      'F3: racer finished before the caller hash began but C4 saw a change -> counted harness-error',
      contra[0]?.contradiction === true &&
        d.status === 'harness-error' &&
        d.mutationApplied === true &&
        d.harnessErrors.some((e) => e.startsWith('clock-hash-contradiction')),
      { landing: contra[0], d }
    )
    const during = L(racer(6.5))
    d = decideRecord({ ...base, landings: during })
    check(
      'F3 control: racer still writing when the caller hash began -> a credited catch, no contradiction',
      during[0]?.contradiction !== true && d.status === 'kept' && d.harnessErrors.length === 0,
      { landing: during[0], d }
    )
  }
}
