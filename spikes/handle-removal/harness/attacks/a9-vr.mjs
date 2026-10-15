// A9 against VR: the same directory-level clock forgery as a9.mjs (see its
// header for why the attack must target a DIRECTORY, not a file, to mean
// anything -- C0's gate only ever checks directories, and that shape
// carries over here for a fair comparison even though VR has no gate at
// all to defeat). VR's own statAt (native C, direct syscalls) is measured
// live via wrapStatAtFieldLog to confirm no time-shaped field is EVER
// present in what the walk reads -- the real, checkable version of "no
// timestamp field read", not an inference from the C source alone.
//
//   (a) 'stub' -- fs.lstatSync monkeypatch (has no effect on VR's own
//       identity checks, which never call node:fs for stat at all -- this
//       is itself part of what's being measured: VR is structurally
//       unreachable by a JS-level stub).
//   (b) 'apfs-setfile' -- real `SetFile -d` forged crtime (macOS/APFS only,
//       see a9.mjs).
//
// Pass criterion: 0 bytes lost AND no timestamp field read.
//
// GUARD SPLIT (found while validating this module, before any recorded
// run): this attack's hook ('afterBind', "as A6") fires at the SAME moment
// A6-VR's own 'root' sub-variant does -- before the guard pass has any
// observation of the tree at all. Under guard=none, an unguarded first pass
// showed 1/1 loss regardless of whether the birthtime forgery was even
// applied, because A6/root/none's ALREADY-KNOWN residual (no earlier
// observation exists for anything before bind) fires here too, independent
// of the clock attack. Reporting only guard=none here would misattribute
// that pre-existing gap to A9's own mechanism. guard=hash is included so
// the two are kept separable: guard=hash removal being 'kept' (0 bytes
// lost) with the SAME forged birthtime in place is the actual, clock-
// specific confirmation that VR's guard hash -- unlike C0's gate -- cannot
// be fooled by a forged timestamp, because it never looks at one.

import { removeVR } from '../../walk.mjs'
import { loadShim } from '../../native-c/load.mjs'
import { guardPass } from '../../hash.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import {
  buildSwapFixture,
  swapDirectorySameTick,
  verifyReplacementIntact,
  withStubbedBirthtime,
  wrapStatAtFieldLog,
  anyTimeFieldSeen,
} from './_shared.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

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

export const id = 'A9-VR'
export const target = 30

const OLD_DATE_SETFILE = '01/01/2020 00:00:00'
const OLD_BIRTHTIME_NS = 1577836800000000000n

/**
 * @param {'stub'|'apfs-setfile'} args.subcase
 * @param {'none'|'guardHash'} args.guardMode
 */
export function runOnce({ harnessRoot, candidate, subcase, guardMode }) {
  if (subcase === 'apfs-setfile' && process.platform !== 'darwin') {
    return {
      precondition: { hookFired: false, mutationApplied: false, controlExpected: true },
      outcome: { status: 'harness-error', reason: 'not-applicable-non-apfs-platform' },
      userFiles: { checked: 0, lost: 0, changed: 0 },
      durationMs: null,
      extra: { subcase, skipped: true },
    }
  }

  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let reuseObserved = null
  let replacementFiles = null

  try {
    const { treeRoot, targetAbs } = buildSwapFixture(fx.root)
    const guardHash = guardMode === 'guardHash' ? originalTreeHash(treeRoot) : undefined

    const applyMutation = () => {
      hookFired = true
      replacementFiles = { 'orig-f1': `replacement-${Date.now()}-${Math.random()}` }
      const swap = swapDirectorySameTick(targetAbs, replacementFiles)
      mutationApplied = true
      reuseObserved = swap.reuseObserved
      if (subcase === 'apfs-setfile') {
        execFileSync('SetFile', ['-d', OLD_DATE_SETFILE, targetAbs], { stdio: 'pipe' })
      }
    }

    const hooks = { afterBind: applyMutation }

    const shim = loadShim()
    const fieldLog = wrapStatAtFieldLog(shim)

    const start = performance.now()
    const outcome =
      subcase === 'stub'
        ? withStubbedBirthtime(fs, targetAbs, OLD_BIRTHTIME_NS, () =>
            removeVR(treeRoot, { ...candidate, guardHash, hooks })
          )
        : removeVR(treeRoot, { ...candidate, guardHash, hooks })
    const durationMs = performance.now() - start

    const timeFieldRead = anyTimeFieldSeen(fieldLog.keysSeen)
    fieldLog.restore()

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
      extra: {
        subcase,
        guardMode,
        reuseObserved,
        timeFieldRead,
        statAtKeysSeen: [...fieldLog.keysSeen].sort(),
      },
    }
  } finally {
    fx.cleanup()
  }
}
