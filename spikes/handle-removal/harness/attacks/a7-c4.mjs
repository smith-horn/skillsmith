// SMI-6715 milestone 1: A7 against C4. A leaf entry is substituted.
//   subcase 'between' -> window 'after-bind' (before C4 hashes)
//   subcase 'late'    -> window 'post-hash'   (after C4 hashed, before its re-check)
// entryKind 'file': orig-f1 deleted and recreated same-tick (swapFileSameTick).
// entryKind 'symlink': the symlink 'link' is replaced by a symlink to a
// different (dangling) target. The user entry is the substituted symlink, whose
// bytes are its target string. locateDisplaced only counts regular files and
// deliberately does not follow symlinks, so a moved symlink is located here by
// walking .skillsmith-trash for a symlink of that name and target.
//
// FOUR MORE 'late' SUBCASES (post-hash, owner-approved scope addition). Each is an
// accidental-writer edit to a file in a directory C4 has ALREADY hashed, made
// before its root-only identity re-check, so the re-check cannot see it. All use
// the user file target/orig-f1 (or a new file beside it):
//   late-renameover  an editor's atomic save: new content written to a temp file in
//                    the same directory, then renameSync'd over the leaf.
//   late-append      appendFileSync to the existing leaf (same inode, content grows).
//   late-chmod       chmodSync to a different mode, content unchanged. WHAT 'LOST'
//                    MEANS HERE: the user's state is the file's mode, and the file
//                    itself. The file missing from its original path counts as lost
//                    (displaced if found under the trash, deleted otherwise), exactly
//                    as for the other subcases; a file still at its path but with a
//                    mode other than the one the user set counts as changed.
//   late-create      a NEW user file created in the already-hashed directory.
// Each onFire proves its mutation landed (new content, mode or file present at the
// original path) before completed = true, so a mutation that did not land reads
// NEVER-RAN rather than being scored against bytes that were never written.

