// A1 against C4 (quarantineTree): a mount over tree/target that exists BEFORE
// the caller computes its guard hash. Linux, privileged container only (real
// mount/umount, see mount-shared.mjs) -- never run outside a throwaway one.
//
// Subcases: 'bind' (a directory holding a user file, bind-mounted over target)
// and 'tmpfs' (a tmpfs over target with a user file written after mounting).
// Window 'pre-call': the mount is made before runC4Candidate, so the caller
// hash already walks the mounted content; runC4Candidate's own onFire is a
// no-op used only as the trace clock. precondition.mutationApplied is the
// strict boolean "isMounted(target) was true before the call".
//
// SCORING (owner decision 2: displacement = failure). The user file is read at
// its ORIGINAL path after the call. If it is not there it counts as lost, and
// locateDisplaced classifies it as displaced (found under .skillsmith-trash:
// recoverable) or deleted (found nowhere). The scoring happens while any mount
// is still attached, because a mount that followed the moved tree is what
// makes the displaced copy findable.
//
// CLEANUP. Every mount under the fixture root is found from /proc/mounts (it
// may have moved into the trash) and unmounted in `finally`, deepest first,
// whether or not the call succeeded. Fixture removal is skipped, and the run
// fails loudly, if a mount cannot be detached: removing a tree through a live
// bind mount would delete the bind source.
//
// This module also exports runMountCase, shared with a2-c4.mjs (only these
// three files may be created, so the shared body lives here).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { runC4Candidate, locateDisplaced } from './c4-shared.mjs'
import { makeFixtureRoot } from '../fixture-root.mjs'
import { scanQuarantineLeftovers } from '../result-schema.mjs'
import { bindMount, tmpfsMount, isMounted, buildMountFixture } from './mount-shared.mjs'

export const id = 'A1-C4'
export const target = 10

const CANDIDATES = new Set(['C4', 'C4-naive'])
const SUBCASES = new Set(['bind', 'tmpfs'])
const USER_FILE = 'mounted-user.txt'

/** /proc/mounts escapes space, tab, newline and backslash as octal. */
function unescapeMountPath(p) {
  return p.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8)))
}

/** Mount points at or below `root`, deepest first. */
export function mountsUnder(root) {
  let text
  try {
    text = fs.readFileSync('/proc/mounts', 'utf8')
  } catch {
    return null
  }
  const out = []
  for (const line of text.split('\n')) {
    const field = line.split(' ')[1]
    if (field === undefined) continue
    const mp = unescapeMountPath(field)
    if (mp === root || mp.startsWith(`${root}/`)) out.push(mp)
  }
  return out.sort((a, b) => b.length - a.length)
}

/** Umounts everything under `root`; reports what happened. Never throws. */
function detachAll(root) {
  const first = mountsUnder(root)
  const report = {
    found: first === null ? null : first.length,
    umounted: 0,
    failed: [],
    lazyUsed: 0,
  }
  if (first === null) return { ...report, remaining: null }
  for (const mp of first) {
    try {
      execFileSync('umount', [mp], { stdio: 'pipe' })
      report.umounted += 1
    } catch (err) {
      report.failed.push({ mp, err: String(err.message).slice(0, 160) })
      try {
        execFileSync('umount', ['-l', mp], { stdio: 'pipe' })
        report.lazyUsed += 1
      } catch {
        /* reported through `remaining` below */
      }
    }
  }
  const left = mountsUnder(root)
  return { ...report, remaining: left === null ? null : left.length }
}

function readUserFile(p) {
  try {
    return { exists: true, content: fs.readFileSync(p, 'utf8') }
  } catch {
    return { exists: false, content: null }
  }
}

/**
 * @param {object} args
 * @param {string} args.harnessRoot
 * @param {'C4'|'C4-naive'} args.candidate
 * @param {'bind'|'tmpfs'} args.subcase
 * @param {'pre-call'|'after-bind'} args.window - 'pre-call': mount first;
 *   otherwise the mount is made inside onFire at that window.
 */
