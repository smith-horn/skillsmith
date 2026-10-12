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
    excludedReason: mutationApplied && scored?.vacuous === true ? VACUOUS_REASON : null,
    harnessErrors,
  }
}
