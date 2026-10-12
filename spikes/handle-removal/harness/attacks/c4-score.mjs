// SMI-6715 milestone 1: scoring helpers shared by the C4 attack modules
// (a3/a4/a7/a8/a10-c4). Kept apart from c4-shared.mjs (the interposition
// driver) so no attack module depends on another.

import { lstatSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { verifyReplacementIntact } from './_shared.mjs'
import { locateDisplaced } from './c4-shared.mjs'

/** Primitive string only: a `new String('C4')` is typeof 'object' and is rejected. */
export function assertC4Candidate(candidate) {
  if (typeof candidate !== 'string' || (candidate !== 'C4' && candidate !== 'C4-naive')) {
    throw new TypeError(`candidate must be the string 'C4' or 'C4-naive', got ${String(candidate)}`)
  }
}

/** `window` defaults to `allowed[0]`; anything else must be in `allowed`. */
export function resolveWindow(window, allowed) {
  const w = window === undefined ? allowed[0] : window
  if (typeof w !== 'string' || !allowed.includes(w)) {
    throw new TypeError(`window must be one of ${allowed.join(', ')}, got ${String(window)}`)
  }
  return w
}

/**
 * Per-file verifyReplacementIntact so the LOST subset is known by name (the
 * aggregate call returns counts only). Returns the userFiles counts plus
 * `lostFiles` ({rel: content} of the lost entries only).
 */
export function checkEachFile(dir, files) {
  let lost = 0
  let changed = 0
  const lostFiles = {}
  for (const [rel, content] of Object.entries(files)) {
    const one = verifyReplacementIntact(dir, { [rel]: content })
    lost += one.lost
    changed += one.changed
    if (one.lost > 0) lostFiles[rel] = content
  }
  return { checked: Object.keys(files).length, lost, changed, lostFiles }
}

/**
 * The `where` argument locateDisplaced requires: displacement is proven against
 * THIS run's destination only. `r` is runC4Candidate's return; `baseDir` is what
 * the keys of the lost files are relative to. The tree being removed is always
 * <fxRoot>/tree in these attacks.
 */
export function whereFor(fxRoot, r, baseDir) {
  const res = r.result
  const destination =
    res?.status === 'quarantined' && typeof res.path === 'string' ? res.path : null
  return { destination, originRoot: path.join(fxRoot, 'tree'), baseDir }
}

/**
 * userFiles with displaced/deleted. locateDisplaced counts EVERY entry it is
 * given, so it receives only the lost subset. displaced + deleted must equal
 * lost; a violation throws (the runner records it as harness-error).
 */
export function scoreUserFiles(fxRoot, check, where) {
  const { checked, lost, changed, lostFiles } = check
  let displaced = 0
  let deleted = 0
  if (lost > 0) ({ displaced, deleted } = locateDisplaced(fxRoot, lostFiles, where))
  if (displaced + deleted !== lost) {
    throw new Error(`displaced(${displaced}) + deleted(${deleted}) !== lost(${lost})`)
  }
  return { checked, lost, changed, displaced, deleted }
}

/**
 * Post-condition for a mutation that writes replacement files: every file must
 * be present at `dir` with exactly the intended content. Throws otherwise, so a
 * mutation that did not land is recorded as mutationApplied:false (never-ran)
 * instead of being scored against bytes that were never written.
 */
export function assertReplacementLanded(dir, files) {
  const v = verifyReplacementIntact(dir, files)
  if (v.lost !== 0 || v.changed !== 0) {
    throw new Error(
      `mutation post-condition failed: replacement not present at ${dir} (lost=${v.lost} changed=${v.changed})`
    )
  }
}

export function c4Precondition(r, mutationCompleted) {
  return {
    hookFired: r.hookFired === true,
    mutationApplied: mutationCompleted === true && r.mutationError === null,
    traceMatched: r.traceMatched === true,
    controlExpected: true,
  }
}

export function c4Outcome(r, fxRoot, candidate) {
  const res = r.result ?? {}
  return {
    status: res.status,
    reason: res.reason,
    path: res.path,
    errno: res.errno,
    opId: r.opId,
    quarantineLeft: scanQuarantineLeftovers(fxRoot, candidate, {
      status: res.status,
      opId: r.opId,
    }),
  }
}

/** `more` is always a plain object literal built by the caller (shape-safe spread). */
export function c4Extra(r, label, window, more) {
  return {
    label,
    window,
    trace: r.trace,
    firedAt: r.firedAt,
    times: r.times,
    guardHash: r.guardHash,
    opId: r.opId,
    onFireInvoked: r.onFireInvoked,
    mutationError: r.mutationError,
    ...more,
  }
}

const isInsideDir = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Whether the symlink that was at `originalAbs` (pointing at `linkTarget`) is now at
 * the matching place inside THIS run's destination. Same confinement as
 * locateDisplaced (c4-displaced.mjs): only the run's own destination is searched
 * (null when nothing moved), the destination must lie inside <fxRoot>/.skillsmith-trash,
 * and every directory down to the link must be a real directory. A stale link left
 * by another operation is therefore never counted.
 *
 * @param {string} fxRoot
 * @param {string} originalAbs - where the link was, inside originRoot
 * @param {string} linkTarget - the link text expected
 * @param {{destination:string|null, originRoot:string}} where - as whereFor() builds
 */
export function trashHasSymlink(fxRoot, originalAbs, linkTarget, where) {
  const { destination, originRoot } = where
  if (destination === null) return false
  const trashRoot = path.resolve(fxRoot, '.skillsmith-trash')
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
    throw new TypeError(
      `trashHasSymlink: destination must be an absolute path or null, got ${String(destination)}`
    )
  }
  if (!isInsideDir(path.resolve(destination), trashRoot)) {
    throw new TypeError(`trashHasSymlink: destination ${destination} is not inside ${trashRoot}`)
  }
  const rel = path.relative(path.resolve(originRoot), path.resolve(originalAbs))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
  let cur = path.resolve(destination)
  for (const part of rel.split(path.sep)) {
    let st
    try {
      st = lstatSync(cur)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false
      throw err
    }
    if (!st.isDirectory()) return false
    cur = path.join(cur, part)
  }
  try {
    return lstatSync(cur).isSymbolicLink() && readlinkSync(cur) === linkTarget
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false
    throw err
  }
}

