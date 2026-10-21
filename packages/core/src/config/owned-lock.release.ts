/**
 * Guarded release of a MAIN owned lock (SMI-7148).
 * @module @skillsmith/core/config/owned-lock.release
 * @see owned-lock.ts for the full soundness argument.
 * @see owned-lock.claim.ts for `releaseClaimFile`, the unguarded release of a
 * claim file, which this module wraps.
 *
 * INTERNAL module -- not part of the public surface. Co-located tests import
 * from here by relative path.
 *
 * Why release takes `<lock>.reclaim`: ownership is decided by reading the
 * claim, and the lock is removed by unlinking its path. Between the two, a
 * reclaimer that judged this holder dead (its pid seen from another PID
 * namespace, or `doctor locks --release --unsafe-unverified-owner`) can remove
 * the lock and a third process can create its own at the same path, which the
 * unlink then destroys. And while `doctor locks` has a newer lock moved
 * aside, a holder releasing finds the path empty, reports itself released, and
 * the lock is then put back with nobody left to release it. Every actor that
 * can remove or replace the inode at the path holds `<lock>.reclaim`
 * (reclaim's unlink, doctor's rename and link back), so holding it across the
 * read and the unlink closes both windows. An acquire only creates the lock at
 * an empty path and takes no `.reclaim`.
 *
 * Every verdict, `absent` included, is reached only under `.reclaim`: reading
 * the claim first and returning early on "absent" is exactly the doctor window.
 *
 * If `.reclaim` cannot be taken, nothing is removed and the answer is `false`
 * (the contract for "the file may still be ours"): a leftover `.reclaim` is
 * never taken over, dead owner or not, and a failure to create it never falls
 * back to an unguarded delete.
 */

import { hostname } from 'node:os'
import { dirname } from 'node:path'

import {
  createLockExclusive,
  randomHex,
  releaseClaimFile,
  sleepSync,
  toTimingMs,
} from './owned-lock.claim.js'
import { thrownCode, thrownText } from './owned-lock.errors.js'
import { stateRootLockPaths } from './lock-doctor.js'
import { LOCK_RETRY_DELAY_MS, RECLAIM_LOCK_TIMEOUT_MS } from './owned-lock.types.js'
import { warnSafely } from '../utils/warn-safely.js'

export interface ReleaseOwnedOptions {
  /** @internal Test seam: max wait for `<path>.reclaim` (ms). Default RECLAIM_LOCK_TIMEOUT_MS. 0 means one try. */
  reclaimLockTimeoutMs?: number
}

/**
 * How to clear an orphaned `.reclaim`. `skillsmith doctor locks --release` only
 * accepts the locks `stateRootLockPaths` lists, so it is named only for those
 * (same source of truth); any other lock gets hand removal.
 */
function reclaimRemedy(reclaimPath: string): string {
  const root = dirname(reclaimPath)
  if (stateRootLockPaths(root).includes(reclaimPath)) {
    return (
      'If no Skillsmith process is mid-way, remove the reclaim lock with ' +
      `\`skillsmith doctor locks --state-root ${root} --release ${reclaimPath}\` or by hand.`
    )
  }
  return `Check that no Skillsmith process is running, then remove ${reclaimPath} by hand.`
}

/**
 * Release the main lock at `path` if `token` still owns it, holding
 * `<path>.reclaim` across the ownership check and the unlink. Returns what
 * {@link releaseClaimFile} returns for the lock, or `false` when `.reclaim`
 * could not be taken (nothing removed, a warning names why). Never throws: it
 * runs in a `finally` (SMI-7143).
 */
export function releaseOwned(path: string, token: string, opts: ReleaseOwnedOptions = {}): boolean {
  try {
    return releaseOwnedChecked(path, token, opts)
  } catch (err) {
    // Anything unexpected (setup, the wait, a throw nothing below contains):
    // never escapes into the caller's `finally`; the lock may still be ours.
    warnSafely(
      `[skillsmith] lock_release_failed: releasing ${path} threw (${thrownText(err)}). ` +
        `Not removing ${path}; it stays held by this process until it exits.`
    )
    return false
  }
}

function releaseOwnedChecked(path: string, token: string, opts: ReleaseOwnedOptions): boolean {
  const reclaimPath = `${path}.reclaim`
  const rToken = randomHex(8)
  const rRecord =
    JSON.stringify({
      v: 1,
      pid: process.pid,
      token: rToken,
      host: hostname(),
      acquiredAt: Date.now(),
    }) + '\n'
  const waitMs = toTimingMs(opts.reclaimLockTimeoutMs, RECLAIM_LOCK_TIMEOUT_MS)
  const deadline = Date.now() + waitMs
  for (;;) {
    let taken: boolean
    try {
      taken = createLockExclusive(reclaimPath, rRecord)
    } catch (err) {
      const code = thrownCode(err)
      // ENOENT/ENOTDIR: the lock's folder is gone, so there is no lock to keep or release.
      const folderGone = code === 'ENOENT' || code === 'ENOTDIR'
      warnSafely(
        `[skillsmith] lock_release_reclaim_failed: could not create ${reclaimPath} (${code}). ` +
          (folderGone
            ? `The folder of ${path} is gone, so there is nothing to release. Not removing ${path}.`
            : `Not removing ${path}; it stays held by this process until it exits.`)
      )
      return false
    }
    if (taken) break
    if (Date.now() >= deadline) {
      warnSafely(
        `[skillsmith] lock_release_reclaim_unavailable: could not take ${reclaimPath} within ${waitMs} ms: ` +
          'another process is deciding about this lock, or a crash left it behind. ' +
          `Not removing ${path}; it stays held by this process until it exits. ` +
          reclaimRemedy(reclaimPath)
      )
      return false
    }
    sleepSync(LOCK_RETRY_DELAY_MS)
  }
  let answer = false
  try {
    answer = releaseClaimFile(path, token) // ownership is decided ONLY here, under .reclaim
  } catch (err) {
    warnSafely(
      `[skillsmith] lock_release_failed: releasing ${path} threw (${thrownText(err)}). ` +
        `Not removing ${path}; it may still be ours.`
    )
  }
  try {
    releaseClaimFile(reclaimPath, rToken) // warns on its own failure; does not change the answer
  } catch (err) {
    warnSafely(
      `[skillsmith] lock_release_guard_failed: releasing the guard ${reclaimPath} threw ` +
        `(${thrownText(err)}); it may be left behind. Check that no Skillsmith process is ` +
        `running, then remove ${reclaimPath} by hand.`
    )
  }
  return answer
}

/**
 * The release function `acquireOwnedLock` hands back. Returns what
 * {@link releaseOwned} returned; a second call returns the first call's result
 * without touching the file again. It passes no options: in particular it does
 * not inherit acquire's `reclaimLockTimeoutMs` (`file-lock` acquires with 0), or
 * a momentary contention on `.reclaim` would leave the lock behind.
 */
export function makeRelease(lockPath: string, token: string): () => boolean {
  let result: boolean | undefined
  return () => {
    if (result !== undefined) return result
    result = releaseOwned(lockPath, token)
    return result
  }
}
