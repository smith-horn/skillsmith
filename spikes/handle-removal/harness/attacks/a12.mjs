// A12 against C0: the stop rule. Plan §5.1 row A12 -- injected EBUSY at an
// inner rmdir, EACCES at an unlink (stubbed fs, per the plan's own
// language). Runs per cell: 10. Pass criterion: outcome 'stopped' with
// path/entry/errno, and nothing removed AFTER the injection point (an
// entry-level diff of before/after sets, checked here via a sibling that
// sorts strictly after the failure point).
//
// Required failing control: a walk that continues past errors, built here
// as `removeContinuingPastErrors` -- a deliberately broken variant that
// catches and ignores every removal error instead of stopping, run against
// the SAME injected-error fixture. If it does NOT keep going past the
// injected error, the fixture itself doesn't exercise what this attack
// needs, and that must be visible rather than assumed.

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { writeFileTree, injectFsErrnoOnce } from './_shared.mjs'
import fs from 'node:fs'
import path from 'node:path'

export const id = 'A12'
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

/** The required failing control: ignores every removal error and keeps going. */
export function removeContinuingPastErrors(targetRoot) {
  function walk(absPath) {
    let entries
    try {
      entries = fs.readdirSync(absPath).sort()
    } catch {
      return
    }
    for (const name of entries) {
      const childAbs = path.join(absPath, name)
      let st
      try {
        st = fs.lstatSync(childAbs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(childAbs)
        try {
          fs.rmdirSync(childAbs)
        } catch {
          /* keep going regardless */
        }
      } else {
        try {
          fs.unlinkSync(childAbs)
        } catch {
          /* keep going regardless */
        }
      }
    }
  }
  walk(targetRoot)
  try {
    fs.rmdirSync(targetRoot)
  } catch {
    /* keep going regardless */
  }
}

/** @param {'ebusy-rmdir'|'eacces-unlink'} args.subcase */
export function runOnce({ harnessRoot, candidate, subcase }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const treeRoot = buildA12Fixture(fx.root)
    const afterPath = path.join(treeRoot, 'c-after.txt')

    let inj
    if (subcase === 'ebusy-rmdir') {
      const innerDirAbs = path.join(treeRoot, 'b-inner-dir')
      inj = injectFsErrnoOnce(fs, 'rmdirSync', (args) => args[0] === innerDirAbs, 'EBUSY')
    } else {
      const failFileAbs = path.join(treeRoot, 'a-before.txt')
      inj = injectFsErrnoOnce(fs, 'unlinkSync', (args) => args[0] === failFileAbs, 'EACCES')
    }

    const start = performance.now()
    const outcome = removeC0(treeRoot, { ...candidate, hooks: {} })
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
      },
      userFiles,
      durationMs,
      extra: { subcase },
    }
  } finally {
    fx.cleanup()
  }
}

/** Runs the deliberately-broken failing control against the same injection. */
export function runControl({ harnessRoot, subcase }) {
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const treeRoot = buildA12Fixture(fx.root)
    const afterPath = path.join(treeRoot, 'c-after.txt')

    let inj
    if (subcase === 'ebusy-rmdir') {
      const innerDirAbs = path.join(treeRoot, 'b-inner-dir')
      inj = injectFsErrnoOnce(fs, 'rmdirSync', (args) => args[0] === innerDirAbs, 'EBUSY')
    } else {
      const failFileAbs = path.join(treeRoot, 'a-before.txt')
      inj = injectFsErrnoOnce(fs, 'unlinkSync', (args) => args[0] === failFileAbs, 'EACCES')
    }

    removeContinuingPastErrors(treeRoot)
    inj.restore()

    const afterSurvived = fs.existsSync(afterPath)
    return {
      precondition: { hookFired: inj.fired, mutationApplied: inj.fired, controlExpected: true },
      outcome: { status: fs.existsSync(treeRoot) ? 'stopped' : 'removed', reason: null },
      userFiles: { checked: 1, lost: afterSurvived ? 0 : 1, changed: 0 },
      durationMs: null,
      extra: { subcase },
    }
  } finally {
    fx.cleanup()
  }
}
