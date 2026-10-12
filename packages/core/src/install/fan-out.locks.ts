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
import { siblingPrefix } from './fan-out.leftovers.js'

export { withFileLock }

const LOCK_TAG = '.skillsmith-fanout'

// Same-process callers for one destination queue here, so only one of them
// holds the file lock at a time; the file lock arbitrates between processes.
const inProcessQueue = new Map<string, Promise<void>>()

/**
 * Queue key for `dest`: its parent's real path plus its name, so a symlinked
 * spelling of the same folder shares one queue (round 7). A case-only variant
 * on a case-insensitive volume still gets its own key, but it then only waits
 * asynchronously on the shared file lock below, never blocking.
 */
async function queueKey(dest: string): Promise<string> {
  const parent = path.dirname(path.resolve(dest))
  const realParent = await fsp.realpath(parent).catch(() => parent)
  return path.join(realParent, path.basename(dest))
}

/**
 * Run `fn` holding the lock for `dest`: first queue behind any other call
 * for the same destination in this process, then take the cross-process
 * file lock `.<name>.skillsmith-fanout.lock` next to it.
 */
export async function withDestinationLock<T>(dest: string, fn: () => Promise<T>): Promise<T> {
  const key = await queueKey(dest)
  const previous = inProcessQueue.get(key) ?? Promise.resolve()
  let releaseQueue: () => void = () => {}
  const mine = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  const tail = previous.then(() => mine)
  inProcessQueue.set(key, tail)
  await previous
  try {
    const parent = path.dirname(dest)
    await fsp.mkdir(parent, { recursive: true })
    const lockTarget = path.join(parent, siblingPrefix(dest, LOCK_TAG))
    return await withFileLock(lockTarget, 'fan-out destination lock', fn)
  } finally {
    releaseQueue()
    if (inProcessQueue.get(key) === tail) inProcessQueue.delete(key)
  }
}
