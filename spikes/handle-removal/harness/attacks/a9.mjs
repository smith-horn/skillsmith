// A9 against C0: clock attacks on the UD25 gate itself. Plan §5.1 row A9,
// hook "as A6" (betweenBindAndWalk -- before the walk begins at all).
//
// IMPORTANT, found by direct measurement before this file's first draft
// shipped: C0's threshold check only ever fires for DIRECTORIES (walkDir()'s
// own entry check) -- a per-FILE swap never reaches it at all (files are
// unlinked via a plain identity `check()` of the PARENT, never their own
// birthtime). An earlier draft of this attack swapped a FILE and always
// measured 100% loss regardless of any stub -- which proved nothing about
// the gate, only re-confirmed A7's separate, already-known finding (no
// per-file check exists). This version swaps the DIRECTORY itself, matching
// A5/A6's own technique, which is the only shape that actually reaches the
// gate.
//
//   (a) 'stub' -- the replacement DIRECTORY's reported birthtimeNs is forged
//       via fs.lstatSync monkeypatching (_shared.mjs's withStubbedBirthtime)
//       to an unambiguously old value, simulating a backward clock step.
//       Works on any filesystem/platform (pure JS-level interception).
//   (b) 'apfs-setfile' -- the replacement directory's REAL on-disk crtime is
//       set via `SetFile -d` (confirmed by direct measurement: this wraps
//       the same setattrlist(ATTR_CMN_CRTIME) syscall the plan names, at
//       1-second granularity -- a real forged crtime, not a JS-level
//       simulation). macOS/APFS only (plan: comparable macOS-only scope to
//       A9(b)); `cp -Rc` was tried first and measured to NOT preserve a
//       cloned directory's own crtime (only individual file clones do), so
//       it cannot serve as this attack's technique.
//
// Pass criterion: C0: record (the gate is exactly what this attack targets,
// so a loss here is the plan-anticipated result). Required failing control:
// "C0 under stub (a)" is this same run -- no separate control cell needed.

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import {
  buildSwapFixture,
  swapDirectorySameTick,
  verifyReplacementIntact,
  withStubbedBirthtime,
} from './_shared.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

export const id = 'A9'
export const target = 30

// Unambiguously old -- 2020-01-01, well before any threshold this process
// could plausibly establish "now".
const OLD_DATE_SETFILE = '01/01/2020 00:00:00'
const OLD_BIRTHTIME_NS = 1577836800000000000n // 2020-01-01T00:00:00Z in ns

/** @param {'stub'|'apfs-setfile'} args.subcase */
export function runOnce({ harnessRoot, candidate, subcase }) {
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

    const hooks = { betweenBindAndWalk: applyMutation }

    const start = performance.now()
    const outcome =
      subcase === 'stub'
        ? withStubbedBirthtime(fs, targetAbs, OLD_BIRTHTIME_NS, () =>
            removeC0(treeRoot, { ...candidate, hooks })
          )
        : removeC0(treeRoot, { ...candidate, hooks })
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
      },
      userFiles,
      durationMs,
      extra: { subcase, reuseObserved },
    }
  } finally {
    fx.cleanup()
  }
}
