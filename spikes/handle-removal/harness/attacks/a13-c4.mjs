// A13 against C4 (quarantineTree): a real concurrent racer, with runC4Candidate
// (c4-shared.mjs) as the removal. Candidates 'C4' (caller guardHash passed)
// and 'C4-naive' (same hash computed at the same moment, not passed). Runs
// per cell: 300.
//
// WHAT THE RACER ACTUALLY DOES. ./a13-c4.racer.mjs makes ONE randomly-chosen
// mutation (a3/a5/a7/a8, the same four shapes as _shared.mjs) per run, after
// a 0-2ms busy-wait; it does not repeat. Each mutation is a short sequence of
// single atomic syscalls, each reported with its own start/end. Its target is
// `<fx.root>/tree/target`, inside the tree quarantineTree renames. It is the
// only mutation here: runC4Candidate's 'pre-call' interposition is used purely
// as a clock, with a no-op onFire. _shared.mjs's spawnConcurrentRacer is not
// used and not modified (A13 and A13-VR depend on it byte-for-byte).
//
// THE DECISION LOGIC (landing classes and their exact boundaries, routing to
// 'A13-C4' / 'A13-C4-OOM', the hash override, the caller-hash-race record)
// lives in ./a13-c4.classify.mjs and the scoring model in ./a13-c4.score.mjs,
// both pure, exercised branch by branch by harness/a13-c4.selftest.mjs. This
// file only measures and calls them. extra.variant is the fixed tag
// 'racer/by-timestamp' for BOTH arms (CONTROL_SPEC resolves the naive control
// with matchVariant 'exact').
//
// WINDOW RESOLUTION IS STILL THE LIMIT OF THIS CELL, but a much smaller one
// than before. With the whole-mutation interval of the shared racer, a
// landing spanned ~2-5 ms against a ~0.3-1.4 ms call, every landing
// straddled, and 'A13-C4-OOM' got 0 runs. Per-step stamps measured ~0.04-0.1
// ms per syscall on darwin (2 smokes, 40 runs), against C4's
// re-check-to-rename-return gap of ~0.1-0.2 ms; no destructive step straddled
// the in-model end in those runs. So the in-model/out-of-model split is now
// resolvable for most landings, but not all: a step whose own interval
// crosses the in-model end stays in the scored cell (conservative) and is
// counted in extra.landingCounts.straddlesInModelEnd / extra.straddleCount so
// the runner can print it beside the verdict. That count is the share of
// A13-C4 whose window this instrument could not decide.
//
// CLOCK. The racer stamps with process.hrtime.bigint() (system monotonic).
// _shared.mjs records that performance.timeOrigin + performance.now() once
// produced impossible cross-process orderings (8/8 runs). Re-measured on this
// darwin host on 2026-10-12 with a two-sided sandwich (100 samples per
// direction): both clocks showed zero violations; hrtime bounded the
// cross-process offset to [-0.035, +0.437] ms (the upper side inflated by the
// child's first `performance` access), the performance clock to
// [-0.032, +0.072] ms. Everything is compared on hrtime; c4-shared stamps with
// the performance clock, so its times are converted IN-PROCESS by one
// tight-sandwich offset, which measured constant to 0.25us over 3s.
//
// KNOWN CONFOUND, STATED. C4-naive does no hash, so its in-model window is
// [callerHashAt, renameAt): ensureTrashRoot + mkdir + a few lstats. C4's adds
// a bind lstat and a full path-tree hash. At fixture scale the hash is tiny,
// so both arms share most of the window (the pre-call gap is shared, as both
// start at callerHashAt). At large trees C4's window grows and naive's does
// not, so naive will land far fewer in-model races and its control can fail
// to fail. In the fixture-scale smokes naive got 2-5 in-model landings per 10
// runs and lost data on every one, so the control does fail at fixture
// scale; large trees are unmeasured.
//
// PARTIAL RUNS ARE LANDINGS (review R1-F1). The racer is this cell's own
// (./a13-c4.racer.mjs), not _shared.mjs's: it reports each completed atomic
// step, so an unlink or rename-aside that landed before a later step failed
// with ENOENT (because C4 had already moved the tree) is a landing, scored
// from what is actually on disk (./a13-c4.score.mjs): every user-owned path
// the completed steps produced or moved, a renamed-aside original included,
// must be intact at its original location; found under THIS run's moved tree
// it is displaced, found nowhere it is deleted. A run that cannot be scored
// (racer output unparseable, a probe error, a step the model does not know)
// is a harness-error with mutationApplied:true, so R6 counts it against the
// cell instead of excusing it. Every landed run has checked >= 1.

