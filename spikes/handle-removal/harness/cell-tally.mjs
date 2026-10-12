// Per-cell record counting and the cell verdict, shared by aggregateCell()
// (harness/result-schema.mjs) and results/generate-summary.mjs so the two
// deciders cannot drift (they did once: SMI-6676 R6). Legacy cells are counted
// exactly as before; the C4 rules below apply only to records whose cell is C4
// (isC4Cell), so no pre-existing record can be affected.

import { verdictFor, RECORD_ONLY_ATTACKS } from './control-spec.mjs'
import { isC4Cell } from './result-schema.c4.mjs'

/** The only `outcome.excludedReason` a C4 record may carry. Anything else is a harness fault. */
export const EXCLUDED_REASONS = new Set(['vacuous-check'])

/** `cell.targetScope` value: the run count covers both A13 labels together. */
export const TARGET_SCOPE_A13 = 'across-a13-labels'
const A13_LABELS = new Set(['A13-C4', 'A13-C4-OOM'])
const validTarget = (x) => Number.isSafeInteger(x) && x > 0

/**
 * Counts one cell's records.
 *
 * C4 records only:
 *  - `outcome.excludedReason === 'vacuous-check'` on a record that otherwise
 *    PASSED leaves the denominator like a non-landing (neverRan, not
 *    otherNeverRan) and is counted in `excluded`, so an A13-C4 run whose only
 *    check was vacuous cannot count toward the 100-landing floor.
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
  let neverRan = 0
  let otherNeverRan = 0
  let excluded = 0
  let c4 = false
  for (const r of records) {
    const isC4 = isC4Cell(r?.cell)
    c4 = c4 || isC4
    const cls = classify(r)
    const er = isC4 ? r?.outcome?.excludedReason : undefined
    // R6 drops only the runs where the RACER DID NOT LAND. For C4 records a
    // harness-error is never a non-landing, whatever mutationApplied says: the
    // run did not happen for a reason that has nothing to do with the racer.
    const nonLanding =
      r?.precondition?.mutationApplied === false &&
      !(isC4 && r?.outcome?.status === 'harness-error')
    if (er !== undefined && er !== null) {
      if (cls === 'failed') {
        // Failures beat exclusion (G3-2): a run whose check FAILED is a loss
        // whatever label it carries -- including 'vacuous-check', which should
        // never co-occur with a loss, and an unrecognised label, which must not
        // hide one.
        failed += 1
      } else if (er === 'vacuous-check' && cls === 'passed') {
        neverRan += 1
        excluded += 1
      } else if (er === 'vacuous-check') {
        neverRan += 1
        if (!nonLanding) otherNeverRan += 1
      } else {
        neverRan += 1
        otherNeverRan += 1
      }
      continue
    }
    if (cls === 'passed') passed += 1
    else if (cls === 'failed') failed += 1
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
    neverRan,
    otherNeverRan,
    excluded,
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
