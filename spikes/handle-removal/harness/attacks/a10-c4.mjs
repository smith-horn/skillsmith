// SMI-6715 milestone 1: A10 against C4, both subcases at window 'pre-call'
// (after the caller's hash, before quarantineTree is called).
//   (a) the WHOLE tree is replaced (swapDirectorySameTick on the tree root).
//       Label 'A10-C4'; control = C4-naive, exact variant. The core accidental case.
//   (b) the tree serializes identically and holds a hard link to an outside
//       file. Label 'A10b-C4'; a PROPERTY check with no control: rename(2) moves
//       the name, never the shared inode, so the outside file must stay intact.
//       onFire is not a no-op: it asserts the hard link really exists
//       (nlink >= 2 on the outside file) so a fixture without it cannot count.

import { statSync } from 'node:fs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import {
  buildSwapFixture,
  buildHardlinkFixture,
  swapDirectorySameTick,
  verifyOutsideIntact,
} from './_shared.mjs'
import { runC4Candidate } from './c4-shared.mjs'
import {
  assertC4Candidate,
  resolveWindow,
  checkEachFile,
  scoreUserFiles,
  c4Precondition,
  c4Outcome,
  c4Extra,
  assertReplacementLanded,
} from './c4-score.mjs'

export const id = 'A10-C4'
export const target = 30
export const WINDOWS = ['pre-call']

export function labelFor({ subcase }) {
  return subcase === 'b' ? 'A10b-C4' : 'A10-C4'
}

export function runOnce({ harnessRoot, candidate, subcase, window, _test }) {
  assertC4Candidate(candidate)
  if (subcase !== 'a' && subcase !== 'b') {
    throw new TypeError(`subcase must be 'a' or 'b', got ${String(subcase)}`)
  }
  const win = resolveWindow(window, WINDOWS)
  const label = labelFor({ subcase })
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    let completed = false
    let reuseObserved = null
    let onFire
    let score

    if (subcase === 'a') {
      const { treeRoot } = buildSwapFixture(fx.root)
      const replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
      const mutate =
        _test?.mutate ??
        (() => {
          reuseObserved = swapDirectorySameTick(treeRoot, replacementFiles).reuseObserved
        })
      onFire = () => {
        mutate()
        assertReplacementLanded(treeRoot, replacementFiles)
        completed = true
      }
      score = () => scoreUserFiles(fx.root, checkEachFile(treeRoot, replacementFiles))
    } else {
      const fixture = buildHardlinkFixture(fx.root)
      const { outsideFile } = fixture
      _test?.afterFixture?.(fixture)
      onFire = () => {
        const nlink = statSync(outsideFile).nlink
        if (nlink < 2) throw new Error(`hard-link fixture invalid: nlink=${nlink}`)
        completed = true
      }
      score = () => {
        const o = verifyOutsideIntact(outsideFile, 'shared-outside-content')
        const lostFiles = o.lost > 0 ? { 'shared-data.txt': 'shared-outside-content' } : {}
        return scoreUserFiles(fx.root, { ...o, lostFiles })
      }
    }

    const start = performance.now()
    const r = runC4Candidate({ candidate, parentAbs: fx.root, name: 'tree', window: win, onFire })
    const durationMs = performance.now() - start

    return {
      precondition: c4Precondition(r, completed),
      outcome: c4Outcome(r, fx.root, candidate),
      userFiles: score(),
      durationMs,
      extra: c4Extra(r, label, win, { subcase, reuseObserved }),
    }
  } finally {
    fx.cleanup()
  }
}
