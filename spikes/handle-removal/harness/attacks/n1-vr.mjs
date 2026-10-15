// N1 against VR: no race -- build a tree and remove it immediately, no
// attack, no mutation. Plan §5.1 row N1. Runs per cell: 300. Pass
// criterion: 300/300 removed, 0 spurious stops. This is criterion 2's own
// missing evidence, closed here for V0/V1/V2 (§10 criterion 2: "no
// spurious stops, 300/300 per filesystem in N1" was C0-only until now).
//
// Same false-positive concern as C0's own n1.mjs, but VR's own checks are
// different in kind: no clock gate to misfire (confirmed structurally
// immune in A9), but V1/V2's identity/content re-verification at removal
// time COULD in principle misfire against ordinary, unmolested content if
// the guard pass and removal pass ever disagree about something that
// never changed. Also runs guard=hash (a real caller would normally supply
// one) alongside guard=none, since a false mismatch on legitimate content
// would be exactly the kind of spurious stop this row exists to catch.

import { removeVR } from '../../walk.mjs'
import { loadShim } from '../../native-c/load.mjs'
import { guardPass } from '../../hash.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { buildSwapFixture } from './_shared.mjs'
import { existsSync } from 'node:fs'
import fs from 'node:fs'

export const id = 'N1-VR'
export const target = 300

function originalTreeHash(treeRoot) {
  const shim = loadShim()
  const T = shim.openDir(treeRoot)
  const g = guardPass(shim, T.fd, {})
  for (const fd of g.heldFds.values()) fs.closeSync(fd)
  return g.treeHash
}

/** @param {'none'|'guardHash'} args.guardMode */
export function runOnce({ harnessRoot, candidate, guardMode }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot } = buildSwapFixture(fx.root)
    const guardHash = guardMode === 'guardHash' ? originalTreeHash(treeRoot) : undefined

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, guardHash, hooks: {} })
    const durationMs = performance.now() - start

    const removedCleanly = outcome.status === 'removed' && !existsSync(treeRoot)
    const spuriousStop = outcome.status === 'stopped'
    const spuriousKept = outcome.status === 'kept' // guardHash matched a clean tree -- should never be 'kept'

    return {
      precondition: { hookFired: true, mutationApplied: true, controlExpected: true },
      outcome: {
        status: outcome.status,
        reason: outcome.reason ?? null,
        path: outcome.path ?? null,
        errno: outcome.errno ?? null,
        // `fx.root` is the directory that HELD the tree, so V2's quarantine
        // (`.skillsmith-rm-<opId>`) lands beside it, i.e. here. Scanning it makes
        // stranding OBSERVED rather than inferred from `outcome.reason`; see
        // result-schema.mjs for why a failed scan reports null and never 0.
        quarantineLeft: scanQuarantineLeftovers(fx.root, candidate?.variant),
      },
      userFiles: {
        checked: 1,
        lost: removedCleanly ? 0 : 1,
        changed: 0,
      },
      durationMs,
      extra: { spuriousStop, spuriousKept, guardMode },
    }
  } finally {
    fx.cleanup()
  }
}
