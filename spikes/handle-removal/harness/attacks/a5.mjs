// A5: same-tick delete-and-recreate (inode and birthtime reuse), replaced
// dir as first entry, mid-walk. Plan §5.1 row A5. Runs per cell: 300.
//
// Unlike A3/A4, this genuinely races the OS's inode allocator: the target
// directory is deleted then immediately recreated with new content, in the
// same process tick, hoping the kernel reuses the freed inode number before
// the walk re-verifies it. A run only counts (is not never-ran) when reuse
// was actually observed -- see plan §9's classification table.
//
// Hook point: after the target's own rmdir probe returns ENOTEMPTY (the
// walk has just confirmed "this is a real non-empty directory, not a
// mount", and is about to identity-check it before descending).

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, swapDirectorySameTick, verifyReplacementIntact } from './_shared.mjs'

export const id = 'A5'
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
      afterProbe(relPath, probeResult) {
        if (hookFired) return
        if (relPath !== 'target') return
        if (probeResult !== 'ENOTEMPTY') return
        hookFired = true
        replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
        const swap = swapDirectorySameTick(targetAbs, replacementFiles)
        mutationApplied = true
        reuseObserved = swap.reuseObserved
        birthtimeReused = swap.birthtimeReused
      },
    }

    const start = performance.now()
    const outcome = removeC0(treeRoot, { ...candidate, hooks })
    const durationMs = performance.now() - start

    const userFiles = replacementFiles
      ? verifyReplacementIntact(targetAbs, replacementFiles)
      : { checked: 0, lost: 0, changed: 0 }

    return {
      precondition: {
        hookFired,
        mutationApplied,
        reuseObserved, // required true, else never-ran (plan §9)
        controlExpected: candidate.gateTiming === 'none',
      },
      outcome: {
        status: outcome.status,
        reason: outcome.reason,
        path: outcome.path,
        errno: outcome.errno,
      },
      userFiles,
      durationMs,
      extra: { birthtimeReused },
    }
  } finally {
    fx.cleanup()
  }
}
