// A8 against VR: symlink swaps, VR timing. Plan §5.1 row A8. Runs per
// cell: 30.
//   (a) 'target' replaced by a symlink to an outside dir, before it is
//       opened by the guard pass -- hook: afterListing('') (guard pass has
//       listed the root, 'target' not yet openAt'd; same moment A3-VR/A6-VR
//       'inner' fire at).
//   (b) 'link' (a real symlink) replaced by a directory with user files,
//       right before its own removal action -- hook: beforeUnlink('link').
//
// V0/V1/V2 all share C1's openAt(O_NOFOLLOW) -- (a) is expected to pass for
// every variant regardless of identity/content checking, since the shim
// refuses to open a symlink as a directory unconditionally. (b) is expected
// to separate V0 from V1/V2: V0 has no type check on what it names-and-
// unlinks; V1/V2 both re-verify identity (V1) or identity+content (V2)
// against the ORIGINAL symlink's recorded record before acting, and that
// record's `type` is 'symlink' while the swapped-in thing now on disk is a
// directory -- required failing control per plan §5.1 A8's row (V0 is
// expected to fail here, the same pattern as A7).

import { removeVR } from '../../walk.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { buildSymlinkFixture, verifyOutsideIntact, verifyReplacementIntact } from './_shared.mjs'
import { rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs'

export const id = 'A8-VR'
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
              if (hookFired || relPath !== '' || !entries.some((e) => e.name === 'target')) return
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
    const outcome = removeVR(treeRoot, { ...candidate, hooks })
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