export function runMountCase({ harnessRoot, candidate, subcase, window, _test }) {
  if (!CANDIDATES.has(candidate)) throw new TypeError(`a1/a2-c4: unknown candidate ${candidate}`)
  if (!SUBCASES.has(subcase)) throw new TypeError(`a1/a2-c4: unknown subcase ${subcase}`)
  if (process.platform !== 'linux') throw new Error('a1/a2-c4: Linux only (real mount/umount)')
  const fx = makeFixtureRoot({ harnessRoot })
  let detach = null
  let ret
  let bodyFailed = false
  let bodyError
  let remainingAfter = null
  let cleanupFailed = false
  let cleanupError
  // `_test` is a selftest seam only (doMount / detachAll / cleanup replacements).
  const detachFn = _test?.detachAll ?? detachAll
  try {
    const { targetAbs, mountSourceDir } = buildMountFixture(fx.root)
    const userContent = `user-${crypto.randomBytes(8).toString('hex')}`
    const opId = `c4-${crypto.randomBytes(6).toString('hex')}`

    const realMount = () => {
      if (subcase === 'bind') {
        fs.writeFileSync(path.join(mountSourceDir, USER_FILE), userContent)
        bindMount(mountSourceDir, targetAbs)
      } else {
        tmpfsMount(targetAbs, 4)
        fs.writeFileSync(path.join(targetAbs, USER_FILE), userContent)
      }
    }

    const doMount = _test?.doMount ?? realMount
    let mountedBeforeCall = false
    let mountedInHook = false
    if (window === 'pre-call') {
      doMount()
      mountedBeforeCall = isMounted(targetAbs) === true
    }
    const onFire =
      window === 'pre-call'
        ? () => {}
        : () => {
            doMount()
            mountedInHook = isMounted(targetAbs) === true
          }

    const start = performance.now()
    const r = runC4Candidate({
      candidate,
      parentAbs: fx.root,
      name: 'tree',
      window,
      onFire,
      opId,
    })
    const durationMs = performance.now() - start

    const originalFile = path.join(targetAbs, USER_FILE)
    const got = readUserFile(originalFile)
    const lost = got.exists ? 0 : 1
    const changed = got.exists && got.content !== userContent ? 1 : 0
    let displaced = 0
    let deleted = 0
    let displacedPaths = []
    if (lost) {
      const loc = locateDisplaced(fx.root, { [USER_FILE]: userContent })
      displaced = loc.displaced
      deleted = loc.deleted
      displacedPaths = loc.displacedPaths
    }
    if (displaced + deleted !== lost) {
      throw new Error(`a1/a2-c4: displaced(${displaced}) + deleted(${deleted}) != lost(${lost})`)
    }
    const userFiles = { checked: 1, lost, changed, displaced, deleted }

    const status = r.result?.status
    const quarantineLeft = scanQuarantineLeftovers(fx.root, candidate, { status, opId })
    const mountsAtScore = mountsUnder(fx.root)
    const stillMountedAtOriginal = isMounted(targetAbs) === true

    // Detach inside the try so the result carries it; `finally` repeats it as a
    // backstop if anything above threw.
    detach = detachFn(fx.root)

    const mutationApplied =
      window === 'pre-call' ? mountedBeforeCall : mountedInHook && r.onFireInvoked === true
    ret = {
      precondition: {
        hookFired: r.hookFired === true,
        mutationApplied: mutationApplied === true,
        traceMatched: r.traceMatched === true,
        controlExpected: true,
      },
      outcome: {
        status: r.traceMatched === true ? status : 'harness-error',
        reason: r.result?.reason ?? null,
        path: r.result?.path ?? null,
        entry: r.result?.entry ?? null,
        errno: r.result?.errno ?? null,
        quarantineLeft,
      },
      userFiles,
      durationMs,
      extra: {
        subcase,
        window,
        candidate,
        firedAt: r.firedAt ?? null,
        trace: r.trace,
        renameBusy: r.result?.errno === 'EBUSY' || /EBUSY/.test(String(r.result?.reason ?? '')),
        mountSurvivedAtOriginalPath: stillMountedAtOriginal,
        mountsAtScore,
        displacedPaths,
        mutationError: r.mutationError ?? null,
        umount: detach,
        umountOk: detach.remaining === 0 && detach.failed.length === 0,
      },
    }
  } catch (err) {
    // A flag, not a null check: `throw null` must not read as success.
    bodyFailed = true
    bodyError = err
  } finally {
    const again = detach ?? detachFn(fx.root)
    if (again.remaining === 0) {
      // Caught, not thrown: a throw inside `finally` replaces the error already
      // in flight. It is rethrown below, after the body error is in hand.
      try {
        if (_test?.cleanup) _test.cleanup(fx)
        else fx.cleanup()
      } catch (err) {
        cleanupFailed = true
        cleanupError = err
      }
    } else remainingAfter = again
  }
  // Thrown AFTER the finally, not inside it: a throw inside `finally` replaces
  // an error already in flight, so a failed run plus a surviving mount used to
  // report only the mount and lose why the run failed.
  if (remainingAfter !== null) {
    throw new Error(
      `a1/a2-c4: mounts remain under ${fx.root} after umount (${JSON.stringify(remainingAfter)}); fixture NOT removed`,
      { cause: bodyFailed ? bodyError : undefined }
    )
  }
  if (cleanupFailed) {
    throw new Error(
      `a1/a2-c4: fixture cleanup failed under ${fx.root}: ${cleanupError?.message ?? String(cleanupError)}`,
      { cause: bodyFailed ? bodyError : cleanupError }
    )
  }
  if (bodyFailed) throw bodyError
  return ret
}

export function runOnce({ harnessRoot, candidate, subcase }) {
  return runMountCase({ harnessRoot, candidate, subcase, window: 'pre-call' })
}
