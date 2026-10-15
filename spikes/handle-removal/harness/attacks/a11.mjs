// A11 against C0: hard link inside the tree to an outside user file. Plan
// §5.1 row A11 -- "property check", no attack/mutation at all, no timing.
// Runs per cell: 10. Pass criterion: outside file intact (unlink(2) removes
// one name, not a shared inode's data, while any other link exists).

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildHardlinkFixture, verifyOutsideIntact } from './_shared.mjs'

export const id = 'A11'
export const target = 10

export function runOnce({ harnessRoot, candidate }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot, outsideFile } = buildHardlinkFixture(fx.root)

    const start = performance.now()
    const outcome = removeC0(treeRoot, { ...candidate, hooks: {} })
    const durationMs = performance.now() - start

    const userFiles = verifyOutsideIntact(outsideFile, 'shared-outside-content')

    return {
      precondition: { hookFired: true, mutationApplied: true, controlExpected: true },
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
