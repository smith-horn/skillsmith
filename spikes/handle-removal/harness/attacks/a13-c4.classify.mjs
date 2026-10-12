// A13-C4's decision logic, as pure functions of plain inputs (no fs, no
// racer, no clock), so harness/a13-c4.selftest.mjs can drive every branch
// with synthetic values. a13-c4.mjs gathers the measurements and calls these.
//
// LANDING IS AN INTERVAL, NOT AN INSTANT. The racer's landedAt is taken after
// its last mutation syscall returned, so it is an UPPER bound (a13-vr.mjs
// documents milliseconds of child scheduling delay under contention);
// mutationStartedAt is a LOWER bound. classifyLanding uses the whole interval
// [s, l], all values on one clock (hrtime ms):
//   pre-caller-hash  l < callerHashAt. Irrelevant: the caller hashed the
//                    racer's own content, so quarantining it is what the
//                    caller asked for. Not a race against C4.
//   post-rename      s > moveEnd (the instant renameSync returned, or
//                    callEndAt when no rename ran). Irrelevant: the tree was
//                    already moved or kept before the mutation began.
//   in-model         the interval intersects [callerHashAt, inModelEnd).
//                    C4: inModelEnd = recheckAt. C4-naive (no re-check):
//                    inModelEnd = renameAt.
//   out-of-model     otherwise: the whole interval lies at or after
//                    inModelEnd and starts no later than moveEnd. Owner
//                    decision 5: [re-check entered, renameSync returned]. The
//                    brief says out-of-model is C4-only; here the rename
//                    syscall itself, [renameAt, moveEnd], is out-of-model for
//                    BOTH arms, because decision 5 puts the rename call out of
//                    model whatever precedes it. A deviation from the brief,
//                    microseconds wide.
// Boundaries, exactly: l == callerHashAt is NOT pre-caller-hash (the window is
// closed at its start); s == inModelEnd is NOT in-model (half-open);
// s == moveEnd is NOT post-rename (decision 5's window includes the return).
// "Intersects" is deliberate: routing on l alone would move possible in-model
// losses into the record-only OOM cell, the direction that hides a defect.
// `straddles` records that a landing was ambiguous.
//
// ROUTING (routeRun). Exactly one label per run:
//   'A13-C4'      no relevant landing (mutationApplied:false, which R6 drops
//                 from the denominator), or at least one in-model or unknown
//                 landing (mutationApplied:true).
//   'A13-C4-OOM'  every relevant landing is out-of-model (record-only).
// `mutationApplied` means "landed inside a window this cell scores"; the raw
// racer fact is kept in extra.racerApplied. A run with BOTH an in-model and an
// out-of-model landing goes to 'A13-C4', because the in-model race happened.
// The cost is real: a loss caused by the out-of-model landing is then charged
// to the in-model cell. lossPrecededBy names the latest-ending relevant
// landing so a summary can re-attribute. spawnConcurrentRacer makes exactly
// one mutation per run, so today a run has at most one landing; routeRun takes
// a list anyway so a racer that makes several cannot silently pick a label.
//
// HASH EVIDENCE (deriveHashEvidence + the override in buildLandings). The
// pristine tree is hashed before the racer exists; a moved tree is hashed at
// its quarantine path after the racer is joined. If the caller's hash differs
// from pristine AND the moved tree still equals the caller's hash, the single
// mutation was complete before the caller hashed: the landing is
// 'pre-caller-hash' whatever the timestamps say. It never fired in 40 live
// smoke runs; the selftest proves the branch synthetically.
//
// CALLER-HASH RACE (recordForRunError). If the racer is mid-mutation while the
// caller hashes, runC4Candidate throws before quarantineTree runs. That is
// recorded as a pre-caller-hash non-landing with status 'harness-error' and
// mutationApplied:false, instead of a throw the runner would count as a
// never-ran R6 cannot explain. Only that message AND a racer that actually
// applied a mutation qualify; anything else rethrows.

export const VARIANT = 'racer/by-timestamp'
export const CALLER_HASH_FAILED_PREFIX = 'runC4Candidate: caller hash failed'
export const CALLER_HASH_RACE_REASON = 'caller-hash-failed-racer-mid-mutation'

const IRRELEVANT = new Set(['pre-caller-hash', 'post-rename'])

/** @returns {{cls:string, straddles:boolean}} */
export function classifyLanding({ s, l, callerHashAt, inModelEnd, moveEnd }) {
  if (l == null || s == null || callerHashAt == null || inModelEnd == null || moveEnd == null) {
    return { cls: 'unknown', straddles: false }
  }
  if (l < callerHashAt) return { cls: 'pre-caller-hash', straddles: false }
  if (s > moveEnd) return { cls: 'post-rename', straddles: false }
  if (s < inModelEnd) {
    // intersects [callerHashAt, inModelEnd) because l >= callerHashAt
    return { cls: 'in-model', straddles: s < callerHashAt || l >= inModelEnd }
  }
  return { cls: 'out-of-model', straddles: l > moveEnd }
}

/**
 * The in-model end and the move end for an arm, from times on one clock.
 * C4 falls back renameAt -> callEndAt only when the re-check never ran (a
 * 'kept' from a hash mismatch), in which case no out-of-model window existed.
 */
export function windowEnds(candidate, times) {
  const inModelEnd =
    candidate === 'C4'
      ? (times.recheckAt ?? times.renameAt ?? times.callEndAt ?? null)
      : (times.renameAt ?? times.callEndAt ?? null)
  const moveEnd = times.renameReturnedAt ?? times.callEndAt ?? null
  return { inModelEnd, moveEnd }
}