import {
  appendFileSync,
  chmodSync,
  lstatSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { buildSwapFixture, buildSymlinkFixture, swapFileSameTick } from './_shared.mjs'
import { runC4Candidate } from './c4-shared.mjs'
import {
  assertC4Candidate,
  checkEachFile,
  scoreUserFiles,
  c4Precondition,
  c4Outcome,
  c4Extra,
  trashHasSymlink,
  assertReplacementLanded,
  whereFor,
} from './c4-score.mjs'

export const id = 'A7-C4'
export const target = 30
export const SUBCASE_WINDOW = Object.freeze({
  between: 'after-bind',
  late: 'post-hash',
  'late-renameover': 'post-hash',
  'late-append': 'post-hash',
  'late-chmod': 'post-hash',
  'late-create': 'post-hash',
})
/** Subcases that edit orig-f1 (or add a file) instead of substituting a leaf; entryKind does not apply. */
export const EDIT_SUBCASES = Object.freeze([
  'late-renameover',
  'late-append',
  'late-chmod',
  'late-create',
])
const ORIG_CONTENT = 'original-content-f1'

/**
 * mutate / verify / score for the four edit subcases. `targetAbs` is the fixture's
 * target dir holding orig-f1.
 */
function editPlan(subcase, fxRoot, targetAbs, _test) {
  const leaf = `${targetAbs}/orig-f1`
  const stamp = `${Date.now()}-${Math.random()}`
  let files // the user files expected at their original path afterwards
  let wantMode = null
  let mutate
  if (subcase === 'late-renameover') {
    files = { 'orig-f1': `atomic-save-${stamp}` }
    mutate = () => {
      const tmp = `${targetAbs}/.orig-f1.tmp`
      writeFileSync(tmp, files['orig-f1'], 'utf8')
      renameSync(tmp, leaf)
    }
  } else if (subcase === 'late-append') {
    const suffix = `-appended-${stamp}`
    files = { 'orig-f1': ORIG_CONTENT + suffix }
    mutate = () => appendFileSync(leaf, suffix, 'utf8')
  } else if (subcase === 'late-chmod') {
    files = { 'orig-f1': ORIG_CONTENT }
    const before = statSync(leaf).mode & 0o777
    wantMode = before === 0o600 ? 0o640 : 0o600
    mutate = () => chmodSync(leaf, wantMode)
  } else {
    files = { 'new-user-file.txt': `created-${stamp}` }
    mutate = () =>
      writeFileSync(`${targetAbs}/new-user-file.txt`, files['new-user-file.txt'], 'utf8')
  }
  const verify = () => {
    assertReplacementLanded(targetAbs, files)
    if (wantMode !== null && (statSync(leaf).mode & 0o777) !== wantMode) {
      throw new Error('mutation post-condition failed: mode was not changed')
    }
  }
  const score = (r) => {
    const check = checkEachFile(targetAbs, files)
    let changed = check.changed
    if (wantMode !== null && check.lost === 0 && (statSync(leaf).mode & 0o777) !== wantMode) {
      changed += 1
    }
    return scoreUserFiles(
      fxRoot,
      { checked: check.checked, lost: check.lost, changed, lostFiles: check.lostFiles },
      whereFor(fxRoot, r, targetAbs)
    )
  }
  return { mutate: _test?.mutate ?? mutate, verify, score }
}

export function labelFor() {
  return id
}

function symlinkUserFiles(fxRoot, linkAbs, newTarget) {
  let lost = 0
  let changed = 0
  try {
    lstatSync(linkAbs)
    if (readlinkSync(linkAbs) !== newTarget) changed = 1
  } catch {
    lost = 1
  }
  const displaced = lost === 1 && trashHasSymlink(fxRoot, 'link', newTarget) ? 1 : 0
  return { checked: 1, lost, changed, displaced, deleted: lost - displaced }
}

export function runOnce({ harnessRoot, candidate, subcase, entryKind, window, _test }) {
  assertC4Candidate(candidate)
  if (!Object.hasOwn(SUBCASE_WINDOW, subcase)) {
    throw new TypeError(`subcase must be 'between' or 'late', got ${String(subcase)}`)
  }
  const isEdit = EDIT_SUBCASES.includes(subcase)
  if (!isEdit && entryKind !== 'file' && entryKind !== 'symlink') {
    throw new TypeError(`entryKind must be 'file' or 'symlink', got ${String(entryKind)}`)
  }
  const win = window === undefined ? SUBCASE_WINDOW[subcase] : window
  if (win !== SUBCASE_WINDOW[subcase]) {
    throw new TypeError(
      `subcase ${subcase} runs at ${SUBCASE_WINDOW[subcase]}, got ${String(window)}`
    )
  }

  const fx = makeFixtureRoot({ harnessRoot })
  try {
    let completed = false
    let reuseObserved = null
    const start0 = { replacementContent: null, newLinkTarget: null }
    let onFire
    let score

    if (isEdit) {
      const bf = buildSwapFixture(fx.root)
      const plan = editPlan(subcase, fx.root, bf.targetAbs, _test)
      onFire = () => {
        plan.mutate()
        plan.verify()
        completed = true
      }
      score = plan.score
    } else if (entryKind === 'symlink') {
      const sf = buildSymlinkFixture(fx.root)
      start0.newLinkTarget = `${sf.treeRoot}/../substituted-outside-marker`
      const mutate =
        _test?.mutate ??
        (() => {
          unlinkSync(sf.linkAbs)
          symlinkSync(start0.newLinkTarget, sf.linkAbs)
        })
      onFire = () => {
        mutate()
        if (readlinkSync(sf.linkAbs) !== start0.newLinkTarget) {
          throw new Error(
            'mutation post-condition failed: link does not point at the substituted target'
          )
        }
        completed = true
      }
      score = () => symlinkUserFiles(fx.root, sf.linkAbs, start0.newLinkTarget)
    } else {
      const bf = buildSwapFixture(fx.root)
      start0.replacementContent = `substituted-${Date.now()}-${Math.random()}`
      const mutate =
        _test?.mutate ??
        (() => {
          reuseObserved = swapFileSameTick(
            `${bf.targetAbs}/orig-f1`,
            start0.replacementContent
          ).reuseObserved
        })
      onFire = () => {
        mutate()
        assertReplacementLanded(bf.targetAbs, { 'orig-f1': start0.replacementContent })
        completed = true
      }
      score = (r) =>
        scoreUserFiles(
          fx.root,
          checkEachFile(bf.targetAbs, { 'orig-f1': start0.replacementContent }),
          whereFor(fx.root, r, bf.targetAbs)
        )
    }

    const start = performance.now()
    const r = runC4Candidate({ candidate, parentAbs: fx.root, name: 'tree', window: win, onFire })
    const durationMs = performance.now() - start

    return {
      precondition: c4Precondition(r, completed),
      outcome: c4Outcome(r, fx.root, candidate),
      userFiles: score(r),
      durationMs,
      extra: c4Extra(r, id, win, { subcase, entryKind: entryKind ?? null, reuseObserved }),
    }
  } finally {
    fx.cleanup()
  }
}
