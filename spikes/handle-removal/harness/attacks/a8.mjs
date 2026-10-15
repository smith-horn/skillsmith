// A8 against C0: symlink swaps. Plan §5.1 row A8. Runs per cell: 30.
//   (a) 'target' (a real dir) replaced by a symlink to an outside dir,
//       before descent -- hook: after root's listing, before 'target' is
//       stat'd/descended (afterListing('')).
//   (b) 'link' (a real symlink to an outside file) replaced by a directory
//       holding user files, before its own unlink -- hook: beforeUnlink
//       ('link').
//
// Required failing control (per the plan's own F2 B measurement, macOS
// only): real `/bin/rm -r` follows a directory swapped for a symlink to an
// outside dir, deleting through it -- measured separately via
// harness/measure-rm-control.mjs, not re-run per-record here. On Linux, F2's
// own table shows GNU `rm` correctly refuses (ENOTDIR) at this timing --
// there is no real external tool that fails (a) on Linux, and this spike
// does not manufacture one; see the decision memo for how that gap is
// reported.

import { removeC0 } from '../../c0-walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSymlinkFixture, verifyOutsideIntact, verifyReplacementIntact } from './_shared.mjs'
import { rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs'

export const id = 'A8'
export const target = 30

/** @param {'a'|'b'} args.subcase */
export function runOnce({ harnessRoot, candidate, subcase }) {
  const fx = makeFixtureRoot({ harnessRoot })
  let hookFired = false
  let mutationApplied = false
  let replacementFiles = null

  try {
    const sf = buildSymlinkFixture(fx.root)
    const { treeRoot, targetAbs, linkAbs, outsideDir, outsideMarker } = sf

    const hooks =
      subcase === 'a'
        ? {
            afterListing(relPath, entries) {
              if (hookFired || relPath !== '' || !entries.some((n) => n === 'target')) return
              hookFired = true
              rmSync(targetAbs, { recursive: true, force: true })
              symlinkSync(outsideDir, targetAbs)
              mutationApplied = true
            },
          }
        : {
            beforeUnlink(relPath) {
              if (hookFired || relPath !== 'link') return
              hookFired = true
              rmSync(linkAbs, { force: true })
              mkdirSync(linkAbs)
              replacementFiles = { 'user-file.txt': `replacement-${Date.now()}-${Math.random()}` }
              writeFileSync(`${linkAbs}/user-file.txt`, replacementFiles['user-file.txt'], 'utf8')
              mutationApplied = true
            },
          }

    const start = performance.now()
    const outcome = removeC0(treeRoot, { ...candidate, hooks })
    const durationMs = performance.now() - start

    const userFiles =
      subcase === 'a'
        ? verifyOutsideIntact(outsideMarker, 'outside-content')
        : replacementFiles
          ? verifyReplacementIntact(linkAbs, replacementFiles)
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
      extra: { subcase },
    }
  } finally {
    fx.cleanup()
  }
}
