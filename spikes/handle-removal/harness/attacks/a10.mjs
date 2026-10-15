// A10 against C0: the whole tree replaced before the caller's gate/guard/
// bind even runs. Plan §5.1 row A10. Hook: beforeBind. Runs per cell: 30.
//   (a) different content -- guard=none has no earlier observation at all
//       (nothing has been bound yet); C0 has no guard-hash concept, so this
//       sub-case for C0 is really just confirming C0's own baseline
//       (same-tick reuse) behavior one hook earlier than A6/root's own
//       betweenBindAndWalk timing.
//   (b) identical content plus a hard link from inside the tree to an
//       outside file -- tests unlink(2)'s own property (removing one name
//       never touches the shared inode's data while another link exists),
//       independent of any identity/gate logic.

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import {
  buildSwapFixture,
  buildHardlinkFixture,
  swapDirectorySameTick,
  verifyReplacementIntact,
  verifyOutsideIntact,
} from './_shared.mjs'
export const id = 'A10'
export const target = 30

/** @param {'a'|'b'} args.subcase */
export function runOnce({ harnessRoot, candidate, subcase }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let reuseObserved = null
  let replacementFiles = null

  try {
    if (subcase === 'a') {
      const { treeRoot, targetAbs } = buildSwapFixture(fx.root)

      const hooks = {
        beforeBind() {
          hookFired = true
          replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
          const swap = swapDirectorySameTick(targetAbs, replacementFiles)
          mutationApplied = true
          reuseObserved = swap.reuseObserved
        },
      }

      const start = performance.now()
      const outcome = removeC0(treeRoot, { ...candidate, hooks })
      const durationMs = performance.now() - start

      const userFiles = replacementFiles
        ? verifyReplacementIntact(targetAbs, replacementFiles)
        : { checked: 0, lost: 0, changed: 0 }

      return {
        precondition: { hookFired, mutationApplied, controlExpected: true },
        outcome: {
          status: outcome.status,
          reason: outcome.reason,
          path: outcome.path,
          errno: outcome.errno,
        },
        userFiles,
        durationMs,
        extra: { subcase, reuseObserved },
      }
    }

    // subcase 'b': hardlink property check, no timing-dependent mutation --
    // the fixture is already in its attacked shape before removeC0 runs.
    const { treeRoot, outsideFile } = buildHardlinkFixture(fx.root)
    hookFired = true
    mutationApplied = true

    const start = performance.now()
    const outcome = removeC0(treeRoot, { ...candidate, hooks: {} })
    const durationMs = performance.now() - start

    const userFiles = verifyOutsideIntact(outsideFile, 'shared-outside-content')

    return {
      precondition: { hookFired, mutationApplied, controlExpected: true },
      outcome: {
        status: outcome.status,
        reason: outcome.reason,
        path: outcome.path,
        errno: outcome.errno,
      },
      userFiles,
      durationMs,
      extra: { subcase },
    }
  } finally {
    fx.cleanup()
  }
}
