// A13 against VR: the same real concurrent racer as a13.mjs (see its header
// for the rendezvous mechanism and why it's needed), removeVR in place of
// removeC0. Runs per cell: 300.

import { removeVR } from '../../walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, spawnConcurrentRacer } from './_shared.mjs'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const id = 'A13-VR'
export const target = 300

export async function runOnce({ harnessRoot, candidate }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)

    const readyMarkerPath = path.join(fx.root, '.racer-ready')
    const racer = spawnConcurrentRacer(targetAbs, readyMarkerPath)
    racer.wait()

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, hooks: {} })
    const durationMs = performance.now() - start

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
      extra: { racerApplied: racerResult.applied, racerError: racerResult.error },
    }
  } finally {
    fx.cleanup()
  }
}
