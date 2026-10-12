// SMI-6715 milestone 1: A8 against C4, both subcases at window 'after-bind'.
//   (b) 'link' (a symlink) replaced by a directory holding a user file.
//       Filed as label 'A8-C4'; control = C4-naive, exact variant.
//   (a) 'target' replaced by a symlink to an outside directory. Filed as label
//       'A8a-C4'; a PROPERTY check with no control: rename(2) moves a symlink,
//       it cannot follow one, so the outside bytes must stay intact on both arms.
// The record's label is returned in extra.label; the runner files it from there.

import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSymlinkFixture, verifyOutsideIntact } from './_shared.mjs'
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
  trashHasSymlink,
} from './c4-score.mjs'

export const id = 'A8-C4'
export const target = 30
export const WINDOWS = ['after-bind']

export function labelFor({ subcase }) {
  return subcase === 'a' ? 'A8a-C4' : 'A8-C4'
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
    const sf = buildSymlinkFixture(fx.root)
    let completed = false
    let onFire
    let score

    if (subcase === 'a') {
      const mutate =
        _test?.mutate ??
        (() => {
          rmSync(sf.targetAbs, { recursive: true, force: true })
          symlinkSync(sf.outsideDir, sf.targetAbs)
        })
      onFire = () => {
        mutate()
        if (
          !lstatSync(sf.targetAbs).isSymbolicLink() ||
          readlinkSync(sf.targetAbs) !== sf.outsideDir
        ) {
          throw new Error(
            'mutation post-condition failed: target is not a symlink to the outside dir'
          )
        }
        completed = true
      }
      score = () => {
        // A moved tree must carry the link with it: a quarantined run whose trash
        // holds no such symlink did not exercise the property under test.
        if (
          completed &&
          r.result?.status === 'quarantined' &&
          !trashHasSymlink(fx.root, 'target', sf.outsideDir)
        ) {
          throw new Error('quarantined but the substituted symlink is not in the trash')
        }
        const o = verifyOutsideIntact(sf.outsideMarker, 'outside-content')
        const lostFiles = o.lost > 0 ? { 'outside-marker.txt': 'outside-content' } : {}
        return scoreUserFiles(fx.root, { ...o, lostFiles })
      }
    } else {
      const replacementFiles = { 'user-file.txt': `replacement-${Date.now()}-${Math.random()}` }
      const mutate =
        _test?.mutate ??
        (() => {
          rmSync(sf.linkAbs, { force: true })
          mkdirSync(sf.linkAbs)
          writeFileSync(`${sf.linkAbs}/user-file.txt`, replacementFiles['user-file.txt'], 'utf8')
        })
      onFire = () => {
        mutate()
        assertReplacementLanded(sf.linkAbs, replacementFiles)
        completed = true
      }
      score = () => scoreUserFiles(fx.root, checkEachFile(sf.linkAbs, replacementFiles))
    }

    const start = performance.now()
    const r = runC4Candidate({ candidate, parentAbs: fx.root, name: 'tree', window: win, onFire })
    const durationMs = performance.now() - start

    return {
      precondition: c4Precondition(r, completed),
      outcome: c4Outcome(r, fx.root, candidate),
      userFiles: (_test?.beforeScore?.({ fxRoot: fx.root }), score()),
      durationMs,
      extra: c4Extra(r, label, win, { subcase }),
    }
  } finally {
    fx.cleanup()
  }
}