import { runC4Candidate } from './c4-shared.mjs'
import {
  VARIANT,
  windowEnds,
  deriveHashEvidence,
  landingFromRacer,
  routeRun,
  lossPrecededBy,
  landingCounts,
  recordForRunError,
} from './a13-c4.classify.mjs'
import { expectationsFromSteps, scoreExpectations } from './a13-c4.score.mjs'
import {
  decideRecord,
  clockOrderOk as clockOrderOkOf,
  callerHashWindowFrom,
  treeChangedAfterCallerHash,
  traceCompactOf,
  traceArtifactFor,
  callerIntentProofOf,
  isValidCallerIntentProof,
  toH,
  SKEW_MIN_MS,
  SKEW_MAX_MS,
} from './a13-c4.record.mjs'
import { applyDirs } from './c4-score.mjs'
import { spawnStepRacer } from './a13-c4.racer.mjs'
import { computePathTreeHash } from '../../quarantine.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanC4Leftovers } from '../result-schema.c4.mjs'
import { buildSwapFixture, randomToken } from './_shared.mjs'
import fs from 'node:fs'
import path from 'node:path'

export { VARIANT, classifyLanding } from './a13-c4.classify.mjs'
export const id = 'A13-C4'
export const target = 300

const CANDIDATES = new Set(['C4', 'C4-naive'])
const nowH = () => Number(process.hrtime.bigint()) / 1e6
const nowP = () => performance.timeOrigin + performance.now()

/**
 * hrtime minus the performance clock, from the tightest of `n` sandwiches.
 * In-process the offset is constant (measured); only preemption between the
 * two reads perturbs a sample, and the tightest bracket discards that.
 */
function hrMinusPerf(n = 64) {
  let best = null
  for (let i = 0; i < n; i++) {
    const a = nowH()
    const p = nowP()
    const b = nowH()
    if (!best || b - a < best.gap) best = { gap: b - a, offset: (a + b) / 2 - p }
  }
  return best
}

/**
 * A probe for scoreExpectations rooted at `base`: what is at base/rel, never
 * following the final component. Absent (ENOENT, or ENOTDIR because a parent
 * is no longer a directory) is null; any other error throws, which makes the
 * run unscorable rather than silently "absent".
 */
function probeAt(base) {
  return (rel) => {
    const abs = path.join(base, ...rel.split('/'))
    let st
    try {
      st = fs.lstatSync(abs)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
      throw err
    }
    if (st.isSymbolicLink()) return { kind: 'symlink', linkText: fs.readlinkSync(abs) }
    if (st.isFile()) return { kind: 'file', content: fs.readFileSync(abs, 'utf8') }
    if (st.isDirectory()) return { kind: 'dir' }
    return { kind: 'other' }
  }
}

/** Scores the racer's completed steps; returns {scored} or {unscorable: reason}. */
function scoreRacer(racer, treeRoot, destPath) {
  try {
    if (!Array.isArray(racer.steps))
      return { unscorable: `racer-report-unknown:${racer.error ?? 'no-steps'}` }
    const expectations = expectationsFromSteps(racer.steps, treeRoot)
    const scored = scoreExpectations({
      expectations,
      probeOrigin: probeAt(treeRoot),
      probeDest: destPath ? probeAt(destPath) : null,
    })
    if (scored.displaced + scored.deleted !== scored.lost) {
      return { unscorable: 'displaced+deleted!=lost' }
    }
    return { scored, expectations }
  } catch (err) {
    return { unscorable: `scoring-threw:${err instanceof Error ? err.message : String(err)}` }
  }
}

