// A5 against VR (V0/V1/V2): same-tick delete-and-recreate, mid-walk, but
// timed at VR's own equivalent moment -- right after the target directory
// has been opened and its fd is now held (afterOpen), not after an rmdir
// probe (VR has no such probe; it opens directly).
//
// This is the direct test of the plan's central claim for V1/V2: once a
// directory's fd is held, its inode cannot be freed for reuse by a
// same-name delete+recreate racing against the walk, because the OS keeps
// an unlinked inode alive as long as any process holds it open. If that
// holds, `reuseObserved` should measure false here even on overlayfs, where
// the identical race against C0 (a5.mjs) shows real, frequent reuse.

import { removeVR } from '../../walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, swapDirectorySameTick, verifyReplacementIntact } from './_shared.mjs'

export const id = 'A5-VR'
export const target = 300

export function runOnce({ harnessRoot, candidate }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let reuseObserved = null
  let birthtimeReused = null
  let replacementFiles = null

  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)

    const hooks = {
      afterOpen(relPath, type) {
        if (hookFired) return
        if (relPath !== 'target' || type !== 'dir') return
        hookFired = true
        replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
        const swap = swapDirectorySameTick(targetAbs, replacementFiles)
        mutationApplied = true
        reuseObserved = swap.reuseObserved
        birthtimeReused = swap.birthtimeReused
      },
    }

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, hooks })
    const durationMs = performance.now() - start

    const userFiles = replacementFiles
      ? verifyReplacementIntact(targetAbs, replacementFiles)
      : { checked: 0, lost: 0, changed: 0 }

    return {
      precondition: {
        hookFired,
        mutationApplied,
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
      extra: { reuseObserved, birthtimeReused },
    }
  } finally {
    fx.cleanup()
  }
}
