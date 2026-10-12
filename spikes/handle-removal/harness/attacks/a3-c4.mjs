// SMI-6715 milestone 1: A3 against C4. 'target' is renamed aside and replaced
// with user files immediately after C4's FIRST lstatSync(originPath) returns
// (identity bound, hash not begun) -- window 'after-bind'. C4 re-hashes after
// that point, so the swapped subtree should make the hash differ from the
// caller's guardHash and the call should be `kept`. C4-naive has no bind, so
// the window maps to 'at-rename' and the swapped tree is moved: DISPLACEMENT is
// failure (owner decision 2).

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

export const id = 'A3-C4'
export const target = 30
export const WINDOWS = ['after-bind']

export function labelFor() {
  return id
}

export function runOnce({ harnessRoot, candidate, window, dirs, traceDir, _test }) {
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
      extra: c4Extra(r, id, win, { dirs: dirs ?? null, actualDirs }, traceDir),
    }
  } finally {
    fx.cleanup()
  }
}
