// A13 against VR: the same real concurrent racer as a13.mjs (see its header
// for the rendezvous mechanism and why it's needed), removeVR in place of
// removeC0. Runs per cell: 300.
//
// NOTE, and it is load-bearing for how this cell's numbers may be read:
// `removeVR` is called here with NO `guardHash` unless `guardMode:
// 'guardHash'` is passed, and the main A13 runner (run-a3-a13-attacks.mjs)
// does not pass it. That is defensible -- the plan's own control for this row
// is "C0 without UD24", i.e. the unguarded configuration -- but it means the
// A13 cells in results/SUMMARY.md measure a configuration the decision memo's
// own recommendation FORBIDS (a mandatory caller-supplied guard hash). An A13
// loss under guard=none is therefore not evidence about the recommended
// configuration. The guard=guardHash arm below is, and
// harness/measure-a13-race-timing.mjs runs it.
//
// TIMING INSTRUMENT (added when a review asked how a remaining V2 loss could
// be attributed to a mechanism rather than explained by one). The racer
// reports the absolute time its mutation LANDED; the two hooks below report
// when the guard pass started and ended, on the same clock. That places every
// landed mutation in one of three phases -- before the guard pass, during it,
// or after it -- which is the difference between "no earlier observation
// existed" (pre/during: the guard hashed the attacker's own content, and only
// a caller-supplied guardHash could have caught it) and "the re-verify V2
// exists to do did not fire" (post: a genuine V2 gap). See
// harness/measure-a13-race-timing.mjs for the runner that consumes it.

