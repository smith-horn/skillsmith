// A13-C4 record-level decisions (status, mutationApplied, excludedReason),
// as one pure function of plain inputs so harness/a13-c4.selftest.record.mjs
// can drive every rule synthetically.
//
// EVERY FORCED HARNESS-ERROR IS COUNTED (review R2-11). A run this module
// turns into a harness-error carries mutationApplied:true, whatever routing
// said. R6 drops only runs with mutationApplied === false, so a harness-error
// left at false was silently treated as "the racer did not land" -- it turned
// a cell that should read NEVER-RAN into NEVER-RAN (underpowered) and erased a
// naive loss. A harness-error is the harness failing, not the racer missing.
//
// CLOCK GUARDS (review R2-10). Every class this cell assigns rests on
// cross-process timestamps, so the two ways they can be wrong are checked:
//   - clockSkewCheckMs = markerObservedAt - markerWrittenAt (parent saw the
//     marker minus child stamped it). It cannot be negative if the clocks
//     agree, because the child stamps before writing. Measured for the step
//     racer on darwin (2026-10-12, 200 runs idle and 200 under an 8-thread CPU
//     load on 10 cores): min +0.073 ms, never negative; max 3.1 ms idle and
//     11.2 ms loaded (p99 8.8 ms), the positive side being parent scheduling
//     delay. SKEW_MIN_MS = -0.05 allows the measured cross-process offset
//     bound (-0.035 ms, two-sided sandwich) and nothing more; a racer clock
//     running ahead by 50 ms (the K3 attack, -49.9 ms) fails it. SKEW_MAX_MS =
//     25 is about twice the loaded maximum: a racer clock running BEHIND by
//     less than that is indistinguishable from scheduling delay, which is why
//     the pre-caller-hash class also needs the hash or last-step evidence (see
//     a13-c4.classify.mjs) rather than resting on the clock alone.
//   - the converted callerHashStartAt must not precede markerObservedAt: the
//     caller hash starts after the parent saw the marker, so an earlier value
//     means the perf-clock-to-hrtime conversion is wrong (the K1 attack, stamps
//     3 ms early). clockOrderOk covers the opposite direction.
// Either failure, or a missing value, makes the run a harness-error.
//
// A POST-RENAME LANDING CANNOT LOSE BYTES. Its destructive step began after the
// rename returned, so the tree it touched was no longer C4's. A post-rename
// class together with lost + changed > 0 means the clock or the model is
// wrong, and the run is a harness-error rather than a quietly dropped loss.
//
// VACUOUS RUNS (owner decision 2026-10-12). A landed run whose only check is
// the vacuous `absent` expectation (a13-c4.score.mjs) keeps mutationApplied
// true and is marked outcome.excludedReason = 'vacuous-check'; the shared
// aggregator and summary drop that exact reason from the 100-landing floor
// and count it separately.

import { compactTrace } from './c4-trace-match.mjs'

export const SKEW_MIN_MS = -0.05
export const SKEW_MAX_MS = 25
export const VACUOUS_REASON = 'vacuous-check'

export function decideRecord({
  c4Status,
  traceMatched,
  clockOrderOk,
  clockSkewCheckMs,
  markerObservedAt,
  callerHashStartAt,
  unscorable,
  routed,
  landings,
  scored,
}) {
  const harnessErrors = []
  if (traceMatched !== true) harnessErrors.push('trace-mismatch')
  if (clockOrderOk !== true) harnessErrors.push('clock-order')
  if (unscorable) harnessErrors.push(`unscorable:${unscorable}`)
  if (typeof clockSkewCheckMs !== 'number' || !Number.isFinite(clockSkewCheckMs)) {
    harnessErrors.push('clock-skew-unmeasured')
  } else if (clockSkewCheckMs < SKEW_MIN_MS || clockSkewCheckMs > SKEW_MAX_MS) {
    harnessErrors.push(`clock-skew:${clockSkewCheckMs}`)
  }
  if (
    typeof callerHashStartAt !== 'number' ||
    typeof markerObservedAt !== 'number' ||
    callerHashStartAt < markerObservedAt
  ) {
    harnessErrors.push('caller-hash-before-marker')
  }
  const lostOrChanged = !!scored && scored.lost + scored.changed > 0
  // Timestamps and hash evidence disagree (classify.mjs landingFromRacer).
  if ((landings ?? []).some((x) => x.contradiction === true)) {
    harnessErrors.push('clock-hash-contradiction')
  }
  if (lostOrChanged && (landings ?? []).some((x) => x.cls === 'post-rename')) {
    harnessErrors.push('impossible-post-rename-loss')
  }
  if (harnessErrors.length > 0) {
    return { status: 'harness-error', mutationApplied: true, excludedReason: null, harnessErrors }
  }
  const mutationApplied = routed.mutationApplied === true
  return {
    status: c4Status,
    mutationApplied,
    // Only a vacuous check that HELD leaves the floor (review G3-2): when it
    // failed (the deleted path came back, changed 1) that is a loss, and a
    // loss is never excluded from the denominator.
    excludedReason:
      mutationApplied && scored?.vacuous === true && scored.lost + scored.changed === 0
        ? VACUOUS_REASON
        : null,
    harnessErrors,
  }
}

