// A3: directory renamed aside and replaced (user files, same name) after the
// probe, before descent. Plan §5.1 row A3. Runs per cell: 30.
//
// The replacement gets a genuinely different inode in the overwhelming
// majority of cases (mkdirSync after a rename-away, not a delete+recreate
// racing for reuse) -- so this attack targets UD24 (plain identity check),
// not the UD25 gate. Control: identityCheck:false is expected to fail.

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, renameAsideAndReplace, verifyReplacementIntact } from './_shared.mjs'

export const id = 'A3'
export const target = 30

export function runOnce({ harnessRoot, candidate }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let replacementFiles = null
  let asideExisted = null

  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)

    const hooks = {
      afterProbe(relPath, probeResult) {
        if (hookFired) return
        if (relPath !== 'target') return
        if (probeResult !== 'ENOTEMPTY') return // wait for the real, expected probe result
        hookFired = true
        replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
        const { asideName } = renameAsideAndReplace(targetAbs, replacementFiles)
        mutationApplied = true
        asideExisted = asideName
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
      extra: { asideExisted },
    }
  } finally {
    fx.cleanup()
  }
}
