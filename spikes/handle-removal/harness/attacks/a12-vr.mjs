// A12 against VR: the stop rule, VR's own syscalls. Plan §5.1 row A12.
// Runs per cell: 10.
//
// V0/V1's first touch on a matched entry is unlinkAt; V2's is
// renameAtNoReplace (into quarantine) -- injectErrnoOnceAcrossFns fires on
// whichever of the two actually happens first for the matched name, so all
// three variants get a fair, uniform "EACCES/EBUSY at this entry's own
// first removal syscall" rather than only literally matching V0/V1's shape.
//
// Required failing control: same `removeContinuingPastErrors` from a12.mjs
// (a plain fs-based walk, not the native shim -- the point of the control
// is "doesn't stop", not "uses the same syscalls").

import { removeVR } from '../../walk.mjs'
import { loadShim } from '../../native-c/load.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { writeFileTree, injectErrnoOnceAcrossFns } from './_shared.mjs'
import fs from 'node:fs'
import path from 'node:path'

export const id = 'A12-VR'
export const target = 10

function buildA12Fixture(root) {
  const treeRoot = path.join(root, 'tree')
  writeFileTree(treeRoot, {
    'a-before.txt': 'before-content',
    'b-inner-dir/inner-f1': 'inner-content',
    'c-after.txt': 'after-content',
  })
  return treeRoot
}

const EACCES = -13
const EBUSY_ERRNO = -16 // POSIX EBUSY is 16 on both Linux and macOS

/** @param {'ebusy-rmdir'|'eacces-unlink'} args.subcase */
export function runOnce({ harnessRoot, candidate, subcase }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const treeRoot = buildA12Fixture(fx.root)
    const afterPath = path.join(treeRoot, 'c-after.txt')
    const shim = loadShim()

    const matchName = subcase === 'ebusy-rmdir' ? 'b-inner-dir' : 'a-before.txt'
    const injErrno = subcase === 'ebusy-rmdir' ? EBUSY_ERRNO : EACCES
    const inj = injectErrnoOnceAcrossFns(
      shim,
      ['unlinkAt', 'renameAtNoReplace'],
      (fnName, args) => args[1] === matchName,
      injErrno
    )

    const start = performance.now()
    const outcome = removeVR(treeRoot, { ...candidate, hooks: {} })
    const durationMs = performance.now() - start
    inj.restore()

    const afterSurvived = fs.existsSync(afterPath)
    const userFiles = { checked: 1, lost: afterSurvived ? 0 : 1, changed: 0 }

    return {
      precondition: { hookFired: inj.fired, mutationApplied: inj.fired, controlExpected: true },
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
      extra: { subcase },
    }
  } finally {
    fx.cleanup()
  }
}
