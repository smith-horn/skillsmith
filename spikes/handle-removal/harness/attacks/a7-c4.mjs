// SMI-6715 milestone 1: A7 against C4. A leaf entry is substituted.
//   subcase 'between' -> window 'after-bind' (before C4 hashes)
//   subcase 'late'    -> window 'post-hash'   (after C4 hashed, before its re-check)
// entryKind 'file': orig-f1 deleted and recreated same-tick (swapFileSameTick).
// entryKind 'symlink': the symlink 'link' is replaced by a symlink to a
// different (dangling) target. The user entry is the substituted symlink, whose
// bytes are its target string. locateDisplaced only counts regular files and
// deliberately does not follow symlinks, so a moved symlink is located here by
// walking .skillsmith-trash for a symlink of that name and target.

import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, buildSymlinkFixture, swapFileSameTick } from './_shared.mjs'
import { runC4Candidate } from './c4-shared.mjs'
import {
  assertC4Candidate,
  checkEachFile,
  scoreUserFiles,
  c4Precondition,
  c4Outcome,
  c4Extra,
  trashHasSymlink,
  assertReplacementLanded,
} from './c4-score.mjs'

export const id = 'A7-C4'
export const target = 30
export const SUBCASE_WINDOW = Object.freeze({ between: 'after-bind', late: 'post-hash' })

export function labelFor() {
  return id
}

function symlinkUserFiles(fxRoot, linkAbs, newTarget) {
  let lost = 0
  let changed = 0
  try {
    lstatSync(linkAbs)
    if (readlinkSync(linkAbs) !== newTarget) changed = 1
  } catch {
    lost = 1
  }
  const displaced = lost === 1 && trashHasSymlink(fxRoot, 'link', newTarget) ? 1 : 0
  return { checked: 1, lost, changed, displaced, deleted: lost - displaced }
}

export function runOnce({ harnessRoot, candidate, subcase, entryKind, window, _test }) {
  assertC4Candidate(candidate)
  if (!Object.hasOwn(SUBCASE_WINDOW, subcase)) {
    throw new TypeError(`subcase must be 'between' or 'late', got ${String(subcase)}`)
  }
  if (entryKind !== 'file' && entryKind !== 'symlink') {
    throw new TypeError(`entryKind must be 'file' or 'symlink', got ${String(entryKind)}`)
  }
  const win = window === undefined ? SUBCASE_WINDOW[subcase] : window
  if (win !== SUBCASE_WINDOW[subcase]) {
    throw new TypeError(
      `subcase ${subcase} runs at ${SUBCASE_WINDOW[subcase]}, got ${String(window)}`
    )
  }

  const fx = makeFixtureRoot({ harnessRoot })
  try {
    let completed = false
    let reuseObserved = null
    const start0 = { replacementContent: null, newLinkTarget: null }
    let onFire
    let score

    if (entryKind === 'symlink') {
      const sf = buildSymlinkFixture(fx.root)
      start0.newLinkTarget = `${sf.treeRoot}/../substituted-outside-marker`
      const mutate =
        _test?.mutate ??
        (() => {
          unlinkSync(sf.linkAbs)
          symlinkSync(start0.newLinkTarget, sf.linkAbs)
        })
      onFire = () => {
        mutate()
        if (readlinkSync(sf.linkAbs) !== start0.newLinkTarget) {
          throw new Error(
            'mutation post-condition failed: link does not point at the substituted target'
          )
        }
        completed = true
      }
      score = () => symlinkUserFiles(fx.root, sf.linkAbs, start0.newLinkTarget)
    } else {
      const bf = buildSwapFixture(fx.root)
      start0.replacementContent = `substituted-${Date.now()}-${Math.random()}`
      const mutate =
        _test?.mutate ??
        (() => {
          reuseObserved = swapFileSameTick(
            `${bf.targetAbs}/orig-f1`,
            start0.replacementContent
          ).reuseObserved
        })
      onFire = () => {
        mutate()
        assertReplacementLanded(bf.targetAbs, { 'orig-f1': start0.replacementContent })
        completed = true
      }
      score = () =>
        scoreUserFiles(
          fx.root,
          checkEachFile(bf.targetAbs, { 'orig-f1': start0.replacementContent })
        )
    }

    const start = performance.now()
    const r = runC4Candidate({ candidate, parentAbs: fx.root, name: 'tree', window: win, onFire })
    const durationMs = performance.now() - start

    return {
      precondition: c4Precondition(r, completed),
      outcome: c4Outcome(r, fx.root, candidate),
      userFiles: score(),
      durationMs,
      extra: c4Extra(r, id, win, { subcase, entryKind, reuseObserved }),
    }
  } finally {
    fx.cleanup()
  }
}
