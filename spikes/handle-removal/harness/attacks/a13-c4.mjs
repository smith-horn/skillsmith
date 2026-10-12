// A13 against C4 (quarantineTree): the real concurrent racer from a13.mjs /
// a13-vr.mjs, with runC4Candidate (c4-shared.mjs) in place of removeVR.
// Candidates 'C4' (caller guardHash passed) and 'C4-naive' (same hash computed
// at the same moment, not passed). Runs per cell: 300.
//
// WHAT THE RACER ACTUALLY DOES. spawnConcurrentRacer (_shared.mjs) makes ONE
// randomly-chosen mutation (a3/a5/a7/a8) per run, after a 0-2ms busy-wait;
// it does not repeat. Its target is `<fx.root>/tree/target`, inside the tree
// quarantineTree renames, so its mutation is a mutation of the tree C4 moves;
// no adaptation of its target was needed. It is the only mutation here:
// runC4Candidate's 'pre-call' interposition is used purely as a clock, with a
// no-op onFire.
//
// THE DECISION LOGIC (landing classes and their exact boundaries, routing to
// 'A13-C4' / 'A13-C4-OOM', the hash override, the caller-hash-race record)
// lives in ./a13-c4.classify.mjs as pure functions, with its own header, and
// is exercised branch by branch by harness/a13-c4.selftest.mjs. This file
// only measures and calls it. extra.variant is the fixed tag
// 'racer/by-timestamp' for BOTH arms (CONTROL_SPEC resolves the naive control
// with matchVariant 'exact').
//
// WINDOW RESOLUTION IS THE LIMIT OF THIS CELL. The racer's mutation interval
// (mutationStartedAt..landedAt) measured ~2-5 ms on darwin; the whole
// quarantineTree call ~0.3-1.4 ms; C4's re-check-to-rename-return gap ~0.1-0.2
// ms. So in the smoke runs EVERY landing straddled the windows, the
// conservative routing sent every one to 'A13-C4', and 'A13-C4-OOM' got 0
// runs in either arm. This instrument cannot separate decision 5's in-model
// and out-of-model windows for most landings: an A13-C4 loss may have landed
// out of model, and an OOM record means only "provably entirely after the
// re-check", which will be rare. The hash evidence separates "before the
// caller hashed" from "after"; nothing here separates post-hash from OOM.
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
// tight-sandwich offset, which measured constant to 0.25us over 3s. Skew is
// small beside the call; the racer's own interval width is what limits
// resolution (above).
//
// KNOWN CONFOUND, STATED. C4-naive does no hash, so its in-model window is
// [callerHashAt, renameAt): ensureTrashRoot + mkdir + a few lstats. C4's adds
// a bind lstat and a full path-tree hash. At fixture scale the hash is tiny,
// so both arms share most of the window (the pre-call gap is shared, as both
// start at callerHashAt). At large trees C4's window grows and naive's does
// not, so naive will land far fewer in-model races and its control can fail
// to fail. In the fixture-scale smokes naive got 3-5 in-model landings per 10
// runs and lost data on every one, so the control does fail at fixture
// scale; large trees are unmeasured.
//
// SCORING. userFiles is the racer's own written bytes at their ORIGINAL path
// (as a13-vr.mjs). A file moved into quarantine reads as lost. displaced
// (found under <fx.root>/.skillsmith-trash by content, or, for the a8
// symlink, by link text) vs deleted (found nowhere) is from locateDisplaced;
// displaced + deleted must equal lost, or the run throws (harness-error).
// A naive smoke run showed a partial mutation too: the racer's a5 rm of
// `target` landed before the rename and its mkdir failed after it, so the
// racer reported ENOENT (applied:null). That run removed only fixture
// content, no user bytes, and is a non-landing.

import { runC4Candidate, locateDisplaced } from './c4-shared.mjs'
import {
  VARIANT,
  windowEnds,
  deriveHashEvidence,
  buildLandings,
  routeRun,
  lossPrecededBy,
  landingCounts,
  recordForRunError,
} from './a13-c4.classify.mjs'
import { computePathTreeHash } from '../../quarantine.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanC4Leftovers } from '../result-schema.c4.mjs'
import { buildSwapFixture, spawnConcurrentRacer, randomToken } from './_shared.mjs'
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
 * Puts a c4-shared timestamp on hrtime. The two clocks are told apart by
 * magnitude, not assumed: the performance clock is epoch-based (~1.7e12 ms),
 * hrtime is boot-based (orders of magnitude smaller).
 */
function toH(t, offset) {
  if (t == null) return null
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    throw new TypeError(`a13-c4: non-numeric timestamp ${String(t)}`)
  }
  return t > 1e12 ? t + offset : t
}

/** Searches <fxRoot>/.skillsmith-trash for a symlink with this link text. */
function findDisplacedSymlink(fxRoot, linkText) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 8 || found.length >= 8) return
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const abs = path.join(dir, n)
      let st
      try {
        st = fs.lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        try {
          if (fs.readlinkSync(abs) === linkText) found.push(path.relative(fxRoot, abs))
        } catch {
          /* unreadable link: not counted as displaced */
        }
      } else if (st.isDirectory()) {
        walk(abs, depth + 1)
      }
    }
  }
  walk(path.join(fxRoot, '.skillsmith-trash'), 0)
  return found
}

