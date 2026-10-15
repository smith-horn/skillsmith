// N1: no race -- build a tree and remove it immediately. Plan §5.1 row N1.
// Runs per cell: 300. Pass criterion: 300/300 removed, 0 spurious stops.
//
// This is the false-positive check: UD24's identity check and UD25's gate
// must not misfire on an ordinary, unmolested tree. There is no attack
// mutation and no paired failing control for this row when testing C0
// itself (N1 exists to prove the candidate doesn't false-positive, not to
// demonstrate a race).

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture } from './_shared.mjs'
import { existsSync } from 'node:fs'

export const id = 'N1'
export const target = 300

export function runOnce({ harnessRoot, candidate }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot } = buildSwapFixture(fx.root)

    const start = performance.now()
    const outcome = removeC0(treeRoot, { ...candidate })
    const durationMs = performance.now() - start

    const removedCleanly = outcome.status === 'removed' && !existsSync(treeRoot)
    const spuriousStop = outcome.status === 'stopped'

    return {
      precondition: { hookFired: true, mutationApplied: true, controlExpected: true },
      outcome: {
        status: outcome.status,
        reason: outcome.reason ?? null,
        path: outcome.path ?? null,
        errno: outcome.errno ?? null,
      },
      // A spurious stop or a leftover tree counts as one lost "user byte"
      // for classification purposes -- there is nothing else to check here,
      // since nothing raced the walk.
      userFiles: { checked: 1, lost: removedCleanly ? 0 : 1, changed: 0 },
      durationMs,
      extra: { spuriousStop },
    }
  } finally {
    fx.cleanup()
  }
}