const NO_FILES = { checked: 0, lost: 0, changed: 0, displaced: 0, deleted: 0 }
const userFilesOf = (s) =>
  s
    ? {
        checked: s.checked,
        lost: s.lost,
        changed: s.changed,
        displaced: s.displaced,
        deleted: s.deleted,
      }
    : NO_FILES

/**
 * @param {object} args
 * @param {number} [args.dirs] - STEP-1 scale: pad the tree to exactly this many
 *   directories under tree/zz-pad (c4-score.mjs applyDirs), outside every path
 *   the step racer touches (tree/target, tree/target.aside-*). Recorded as
 *   extra.dirs / extra.actualDirs on every record, the caller-hash-race one
 *   included; the runner appends '/dirs=<n>' to the variant itself.
 * @param {string} [args.traceDir] - ABSOLUTE directory for the content-addressed
 *   trace side file (c4-trace-store.mjs). Required for every run that has a
 *   trace: without it, or on a write/verify failure, the run is a counted
 *   harness-error (a matched run's compact drops the full trace).
 */
export async function runOnce({ harnessRoot, candidate, dirs, traceDir }) {
  if (!CANDIDATES.has(candidate)) throw new TypeError(`a13-c4: unknown candidate ${candidate}`)
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot } = buildSwapFixture(fx.root)
    // Padded BEFORE the pristine hash, so the caller, C4 and the pristine
    // reference all hash the same padded tree.
    const actualDirs = applyDirs(fx.root, dirs)
    const scale = { dirs: dirs ?? null, actualDirs }
    const targetAbs = path.join(treeRoot, 'target')
    const opId = randomToken()
    // The pristine tree's hash, before any racer exists (hash evidence).
    const pristine = computePathTreeHash(treeRoot)
    if (!pristine.ok) throw new Error(`a13-c4: pristine hash failed: ${JSON.stringify(pristine)}`)

    const readyMarkerPath = path.join(fx.root, '.racer-ready')
    const spawned = spawnStepRacer(targetAbs, readyMarkerPath)
    const markerObservedAt = spawned.wait()

    const start = performance.now()
    const callAttemptAtH = nowH()
    let r
    try {
      r = runC4Candidate({
        candidate,
        parentAbs: fx.root,
        name: 'tree',
        window: 'pre-call',
        onFire: () => {},
        opId,
      })
    } catch (err) {
      const catchAtH = nowH()
      // Joined before deciding, so the decision sees what the racer completed.
      const racer = await spawned.result
      // The caller-hash window (review R2-7): c4-shared's own stamps when the
      // error carries them (perf clock, converted), else this process's
      // bracket around the throwing call, which contains the caller hash
      // because runC4Candidate throws from it. Attached to the error so the
      // relatedness check, and anyone reading a rethrown error, has the times.
      const callerHashWindow = callerHashWindowFrom(err, {
        offset: hrMinusPerf().offset,
        callAttemptAtH,
        catchAtH,
      })
      if (err instanceof Error && Object.isExtensible(err)) err.callerHashWindow = callerHashWindow
      // The relatedness check compares racer stamps with ours, so it is only
      // as good as the racer clock: out-of-tolerance skew rethrows (counted).
      const skew = racer.markerWrittenAt == null ? null : markerObservedAt - racer.markerWrittenAt
      if (typeof skew !== 'number' || skew < SKEW_MIN_MS || skew > SKEW_MAX_MS) throw err
      const s = scoreRacer(racer, treeRoot, null)
      const rec = recordForRunError({
        callerHashWindow,
        err,
        candidate,
        racer,
        markerObservedAt,
        durationMs: performance.now() - start,
        // quarantineTree never ran: no status/opId, so the scan reports nulls.
        quarantineLeft: scanC4Leftovers(fx.root, { status: null, opId: null }),
        scored: s.scored ?? null,
      })
      rec.extra.dirs = scale.dirs
      rec.extra.actualDirs = scale.actualDirs
      rec.extra.callerHashWindow = callerHashWindow
      return rec
    }
    const durationMs = performance.now() - start
    const callReturnedAtH = nowH()
    const clock = hrMinusPerf()

    const racer = await spawned.result

    const t = r.times ?? {}
    const times = {
      callerHashStartAt: toH(t.callerHashStartAt, clock.offset),
      callerHashAt: toH(t.callerHashAt, clock.offset),
      callStartAt: toH(t.callStartAt, clock.offset),
      recheckAt: toH(t.recheckAt, clock.offset),
      renameAt: toH(t.renameAt, clock.offset),
      callEndAt: toH(t.callEndAt, clock.offset),
      // c4-shared's renameEndAt: the instant renameSync(originPath) returned
      // (or threw). Decision 5's out-of-model window ends here.
      renameReturnedAt: toH(t.renameEndAt, clock.offset),
    }
    // A converted c4-shared stamp may not lie after this process stamped the
    // call's return; a violation means the conversion is wrong, and the run
    // is made a harness-error rather than scored.
    // A missing stamp FAILS (review G3-8); decideRecord counts the failure.
    const clockOrderOk = clockOrderOkOf({
      callerHashStartAt: times.callerHashStartAt,
      callAttemptAtH,
      callEndAt: times.callEndAt,
      callReturnedAtH,
    })
    const { inModelEnd, moveEnd } = windowEnds(candidate, times)

    // Hash the moved tree after the racer is joined (nothing can change it now).
    const destPath =
      r.result?.status === 'quarantined' && typeof r.result.path === 'string' ? r.result.path : null
    let postMoveHash = null
    if (destPath) {
      const h = computePathTreeHash(destPath)
      postMoveHash = h.ok ? h.treeHash : null
    }
    const hashEvidence = deriveHashEvidence({
      candidate,
      pristineHash: pristine.treeHash,
      guardHash: r.guardHash,
      postMoveHash,
    })

    // The caller-intent proof (owner decision): both hashes, recorded. A moved
    // tree counts as matching the caller hash ONLY through a valid proof (two
    // real 64-hex hashes, equal), so a quarantined run can be pre-caller-hash
    // only when the record can prove it.
    const callerIntentProof = destPath ? callerIntentProofOf(r.guardHash, postMoveHash) : null
    const movedTreeProvenEqual = isValidCallerIntentProof(callerIntentProof)

    // The full trace goes to a verified side file; the record keeps the
    // compact summary plus the artifact reference.
    const traceCompact = traceCompactOf(r.trace, r.traceMatched)
    const artifact = traceArtifactFor(r.trace, traceCompact, traceDir)

    const s = scoreRacer(racer, treeRoot, destPath)
    let unscorable = s.unscorable ?? null
    let landings = []
    if (!unscorable) {
      landings = landingFromRacer({
        racer,
        callerHashStartAt: times.callerHashStartAt,
        callerHashAt: times.callerHashAt,
        inModelEnd,
        moveEnd,
        provenPreCallerHash: hashEvidence.provenPreCallerHash && movedTreeProvenEqual,
        // Clock-independent evidence the tree changed after the caller
        // hashed (a13-c4.record.mjs): a non-matching or unhashable moved
        // tree, a C4 'kept', or a C4 'stopped' by its own hash read.
        movedTreeDiffersFromCallerHash: treeChangedAfterCallerHash({
          c4Status: r.result?.status,
          c4Reason: r.result?.reason,
          destPath,
          movedTreeMatchesCallerHash: movedTreeProvenEqual,
        }),
      })
    }
    const routed = routeRun(landings)
    if (!unscorable && routed.mutationApplied && s.scored.checked < 1)
      unscorable = 'landed-with-checked-0'
    const userFiles = userFilesOf(unscorable ? null : s.scored)
    const lostOrChanged = userFiles.lost + userFiles.changed > 0
    const clockSkewCheckMs =
      racer.markerWrittenAt == null ? null : markerObservedAt - racer.markerWrittenAt
    const traceMatched = r.traceMatched === true
    // Status, mutationApplied and excludedReason in one place (a13-c4.record.mjs):
    // every forced harness-error is counted (mutationApplied true), clock
    // skew and conversion are checked, a post-rename loss is a harness-error,
    // and a vacuous landed run is marked excluded from the floor.
    const decided = decideRecord({
      c4Status: r.result?.status,
      traceMatched,
      clockOrderOk,
      clockSkewCheckMs,
      markerObservedAt,
      callerHashStartAt: times.callerHashStartAt,
      unscorable,
      routed,
      landings,
      scored: unscorable ? null : s.scored,
      callerIntentProof,
      traceArtifactError: artifact.error,
    })
    const { mutationApplied, status } = decided
    const label = decided.status === 'harness-error' ? 'A13-C4' : routed.label

    // Scanned against quarantineTree's OWN status and opId, even when the run
    // is later marked harness-error: the layout on disk follows what
    // quarantineTree did, not how this record is scored.
    const quarantineLeft = scanC4Leftovers(fx.root, { status: r.result?.status, opId })

    const hookFired = r.hookFired === true && traceMatched

    return {
      precondition: { hookFired, mutationApplied, traceMatched, controlExpected: true },
      outcome: {
        status,
        reason:
          status === 'harness-error'
            ? `a13-c4-harness-error:${decided.harnessErrors.join(',')}`
            : (r.result?.reason ?? null),
        excludedReason: decided.excludedReason,
        callerIntentProof: decided.callerIntentProof,
        path: r.result?.path ?? null,
        entry: r.result?.entry ?? null,
        errno: r.result?.errno ?? null,
        quarantineLeft,
      },
      userFiles,
      durationMs,
      extra: {
        label,
        variant: VARIANT,
        dirs: scale.dirs,
        actualDirs: scale.actualDirs,
        candidate,
        firedAt: r.firedAt ?? null,
        traceCompact,
        traceArtifact: artifact.traceArtifact,
        c4Status: r.result?.status ?? null,
        unscorable,
        harnessErrors: decided.harnessErrors,
        racerMutation: racer.mutation ?? null,
        racerComplete: racer.complete === true,
        racerSteps: racer.steps ?? null,
        racerFailedStep: racer.failedStep ?? null,
        racerError: racer.error ?? null,
        racerDelayMs: racer.delayMs ?? null,
        expectations: s.expectations ?? null,
        scoreDetails: s.scored?.details ?? null,
        vacuousCheck: s.scored?.vacuous === true,
        landings,
        landingCounts: landingCounts(landings),
        straddleCount: landingCounts(landings).straddlesInModelEnd,
        lossAttribution: {
          lost: lostOrChanged,
          lossPrecededBy: lossPrecededBy(routed.relevant, lostOrChanged),
          classes: landings.map((x) => x.cls),
        },
        hashEvidence,
        timing: {
          clock: 'hrtime-ms',
          perfToHrOffsetMs: clock.offset,
          perfToHrSandwichGapMs: clock.gap,
          clockOrderOk,
          markerObservedAt,
          markerWrittenAt: racer.markerWrittenAt ?? null,
          clockSkewCheckMs,
          ...times,
          callReturnedAtH,
          inModelEnd,
          moveEnd,
        },
      },
    }
  } finally {
    fx.cleanup()
  }
}
