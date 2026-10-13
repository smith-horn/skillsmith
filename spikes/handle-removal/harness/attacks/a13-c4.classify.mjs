// A13-C4's decision logic, as pure functions of plain inputs (no fs, no
// racer, no clock), so harness/a13-c4.selftest.mjs can drive every branch
// with synthetic values. a13-c4.mjs gathers the measurements and calls these.
//
// LANDING IS AN INTERVAL, NOT AN INSTANT. [s, l] is the DESTRUCTIVE step's own
// interval (the first completed step of a13-c4.racer.mjs; review R1-F3): s is
// stamped before that syscall, l after it returned, so l is an UPPER bound on
// when it hit the filesystem (a13-vr.mjs documents milliseconds of child
// scheduling delay under contention) and s a LOWER bound. classifyLanding
// uses the whole interval, all values on one clock (hrtime ms):
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
// racer facts are kept in extra.racerSteps / racerFailedStep. A run with BOTH an in-model and an
// out-of-model landing goes to 'A13-C4', because the in-model race happened.
// The cost is real: a loss caused by the out-of-model landing is then charged
// to the in-model cell. lossPrecededBy names the latest-ending relevant
// landing so a summary can re-attribute. The step racer makes exactly one
// mutation per run, so today a run has at most one landing; routeRun takes
// a list anyway so a racer that makes several cannot silently pick a label.
//
// HASH EVIDENCE (deriveHashEvidence + the override in landingFromRacer). The
// pristine tree is hashed before the racer exists; a moved tree is hashed at
// its quarantine path after the racer is joined. If the caller's hash differs
// from pristine AND the moved tree still equals the caller's hash, the single
// mutation was complete before the caller hashed: the landing is
// 'pre-caller-hash' whatever the timestamps say. Never applied to a PARTIAL
// run (see landingFromRacer). It never fired in 40 live smoke runs; the
// selftest proves the branch synthetically.
//
// CALLER-HASH RACE (recordForRunError). If the racer is mid-mutation while the
// caller hashes, runC4Candidate throws before quarantineTree runs. When the
// racer's expectations, scored at their original paths, show nothing lost or
// changed, that is a NON-ERROR NON-LANDING: status 'not-run', mutationApplied
// false, which the shared tally drops from the denominator (final governance
// F1; why it is not a harness error is in recordForRunError's docblock). A
// loss there, or a run that cannot be scored, means the harness model is
// wrong: a harness-error with mutationApplied true, counted against the cell.
// Only a real Error with the c4-shared prefix AND a racer whose first step
// overlaps the caller-hash window qualify; anything else rethrows.
//
// CLOCK/HASH CONTRADICTION (final governance F3). Timestamps that say the
// racer finished before the caller hash BEGAN, together with clock-independent
// evidence the tree changed after the caller hashed, cannot both be true with
// one writer. landingFromRacer marks it and decideRecord makes it a counted
// harness-error, never a credited catch.

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
 * A13-C4-POSTHASH (SMI-6715 Step 1b part 2): a landing's class against C4's OWN
 * pre-move hash end, from the destructive step's interval [s, l] (hrtime ms):
 *   pre-hash     l < hashEndAt: landed before C4's hash had certainly ended,
 *                so C4's pre-move hash may have seen it.
 *   post-rename  s > moveEnd: began after the rename returned.
 *   post-hash    otherwise: the interval reaches [hashEndAt, moveEnd]. These
 *                are the landings the variant exists to produce; the repaired
 *                C4 can only catch them after the move (held).
 * Boundaries as classifyLanding: l == hashEndAt is post-hash, s == moveEnd is
 * post-hash. A missing stamp is 'unknown'. Informational: routing and scoring
 * use classifyLanding/routeRun; this is the distribution the variant reports.
 */
