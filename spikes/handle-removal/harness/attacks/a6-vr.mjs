// A6 against VR: the walked directory itself, and separately an inner
// directory, deleted and recreated (same-tick) before VR has ever touched
// it. Two guard configurations, both real per the plan (§4.1 step 3: "For
// guard none, this pass only records" -- callers like uninstall/undo run
// with no external guard; abort cleanup/move/prune supply the caller's own
// pre-computed §3.4 tree hash as `guardHash`):
//
//   'none'      -- no guardHash. VR has no earlier observation of the
//                  swapped entry to compare against (same structural gap
//                  C0's pre-gate design had) -- this measures whether VR's
//                  held-fd pinning alone (with no caller-side guard) closes
//                  the window, or whether it is a stated residual matching
//                  the plan's own A10 "guard none: record as residual" row.
//   'guardHash' -- guardHash is the tree hash computed from the ORIGINAL,
//                  pre-swap tree (as a real caller with a guard would have
//                  computed it before calling removeVR at all). This tests
//                  whether the guard-hash mismatch path (`kept`, 0 bytes
//                  removed) actually closes A6 for guarded callers.
//
// 'root' hook: afterBind (T is open and held; guard pass not yet started).
// 'inner' hook: afterListing('', ...) (root's children are known, but
// 'target' itself has not been opened yet -- VR has no observation of it).

import { removeVR } from '../../walk.mjs'
import { loadShim } from '../../native-c/load.mjs'
import { guardPass } from '../../hash.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { buildSwapFixture, swapDirectorySameTick, verifyReplacementIntact } from './_shared.mjs'
import fs from 'node:fs'

export const id = 'A6-VR'
export const target = 300

function originalTreeHash(treeRoot) {
  const shim = loadShim()
  const T = shim.openDir(treeRoot)
  const g = guardPass(shim, T.fd, {})
  if (g.status !== 'ok') {
    for (const fd of g.heldFds?.values?.() ?? []) fs.closeSync(fd)
    throw new Error(`originalTreeHash: guard pass failed: ${JSON.stringify(g)}`)
  }
  for (const fd of g.heldFds.values()) fs.closeSync(fd)
  return g.treeHash
}

/**
 * @param {object} args
 * @param {string} args.harnessRoot
 * @param {object} args.candidate - { variant }
 * @param {'root'|'inner'} args.variant2 - which sub-target
 * @param {'none'|'guardHash'} args.guardMode
 */
export function runOnce({ harnessRoot, candidate, variant2, guardMode }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let reuseObserved = null
  let replacementFiles = null
  let verifyDir = null

  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)
    const swapTarget = variant2 === 'root' ? treeRoot : targetAbs
    verifyDir = swapTarget

    const guardHash = guardMode === 'guardHash' ? originalTreeHash(treeRoot) : undefined

    const doSwap = () => {
      hookFired = true
      replacementFiles =
        variant2 === 'root'
          ? {
              'target/orig-f1': `replacement-${Date.now()}-${Math.random()}`,
              'zzz-sibling/f1': `replacement-${Date.now()}-${Math.random()}`,
            }
          : { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
      const swap = swapDirectorySameTick(swapTarget, replacementFiles)
      mutationApplied = true
      reuseObserved = swap.reuseObserved
    }

    const hooks =
      variant2 === 'root'
        ? { afterBind: doSwap }
        : {
            afterListing(relPath) {
              if (hookFired || relPath !== '') return
              doSwap()
            },
          }

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, guardHash, hooks })
    const durationMs = performance.now() - start

    const userFiles = replacementFiles
      ? verifyReplacementIntact(verifyDir, replacementFiles)
      : { checked: 0, lost: 0, changed: 0 }

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
      extra: { reuseObserved, variant2, guardMode },
    }
  } finally {
    fx.cleanup()
  }
}
