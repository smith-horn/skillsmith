// A7 against VR: the file substitution this checkpoint exists to separate
// V1 from V2 on. Two sub-cases (plan §5.1 row A7):
//   'between'      -- after the guard pass has fully recorded the ORIGINAL
//                      file's identity+content hash, but before the removal
//                      pass has acted on anything (hook: betweenGuardAnd
//                      Removal, whole-tree scope).
//   'before-unlink' -- right before THIS entry's own removal action (hook:
//                      beforeUnlink(relPath, type), fired per-entry).
// Both use the same same-tick delete+recreate technique as A5/A6, applied to
// a leaf FILE (or the symlink sub-case, a leaf SYMLINK) instead of a
// directory -- racing for inode reuse so V1's (dev, ino) check alone is not
// automatically sufficient.
//
// V0 has no identity or content check on files at all -- required failing
// control per the plan's own attack table ("V0 (expected to delete the
// substitute)"). V1 checks (dev, ino) only -- expected to fail whenever
// reuse is achieved, since a reused inode number passes V1's check even
// though the CONTENT differs. V2 re-hashes content before quarantining --
// expected to survive via `entry-changed`/`entry-substituted`.

import { removeVR } from '../../walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import {
  buildSwapFixture,
  buildSymlinkFixture,
  swapFileSameTick,
  verifyReplacementIntact,
} from './_shared.mjs'
import { symlinkSync, unlinkSync, lstatSync } from 'node:fs'

export const id = 'A7-VR'
export const target = 30

/**
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
  let targetRel = null

  try {
    let treeRoot
    if (entryKind === 'symlink') {
      const sf = buildSymlinkFixture(fx.root)
      treeRoot = sf.treeRoot
      targetFileAbs = sf.linkAbs
      targetRel = 'link'
    } else {
      const bf = buildSwapFixture(fx.root)
      treeRoot = bf.treeRoot
      targetFileAbs = `${bf.targetAbs}/orig-f1`
      targetRel = 'target/orig-f1'
    }

    const applyMutation = () => {
      hookFired = true
      if (entryKind === 'symlink') {
        const newOutside = `${treeRoot}/../substituted-outside-marker`
        unlinkSync(targetFileAbs)
        symlinkSync(newOutside, targetFileAbs)
        mutationApplied = true
      } else {
        replacementContent = `substituted-${Date.now()}-${Math.random()}`
        const swap = swapFileSameTick(targetFileAbs, replacementContent)
        mutationApplied = true
        reuseObserved = swap.reuseObserved
      }
    }

    const hooks =
      subcase === 'between'
        ? { betweenGuardAndRemoval: applyMutation }
        : {
            beforeUnlink(relPath) {
              if (hookFired || relPath !== targetRel) return
              applyMutation()
            },
          }

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, hooks })
    const durationMs = performance.now() - start

    let userFiles
    if (entryKind === 'symlink') {
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
        // `fx.root` is the directory that HELD the tree, so V2's quarantine
        // (`.skillsmith-rm-<opId>`) lands beside it, i.e. here. Scanning it makes
        // stranding OBSERVED rather than inferred from `outcome.reason`; see
        // result-schema.mjs for why a failed scan reports null and never 0.
        quarantineLeft: scanQuarantineLeftovers(fx.root, candidate?.variant),
      },
      userFiles,
      durationMs,
      extra: { reuseObserved, subcase, entryKind },
    }
  } finally {
    fx.cleanup()
  }
}
