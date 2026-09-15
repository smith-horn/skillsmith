// Shared fixture/attack helpers for the C0 control's A3-A6 and N1 cells.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  rmSync,
  renameSync,
} from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * (dev, ino, birthtimeNs) for a path, or null if it doesn't exist. bigint
 * precision throughout, matching c0-walk.mjs's own identity source -- a
 * float birthtimeMs comparison here would be a weaker instrument than the
 * mechanism actually being tested.
 */
export function statId(absPath) {
  try {
    const st = lstatSync(absPath, { bigint: true })
    return { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs }
  } catch {
    return null
  }
}

/** Writes a flat map of {relPath: content} under `dir`, creating parents. */
export function writeFileTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
}

/**
 * Builds the standard fixture shape used by A3-A6: a tree root containing an
 * inert sibling directory (so the walk has more than one child, matching
 * "replaced dir as first entry" -- the target sorts first) and a `target`
 * directory that the attack will swap out.
 *
 *   <treeRoot>/
 *     target/        <- the directory an attack swaps
 *       orig-f1
 *     zzz-sibling/
 *       f1
 *
 * Returns absolute paths and the target's pre-swap identity.
 */
export function buildSwapFixture(root) {
  const treeRoot = path.join(root, 'tree')
  writeFileTree(treeRoot, {
    'target/orig-f1': 'original-content-f1',
    'zzz-sibling/f1': 'sibling-content',
  })
  const targetAbs = path.join(treeRoot, 'target')
  return { treeRoot, targetAbs, targetRelFromRoot: 'target' }
}

/**
 * Deletes `targetAbs` and immediately recreates it with fresh "replacement"
 * (would-be-user) content, as fast as fully-synchronous Node calls allow --
 * this is what the plan calls "same-tick": no scheduling gap, just the
 * fastest sequence of syscalls this process can issue. Returns whether the
 * OS reused the directory's (dev, ino) -- and, incidentally, whether it also
 * reused/collided the birthtime, which is the E47 phenomenon the UD25 gate
 * exists to catch.
 */
export function swapDirectorySameTick(targetAbs, replacementFiles) {
  const before = statId(targetAbs)
  rmSync(targetAbs, { recursive: true, force: true })
  mkdirSync(targetAbs)
  writeFileTree(targetAbs, replacementFiles)
  const after = statId(targetAbs)
  const reuseObserved = !!(before && after && before.dev === after.dev && before.ino === after.ino)
  const birthtimeReused = !!(
    before &&
    after &&
    before.birthtimeNs === after.birthtimeNs &&
    before.birthtimeNs != null
  )
  return { reuseObserved, birthtimeReused, before, after }
}

/**
 * Renames `targetAbs` aside (simulating "renamed aside and replaced" -- A3),
 * then creates a fresh replacement directory at the original path with new
 * content. Unlike swapDirectorySameTick, this does not delete first, so it
 * does not depend on inode reuse at all -- a plain identity check should
 * already catch it.
 */
export function renameAsideAndReplace(targetAbs, replacementFiles) {
  const asideName = `${targetAbs}.aside-${crypto.randomBytes(4).toString('hex')}`
  renameSync(targetAbs, asideName)
  mkdirSync(targetAbs)
  writeFileTree(targetAbs, replacementFiles)
  return { asideName }
}

/**
 * Verifies that every file in `expectedFiles` (relPath -> expected content,
 * relative to `dir`) is still present unchanged. Returns the §9 userFiles
 * shape: {checked, lost, changed}.
 */
export function verifyReplacementIntact(dir, expectedFiles) {
  let lost = 0
  let changed = 0
  const checked = Object.keys(expectedFiles).length
  for (const [rel, expected] of Object.entries(expectedFiles)) {
    const abs = path.join(dir, rel)
    if (!existsSync(abs)) {
      lost += 1
      continue
    }
    const actual = readFileSync(abs, 'utf8')
    if (actual !== expected) {
      changed += 1
    }
  }
  return { checked, lost, changed }
}

export function randomToken() {
  return crypto.randomBytes(6).toString('hex')
}
