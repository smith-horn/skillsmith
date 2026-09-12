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
 */
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireOwnedLock, StuckLockError, type StuckLockReason } from '../config/owned-lock.js'
import { siblingPrefix } from './fan-out.leftovers.js'

const LOCK_TAG = '.skillsmith-fanout'
/** How long to wait for another process's lock on the same destination (ms). */
const DESTINATION_LOCK_TIMEOUT_MS = 30_000
/** Pause between attempts while another process holds the lock (ms). */
const DESTINATION_LOCK_POLL_MS = 50
/**
 * Refusals that end on their own, so they are waited out: a live holder, a
 * busy reclaim lock, and a holder we may not reclaim because auto-reclaim is
 * off (it still ends when that holder releases). An unparseable or legacy
 * claim never goes away by itself, so it fails at once.
 */
const RETRYABLE_REASONS: ReadonlySet<StuckLockReason> = new Set([
  'held',
  'reclaim_unavailable',
  'reclaim_disabled',
])

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
 * Take the cross-process file lock without ever blocking the event loop.
 * `acquireOwnedLock` normally waits with a synchronous sleep, which froze a
 * whole MCP server for up to 10 s (round 7). Here each attempt is one
 * non-waiting try (`timeoutMs: 0`) that still reclaims a dead holder's lock
 * at once (`reclaimProbeAfterMs: 0`) and never waits on the reclaim lock
 * either (`reclaimLockTimeoutMs: 0`, round 8). Between attempts we await.
 */
async function acquireFileLock(target: string, label: string): Promise<() => void> {
  const deadline = Date.now() + DESTINATION_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      return acquireOwnedLock(target, {
        timeoutMs: 0,
        reclaimProbeAfterMs: 0,
        reclaimLockTimeoutMs: 0,
        label,
      })
    } catch (err) {
      const retryable = err instanceof StuckLockError && RETRYABLE_REASONS.has(err.reason)
      if (!retryable || Date.now() >= deadline) throw err
      await delay(DESTINATION_LOCK_POLL_MS)
    }
  }
}

/**
 * Run `fn` holding the cross-process file lock `<target>.lock`, waiting
 * without blocking the event loop. Callers in one process contend on it too.
 */
export async function withFileLock<T>(
  target: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const release = await acquireFileLock(target, label)
  try {
    return await fn()
  } finally {
    release()
  }
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
