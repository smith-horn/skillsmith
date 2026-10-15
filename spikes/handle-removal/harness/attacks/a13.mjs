// A13 against C0: the concurrent racer. Plan §5.1 row A13 -- a second,
// genuinely separate process loops A3/A5/A7/A8-shaped mutations against the
// tree while removeC0 runs, with NO synchronization and no hook point at
// all ("none (real concurrency)"). Runs per cell: 300.
//
// spawnConcurrentRacer (_shared.mjs) starts the child BEFORE removeC0 is
// called -- the child busy-waits a randomized 0-2ms jitter, then attempts
// one randomly-chosen mutation against 'target', entirely independent of
// this process's own event loop (removeC0 itself is synchronous and blocks
// it, which is fine: the child is a separate OS process, not a callback).
// Required failing control: "C0 without UD24" -- run alongside, not a
// separate fixture.

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, spawnConcurrentRacer } from './_shared.mjs'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const id = 'A13'
export const target = 300

export async function runOnce({ harnessRoot, candidate }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)

    const readyMarkerPath = path.join(fx.root, '.racer-ready')
    const racer = spawnConcurrentRacer(targetAbs, readyMarkerPath)
    racer.wait() // synchronous rendezvous -- see spawnConcurrentRacer's own comment

    const start = performance.now()
    const outcome = removeC0(treeRoot, { ...candidate, hooks: {} })
    const durationMs = performance.now() - start

    const racerResult = await racer.result

    // "0 user bytes lost": whatever the racer actually wrote must survive
    // exactly. A racer that never applied anything (lost the race entirely,
    // e.g. ENOENT against an already-removed target) has nothing to check --
    // that is a real, expected outcome of genuine concurrency, not a
    // precondition failure; A13 tests the SYSTEM under real racing, not a
    // guaranteed-to-land mutation.
    let userFiles = { checked: 0, lost: 0, changed: 0 }
    if (racerResult.applied && racerResult.writtenPath) {
      if (racerResult.applied === 'a8') {
        // symlink swap: survival means the entry (lstat) is still there --
        // existsSync would follow the dangling /tmp target and misreport.
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
      extra: { racerApplied: racerResult.applied, racerError: racerResult.error },
    }
  } finally {
    fx.cleanup()
  }
}
