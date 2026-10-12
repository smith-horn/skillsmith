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
import { writeTraceArtifact, assertCompactMatchesArtifact } from './c4-trace-store.mjs'

export const SKEW_MIN_MS = -0.05
export const SKEW_MAX_MS = 25
export const VACUOUS_REASON = 'vacuous-check'
export const PRE_CALLER_HASH_REASON = 'pre-caller-hash'

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
  callerIntentProof,
  traceArtifactError,
}) {
  const harnessErrors = []
  if (traceMatched !== true) harnessErrors.push('trace-mismatch')
  if (clockOrderOk !== true) harnessErrors.push('clock-order')
  if (unscorable) harnessErrors.push(`unscorable:${unscorable}`)
  // The trace could not be stored and verified (traceArtifactFor).
  if (traceArtifactError) harnessErrors.push(String(traceArtifactError))
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
    return {
      status: 'harness-error',
      mutationApplied: true,
      excludedReason: null,
      callerIntentProof: null,
      harnessErrors,
    }
  }
  const mutationApplied = routed.mutationApplied === true
  // Caller intent: a quarantined, non-landing run whose landing is
  // pre-caller-hash (not a forced partial) AND whose proof is valid. The
  // measured userFiles are left as measured; this label is what says the loss
  // was the caller's request. A kept run moved nothing and stays a plain
  // non-landing. landingFromRacer only ever classes a quarantined run
  // pre-caller-hash when the moved tree matched the caller hash, so a missing
  // or mismatched hash never reaches here as pre-caller-hash.
  if (
    !mutationApplied &&
    c4Status === 'quarantined' &&
    (landings ?? []).some((x) => x.cls === 'pre-caller-hash' && x.forceScored !== true) &&
    isValidCallerIntentProof(callerIntentProof)
  ) {
    return {
      status: c4Status,
      mutationApplied,
      excludedReason: PRE_CALLER_HASH_REASON,
      callerIntentProof,
      harnessErrors,
    }
  }
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
    callerIntentProof: null,
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

const HEX64 = /^[0-9a-f]{64}$/
const isHex64 = (h) => typeof h === 'string' && HEX64.test(h)

/**
 * CALLER INTENT (owner decision on governance finding 1). An A13 run whose
 * racer finished BEFORE the caller hashed, where C4 then moved exactly the
 * tree the caller hashed, is not a loss against C4: the caller saw that
 * content and asked to remove it (decision 5). It must be provable, so a
 * producer bug cannot hide a real loss: the record carries both hashes.
 * callerHash is runC4Candidate's caller (guard) hash, movedTreeHash the hash of
 * the quarantined tree, computed after the racer was joined.
 */
export function callerIntentProofOf(callerHash, movedTreeHash) {
  return {
    callerHash: callerHash ?? null,
    movedTreeHash: movedTreeHash ?? null,
    equal: callerHash === movedTreeHash,
  }
}

/** Valid only for two real 64-hex hashes that are equal (a stored equal:true is re-checked). */
export function isValidCallerIntentProof(p) {
  return (
    p !== null &&
    typeof p === 'object' &&
    isHex64(p.callerHash) &&
    isHex64(p.movedTreeHash) &&
    p.callerHash === p.movedTreeHash &&
    p.equal === true
  )
}

/**
 * Stores the run's full trace as a content-addressed side file
 * (c4-trace-store.mjs: atomic write, verified by read-back) and returns the
 * reference recorded as extra.traceArtifact. The compact's sha256 must name
 * the artifact. Any failure -- no traceDir, a write or verify throw, a sha256
 * mismatch -- is returned as `error`, never swallowed: decideRecord turns it
 * into a counted harness-error, because a matched run's compact drops the full
 * trace and an unstored trace would be lost evidence. `write` is injectable
 * so the failure branch is testable without breaking a filesystem.
 * @returns {{traceArtifact: {sha256: string, path: string}|null, error: string|null}}
 */
export function traceArtifactFor(trace, traceCompact, traceDir, write = writeTraceArtifact) {
  try {
    if (traceDir === undefined || traceDir === null) throw new Error('no traceDir given')
    const ref = write(trace, { dir: traceDir })
    assertCompactMatchesArtifact(traceCompact, ref)
    return { traceArtifact: { sha256: ref.sha256, path: ref.path }, error: null }
  } catch (err) {
    return {
      traceArtifact: null,
      error: `trace-artifact:${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
