// A7 against C0: a leaf entry (file, or symlink-to-outside-file) substituted
// same-tick, either (a) after the parent's listing but before the per-child
// loop reaches it, or (b) right before its own unlink. Plan §5.1 row A7.
// Runs per cell: 30.
//
// C0 has NO per-file identity or content check at all -- `check()` only
// re-verifies the PARENT directory's identity before each child action, not
// the child itself. So C0 is expected to fail every cell here regardless of
// sub-case or entry kind: this attack targets a check C0 was never designed
// to have, and the loss count is the useful, unsurprising confirmation the
// plan's own row calls for ("record loss counts; expected to fail").

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import {
  buildSwapFixture,
  buildSymlinkFixture,
  swapFileSameTick,
  verifyReplacementIntact,
} from './_shared.mjs'
import { symlinkSync, unlinkSync, lstatSync } from 'node:fs'

export const id = 'A7'
export const target = 30

/**
 * @param {object} args
 * @param {'between'|'before-unlink'} args.subcase
 * @param {'file'|'symlink'} args.entryKind
 */
export function runOnce({ harnessRoot, candidate, subcase, entryKind }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let reuseObserved = null
  let replacementContent = null
  let targetFileAbs = null

  try {
    let treeRoot, targetAbs
    if (entryKind === 'symlink') {
      const sf = buildSymlinkFixture(fx.root)
      treeRoot = sf.treeRoot
      targetFileAbs = sf.linkAbs
    } else {
      const bf = buildSwapFixture(fx.root)
      treeRoot = bf.treeRoot
      targetAbs = bf.targetAbs
      targetFileAbs = `${targetAbs}/orig-f1`
    }

    const applyMutation = () => {
      hookFired = true
      if (entryKind === 'symlink') {
        // Substitute the symlink for one pointing at a DIFFERENT outside
        // location -- same technique as swapFileSameTick's delete+recreate,
        // applied to a symlink instead of a regular file.
        const newOutside = `${treeRoot}/../substituted-outside-marker`
        replacementContent = null
        unlinkSync(targetFileAbs)
        symlinkSync(newOutside, targetFileAbs)
        mutationApplied = true
        reuseObserved = null
      } else {
        replacementContent = `substituted-${Date.now()}-${Math.random()}`
        const swap = swapFileSameTick(targetFileAbs, replacementContent)
        mutationApplied = true
        reuseObserved = swap.reuseObserved
      }
    }

    const hooks =
      subcase === 'between'
        ? {
            afterListing(relPath, entries) {
              if (hookFired) return
              const inScope = entryKind === 'symlink' ? relPath === '' : relPath === 'target'
              if (!inScope) return
              if (!entries.some((n) => (entryKind === 'symlink' ? n === 'link' : n === 'orig-f1')))
                return
              applyMutation()
            },
          }
        : {
            beforeUnlink(relPath) {
              if (hookFired) return
              const wanted = entryKind === 'symlink' ? 'link' : 'target/orig-f1'
              if (relPath !== wanted) return
              applyMutation()
            },
          }

    const start = performance.now()
    const outcome = removeC0(treeRoot, { ...candidate, hooks })
    const durationMs = performance.now() - start

    let userFiles
    if (entryKind === 'symlink') {
      // "0 substituted user bytes lost" for a symlink swap means: the NEW
      // symlink (the thing now occupying the name) must survive as an entry
      // -- lstat, not existsSync, since the latter follows the (dangling)
      // link and would misreport survival as loss.
      let survives = false
      try {
        lstatSync(targetFileAbs)
        survives = true
      } catch {
        survives = false
      }
      userFiles = survives
        ? { checked: 1, lost: 0, changed: 0 }
        : { checked: 1, lost: 1, changed: 0 }
    } else {
      userFiles = replacementContent
        ? verifyReplacementIntact(targetFileAbs.replace(/\/orig-f1$/, ''), {
            'orig-f1': replacementContent,
          })
        : { checked: 0, lost: 0, changed: 0 }
    }

    return {
      precondition: { hookFired, mutationApplied, controlExpected: true },
      outcome: {
        status: outcome.status,
        reason: outcome.reason,
        path: outcome.path,
        errno: outcome.errno,
      },
      userFiles,
      durationMs,
      extra: { reuseObserved, subcase, entryKind },
    }
  } finally {
    fx.cleanup()
  }
}
