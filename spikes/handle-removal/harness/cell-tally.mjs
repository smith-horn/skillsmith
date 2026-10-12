// Per-cell record counting and the cell verdict, shared by aggregateCell()
// (harness/result-schema.mjs) and results/generate-summary.mjs so the two
// deciders cannot drift (they did once: SMI-6676 R6). Legacy cells are counted
// exactly as before; the C4 rules below apply only to records whose cell is C4
// (isC4Cell), so no pre-existing record can be affected.

import { verdictFor, RECORD_ONLY_ATTACKS } from './control-spec.mjs'
import { isC4Cell, C4_KNOWN_STATUSES } from './result-schema.c4.mjs'

/**
 * The single source of truth for `outcome.excludedReason`: tallyCell treats any C4
 * reason NOT in this set as a harness fault (never-ran and otherNeverRan).
 */
export const EXCLUDED_REASONS = new Set(['vacuous-check', 'pre-caller-hash'])

/** `cell.targetScope` value: the run count covers both A13 labels together. */
export const TARGET_SCOPE_A13 = 'across-a13-labels'
const A13_LABELS = new Set(['A13-C4', 'A13-C4-OOM'])
// A control failure is a GENUINE scored failure: a known non-error status that
// actually moved or kept a tree ('not-run' and 'harness-error' never are).
const GENUINE_STATUSES = new Set(['quarantined', 'kept', 'stopped'])
const HEX64 = /^[0-9a-f]{64}$/

/**
 * The ONE exemption from "a measured loss is a failure" (owner decision,
 * SMI-6715 governance finding 1): a non-landing whose tree moved is proved to be
 * the very tree the caller hashed. Re-derived here from the two hashes; the
 * producer's `equal` flag is required to be true but is never trusted alone.
 *
 * Deliberately as narrow as the only producer: an A13 label, status exactly
 * 'quarantined', hookFired and traceMatched strictly true, mutationApplied
 * strictly false, reason 'pre-caller-hash', plus the proof rules. A harness
 * error, or any other attack or status, always counts against the cell.
 */
function callerIntentProven(r) {
  const [cell, outcome, pre] = [r?.cell, r?.outcome, r?.precondition]
  if (!A13_LABELS.has(cell?.attack)) return false
  if (outcome?.excludedReason !== 'pre-caller-hash') return false
  if (outcome?.status !== 'quarantined') return false
  if (pre?.hookFired !== true || pre?.traceMatched !== true) return false
  if (pre?.mutationApplied !== false) return false
  const proof = outcome?.callerIntentProof
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) return false
  const proto = Object.getPrototypeOf(proof)
  if (proto !== Object.prototype && proto !== null) return false
  const [a, b, eq] = [proof.callerHash, proof.movedTreeHash, proof.equal]
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    HEX64.test(a) &&
    HEX64.test(b) &&
    a === b &&
    eq === true
  )
}

/** A measured loss: valid non-negative integer lost and changed with a positive sum. */
function measuredLoss(r) {
  const [lost, changed] = [r?.userFiles?.lost, r?.userFiles?.changed]
  return (
    Number.isSafeInteger(lost) &&
    lost >= 0 &&
    Number.isSafeInteger(changed) &&
    changed >= 0 &&
    lost + changed > 0
  )
}

const validTarget = (x) => Number.isSafeInteger(x) && x > 0

/**
 * Counts one cell's records.
 *
 * C4 records only:
 *  - `outcome.excludedReason === 'vacuous-check'` on a record that otherwise
 *    PASSED leaves the denominator like a non-landing (neverRan, not
 *    otherNeverRan) and is counted in `excluded`, so an A13-C4 run whose only
 *    check was vacuous cannot count toward the 100-landing floor.
 *  - a harness-error that nonetheless reports valid integer lost/changed counts
 *    with lost + changed > 0 is counted failed (a measured loss is not a fault).
 *  - a record that LOST bytes is counted failed whatever excludedReason it
 *    carries (failures beat exclusion, G3-2); 'vacuous-check' should never
 *    co-occur with a loss, and the producer guards it, but the consumer must
 *    not let the label hide one.
 *  - any other excludedReason value is a harness fault too: never-ran and
 *    otherNeverRan. A record that LOST bytes keeps its `failed` count under an
 *    unknown reason -- a loss is evidence and an unrecognised label must not hide it.
 *
 * `target` is the module's intended run count from `cell.target`, valid only if
 * every record carries the same positive integer.
 */
