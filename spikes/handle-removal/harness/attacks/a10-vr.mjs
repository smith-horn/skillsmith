// A10 against VR: the whole tree replaced before removeVR is even called at
// all -- one hook point earlier than A6-VR/root's own afterBind timing, and
// genuinely BEFORE the caller's own bind, matching the plan's own framing
// ("before bind"). Runs per cell: 30.
//   (a) different content, guard=none vs guard=hash (see A6-VR/A9-VR for
//       the same split rationale -- guard=none has no earlier observation
//       of ANYTHING here, since the swap predates even the open of P).
//   (b) identical serialization plus a hard link to an outside file --
//       unlink(2)'s own property, independent of guard mode.

import { removeVR } from '../../walk.mjs'
import { loadShim } from '../../native-c/load.mjs'
import { guardPass } from '../../hash.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import {
  buildSwapFixture,
  buildHardlinkFixture,
  swapDirectorySameTick,
  verifyReplacementIntact,
  verifyOutsideIntact,
} from './_shared.mjs'
import fs from 'node:fs'

export const id = 'A10-VR'
export const target = 30

function originalTreeHash(treeRoot) {
  const shim = loadShim()
  const T = shim.openDir(treeRoot)
  const g = guardPass(shim, T.fd, {})
  if (g.status !== 'ok') {
    for (const fd of g.heldFds?.values?.() ?? []) fs.closeSync(fd)
    throw new Error(`originalTreeHash: guard pass failed: ${JSON.stringify(g)}`)
  }
  for (const fd of g.heldFds.values()) fs.closeSync(fd)
  return g.treeHash
}

/**
 * @param {'a'|'b'} args.subcase
 * @param {'none'|'guardHash'} args.guardMode - subcase 'a' only
 */
export function runOnce({ harnessRoot, candidate, subcase, guardMode }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let reuseObserved = null
  let replacementFiles = null

  try {
    if (subcase === 'a') {
      const { treeRoot, targetAbs } = buildSwapFixture(fx.root)
      const guardHash = guardMode === 'guardHash' ? originalTreeHash(treeRoot) : undefined

      // The swap happens BEFORE removeVR is even called -- no hook needed;
      // this fixture is already attacked by the time removeVR runs.
      replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
      const swap = swapDirectorySameTick(targetAbs, replacementFiles)
      hookFired = true
      mutationApplied = true
      reuseObserved = swap.reuseObserved

      const start = performance.now()
      const outcome = removeVR(treeRoot, { ...candidate, guardHash, hooks: {} })
      const durationMs = performance.now() - start

      const userFiles = verifyReplacementIntact(targetAbs, replacementFiles)

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
        extra: { subcase, guardMode, reuseObserved },
      }
    }

    const { treeRoot, outsideFile } = buildHardlinkFixture(fx.root)
    hookFired = true
    mutationApplied = true

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, hooks: {} })
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