/** The racer's bytes at their original path; displaced vs deleted. */
function scoreUserFiles(fxRoot, racer) {
  let userFiles = { checked: 0, lost: 0, changed: 0, displaced: 0, deleted: 0 }
  let displacedPaths = []
  if (racer.applied && racer.writtenPath) {
    if (racer.applied === 'a8') {
      let survives = false
      try {
        survives = fs.lstatSync(racer.writtenPath).isSymbolicLink()
      } catch {
        survives = false
      }
      const lost = survives ? 0 : 1
      displacedPaths = lost ? findDisplacedSymlink(fxRoot, '/tmp') : []
      const displaced = lost && displacedPaths.length > 0 ? 1 : 0
      userFiles = { checked: 1, lost, changed: 0, displaced, deleted: lost - displaced }
    } else if (racer.writtenContent) {
      let lost = 0
      let changed = 0
      if (!fs.existsSync(racer.writtenPath)) lost = 1
      else if (fs.readFileSync(racer.writtenPath, 'utf8') !== racer.writtenContent) changed = 1
      let displaced = 0
      let deleted = 0
      if (lost) {
        const rel = path.relative(fxRoot, racer.writtenPath)
        const loc = locateDisplaced(fxRoot, { [rel]: racer.writtenContent })
        displaced = loc.displaced
        deleted = loc.deleted
        displacedPaths = loc.displacedPaths
      }
      userFiles = { checked: 1, lost, changed, displaced, deleted }
    }
  }
  // A changed-in-place file was not moved (nothing in C4 writes into the
  // tree), so the reconciliation is against `lost` alone.
  if (userFiles.displaced + userFiles.deleted !== userFiles.lost) {
    throw new Error(
      `a13-c4: displaced(${userFiles.displaced}) + deleted(${userFiles.deleted}) != lost(${userFiles.lost})`
    )
  }
  return { userFiles, displacedPaths }
}

export async function runOnce({ harnessRoot, candidate }) {
  if (!CANDIDATES.has(candidate)) throw new TypeError(`a13-c4: unknown candidate ${candidate}`)
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot } = buildSwapFixture(fx.root)
    const targetAbs = path.join(treeRoot, 'target')
    const opId = randomToken()
    // The pristine tree's hash, before any racer exists (hash evidence).
    const pristine = computePathTreeHash(treeRoot)
    if (!pristine.ok) throw new Error(`a13-c4: pristine hash failed: ${JSON.stringify(pristine)}`)

    const readyMarkerPath = path.join(fx.root, '.racer-ready')
    const spawned = spawnConcurrentRacer(targetAbs, readyMarkerPath)
    const markerObservedAt = spawned.wait()

    const start = performance.now()
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
      // Joined before deciding, so the decision sees whether the racer applied.
      const racer = await spawned.result
      return recordForRunError({
        err,
        candidate,
        racer,
        markerObservedAt,
        durationMs: performance.now() - start,
        // quarantineTree never ran: no status/opId, so the scan reports nulls.
        quarantineLeft: scanC4Leftovers(fx.root, { status: null, opId: null }),
      })
    }
    const durationMs = performance.now() - start
    const callReturnedAtH = nowH()
    const clock = hrMinusPerf()

    const racer = await spawned.result

    const t = r.times ?? {}
    const times = {
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
    const clockOrderOk = times.callEndAt == null || times.callEndAt <= callReturnedAtH + 0.01
    const { inModelEnd, moveEnd } = windowEnds(candidate, times)

    // Hash the moved tree after the racer is joined (nothing can change it now).
    let postMoveHash = null
    if (r.result?.status === 'quarantined' && typeof r.result.path === 'string') {
      const h = computePathTreeHash(r.result.path)
      postMoveHash = h.ok ? h.treeHash : null
    }
    const hashEvidence = deriveHashEvidence({
      candidate,
      pristineHash: pristine.treeHash,
      guardHash: r.guardHash,
      postMoveHash,
    })
    const landings = buildLandings({
      racer,
      callerHashAt: times.callerHashAt,
      inModelEnd,
      moveEnd,
      provenPreCallerHash: hashEvidence.provenPreCallerHash,
    })
    const { label, mutationApplied, relevant } = routeRun(landings)
    const { userFiles, displacedPaths } = scoreUserFiles(fx.root, racer)
    const lostOrChanged = userFiles.lost + userFiles.changed > 0

    // Scanned against quarantineTree's OWN status and opId, even when the run
    // is later marked harness-error: the layout on disk follows what
    // quarantineTree did, not how this record is scored.
    const quarantineLeft = scanC4Leftovers(fx.root, { status: r.result?.status, opId })

    const traceMatched = r.traceMatched === true
    const hookFired = r.hookFired === true && traceMatched
    const status = traceMatched && clockOrderOk ? r.result?.status : 'harness-error'

    return {
      precondition: { hookFired, mutationApplied, traceMatched, controlExpected: true },
      outcome: {
        status,
        reason: r.result?.reason ?? null,
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
        candidate,
        firedAt: r.firedAt ?? null,
        trace: r.trace,
        racerApplied: racer.applied ?? null,
        racerError: racer.error ?? null,
        racerDelayMs: racer.delayMs ?? null,
        landings,
        landingCounts: landingCounts(landings),
        lossAttribution: {
          lost: lostOrChanged,
          lossPrecededBy: lossPrecededBy(relevant, lostOrChanged),
          classes: landings.map((x) => x.cls),
        },
        displacedPaths,
        hashEvidence,
        timing: {
          clock: 'hrtime-ms',
          perfToHrOffsetMs: clock.offset,
          perfToHrSandwichGapMs: clock.gap,
          clockOrderOk,
          markerObservedAt,
          markerWrittenAt: racer.markerWrittenAt ?? null,
          clockSkewCheckMs:
            racer.markerWrittenAt == null ? null : markerObservedAt - racer.markerWrittenAt,
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