export function tallyCell(records, classify, universe = records) {
  let passed = 0
  let failed = 0
  // Failures from NON-ERROR records only. A harness-error that reports a loss
  // counts `failed` for its own cell (failures beat everything) but is not a
  // measured loss of the arm, so it must not satisfy a control (resolveControl
  // reads this, not `failed`): a harness-model fault is never the evidence that
  // unlocks a C4 PASS.
  let controlFailures = 0
  let neverRan = 0
  let otherNeverRan = 0
  let excluded = 0
  let callerIntentExcluded = 0
  let c4 = false
  for (const r of records) {
    const isC4 = isC4Cell(r?.cell)
    c4 = c4 || isC4
    const cls = classify(r)
    const [status, er, mutationApplied] = [
      r?.outcome?.status,
      isC4 ? r?.outcome?.excludedReason : undefined,
      r?.precondition?.mutationApplied,
    ]
    // Counts one failure. It is control evidence only if it is a GENUINE scored
    // failure: the classifier calls it failed (so the C4 validation passed: every
    // precondition strictly true, valid counts) AND its status is a known
    // non-error one. A measured loss that fails those tests still counts failed
    // for its own cell (failures beat everything) but never unlocks a PASS.
    const fail = () => {
      failed += 1
      if (!isC4 || (cls === 'failed' && GENUINE_STATUSES.has(status))) controlFailures += 1
    }
    // A C4 record that MEASURED a loss is a failure whatever its status or
    // mutationApplied says: failures beat everything. The single exemption is a
    // proven caller-intent non-landing (callerIntentProven), which leaves the
    // denominator like a non-landing and is counted separately. Only valid
    // integer counts qualify; a record with malformed counts stays a fault.
    if (isC4 && measuredLoss(r)) {
      if (callerIntentProven(r)) {
        neverRan += 1
        callerIntentExcluded += 1
      } else {
        fail()
      }
      continue
    }
    // R6 drops only the runs where the RACER DID NOT LAND. For C4 records only a
    // KNOWN non-error status can be a non-landing: a harness-error never is, and
    // neither is an unknown status (a typo such as 'quarantine' must disqualify
    // the cell, not silently leave the denominator).
    const nonLanding =
      mutationApplied === false &&
      !(isC4 && (status === 'harness-error' || !C4_KNOWN_STATUSES.has(status)))
    // 'pre-caller-hash' without a measured loss is informational: normal handling.
    if (er !== undefined && er !== null && er !== 'pre-caller-hash') {
      if (cls === 'failed') {
        // Failures beat exclusion: a run whose check FAILED is a loss whatever
        // label it carries, including 'vacuous-check' and an unrecognised one.
        fail()
      } else if (!EXCLUDED_REASONS.has(er)) {
        neverRan += 1
        otherNeverRan += 1
      } else if (cls === 'passed') {
        // 'vacuous-check' on a clean run leaves the denominator, counted apart.
        neverRan += 1
        excluded += 1
      } else {
        neverRan += 1
        if (!nonLanding) otherNeverRan += 1
      }
      continue
    }
    if (cls === 'passed') passed += 1
    else if (cls === 'failed') fail()
    else {
      neverRan += 1
      if (!nonLanding) otherNeverRan += 1
    }
  }

  let target = null
  let targetState = 'n/a'
  let groupRan = null
  if (c4) {
    const ts = records.map((r) => r?.cell?.target)
    const scopes = records.map((r) => r?.cell?.targetScope)
    const unscoped = scopes.every((x) => x === undefined)
    const a13Scoped =
      scopes.every((x) => x === TARGET_SCOPE_A13) &&
      records.every((r) => A13_LABELS.has(r?.cell?.attack))
    if (!unscoped && !a13Scoped) targetState = 'inconsistent'
    else if (ts.every((x) => x === undefined || x === null)) targetState = 'missing'
    else if (ts.every(validTarget) && ts.every((x) => x === ts[0])) {
      targetState = 'ok'
      target = ts[0]
      if (a13Scoped) {
        // The run count covers BOTH A13 labels: count the candidate's records
        // across them (same candidate, fs, variant, dirs). `universe` must hold
        // the sibling label's records; without it the group cannot be proven
        // complete and the cell is INCOMPLETE rather than PASS.
        const c = records[0].cell
        groupRan = universe.filter((r) => {
          const rc = r?.cell
          return (
            A13_LABELS.has(rc?.attack) &&
            rc.candidate === c.candidate &&
            rc.fs === c.fs &&
            rc.variant === c.variant &&
            rc.dirs === c.dirs
          )
        }).length
      }
    } else targetState = 'inconsistent'
  }
  return {
    ran: records.length,
    passed,
    failed,
    controlFailures,
    neverRan,
    otherNeverRan,
    excluded,
    callerIntentExcluded,
    c4,
    target,
    targetState,
    groupRan,
  }
}

/**
 * The cell verdict. For a C4 cell with no losses, a run that does not match its
 * recorded target (or has none) is INCOMPLETE and can never render PASS; a cell
 * WITH losses stays FAIL, because failures beat everything. Everything else is
 * verdictFor().
 */
export function cellVerdict(t, attack, controlFailed, controlState) {
  // A record-only cell (A13-C4-OOM) is never INCOMPLETE: it is RECORD-ONLY.
  if (t.c4 && t.failed === 0 && !RECORD_ONLY_ATTACKS.has(attack)) {
    if (t.targetState === 'missing') return 'INCOMPLETE (no target recorded)'
    if (t.targetState === 'inconsistent') return 'INCOMPLETE (inconsistent target)'
    if (t.targetState === 'ok' && t.groupRan !== null && t.groupRan !== t.target) {
      return `INCOMPLETE (ran ${t.groupRan}/${t.target} across A13 labels)`
    }
    if (t.targetState === 'ok' && t.groupRan === null && t.ran !== t.target) {
      return `INCOMPLETE (ran ${t.ran}/${t.target})`
    }
  }
  return verdictFor(
    {
      attack,
      passed: t.passed,
      failed: t.failed,
      neverRan: t.neverRan,
      otherNeverRan: t.otherNeverRan,
    },
    controlFailed,
    controlState
  )
}
