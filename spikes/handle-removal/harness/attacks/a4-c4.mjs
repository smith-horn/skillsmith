// SMI-6715 milestone 1: A4 against C4. The same rename-aside swap as A3-C4,
// timed at 'post-hash': immediately BEFORE C4's pre-rename re-check lstat. C4's
// re-check covers root identity only, and the swap does not change the root's
// identity, so per owner decision 4 C4 is EXPECTED TO FAIL here (the swapped
// subtree is moved to quarantine = displaced). That is a finding, not a bug in
// this module. C4-naive maps the window to 'at-rename'.

import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, renameAsideAndReplace } from './_shared.mjs'
import { runC4Candidate } from './c4-shared.mjs'
import {
  assertC4Candidate,
  applyDirs,
  resolveWindow,
  checkEachFile,
  scoreUserFiles,
  c4Precondition,
  c4Outcome,
  c4Extra,
  assertReplacementLanded,
  whereFor,
} from './c4-score.mjs'

export const id = 'A4-C4'
export const target = 30
export const WINDOWS = ['post-hash']

export function labelFor() {
  return id
}

export function runOnce({ harnessRoot, candidate, window, dirs, _test }) {
  assertC4Candidate(candidate)
  const win = resolveWindow(window, WINDOWS)
  const fx = makeFixtureRoot({ harnessRoot })
  let actualDirs = null
  try {
    const { targetAbs } = buildSwapFixture(fx.root)
    actualDirs = applyDirs(fx.root, dirs)
    const replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
    let completed = false
    const mutate = _test?.mutate ?? (() => renameAsideAndReplace(targetAbs, replacementFiles))
    const onFire = () => {
      mutate()
      assertReplacementLanded(targetAbs, replacementFiles)
      completed = true
    }

    const start = performance.now()
    const r = runC4Candidate({ candidate, parentAbs: fx.root, name: 'tree', window: win, onFire })
    const durationMs = performance.now() - start

    return {
      precondition: c4Precondition(r, completed),
      outcome: c4Outcome(r, fx.root, candidate),
      userFiles: scoreUserFiles(
        fx.root,
        checkEachFile(targetAbs, replacementFiles),
        whereFor(fx.root, r, targetAbs)
      ),
      durationMs,
      extra: c4Extra(r, id, win, { dirs: dirs ?? null, actualDirs }),
    }
  } finally {
    fx.cleanup()
  }
}
