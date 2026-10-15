// A4: the same swap as A3, but earlier -- right after the *parent's* listing
// returns the child's name, before the child's own probe/descent has begun
// at all (the C0 analogue of VR's "after readdirFd(child), before
// openAt(child)"). Plan §5.1 row A4. Runs per cell: 30. Control: C0 without
// UD24 is expected to fail, same as A3.

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, renameAsideAndReplace, verifyReplacementIntact } from './_shared.mjs'

export const id = 'A4'
export const target = 30

export function runOnce({ harnessRoot, candidate }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let replacementFiles = null

  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)

    const hooks = {
      afterListing(relPath, entries) {
        if (hookFired) return
        if (relPath !== '') return // the root's own listing, before any child is touched
        if (!entries.includes('target')) return
        hookFired = true
        replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
        renameAsideAndReplace(targetAbs, replacementFiles)
        mutationApplied = true
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
        controlExpected: !candidate.identityCheck,
      },
      outcome: {
        status: outcome.status,
        reason: outcome.reason,
        path: outcome.path,
        errno: outcome.errno,
      },
      userFiles,
      durationMs,
    }
  } finally {
    fx.cleanup()
  }
}
