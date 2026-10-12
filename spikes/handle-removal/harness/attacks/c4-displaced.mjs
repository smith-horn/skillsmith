// SMI-6715: displaced-vs-deleted classification for C4 user files.
// Split out of c4-shared.mjs (file-length limit); re-exported from there, so
// `import { locateDisplaced } from './c4-shared.mjs'` keeps working.
//
// R1-F5 (GPT-5.6-Sol review, round 1): the first version matched by CONTENT
// ANYWHERE under <fxRoot>/.skillsmith-trash. An identical stale file left by a
// different operation therefore turned a genuinely deleted file into
// "displaced". That never flipped a FAIL to a PASS (lost stays non-zero), but
// it corrupted the displaced/deleted evidence the D2 decision rests on.
//
// Now displacement is proven against THIS run's destination only, and the
// relative path, the type (regular file, reached through real directories)
// and the content must all agree.

import fs from 'node:fs'
import path from 'node:path'

const LOCATE_MAX_PATHS = 8

const isInside = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** lstat that returns null on ENOENT/ENOTDIR and rethrows anything else. */
function lstatOrNull(abs) {
  try {
    return fs.lstatSync(abs)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw err
  }
}

/**
 * Whether `candidate` (inside `destination`) is a regular file whose every
 * ancestor from `destination` down is a real directory -- never a symlink. A
 * symlinked component would let the lookup reach bytes OUTSIDE the quarantined
 * tree (A8a: target -> outside dir) and misreport them as displaced.
 */
function regularFileThroughRealDirs(destination, candidate) {
  const parts = path.relative(destination, candidate).split(path.sep)
  let cur = destination
  const top = lstatOrNull(cur)
  if (!top || !top.isDirectory()) return false
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i])
    const st = lstatOrNull(cur)
    if (!st) return false
    const last = i === parts.length - 1
    if (last ? !st.isFile() : !st.isDirectory()) return false
  }
  return true
}

/**
 * Classifies user files that are no longer intact at their original path.
 * EVERY entry of `expectedFiles` is classified -- pass only the lost (and
 * changed) subset; an intact file passed here would count as `deleted`.
 *
 * An entry is DISPLACED only when, at the place the quarantine rename would
 * have carried it, there is a regular file (reached through real directories)
 * with exactly the expected content. Otherwise it is DELETED.
 *
 * @param {string} fxRoot - absolute; the fixture root holding .skillsmith-trash
 * @param {Record<string,string>} expectedFiles - {rel: content}, rel to `baseDir`
 * @param {object} where - REQUIRED
 * @param {string|null} where.destination - REQUIRED: the quarantined path this
 *   run returned (result.path), which must lie inside <fxRoot>/.skillsmith-trash;
 *   or null when the run moved nothing, in which case every entry is deleted.
 * @param {string} where.originRoot - absolute: the tree's path BEFORE the move
 *   (what `destination` used to be called). Required when destination is set.
 * @param {string} [where.baseDir] - absolute: what the keys of expectedFiles are
 *   relative to. Defaults to originRoot. An entry outside originRoot cannot have
 *   been moved by this rename and is counted deleted without a lookup.
 * @returns {{displaced:number, deleted:number, displacedPaths:string[]}}
 */
export function locateDisplaced(fxRoot, expectedFiles, where) {
  if (typeof fxRoot !== 'string' || !path.isAbsolute(fxRoot)) {
    throw new TypeError(
      `locateDisplaced: fxRoot must be an absolute path string, got ${String(fxRoot)}`
    )
  }
  if (expectedFiles === null || typeof expectedFiles !== 'object') {
    throw new TypeError('locateDisplaced: expectedFiles must be an object of {relName: content}')
  }
  if (where === null || typeof where !== 'object') {
    throw new TypeError(
      'locateDisplaced: third argument {destination, originRoot, baseDir?} is required; ' +
        'destination is result.path for a quarantined run, or null'
    )
  }
  // One read of each property.
  const { destination, originRoot, baseDir: rawBase } = where
  const wanted = Object.entries(expectedFiles)
  for (const [rel, content] of wanted) {
    if (typeof content !== 'string') {
      throw new TypeError(`locateDisplaced: content for ${JSON.stringify(rel)} must be a string`)
    }
  }
  if (destination === null) {
    return { displaced: 0, deleted: wanted.length, displacedPaths: [] }
  }
  const trashRoot = path.resolve(fxRoot, '.skillsmith-trash')
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
    throw new TypeError(
      `locateDisplaced: destination must be an absolute path or null (required), got ${String(destination)}`
    )
  }
  if (!isInside(path.resolve(destination), trashRoot)) {
    throw new TypeError(`locateDisplaced: destination ${destination} is not inside ${trashRoot}`)
  }
  if (typeof originRoot !== 'string' || !path.isAbsolute(originRoot)) {
    throw new TypeError(
      `locateDisplaced: originRoot must be an absolute path string, got ${String(originRoot)}`
    )
  }
  const baseDir = rawBase === undefined ? originRoot : rawBase
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) {
    throw new TypeError(
      `locateDisplaced: baseDir must be an absolute path string, got ${String(baseDir)}`
    )
  }

  const dest = path.resolve(destination)
  let displaced = 0
  let deleted = 0
  const displacedPaths = []
  for (const [rel, content] of wanted) {
    const original = path.resolve(baseDir, rel)
    if (!isInside(original, path.resolve(originRoot))) {
      deleted += 1
      continue
    }
    const candidate = path.join(dest, path.relative(path.resolve(originRoot), original))
    const hit =
      regularFileThroughRealDirs(dest, candidate) && fs.readFileSync(candidate, 'utf8') === content
    if (hit) {
      displaced += 1
      if (displacedPaths.length < LOCATE_MAX_PATHS)
        displacedPaths.push(path.relative(fxRoot, candidate))
    } else {
      deleted += 1
    }
  }
  return { displaced, deleted, displacedPaths }
}
