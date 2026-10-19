/**
 * @fileoverview The per-destination locking used by every fan-out write: an
 *   in-process queue so same-process callers serialize, and a cross-process
 *   file lock taken without ever blocking the event loop.
 * @module @skillsmith/core/install/fan-out.locks
 *
 * Split out of `fan-out.overwrite.ts` in SMI-6529 round 27, when that file
 * reached 505 lines against the 500-line standard — the same sibling-split
 * convention `fan-out.leftovers.ts` already follows. `fan-out.overwrite.ts`
 * re-exports both entry points, so existing importers are unchanged.
 *
 * SMI-6735: the cross-process file-lock half (`withFileLock`) moved to
 * `../config/file-lock.ts` — it was always fully generic, and two other
 * modules elsewhere in the repo needed to share it instead of hand-rolling
 * their own age-based lock protocol. Re-exported here so this file's own
 * existing importers (`fan-out.overwrite.ts`) are unchanged.
 */
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import { withFileLock } from '../config/file-lock.js'
import { checkLockRequest } from '../config/lock-tracker.js'
import { siblingPrefix } from './fan-out.leftovers.js'

export { withFileLock }

const LOCK_TAG = '.skillsmith-fanout'

// Same-process callers for one destination queue here, so only one of them
// holds the file lock at a time; the file lock arbitrates between processes.
const inProcessQueue = new Map<string, Promise<void>>()

/**
 * Run `fn` holding the lock for `dest`: first queue behind any other call
 * for the same destination in this process, then take the cross-process
 * file lock `.<name>.skillsmith-fanout.lock` next to it.
 */
export async function withDestinationLock<T>(dest: string, fn: () => Promise<T>): Promise<T> {
  // A1 step 1: the tracker's refusal must come before the queue and the
  // mkdir below, or a re-entry waits on itself forever (plan §3.2). One
  // identity serves both: the admission check returns the lock-file key it
  // computed, and that value is the queue key, so the check and the queue name
  // the lock file the same way (the authoritative check in `withFileLock`
  // computes its own, in the same way). A symlinked spelling
  // shares the queue even while the parent doesn't exist yet (it is resolved
  // at its nearest existing ancestor), and so does a case variant of an
  // existing lock file where the OS folds case. The parent is not created
  // before the check: a refused request must not write.
  const lockTarget = path.join(path.dirname(dest), siblingPrefix(dest, LOCK_TAG))
  const key = checkLockRequest(lockTarget, 'fan-out destination lock', '2a')
  const previous = inProcessQueue.get(key) ?? Promise.resolve()
  let releaseQueue: () => void = () => {}
  const mine = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  const tail = previous.then(() => mine)
  inProcessQueue.set(key, tail)
  await previous
  try {
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    return await withFileLock(lockTarget, 'fan-out destination lock', fn, { rank: '2a' })
  } finally {
    releaseQueue()
    if (inProcessQueue.get(key) === tail) inProcessQueue.delete(key)
  }
}
