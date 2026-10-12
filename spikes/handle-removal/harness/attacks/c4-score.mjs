// SMI-6715 milestone 1: scoring helpers shared by the C4 attack modules
// (a3/a4/a7/a8/a10-c4). Kept apart from c4-shared.mjs (the interposition
// driver) so no attack module depends on another.

import { lstatSync, readdirSync, readlinkSync } from 'node:fs'
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
 * userFiles with displaced/deleted. locateDisplaced counts EVERY entry it is
 * given, so it receives only the lost subset. displaced + deleted must equal
 * lost; a violation throws (the runner records it as harness-error).
 */
export function scoreUserFiles(fxRoot, check) {
  const { checked, lost, changed, lostFiles } = check
  let displaced = 0
  let deleted = 0
  if (lost > 0) ({ displaced, deleted } = locateDisplaced(fxRoot, lostFiles))
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

/**
 * Whether a symlink named `name` pointing at `linkTarget` exists anywhere under
 * <fxRoot>/.skillsmith-trash. locateDisplaced deliberately does not follow or
 * count symlinks, so a moved symlink needs this instead.
 */
export function trashHasSymlink(fxRoot, name, linkTarget) {
  const walk = (abs) => {
    let st
    try {
      st = lstatSync(abs)
    } catch (err) {
      if (err.code === 'ENOENT') return false
      throw err
    }
    if (st.isSymbolicLink()) return path.basename(abs) === name && readlinkSync(abs) === linkTarget
    if (!st.isDirectory()) return false
    return readdirSync(abs).some((n) => walk(path.join(abs, n)))
  }
  return walk(path.join(fxRoot, '.skillsmith-trash'))
}
