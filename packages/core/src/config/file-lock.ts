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
 * Refusals that are waited out rather than failed at once: a live holder, a
 * busy reclaim lock, and `reclaim_disabled`. An unparseable or legacy claim
 * never goes away by itself, so it fails immediately.
 *
 * `reclaim_disabled` is the one that needs its reason stated, because the
 * obvious one is wrong (SMI-6759). It does NOT end when the holder releases:
 * `classifyRefusal` returns it only when auto-reclaim is off AND the v1 owner
 * is already dead, so that holder will never release anything — a LIVE owner
 * yields `held` instead. It stays here because a differently-configured peer
 * process, one without `SKILLSMITH_LOCK_NO_AUTO_RECLAIM` set, can still
 * reclaim the dead claim and release it, so waiting can pay off in a mixed
 * configuration. In a uniformly opted-out one it cannot, which is why the
 * user-facing message for this reason says so rather than reporting a plain
 * timeout (`apply-manifest-reconcile.errors.ts`).
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
