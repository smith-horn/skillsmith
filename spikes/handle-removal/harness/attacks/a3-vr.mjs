// A3 against VR: 'target' renamed aside and replaced with user files, timed
// after the root's own guard-pass listing but before 'target' is ever
// opened -- the plan's own VR timing for A3 ("after parent readdirFd and
// before openAt(child)"), which is structurally the SAME moment A6-VR's
// 'inner' hook fires at. Two guard configurations, same reasoning as A6-VR:
// guard=none has no earlier observation of 'target' to compare against
// (VR's guard pass hasn't touched it yet); guard=hash is computed from the
// ORIGINAL pre-swap tree by a caller that already had one.

import { removeVR } from '../../walk.mjs'
import { loadShim } from '../../native-c/load.mjs'
import { guardPass } from '../../hash.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { buildSwapFixture, renameAsideAndReplace, verifyReplacementIntact } from './_shared.mjs'
import fs from 'node:fs'

export const id = 'A3-VR'
export const target = 30

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
 * @param {object} args.candidate - { variant }
 * @param {'none'|'guardHash'} args.guardMode
 */
export function runOnce({ harnessRoot, candidate, guardMode }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let replacementFiles = null

  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)
    const guardHash = guardMode === 'guardHash' ? originalTreeHash(treeRoot) : undefined

    const hooks = {
      afterListing(relPath, entries) {
        if (hookFired || relPath !== '' || !entries.some((e) => e.name === 'target')) return
        hookFired = true
        replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
        renameAsideAndReplace(targetAbs, replacementFiles)
        mutationApplied = true
      },
    }

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, guardHash, hooks })
    const durationMs = performance.now() - start

    const userFiles = replacementFiles
      ? verifyReplacementIntact(targetAbs, replacementFiles)
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
      extra: { guardMode },
    }
  } finally {
    fx.cleanup()
  }
}
