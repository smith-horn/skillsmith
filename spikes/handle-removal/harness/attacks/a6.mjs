// A6: the walked directory itself, and separately an inner directory,
// deleted and recreated (same-tick, racing inode reuse) after the caller's
// bind but before the walk begins at all. Plan §5.1 row A6. Runs per cell:
// 300, two sub-variants ('root', 'inner'). Pass criterion: as A5.
//
// The plan's own attack table records "C0 with the gate at walk start" as
// the control expected to fail 269-300/300 -- that is c0-walk.mjs's
// gateTiming: 'walk-start' (ported directly from e54.mjs), run separately by
// run-c0-control.mjs alongside gateTiming: 'before-bind' (the plan's actual
// "C0 as of UD25", measured 0/300 in this session). Both are real,
// independently-measured configurations, not two readings of one mechanism.

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, swapDirectorySameTick, verifyReplacementIntact } from './_shared.mjs'

export const id = 'A6'
export const target = 300

/**
 * @param {object} args
 * @param {string} args.harnessRoot
 * @param {object} args.candidate - { identityCheck, gateTiming }
 * @param {'root'|'inner'} args.variant
 */
export function runOnce({ harnessRoot, candidate, variant }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let reuseObserved = null
  let birthtimeReused = null
  let replacementFiles = null
  let verifyDir = null

  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)
    const swapTarget = variant === 'root' ? treeRoot : targetAbs
    verifyDir = swapTarget

    const hooks = {
      betweenBindAndWalk() {
        hookFired = true
        // The replacement must keep the SAME relative-path shape as the
        // original tree (same child names), or a generic "entry-added"
        // structural mismatch catches the swap for reasons unrelated to
        // identity/gate logic -- that would not actually test UD24/UD25.
        replacementFiles =
          variant === 'root'
            ? {
                'target/orig-f1': `replacement-${Date.now()}-${Math.random()}`,
                'zzz-sibling/f1': `replacement-${Date.now()}-${Math.random()}`,
              }
            : { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
        const swap = swapDirectorySameTick(swapTarget, replacementFiles)
        mutationApplied = true
        reuseObserved = swap.reuseObserved
        birthtimeReused = swap.birthtimeReused
      },
    }

    const start = performance.now()
    const outcome = removeC0(treeRoot, { ...candidate, hooks })
    const durationMs = performance.now() - start

    // For variant 'root', treeRoot itself was replaced -- verify its own
    // replacement content directly, since removeC0 may or may not have
    // removed it.
    const userFiles = replacementFiles
      ? verifyReplacementIntact(verifyDir, replacementFiles)
      : { checked: 0, lost: 0, changed: 0 }

    return {
      precondition: {
        hookFired,
        mutationApplied,
        reuseObserved,
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
      extra: { birthtimeReused, variant },
    }
  } finally {
    // For variant 'root' the tree itself may already be gone (correctly, if
    // C0 wrongly removed the replacement) -- cleanup is force:true so this
    // is safe either way.
    fx.cleanup()
  }
}