/**
 * Converted c4-shared stamps may not lie after this process stamped the call's
 * return. A missing or non-numeric stamp FAILS (review G3-8): "not measured"
 * is not "in order", and decideRecord turns the failure into a harness-error
 * counted against the cell.
 */
export function clockOrderOk({ callerHashStartAt, callAttemptAtH, callEndAt, callReturnedAtH }) {
  // Both sides (rt3): a late shift puts the converted call end after this
  // process's post-call stamp; an EARLY shift puts the converted caller-hash
  // start before this process's pre-call stamp. The caller hash runs inside
  // runC4Candidate, so it cannot start before the call was made. 0.01 ms
  // tolerance on each side, the same as before; the in-process conversion
  // offset measured constant to 0.25 us.
  return (
    typeof callerHashStartAt === 'number' &&
    typeof callAttemptAtH === 'number' &&
    typeof callEndAt === 'number' &&
    typeof callReturnedAtH === 'number' &&
    callerHashStartAt >= callAttemptAtH - 0.01 &&
    callEndAt <= callReturnedAtH + 0.01
  )
}

/**
 * The caller-hash window for the R2-7 relatedness check (review G3-7).
 * c4-shared's own stamps when the thrown error carries them (performance
 * clock, converted to hrtime with `offset`); otherwise this process's bracket
 * around the throwing call, which contains the caller hash because
 * runC4Candidate throws from it.
 */
export function callerHashWindowFrom(err, { offset, callAttemptAtH, catchAtH }) {
  const own = typeof err?.callerHashStartAt === 'number' && typeof err?.callerHashAt === 'number'
  return own
    ? {
        startAt: toH(err.callerHashStartAt, offset),
        endAt: toH(err.callerHashAt, offset),
        source: 'c4-shared',
      }
    : { startAt: callAttemptAtH, endAt: catchAtH, source: 'call-bracket' }
}

/**
 * Puts a c4-shared timestamp on hrtime. The two clocks are told apart by
 * magnitude, not assumed: the performance clock is epoch-based (~1.7e12 ms),
 * hrtime is boot-based (orders of magnitude smaller).
 */
export function toH(t, offset) {
  if (t == null) return null
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    throw new TypeError(`a13-c4: non-numeric timestamp ${String(t)}`)
  }
  return t > 1e12 ? t + offset : t
}

/**
 * Whether the tree provably changed after the caller hashed it, from
 * clock-independent evidence (found at --dirs 200, where four C4 'kept' runs
 * were being dropped as pre-caller-hash):
 *   - a moved tree that does not match the caller's hash (or could not be
 *     hashed: the conservative reading);
 *   - C4 'kept' with reason 'identity-changed' (final governance F3): its own
 *     hash or identity check saw the ORIGIN tree differ from what the caller
 *     hashed, and C4's checks all run after the caller's hash. Any other kept
 *     reason (e.g. quarantine-destination-changed, about the trash, not the
 *     tree) is not evidence about the origin tree;
 *   - C4 'stopped' by its own hash read (reason guard-*): an entry the caller
 *     read was gone or unreadable when C4 read it.
 * A 'stopped' at the rename (quarantine-failed) is not hash evidence.
 */
export function treeChangedAfterCallerHash({
  c4Status,
  c4Reason,
  destPath,
  movedTreeMatchesCallerHash,
}) {
  if (destPath != null) return movedTreeMatchesCallerHash !== true
  if (c4Status === 'kept') return c4Reason === 'identity-changed'
  return c4Status === 'stopped' && typeof c4Reason === 'string' && c4Reason.startsWith('guard-')
}

/**
 * The per-run trace as emitted (Step 1 record size: A13 records at --dirs 1630
 * were ~2 MB, almost all full trace). compactTrace (c4-trace-match.mjs) keeps a
 * bounded summary and drops the full trace ONLY when `traceMatched` is the
 * strict boolean true, so a mismatch stays fully diagnosable. runC4Candidate's
 * own strict boolean is passed straight through, never coerced. Nothing that
 * classifies or scores reads the trace: decideRecord takes traceMatched itself.
 */
export function traceCompactOf(trace, traceMatched) {
  return compactTrace(trace, { traceMatched })
}