import { removeVR } from '../../walk.mjs'
import { loadShim } from '../../native-c/load.mjs'
import { guardPass } from '../../hash.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, spawnConcurrentRacer } from './_shared.mjs'
import fs, { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const id = 'A13-VR'
export const target = 300

/**
 * Places a landed mutation relative to the guard pass, on one clock.
 *
 * The mutation is an interval (`mutationStartedAt` .. `landedAt`), not an
 * instant, so a mutation that begins before the guard pass ends and completes
 * after it is reported as `straddles-guard-end` rather than forced into one
 * side -- an ambiguous case named is worth more than a confident wrong one.
 *
 * - `pre-guard`      -- landed before the guard pass began. The guard pass
 *                       hashed the attacker's own content; nothing short of a
 *                       caller-supplied guardHash could detect it.
 * - `during-guard`   -- landed while the guard pass was running. Whether the
 *                       guard saw the original or the substitute depends on
 *                       readdir order, so this is the same "no earlier
 *                       observation" class, not a distinct mechanism.
 * - `post-guard`     -- landed after the guard pass finished, i.e. inside the
 *                       window V2's per-entry re-verification exists to close.
 *                       A LOSS here is a genuine V2 gap, not a residual.
 * - `post-call`      -- landed after removeVR() returned; it raced nothing.
 */
export function classifyPhase({
  guardStartedAt,
  guardEndedAt,
  callEndedAt,
  mutationStartedAt,
  landedAt,
}) {
  if (landedAt == null || guardStartedAt == null || guardEndedAt == null) return 'unknown'
  if (landedAt <= guardStartedAt) return 'pre-guard'
  if (mutationStartedAt != null && mutationStartedAt < guardStartedAt)
    return 'straddles-guard-start'
  if (landedAt <= guardEndedAt) return 'during-guard'
  if (mutationStartedAt != null && mutationStartedAt <= guardEndedAt) return 'straddles-guard-end'
  if (callEndedAt != null && landedAt > callEndedAt) return 'post-call'
  return 'post-guard'
}

/**
 * Hashes the tree exactly as `removeVR`'s own guard pass would, BEFORE the
 * racer is spawned -- i.e. what a real caller holding a guard hash would have
 * computed from the pristine tree. Taking it after the racer starts would
 * hash whatever the attacker had already substituted, which "matches" and
 * produces a meaningless pass (the same mistake the memo's own pre-aged table
 * caught in draft).
 */
function originalTreeHash(treeRoot) {
  const shim = loadShim()
  const T = shim.openDir(treeRoot)
  const g = guardPass(shim, T.fd, {})
  // `guardPass` puts the root's own fd in heldFds under key '', so the loop
  // below already closes T.fd -- an extra closeSync(T.fd) here threw EBADF on
  // every single run and, because runOnce's caller turns a throw into a
  // `harness-error` record, showed up as "racer-landed=0" across 1,500 runs
  // rather than as an error. Caught only because 0/300 landings contradicted
  // the guard=none arm's 226/300 on the same filesystem minutes earlier.
  for (const fd of g.heldFds.values()) fs.closeSync(fd)
  return g.treeHash
}

/** @param {'none'|'guardHash'} [args.guardMode='none'] */
export async function runOnce({ harnessRoot, candidate, guardMode = 'none' }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)
    const guardHash = guardMode === 'guardHash' ? originalTreeHash(treeRoot) : undefined

    const readyMarkerPath = path.join(fx.root, '.racer-ready')
    const racer = spawnConcurrentRacer(targetAbs, readyMarkerPath)
    const markerObservedAt = racer.wait()

    // System monotonic clock in ms -- the same clock the racer child uses, and
    // the reason its timestamps and these are comparable at all. See
    // spawnConcurrentRacer's own note for why performance.timeOrigin is not.
    const nowAbs = () => Number(process.hrtime.bigint()) / 1e6
    let guardStartedAt = null
    let guardEndedAt = null
    const hooks = {
      afterBind: () => {
        guardStartedAt = nowAbs()
      },
      betweenGuardAndRemoval: () => {
        guardEndedAt = nowAbs()
      },
    }

    const callStartedAt = nowAbs()
    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, guardHash, hooks })
    const durationMs = performance.now() - start
    const callEndedAt = nowAbs()

    const racerResult = await racer.result

    let userFiles = { checked: 0, lost: 0, changed: 0 }
    if (racerResult.applied && racerResult.writtenPath) {
      if (racerResult.applied === 'a8') {
        let survives = false
        try {
          lstatSync(racerResult.writtenPath)
          survives = true
        } catch {
          survives = false
        }
        userFiles = { checked: 1, lost: survives ? 0 : 1, changed: 0 }
      } else if (racerResult.writtenContent) {
        let survives = false
        let changed = false
        if (existsSync(racerResult.writtenPath)) {
          survives = true
          changed = readFileSync(racerResult.writtenPath, 'utf8') !== racerResult.writtenContent
        }
        userFiles = { checked: 1, lost: survives ? 0 : 1, changed: changed ? 1 : 0 }
      }
    }

    return {
      precondition: {
        hookFired: true,
        mutationApplied: !!racerResult.applied,
        controlExpected: true,
      },
      outcome: {
        status: outcome.status,
        reason: outcome.reason,
        path: outcome.path,
        errno: outcome.errno,
      },
      userFiles,
      durationMs,
      extra: {
        racerApplied: racerResult.applied,
        racerError: racerResult.error,
        guardMode,
        timing: {
          // Parent clock.
          markerObservedAt,
          callStartedAt,
          guardStartedAt,
          guardEndedAt,
          callEndedAt,
          // Child clock (same system clock; see spawnConcurrentRacer).
          markerWrittenAt: racerResult.markerWrittenAt ?? null,
          mutationStartedAt: racerResult.mutationStartedAt ?? null,
          landedAt: racerResult.landedAt ?? null,
          racerDelayMs: racerResult.delayMs ?? null,
          // Cross-process clock sanity: the parent cannot observe a marker
          // before the child wrote it. A negative value here means the two
          // clocks are NOT comparable and every phase below is worthless.
          clockSkewCheckMs:
            racerResult.markerWrittenAt == null
              ? null
              : markerObservedAt - racerResult.markerWrittenAt,
          phase: classifyPhase({
            guardStartedAt,
            guardEndedAt,
            callEndedAt,
            mutationStartedAt: racerResult.mutationStartedAt ?? null,
            landedAt: racerResult.landedAt ?? null,
          }),
        },
      },
    }
  } finally {
    fx.cleanup()
  }
}
