// Owner decision (governance finding 1) cases for harness/a13-c4.selftest.mjs.
// An A13 run whose racer finished BEFORE the caller hashed, where C4 then
// moved exactly the tree the caller hashed, is caller intent, not a loss
// against C4 -- but only when PROVABLE: outcome.excludedReason
// 'pre-caller-hash' plus outcome.callerIntentProof {callerHash,
// movedTreeHash, equal}, both real 64-hex hashes and equal. Without a valid
// proof the run is not pre-caller-hash at all (in-model, or a counted
// contradiction). Each rule has a positive case and a control.

import { landingFromRacer, windowEnds, routeRun } from './attacks/a13-c4.classify.mjs'
import {
  decideRecord,
  callerIntentProofOf,
  isValidCallerIntentProof,
  treeChangedAfterCallerHash,
} from './attacks/a13-c4.record.mjs'

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const T = {
  callerHashStartAt: 6,
  callerHashAt: 10,
  recheckAt: 20,
  renameAt: 21,
  renameReturnedAt: 22,
  callEndAt: 25,
}
const F = '/fx/tree/target/orig-f1'
// A complete a7 whose every step ended before the caller hash began (6).
const RACER = {
  mutation: 'a7',
  steps: [
    { op: 'unlink', path: F, startAt: 4, endAt: 4.1 },
    { op: 'write', path: F, startAt: 4.2, endAt: 4.3, content: 'u' },
  ],
  failedStep: null,
}

/** The whole producer chain for a quarantined run, from the two hashes. */
function produce(callerHash, movedTreeHash, c4Status = 'quarantined') {
  const proof = callerIntentProofOf(callerHash, movedTreeHash)
  const differs = treeChangedAfterCallerHash({
    c4Status,
    c4Reason: null,
    destPath: c4Status === 'quarantined' ? '/fx/.skillsmith-trash/op/tree-x' : null,
    movedTreeMatchesCallerHash: isValidCallerIntentProof(proof),
  })
  const landings = landingFromRacer({
    racer: RACER,
    callerHashStartAt: T.callerHashStartAt,
    callerHashAt: T.callerHashAt,
    ...windowEnds('C4', T),
    provenPreCallerHash: false,
    movedTreeDiffersFromCallerHash: differs,
  })
  const d = decideRecord({
    c4Status,
    traceMatched: true,
    clockOrderOk: true,
    clockSkewCheckMs: 0.1,
    markerObservedAt: 1,
    callerHashStartAt: 6,
    unscorable: null,
    routed: routeRun(landings),
    landings,
    // The measured userFiles stay as measured: the user's new file WAS moved.
    scored: { lost: 1, changed: 0, vacuous: false },
    callerIntentProof: proof,
  })
  return { proof, landings, d }
}

export function runIntentCases(check) {
  // --- the proof itself ---------------------------------------------------------
  {
    const p = callerIntentProofOf(H1, H1)
    check(
      'intent: proof carries both hashes and equal true when they match',
      p.callerHash === H1 &&
        p.movedTreeHash === H1 &&
        p.equal === true &&
        isValidCallerIntentProof(p) === true,
      p
    )
    check(
      'intent control: different hashes -> equal false, not valid',
      isValidCallerIntentProof(callerIntentProofOf(H1, H2)) === false
    )
    check(
      'intent control: missing movedTreeHash -> not valid',
      isValidCallerIntentProof(callerIntentProofOf(H1, null)) === false
    )
    check(
      'intent control: equal but not 64-hex strings -> not valid',
      isValidCallerIntentProof(callerIntentProofOf('abc', 'abc')) === false &&
        isValidCallerIntentProof(callerIntentProofOf(null, null)) === false
    )
    check(
      'intent control: a hand-made {equal:true} over different hashes is not valid',
      isValidCallerIntentProof({ callerHash: H1, movedTreeHash: H2, equal: true }) === false
    )
  }

  // --- through the producer chain ---------------------------------------------
  {
    let { landings, d } = produce(H1, H1)
    check(
      "intent: pre-caller-hash quarantined run with matching hashes -> excludedReason 'pre-caller-hash' + proof equal true",
      landings[0]?.cls === 'pre-caller-hash' &&
        d.status === 'quarantined' &&
        d.mutationApplied === false &&
        d.excludedReason === 'pre-caller-hash' &&
        d.callerIntentProof?.equal === true &&
        d.callerIntentProof?.callerHash === H1 &&
        d.callerIntentProof?.movedTreeHash === H1,
      { landing: landings[0], d }
    )
    ;({ landings, d } = produce(H1, H2))
    check(
      'intent: mismatching hashes -> NOT pre-caller-hash (counted contradiction here: racer finished before the caller hash began)',
      landings[0]?.cls !== 'pre-caller-hash' &&
        d.excludedReason !== 'pre-caller-hash' &&
        d.status === 'harness-error' &&
        d.mutationApplied === true,
      { landing: landings[0], d }
    )
    ;({ landings, d } = produce(H1, null))
    check(
      'intent: missing movedTreeHash -> NOT pre-caller-hash, no exclusion',
      landings[0]?.cls !== 'pre-caller-hash' &&
        d.excludedReason !== 'pre-caller-hash' &&
        d.callerIntentProof == null,
      { landing: landings[0], d }
    )
    ;({ landings, d } = produce(H1, null, 'kept'))
    check(
      'intent: C4 kept (nothing moved), racer finished before the caller hash -> plain non-landing, no excludedReason',
      d.status === 'kept' &&
        d.mutationApplied === false &&
        d.excludedReason === null &&
        d.callerIntentProof == null,
      { landing: landings[0], d }
    )
  }
}