/** Directories in `root`'s subtree, root included; symlinks are not followed. */
export function countDirs(root) {
  let n = 1
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) n += countDirs(path.join(root, e.name))
  }
  return n
}

/**
 * STEP-1 scale option: pads `treeRoot` with directories (one small file each), under
 * a separate `zz-pad` subtree so no attacked path changes, until the tree holds exactly
 * `n` directories counted from the root. Shape follows buildTree in
 * measure-c4-guard-window.mjs (32-wide fan-out). Returns the measured count.
 */
export function padTree(treeRoot, n) {
  const existing = countDirs(treeRoot)
  if (n < existing) throw new Error(`--dirs ${n} is below the fixture minimum of ${existing}`)
  const extra = n - existing
  if (extra > 0) {
    const root = path.join(treeRoot, 'zz-pad')
    mkdirSync(root)
    writeFileSync(path.join(root, 'f.txt'), 'x')
    let made = 1
    let level = [root]
    while (made < extra) {
      const next = []
      for (const parent of level) {
        for (let i = 0; i < 32 && made < extra; i += 1) {
          const d = path.join(parent, `d${i}`)
          mkdirSync(d)
          writeFileSync(path.join(d, 'f.txt'), 'x')
          next.push(d)
          made += 1
        }
        if (made >= extra) break
      }
      level = next
    }
  }
  const actual = countDirs(treeRoot)
  if (actual !== n) throw new Error(`padTree: asked for ${n} directories, built ${actual}`)
  return actual
}

/** padTree on <fxRoot>/tree when `dirs` is set; null when no padding was requested. */
export function applyDirs(fxRoot, dirs) {
  return dirs === undefined || dirs === null ? null : padTree(path.join(fxRoot, 'tree'), dirs)
}