export function phaseClass({ s, l, hashEndAt, moveEnd }) {
  if (s == null || l == null || hashEndAt == null || moveEnd == null) return 'unknown'
  if (l < hashEndAt) return 'pre-hash'
  if (s > moveEnd) return 'post-rename'
  return 'post-hash'
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
 * The landing for one run, from the step racer's report (a13-c4.racer.mjs).
 *
 * A LANDING IS ANY COMPLETED STEP (review R1-F1). The shared racer reported
 * `applied:null` whenever a later syscall failed, so a destructive first step
 * that DID land (an unlink or a rename-aside, followed by an ENOENT because C4
 * had already moved the tree) produced no landing, no scored files, and R6's
 * non-landing exemption. Here the first completed step decides.
 *
 * CLASSIFIED FROM THE DESTRUCTIVE STEP'S OWN INTERVAL (review R1-F3): the first
 * completed step's [startAt, endAt], not the whole mutation's. Every later step
 * is carried in the record so a re-analysis can key on another one.
 *
 * A PARTIAL RUN (some steps completed, then one failed) is ALWAYS scored:
 * `forceScored` keeps it out of the irrelevant classes' R6 exemption even when
 * its destructive step timestamps as pre-caller-hash or post-rename, and the
 * hash override is not applied to it (that override's proof assumes the one
 * mutation was COMPLETE before the caller hashed). That is the conservative
 * direction: a partial whose first step truly landed before the caller hashed
 * is scored against C4 anyway.
 *
 * @param {object} a
 * @param {object|null} a.racer - the step racer's result. `steps: null` means
 *   the racer's report is unknown (unparseable output); the caller must treat
 *   that as unscorable, never as "no landing". This function throws on it.
 */
export function landingFromRacer({
  racer,
  callerHashStartAt,
  callerHashAt,
  inModelEnd,
  moveEnd,
  provenPreCallerHash,
  movedTreeDiffersFromCallerHash,
}) {
  if (!racer || !Array.isArray(racer.steps)) {
    throw new TypeError('landingFromRacer: racer report has no steps array (unknown, not empty)')
  }
  if (racer.steps.length === 0) return []
  const first = racer.steps[0]
  const last = racer.steps[racer.steps.length - 1]
  const partial = racer.failedStep != null
  const c = classifyLanding({
    s: first.startAt ?? null,
    l: first.endAt ?? null,
    callerHashAt,
    inModelEnd,
    moveEnd,
  })
  // PRE-CALLER-HASH NEEDS THE WHOLE MUTATION, NOT THE FIRST STEP. The first
  // step is the right instant for in-model vs out-of-model (it decides whether
  // C4 could have noticed the change), but "the caller hashed the racer's own
  // content" holds only if EVERY step had landed before the caller's hash
  // finished, and never if the moved tree differs from what the caller hashed.
  // Found by smoke: an a7 whose unlink ended before callerHashAt and whose
  // write ended after it was being dropped as irrelevant while the user's new
  // file sat in the trash. Such a run is in-model: its first step started
  // before inModelEnd (it started before callerHashAt) and part of it landed
  // after the caller observed the tree.
  let cls = c.cls
  let evidence = 'timestamp'
  let contradiction = false
  if (cls === 'pre-caller-hash') {
    if (
      movedTreeDiffersFromCallerHash === true &&
      typeof callerHashStartAt === 'number' &&
      typeof last.endAt === 'number' &&
      last.endAt < callerHashStartAt
    ) {
      // CONTRADICTION (final governance F3): the timestamps say the racer's
      // whole mutation finished before the caller hash BEGAN, so the caller
      // hashed the final state -- yet C4's outcome or the moved tree says the
      // tree changed after the caller hashed. With one writer that cannot
      // happen; the clock or the model is wrong. Not credited as a catch:
      // decideRecord makes it a counted harness-error.
      cls = 'in-model'
      evidence = 'clock-hash-contradiction'
      contradiction = true
    } else if (movedTreeDiffersFromCallerHash === true) {
      cls = 'in-model'
      evidence = 'hash-moved-tree-differs'
    } else if (last.endAt == null || !(last.endAt < callerHashAt)) {
      cls = 'in-model'
      evidence = 'last-step-after-caller-hash'
    } else if (typeof callerHashStartAt !== 'number' || !(last.endAt < callerHashStartAt)) {
      // Landed DURING the caller's own hash (found at --dirs 200, where that
      // hash takes ~10 ms): the caller may have read the entry before the
      // mutation, so the timestamps cannot say it hashed the racer's content.
      // Only the hash proof below can; without it the run is scored. A
      // missing start stamp cannot prove anything either (fail-closed).
      cls = 'in-model'
      evidence = 'landed-during-caller-hash'
    }
  }
  const byHash = !partial && provenPreCallerHash === true && cls !== 'pre-caller-hash'
  if (byHash) {
    cls = 'pre-caller-hash'
    evidence = 'hash'
  }
  return [
    {
      mutation: racer.mutation ?? null,
      destructiveOp: first.op,
      destructivePath: first.path,
      mutationStartedAt: first.startAt ?? null,
      landedAt: first.endAt ?? null,
      cls,
      straddles: c.straddles,
      // The destructive step's own interval crosses the in-model end. Such a
      // run stays in the scored cell (conservative) and is counted.
      straddlesInModelEnd:
        first.startAt != null &&
        first.endAt != null &&
        inModelEnd != null &&
        first.startAt < inModelEnd &&
        first.endAt >= inModelEnd,
      timestampCls: c.cls,
      evidence,
      contradiction,
      lastStepEndAt: last.endAt ?? null,
      partial,
      forceScored: partial && IRRELEVANT.has(cls),
      stepsCompleted: racer.steps.length,
      failedOp: partial ? racer.failedStep.op : null,
      failedError: partial ? (racer.failedStep.error ?? null) : null,
    },
  ]
}

/** @returns {{label:string, mutationApplied:boolean, relevant:object[]}} */
export function routeRun(landings) {
  const relevant = landings.filter((x) => !IRRELEVANT.has(x.cls) || x.forceScored === true)
  const scored = (x) => x.cls === 'in-model' || x.cls === 'unknown' || x.forceScored === true
  const label = relevant.length > 0 && !relevant.some(scored) ? 'A13-C4-OOM' : 'A13-C4'
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
  const n = (p) => landings.filter(p).length
  return {
    total: landings.length,
    inModel: n((x) => x.cls === 'in-model'),
    outOfModel: n((x) => x.cls === 'out-of-model'),
    preCallerHash: n((x) => x.cls === 'pre-caller-hash'),
    postRename: n((x) => x.cls === 'post-rename'),
    unknown: n((x) => x.cls === 'unknown'),
    partial: n((x) => x.partial === true),
    forceScored: n((x) => x.forceScored === true),
    // Printed beside the verdict by the runner: runs kept in the scored cell
    // although the destructive step's own interval crosses the in-model end.
    straddlesInModelEnd: n((x) => x.straddlesInModelEnd === true),
  }
}

/**
 * Whether a runC4Candidate throw is the caller-hash race, and only that
 * (review R2-7). All three must hold:
 *   - `err` is a real Error whose message starts with the c4-shared prefix. A
 *     non-Error is never accepted, even if its toString carries the prefix.
 *   - the racer completed at least one step.
 *   - the racer's FIRST step interval overlaps the caller-hash window
 *     [startAt, endAt] (closed, one clock). Without this, an unrelated
 *     caller-hash failure was swallowed while the racer landed 5 s later. A
 *     missing window fails closed: the error is rethrown.
 */
export function isCallerHashRaceFailure({ err, racer, callerHashWindow }) {
  if (!(err instanceof Error) || typeof err.message !== 'string') return false
  if (!err.message.startsWith(CALLER_HASH_FAILED_PREFIX)) return false
  if (!Array.isArray(racer?.steps) || racer.steps.length === 0) return false
  const w = callerHashWindow
  if (!w || typeof w.startAt !== 'number' || typeof w.endAt !== 'number') return false
  const first = racer.steps[0]
  if (typeof first.startAt !== 'number' || typeof first.endAt !== 'number') return false
  return first.startAt <= w.endAt && first.endAt >= w.startAt
}

/**
 * Turns a runC4Candidate throw into a record, or rethrows it. Qualifies only
 * as isCallerHashRaceFailure decides (a real Error with the prefix, and the
 * racer's first step overlapping the caller-hash window). quarantineTree never
 * ran on this path, so nothing was moved; `quarantineLeft` comes from the caller.
 *
 * A CLEAN CALLER-HASH RACE IS A NON-ERROR NON-LANDING (final governance F1):
 * status 'not-run', mutationApplied false, so the shared tally (cell-tally.mjs)
 * drops it from the denominator like any racer that did not land in a window
 * this cell scores. It is not a harness error -- nothing in the harness failed:
 * the racer was mutating while the CALLER computed its guard hash, the caller
 * got an error, and removal was never called, exactly as a real caller would
 * behave. C4 never ran, so this is not a race against C4. Counting it as a
 * harness error would also disqualify the A13 cell at scale: at 1,630 dirs the
 * caller hash takes ~100 ms and most landings fall inside it. 'not-run' rather
 * than 'stopped', so a status histogram never confuses it with a real C4 stop.
 *
 * `scored` is the racer's expectations scored at their original paths (see
 * a13-c4.score.mjs). If that scoring found anything lost or changed, or could
 * not run, the record IS a harness-error with mutationApplied true: C4 never
 * ran, so a loss means the harness's own model of the racer is wrong. The tally
 * counts a measured loss on a C4 harness-error as failed and an unmeasured one
 * as otherNeverRan; both keep the cell from passing.
 */
export function recordForRunError({
  err,
  candidate,
  racer,
  markerObservedAt,
  durationMs,
  quarantineLeft,
  scored,
  callerHashWindow,
}) {
  if (!isCallerHashRaceFailure({ err, racer, callerHashWindow })) throw err
  const message = err.message
  const unexplainedLoss = !scored || scored.lost + scored.changed > 0
  return {
    precondition: {
      hookFired: false,
      mutationApplied: unexplainedLoss,
      traceMatched: false,
      controlExpected: true,
    },
    outcome: {
      status: unexplainedLoss ? 'harness-error' : 'not-run',
      reason: unexplainedLoss
        ? `${CALLER_HASH_RACE_REASON}+unexplained-loss`
        : CALLER_HASH_RACE_REASON,
      path: null,
      entry: null,
      errno: null,
      quarantineLeft,
    },
    userFiles: scored
      ? {
          checked: scored.checked,
          lost: scored.lost,
          changed: scored.changed,
          displaced: scored.displaced,
          deleted: scored.deleted,
        }
      : { checked: 0, lost: 0, changed: 0, displaced: 0, deleted: 0 },
    durationMs,
    extra: {
      label: 'A13-C4',
      variant: VARIANT,
      candidate,
      firedAt: null,
      // quarantineTree never ran: no trace. Same field as every other A13
      // record, with nothing in it.
      traceCompact: null,
      traceArtifact: null,
      racerMutation: racer.mutation ?? null,
      racerComplete: racer.complete === true,
      racerSteps: racer.steps,
      racerFailedStep: racer.failedStep ?? null,
      racerDelayMs: racer.delayMs ?? null,
      callerHashError: message,
      landings: [
        {
          mutation: racer.mutation ?? null,
          mutationStartedAt: racer.steps[0].startAt ?? null,
          landedAt: racer.steps[0].endAt ?? null,
          cls: 'pre-caller-hash',
          straddles: true,
          timestampCls: null,
          evidence: 'caller-hash-threw',
          partial: racer.failedStep != null,
          forceScored: false,
          straddlesInModelEnd: false,
        },
      ],
      landingCounts: {
        total: 1,
        inModel: 0,
        outOfModel: 0,
        preCallerHash: 1,
        postRename: 0,
        unknown: 0,
        partial: racer.failedStep != null ? 1 : 0,
        forceScored: 0,
        straddlesInModelEnd: 0,
      },
      lossAttribution: {
        lost: unexplainedLoss,
        lossPrecededBy: null,
        classes: ['pre-caller-hash'],
      },
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
