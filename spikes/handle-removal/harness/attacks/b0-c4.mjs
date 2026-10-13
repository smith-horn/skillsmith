// B0-C4 (SMI-6715 Step 1b part 2, design §9 "No-attack, one per filesystem"):
// guarded C4 on an UNTOUCHED tree, padded to 1,630 directories by default.
//
// WHAT IT MEASURES. The false-positive rate of the C4 repair. Nothing mutates
// the tree, so the only correct outcome is `quarantined`. A `held` means the
// post-move check (identity at the destination, or the re-hash) disagreed with
// a tree nobody touched -- e.g. a filesystem where rename(2) does not keep the
// inode or a directory's size/mode changes on a move (the host share is the
// suspect, design §4). A `kept/mount-inside-tree` means the st_dev or mountinfo
// check misfired (btrfs subvolumes, mixed-device overlayfs, design §6). Either
// one FAILS the run: result-schema.c4.mjs C4_BASELINE_ATTACKS makes
// classifyRecord fail any non-quarantined baseline record, whatever its bytes.
//
// RECORD. runC4Candidate at 'pre-call' with a no-op onFire (a clock only).
// precondition.mutationApplied is the BASELINE CONDITION, measured: the
// pristine tree hash, taken before the call, equals the caller's guard hash --
// i.e. the tree really was untouched when C4 was called. The two user files of
// the swap fixture are checked byte-exact where the outcome left the tree: the
// quarantined copy, the held copy, or the origin for kept/stopped.
//
// Control: none by design (control-spec.c4.mjs): there is no loss to
// demonstrate. C4-naive is run too (the runner runs both arms) and must also be
// quarantined every time.

import path from 'node:path'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture } from './_shared.mjs'
import { runC4Candidate } from './c4-shared.mjs'
import { computePathTreeHash } from '../../quarantine.mjs'
import {
  assertC4Candidate,
  applyDirs,
  checkEachFile,
  c4Precondition,
  c4Outcome,
  c4Extra,
  scoreLocation,
} from './c4-score.mjs'

export const id = 'B0-C4'
export const target = 30
export const DEFAULT_DIRS = 1630
export const VARIANT = 'untouched'
const FILES = { 'target/orig-f1': 'original-content-f1', 'zzz-sibling/f1': 'sibling-content' }

export function labelFor() {
  return id
}

/** Where the outcome left the tree's root. */
function treeNow(fxRoot, res) {
  const moved = res?.status === 'quarantined' || res?.status === 'held'
  return moved && typeof res.path === 'string' ? res.path : path.join(fxRoot, 'tree')
}

export function runOnce({ harnessRoot, candidate, dirs, traceDir }) {
  assertC4Candidate(candidate)
  const fx = makeFixtureRoot({ harnessRoot })
  try {
    const { treeRoot } = buildSwapFixture(fx.root)
    const wantDirs = dirs ?? DEFAULT_DIRS
    const actualDirs = applyDirs(fx.root, wantDirs)
    const pristine = computePathTreeHash(treeRoot)
    if (!pristine.ok) throw new Error(`b0-c4: pristine hash failed: ${JSON.stringify(pristine)}`)
    const start = performance.now()
    const r = runC4Candidate({
      candidate,
      parentAbs: fx.root,
      name: 'tree',
      window: 'pre-call',
      onFire: () => {},
    })
    const durationMs = performance.now() - start
    const check = checkEachFile(treeNow(fx.root, r.result), FILES)
    const untouched = pristine.treeHash === r.guardHash
    return {
      precondition: c4Precondition(r, untouched),
      outcome: c4Outcome(r, fx.root, candidate, { location: scoreLocation(r) }),
      userFiles: {
        checked: check.checked,
        lost: check.lost,
        changed: check.changed,
        // Nothing is ever "displaced" here: the files are checked where the
        // outcome put the tree, so a missing one is gone.
        displaced: 0,
        deleted: check.lost,
      },
      durationMs,
      extra: c4Extra(
        r,
        id,
        'pre-call',
        { variant: VARIANT, dirs: dirs ?? null, actualDirs, defaultDirs: DEFAULT_DIRS, untouched },
        traceDir
      ),
    }
  } finally {
    fx.cleanup()
  }
}
