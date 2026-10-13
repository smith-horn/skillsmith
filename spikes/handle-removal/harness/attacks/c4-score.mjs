// SMI-6715 milestone 1: scoring helpers shared by the C4 attack modules
// (a3/a4/a7/a8/a10-c4). Kept apart from c4-shared.mjs (the interposition
// driver) so no attack module depends on another.

import { lstatSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { verifyHeldSidecar } from '../result-schema.c4.mjs'
import { verifyReplacementIntact } from './_shared.mjs'
import { locateDisplaced } from './c4-shared.mjs'
import { compactTrace } from './c4-trace-match.mjs'
import { writeTraceArtifact, assertCompactMatchesArtifact } from './c4-trace-store.mjs'

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
  // SMI-6715 Step 1b part 2: a `held` run's tree is whole at result.path too, so
  // that is its destination; otherwise its moved bytes would read `deleted`.
  const moved = res?.status === 'quarantined' || res?.status === 'held'
  const destination = moved && typeof res.path === 'string' ? res.path : null
  return { destination, originRoot: path.join(fxRoot, 'tree'), baseDir }
}

/**
 * Where a run's user files are SCORED (SMI-6715 Step 1b part 2; design §9 item
 * 3): for a `held` result the held copy is the location of record, so `absPath`
 * (a path inside <fxRoot>/tree) is mapped to the same relative path inside
 * result.path; for every other outcome it is returned unchanged. A held result
 * without a string path, or a path outside the tree, throws (the runner records
 * a harness-error rather than scoring the wrong place).
 */
export function scoringDir(fxRoot, r, absPath) {
  const res = r.result
  if (res?.status !== 'held') return absPath
  const rel = path.relative(path.join(fxRoot, 'tree'), absPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new TypeError(`scoringDir: ${absPath} is not inside ${path.join(fxRoot, 'tree')}`)
  }
  if (typeof res.path !== 'string') throw new TypeError('scoringDir: held result has no path')
  return path.join(res.path, rel)
}

/** The scoring location scoringDir chose: 'held-copy' for a held result, else 'origin'. */
export const scoreLocation = (r) => (r.result?.status === 'held' ? 'held-copy' : 'origin')

/**
 * The evidence the strict held predicate reads (result-schema.c4.mjs
 * c4HeldClass), or undefined for a non-held result. `location` must be what the
 * module actually scored against (scoreLocation when it used scoringDir);
 * omitted, it reads 'origin' and the predicate fails closed.
 */
export function heldEvidenceOf(
  r,
  { location = 'origin', originRecreated = false, originIntact = null } = {}
) {
  if (r.result?.status !== 'held') return undefined
  return {
    location,
    sidecarVerified: verifyHeldSidecar(r.result).ok,
    originRecreated,
    originIntact,
  }
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

export function c4Outcome(r, fxRoot, candidate, held) {
  const res = r.result ?? {}
  const heldEvidence = heldEvidenceOf(r, held)
  return {
    status: res.status,
    reason: res.reason,
    path: res.path,
    errno: res.errno,
    opId: r.opId,
    ...(heldEvidence === undefined ? {} : { heldEvidence }),
    quarantineLeft: scanQuarantineLeftovers(fxRoot, candidate, {
      status: res.status,
      opId: r.opId,
      heldPath: res.heldPath ?? null,
      originPath: res.originPath ?? null,
      sidecarPath: res.sidecarPath ?? null,
    }),
  }
}

/**
 * The trace evidence for one record: the compact summary always, and -- when
 * `traceDir` (absolute) is given -- the FULL trace kept as a Brotli side file named
 * by `traceArtifact`. The compact summary alone would not let a matched verdict be
 * re-audited.
 *
 * It does NOT throw on a write or verify failure: by this point the run's loss has
 * been measured, and throwing would make the runner replace the scored record with a
 * blank one (a FAIL turned NEVER-RAN). The failure is returned as `harnessErrors`
 * with no `traceArtifact`; the runner then marks the record harness-error while
 * keeping what it measured (c4-trace-check.mjs).
 */
export function keepTrace(r, traceDir) {
  // A full trace is ~3.4 MB per record at 1630 directories. The compact summary keeps
  // the evidence: the full trace survives inside it unless traceMatched is true.
  const traceCompact = compactTrace(r.trace, { traceMatched: r.traceMatched })
  if (traceDir === undefined) return { traceCompact }
  try {
    const ref = writeTraceArtifact(r.trace, { dir: traceDir })
    assertCompactMatchesArtifact(traceCompact, ref)
    return { traceCompact, traceArtifact: { sha256: ref.sha256, path: ref.path } }
  } catch (err) {
    return { traceCompact, harnessErrors: [`trace artifact not kept: ${err.message}`] }
  }
}

/** `more` is always a plain object literal built by the caller (shape-safe spread). */
export function c4Extra(r, label, window, more, traceDir) {
  return {
    label,
    window,
    ...keepTrace(r, traceDir),
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
