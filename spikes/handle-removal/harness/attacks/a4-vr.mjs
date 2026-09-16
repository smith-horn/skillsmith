// A4 against VR: the same swap as A3-VR, but later -- after 'target' has
// already been opened and its fd is held, and after the guard pass has read
// ITS OWN listing (readdirFd(child)), matching the plan's VR timing "after
// readdirFd(child)". Unlike A3, 'target' has already been recorded with its
// REAL pre-swap identity by the time this fires, so guard=none is a
// different structural regime here than at A3/A6-inner -- V1/V2 have an
// earlier observation to compare the post-swap NAME lookup against even
// with no caller-supplied guardHash at all. This is the direct measurement
// of whether that earlier-record alone (not a guard hash) already closes
// the gap for V1/V2, or whether it takes the guard hash too.

import { removeVR } from '../../walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { buildSwapFixture, renameAsideAndReplace, verifyReplacementIntact } from './_shared.mjs'

export const id = 'A4-VR'
export const target = 30

export function runOnce({ harnessRoot, candidate }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let replacementFiles = null

  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)

    const hooks = {
      afterListing(relPath) {
        if (hookFired || relPath !== 'target') return
        hookFired = true
        replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
        renameAsideAndReplace(targetAbs, replacementFiles)
        mutationApplied = true
      },
    }

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, hooks })
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
        // `fx.root` is the directory that HELD the tree, so V2's quarantine
        // (`.skillsmith-rm-<opId>`) lands beside it, i.e. here. Scanning it makes
        // stranding OBSERVED rather than inferred from `outcome.reason`; see
        // result-schema.mjs for why a failed scan reports null and never 0.
        quarantineLeft: scanQuarantineLeftovers(fx.root),
      },
      userFiles,
      durationMs,
    }
  } finally {
    fx.cleanup()
  }
}
