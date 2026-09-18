/**
 * @fileoverview Generic, non-blocking cross-process file lock, wrapping
 *   `owned-lock.ts`'s two-level primitive.
 * @module @skillsmith/core/config/file-lock
 *
 * Split out of `packages/core/src/install/fan-out.locks.ts` in SMI-6735: that
 * module's `withFileLock` was already fully generic (it never referenced
 * anything fan-out-specific), so hand-rolled manifest locks elsewhere in the
 * repo (`services/skill-manifest.ts`, `@skillsmith/mcp-server`'s
 * `install.helpers.manifest.ts`) can share it instead of re-implementing an
 * age-based lock protocol. `fan-out.locks.ts` re-exports `withFileLock` from
 * here so its own existing importers (`fan-out.overwrite.ts`) are unchanged.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { acquireOwnedLock, StuckLockError, type StuckLockReason } from './owned-lock.js'

/** How long to wait for another process's lock on the same target (ms). */
const FILE_LOCK_TIMEOUT_MS = 30_000
/** Pause between attempts while another process holds the lock (ms). */
const FILE_LOCK_POLL_MS = 50
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

/**
 * Take the cross-process file lock without ever blocking the event loop.
 * `acquireOwnedLock` normally waits with a synchronous sleep, which froze a
 * whole MCP server for up to 10 s (round 7). Here each attempt is one
 * non-waiting try (`timeoutMs: 0`) that still reclaims a dead holder's lock
 * at once (`reclaimProbeAfterMs: 0`) and never waits on the reclaim lock
 * either (`reclaimLockTimeoutMs: 0`, round 8). Between attempts we await.
 */
async function acquireFileLock(target: string, label: string): Promise<() => void> {
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS
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
      await delay(FILE_LOCK_POLL_MS)
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
