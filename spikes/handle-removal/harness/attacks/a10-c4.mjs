// SMI-6715 milestone 1: A10 against C4, both subcases at window 'pre-call'
// (after the caller's hash, before quarantineTree is called).
//   (a) the WHOLE tree is replaced (swapDirectorySameTick on the tree root).
//       Label 'A10-C4'; control = C4-naive, exact variant. The core accidental case.
//   (b) the tree serializes identically and holds a hard link to an outside
//       file. Label 'A10b-C4'; a PROPERTY check with no control: rename(2) moves
//       the name, never the shared inode, so the outside file must stay intact.
//       onFire is not a no-op: it asserts the hard link really exists
//       (nlink >= 2 on the outside file) so a fixture without it cannot count.
//
// SCOPE OF THE A10b ROW. A10b ('A10b-C4') is a NARROW PROPERTY row: it checks that
// moving a tree by rename(2) renames one name for a shared inode and does not unlink
// the other hard-link name (the outside file). Both arms pass by construction, so it
// says nothing about how well C4's guard detects a mutation. It must stay OUT of
// comparative safety totals (do not sum it with the controlled rows, and do not
// count its PASS as C4 beating naive).

import { lstatSync, statSync } from 'node:fs'
import path from 'node:path'
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
  whereFor,
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
      score = (r) =>
        scoreUserFiles(
          fx.root,
          checkEachFile(treeRoot, replacementFiles),
          whereFor(fx.root, r, treeRoot)
        )
    } else {
      const fixture = buildHardlinkFixture(fx.root)
      const { outsideFile, hardlinkAbs, treeRoot } = fixture
      _test?.afterFixture?.(fixture)
      onFire = () => {
        // The link must be a name for the OUTSIDE file's inode and must sit inside
        // the tree; nlink >= 2 alone is satisfied by a link moved anywhere else.
        const outside = statSync(outsideFile, { bigint: true })
        const inside = lstatSync(hardlinkAbs, { bigint: true })
        if (inside.dev !== outside.dev || inside.ino !== outside.ino) {
          throw new Error('hard-link fixture invalid: tree link is not the outside file inode')
        }
        const rel = path.relative(treeRoot, hardlinkAbs)
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error('hard-link fixture invalid: link is not under the tree')
        }
        if (outside.nlink < 2n) {
          throw new Error(`hard-link fixture invalid: nlink=${outside.nlink}`)
        }
        completed = true
      }
      score = (r) => {
        const o = verifyOutsideIntact(outsideFile, 'shared-outside-content')
        const lostFiles = o.lost > 0 ? { 'shared-data.txt': 'shared-outside-content' } : {}
        return scoreUserFiles(
          fx.root,
          { ...o, lostFiles },
          whereFor(fx.root, r, path.dirname(outsideFile))
        )
      }
    }

    const start = performance.now()
    const r = runC4Candidate({ candidate, parentAbs: fx.root, name: 'tree', window: win, onFire })
    const durationMs = performance.now() - start

    return {
      precondition: c4Precondition(r, completed),
      outcome: c4Outcome(r, fx.root, candidate),
      userFiles: score(r),
      durationMs,
      extra: c4Extra(r, label, win, { subcase, reuseObserved }),
    }
  } finally {
    fx.cleanup()
  }
}