/**
 * @param {{candidate:string, pristineHash:string, guardHash:string, postMoveHash:string|null}} a
 *   postMoveHash: the moved tree's hash, or null when nothing was moved or it
 *   could not be hashed.
 */
export function deriveHashEvidence({ candidate, pristineHash, guardHash, postMoveHash }) {
  const callerSawMutation = guardHash !== pristineHash
  const movedTreeMatchesCallerHash = postMoveHash != null && postMoveHash === guardHash
  // The window the hashes alone bound the change to, when they bound it. For
  // C4 a 'quarantined' result means C4's own hash equalled the caller's, so a
  // moved tree that differs changed after C4 read the changed entry: post-hash
  // (in model, decision 4) or out of model. The hashes cannot split those.
  let window = null
  if (postMoveHash != null && !movedTreeMatchesCallerHash) {
    window =
      candidate === 'C4'
        ? 'after-C4-read-of-entry..rename-returned'
        : 'after-caller-read-of-entry..rename-returned'
  } else if (postMoveHash != null && callerSawMutation) {
    window = 'before-caller-hash'
  }
  return {
    pristineHash,
    guardHash,
    postMoveHash: postMoveHash ?? null,
    callerSawMutation,
    movedTreeMatchesCallerHash,
    provenPreCallerHash: callerSawMutation && movedTreeMatchesCallerHash,
    window,
  }
}

/**
 * Landings for one run. `racer` is the racer's own result object (applied,
 * mutationStartedAt, landedAt); a racer that applied nothing has no landing.
 */
export function buildLandings({ racer, callerHashAt, inModelEnd, moveEnd, provenPreCallerHash }) {
  if (!racer || !racer.applied) return []
  const s = racer.mutationStartedAt ?? null
  const l = racer.landedAt ?? null
  const c = classifyLanding({ s, l, callerHashAt, inModelEnd, moveEnd })
  const byHash = provenPreCallerHash === true && c.cls !== 'pre-caller-hash'
  return [
    {
      mutation: racer.applied,
      mutationStartedAt: s,
      landedAt: l,
      cls: byHash ? 'pre-caller-hash' : c.cls,
      straddles: c.straddles,
      timestampCls: c.cls,
      evidence: byHash ? 'hash' : 'timestamp',
    },
  ]
}

/** @returns {{label:string, mutationApplied:boolean, relevant:object[]}} */
export function routeRun(landings) {
  const relevant = landings.filter((x) => !IRRELEVANT.has(x.cls))
  const anyInModel = relevant.some((x) => x.cls === 'in-model' || x.cls === 'unknown')
  const label = relevant.length > 0 && !anyInModel ? 'A13-C4-OOM' : 'A13-C4'
  return { label, mutationApplied: relevant.length > 0, relevant }
}

/** The latest-ending relevant landing's class when bytes were lost, else null. */
export function lossPrecededBy(relevant, lostOrChanged) {
  if (!lostOrChanged || relevant.length === 0) return null
  let best = relevant[0]
  for (const x of relevant) if ((x.landedAt ?? 0) > (best.landedAt ?? 0)) best = x
  return best.cls
}

export function landingCounts(landings) {
  const n = (c) => landings.filter((x) => x.cls === c).length
  return {
    total: landings.length,
    inModel: n('in-model'),
    outOfModel: n('out-of-model'),
    preCallerHash: n('pre-caller-hash'),
    postRename: n('post-rename'),
    unknown: n('unknown'),
  }
}

/** Whether a runC4Candidate throw is the caller-hash race, and only that. */
export function isCallerHashRaceFailure({ message, racerApplied }) {
  return (
    typeof message === 'string' && message.startsWith(CALLER_HASH_FAILED_PREFIX) && !!racerApplied
  )
}

/**
 * Turns a runC4Candidate throw into a record, or rethrows it. quarantineTree
 * never ran on this path, so `quarantineLeft` is supplied by the caller (a
 * scan with no status/opId, which reports nulls rather than a confident 0).
 */
export function recordForRunError({
  err,
  candidate,
  racer,
  markerObservedAt,
  durationMs,
  quarantineLeft,
}) {
  const message = err instanceof Error ? err.message : String(err)
  if (!isCallerHashRaceFailure({ message, racerApplied: racer?.applied })) throw err
  return {
    precondition: {
      hookFired: false,
      mutationApplied: false,
      traceMatched: false,
      controlExpected: true,
    },
    outcome: {
      status: 'harness-error',
      reason: CALLER_HASH_RACE_REASON,
      path: null,
      entry: null,
      errno: null,
      quarantineLeft,
    },
    userFiles: { checked: 0, lost: 0, changed: 0, displaced: 0, deleted: 0 },
    durationMs,
    extra: {
      label: 'A13-C4',
      variant: VARIANT,
      candidate,
      firedAt: null,
      trace: [],
      racerApplied: racer.applied ?? null,
      racerError: racer.error ?? null,
      racerDelayMs: racer.delayMs ?? null,
      callerHashError: message,
      landings: [
        {
          mutation: racer.applied,
          mutationStartedAt: racer.mutationStartedAt ?? null,
          landedAt: racer.landedAt ?? null,
          cls: 'pre-caller-hash',
          straddles: true,
          timestampCls: null,
          evidence: 'caller-hash-threw',
        },
      ],
      landingCounts: {
        total: 1,
        inModel: 0,
        outOfModel: 0,
        preCallerHash: 1,
        postRename: 0,
        unknown: 0,
      },
      lossAttribution: { lost: false, lossPrecededBy: null, classes: ['pre-caller-hash'] },
      displacedPaths: [],
      hashEvidence: null,
      timing: {
        clock: 'hrtime-ms',
        markerObservedAt,
        markerWrittenAt: racer.markerWrittenAt ?? null,
      },
    },
  }
}
