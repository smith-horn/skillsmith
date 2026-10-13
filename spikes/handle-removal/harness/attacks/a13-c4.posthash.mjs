// A13-C4-POSTHASH (SMI-6715 Step 1b part 2, design §9 "A13-C4-posthash",
// coordinator decision): A13-C4's real concurrent step racer, released at the
// END OF C4's OWN PRE-MOVE HASH rather than before the caller's hash, so its
// landings fall in the window the C4 repair exists for -- after C4 hashed, before
// (or during) the rename. The repaired C4 can only catch those after the move,
// as `held`.
//
// MECHANISM. a13-c4.mjs runA13Once with a posthash spec: the racer
// (a13-c4.racer.mjs, go-marker mode) waits, mutating nothing, until
// runC4Candidate's hash-end clock (c4-shared.mjs onHashEnd: the first
// statSync(parentAbs) after C4's root readdir, i.e. the first fs call after
// S2c) writes the go marker; it then busy-waits a delay drawn uniformly from
// [0, ceiling) and makes its one mutation. C4-naive (the control) has no hash:
// its release is the same code point, the start of trash setup.
//
// DELAY CEILING: CALIBRATED PER FILESYSTEM AND PER INVOCATION, OPENLY
// (coordinator change A). Before the first run of an invocation (per harness
// root and --dirs), CALIBRATION_N untimed guarded C4 probes on a fresh padded
// fixture measure C4's hash-end -> rename-call window. ceiling = DELAY_FRACTION
// x the measured MEDIAN. Every record carries the calibration it used (median,
// p10, p90, ceiling, fraction, n) in extra.posthashCalibration, because the
// landing rate -- and so whether the R6 floor can be reached -- rests on it.
// A window that cannot be measured, or whose median is under MIN_WINDOW_MS,
// THROWS: every run of the invocation then becomes a counted harness-error
// naming the calibration. There is no fixed fallback.
//
// WHY A FRACTION OF THE MEDIAN, MEASURED. A ceiling of 1.2 x the median (the
// design's first rule; 0.233 ms on darwin) put the C4 post-hash landing rate at
// 5/20 on darwin: the racer's own wake-up and first syscall already consume
// most of a ~0.2 ms window, so most racers fired after the rename. A 300-run
// cell would then land ~75 times, under R6's floor of 100, and could never pass.
// DELAY_FRACTION was chosen from a darwin smoke (APFS, 1,630 dirs, calibrated
// median 0.213 ms, 20 C4 runs per fraction, scratchpad p2c-fraction.mjs): C4
// post-hash landing rate 20/20 at 0, 18/20 at 0.1, 15/20 at 0.25, 10/20 at 0.5.
// 0.25 keeps the rate comfortably above 1/2 while still spreading the delay
// over the first quarter of the window rather than releasing at one instant.
//
// SCORING. One label, A13-C4-POSTHASH, for every record, scored under R6 like
// A13-C4 (landed subset, floor 100), with C4-naive as the control. Each landing
// also carries its phase class against C4's hash end (pre-hash / post-hash /
// post-rename, a13-c4.classify.mjs phaseClass), and each run its attempt phase.
// A landing in the old out-of-model window (re-check .. rename returned) is
// SCORED here (design §9: "landings in [recheckAt, renameAt) are expected to
// come out held").

import { runA13Once } from './a13-c4.mjs'
import { runC4Candidate } from './c4-shared.mjs'
import { applyDirs } from './c4-score.mjs'
import { buildSwapFixture } from './_shared.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'

export const id = 'A13-C4-POSTHASH'
export const target = 300
export const VARIANT = 'racer/post-hash'
export const DELAY_FRACTION = 0.25
export const CALIBRATION_N = 30
/** A window median under this is degenerate: no delay could be drawn inside it. */
export const MIN_WINDOW_MS = 0.02

export function labelFor() {
  return id
}

const quantile = (sorted, p) => sorted[Math.round(p * (sorted.length - 1))]

/**
 * Pure: runs `probe()` `n` times; each returns the window in ms, or null when it
 * could not be measured. Throws on any unmeasured or thrown probe and on a
 * degenerate median. Returns the calibration record.
 */
export function calibrateWindow({ n = CALIBRATION_N, probe, fraction = DELAY_FRACTION }) {
  const ws = []
  for (let i = 0; i < n; i++) {
    let w
    try {
      w = probe(i)
    } catch (err) {
      throw new Error(`a13-c4-posthash calibration: probe ${i} threw: ${err?.message ?? err}`)
    }
    if (typeof w !== 'number' || !Number.isFinite(w)) {
      throw new Error(`a13-c4-posthash calibration: probe ${i} unmeasured (window ${String(w)})`)
    }
    ws.push(w)
  }
  const sorted = [...ws].sort((a, b) => a - b)
  const medianMs = quantile(sorted, 0.5)
  if (!(medianMs >= MIN_WINDOW_MS)) {
    throw new Error(
      `a13-c4-posthash calibration: degenerate window, median ${medianMs} ms < floor ${MIN_WINDOW_MS} ms`
    )
  }
  return {
    medianMs,
    p10Ms: quantile(sorted, 0.1),
    p90Ms: quantile(sorted, 0.9),
    ceilingMs: fraction * medianMs,
    fraction,
    n,
    minWindowMs: MIN_WINDOW_MS,
  }
}

/** One real probe: guarded C4 on a fresh padded fixture; hash end -> rename call. */
export function realProbe(harnessRoot, dirs) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    buildSwapFixture(fx.root)
    applyDirs(fx.root, dirs)
    const r = runC4Candidate({
      candidate: 'C4',
      parentAbs: fx.root,
      name: 'tree',
      window: 'pre-call',
      onFire: () => {},
      onHashEnd: () => {},
    })
    const t = r.times
    if (r.result?.status !== 'quarantined' || r.traceMatched !== true) return null
    if (typeof t.hashEndAt !== 'number' || typeof t.renameAt !== 'number') return null
    return t.renameAt - t.hashEndAt
  } finally {
    fx.cleanup()
  }
}

const cache = new Map()
/** The invocation's calibration for (harnessRoot, dirs); a failure is cached and rethrown. */
export function calibrationFor(harnessRoot, dirs) {
  const key = `${harnessRoot}|${dirs ?? 'fixture'}`
  if (!cache.has(key)) {
    try {
      const c = calibrateWindow({ probe: () => realProbe(harnessRoot, dirs) })
      cache.set(key, { ok: true, value: { ...c, dirs: dirs ?? null, harnessRoot } })
    } catch (err) {
      cache.set(key, { ok: false, error: err })
    }
  }
  const e = cache.get(key)
  if (!e.ok) throw e.error
  return e.value
}

export function runOnce(args) {
  const calibration = calibrationFor(args.harnessRoot, args.dirs)
  return runA13Once(args, {
    label: id,
    variant: VARIANT,
    delayCeilingMs: calibration.ceilingMs,
    calibration,
  })
}
