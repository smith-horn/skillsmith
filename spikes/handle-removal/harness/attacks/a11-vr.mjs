// A11 against VR: same property check as a11.mjs, no attack/mutation, no
// timing. Runs per cell: 10.

import { removeVR } from '../../walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { buildHardlinkFixture, verifyOutsideIntact } from './_shared.mjs'

export const id = 'A11-VR'
export const target = 10

export function runOnce({ harnessRoot, candidate }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot, outsideFile } = buildHardlinkFixture(fx.root)

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, hooks: {} })
    const durationMs = performance.now() - start

    const userFiles = verifyOutsideIntact(outsideFile, 'shared-outside-content')

    return {
      precondition: { hookFired: true, mutationApplied: true, controlExpected: true },
      outcome: {
        status: outcome.status,
        reason: outcome.reason,
        path: outcome.path,
        errno: outcome.errno,
        // `fx.root` is the directory that HELD the tree, so V2's quarantine
        // (`.skillsmith-rm-<opId>`) lands beside it, i.e. here. Scanning it makes
        // stranding OBSERVED rather than inferred from `outcome.reason`; see
        // result-schema.mjs for why a failed scan reports null and never 0.
        quarantineLeft: scanQuarantineLeftovers(fx.root, candidate?.variant),
      },
      userFiles,
      durationMs,
    }
  } finally {
    fx.cleanup()
  }
}
