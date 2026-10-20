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
import { closeSync, openSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireOwnedLock, StuckLockError, type StuckLockReason } from './owned-lock.js'
import {
  isLockOrder,
  LOCK_ORDERS,
  LockOrderError,
  runHoldingLock,
  type LockOrder,
} from './lock-tracker.js'

/** How long to wait for another process's lock on the same target (ms). */
const FILE_LOCK_TIMEOUT_MS = 30_000
/** Pause between attempts while another process holds the lock (ms). */
const FILE_LOCK_POLL_MS = 50
/**
 * Refusals that are waited out rather than failed at once: a live holder, a
 * busy reclaim lock, and `reclaim_disabled`.
 *
 * The two excluded reasons fail on the FIRST attempt. For `unreclaimable_
 * unparseable` that is plainly right. For `unreclaimable_legacy` it is a
 * judgement call this comment used to misstate as a fact (SMI-6764): the
 * claim is never auto-*reclaimed* in any configuration (D-5), but a legacy
 * holder that is still ALIVE releases normally, so the lock can go away by
 * itself and waiting could pay off. Failing at once stays the default; a
 * caller that shares its lock file with older versions opts into waiting
 * with `FileLockOptions.waitOnLegacy` (the manifest lock does, SMI-7143).
 *
 * `reclaim_disabled` is the one that needs its reason stated, because the
 * obvious one is wrong (SMI-6759). It does NOT end when the holder releases:
 * `classifyRefusal` returns it only when auto-reclaim is off AND the v1 owner
 * is already dead, so that holder will never release anything — a LIVE owner
 * yields `held` instead. It stays here because a differently-configured peer
 * process, one without `SKILLSMITH_LOCK_NO_AUTO_RECLAIM` set, can still
 * reclaim the dead claim and release it, so waiting can pay off in a mixed
 * configuration. In a uniformly opted-out one it cannot, which is why
 * `StuckLockError`'s own remedy clause for this reason says exactly that —
 * retrying HERE cannot reclaim it, a peer without the opt-out still can
 * (`owned-lock.acquire.ts`'s `describeRemedy`).
 */
const RETRYABLE_REASONS: ReadonlySet<StuckLockReason> = new Set([
  'held',
  'reclaim_unavailable',
  'reclaim_disabled',
])

/** Options a caller may opt into; the defaults are every caller's behaviour before SMI-7143. */
export interface FileLockOptions {
  /**
   * Keep waiting on a bare-PID (legacy) claim instead of failing at once. A
   * legacy claim is never auto-reclaimed (owned-lock D-5), but a live older
   * process may own it and will release it when its save finishes, so a
   * caller sharing a lock file with older versions (the manifest lock) waits
   * out the normal budget for it like any live holder (A1 plan §3.8, #8).
   */
  waitOnLegacy?: boolean
  /**
   * Called once per acquisition, the first time a legacy claim is waited on,
   * with the pid the claim names (null when it cannot be read as one).
   */
  onLegacyWait?: (pid: number | null) => void
  /**
   * Keep waiting while the claim cannot be READ (the open fails `EACCES` or
   * `EPERM`), then end `unreclaimable_unparseable` at the deadline, instead of
   * failing on the first attempt. A claim is mode 0600, so another user's lock
   * cannot be read by this one; that user's writer may release it, so the
   * skills-root lock waits it out like any live holder (A1 plan §3.0 item 11,
   * SMI-6531 step 2, C2). A claim that opens but does not parse is still
   * refused at once: nothing will make it readable. The re-probe after a
   * refusal also retries when the claim is gone (`ENOENT`, released meanwhile)
   * or the process is out of descriptors (`EMFILE`, `ENFILE`).
   */
  waitWhileUnreadable?: boolean
  /** How long to wait before giving up, in ms (default 30 s); a test seam. */
  timeoutMs?: number
  /**
   * The lock's rank in A1 plan §3.2's order table (SMI-6531 step 1), or
   * `'unordered'` for a lock outside it. Required by the type, and a missing or
   * unknown rank rejects at runtime, so a lock can't skip the order rules by
   * omission. The tracker refuses, before any wait, a request
   * that re-enters a held lock, takes a second skills-root lock, ranks below
   * or equal to a held lock, or is made while lock 4 is held.
   */
  rank: LockOrder
}

/** The pid a bare-PID claim names, or null. Reads the lock file only. */
function legacyPid(lockPath: string): number | null {
  try {
    const text = readFileSync(lockPath, 'utf8').trim()
    return /^[0-9]+$/.test(text) ? Number(text) : null
  } catch {
    return null
  }
}

/** Refusals whose last probe found the claim unreadable by permission, so a caller can word the stop. */
const endedUnreadable = new WeakSet<object>()

/**
 * Whether `err` is the refusal `waitWhileUnreadable` threw at its deadline
 * because the claim stayed unreadable for lack of permission (another user's
 * live lock), as opposed to a claim that opened but did not parse.
 */
export function endedOnUnreadableClaim(err: unknown): boolean {
  return typeof err === 'object' && err !== null && endedUnreadable.has(err)
}

type ClaimProbe =
  /** The open failed `EACCES`/`EPERM`: the other user's writer may release it. */
  | 'unreadable'
  /** The open failed in a way that can clear by itself (released meanwhile, or out of descriptors). */
  | 'transient'
  /** It opened, or failed some other way: nothing will make it readable. */
  | 'other'

/**
 * Re-probe the claim at `lockPath` after owned-lock's refusal, because
 * owned-lock reports every open failure as one `unreclaimable_unparseable`
 * reason. A permission failure can clear by itself (the other user releases). So
 * can `ENOENT` (the claim was released between owned-lock's `EACCES` and this
 * open) and `EMFILE`/`ENFILE` (descriptor exhaustion). All three are retried,
 * and a retry goes back through owned-lock's exclusive create, so it can never
 * take a lock wrongly.
 */
function probeClaim(lockPath: string): ClaimProbe {
  try {
    closeSync(openSync(lockPath, 'r'))
    return 'other'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return 'unreadable'
    if (code === 'ENOENT' || code === 'EMFILE' || code === 'ENFILE') return 'transient'
    return 'other'
  }
}

/**
 * Take the cross-process file lock without ever blocking the event loop.
 * `acquireOwnedLock` normally waits with a synchronous sleep, which froze a
 * whole MCP server for up to 10 s (round 7). Here each attempt is one
 * non-waiting try (`timeoutMs: 0`) that still reclaims a dead holder's lock
 * at once (`reclaimProbeAfterMs: 0`) and never waits on the reclaim lock
 * either (`reclaimLockTimeoutMs: 0`, round 8). Between attempts we await.
 */
async function acquireFileLock(
  target: string,
  label: string,
  options: FileLockOptions
): Promise<() => boolean> {
  const deadline = Date.now() + (options.timeoutMs ?? FILE_LOCK_TIMEOUT_MS)
  let warnedLegacy = false
  for (;;) {
    try {
      return acquireOwnedLock(target, {
        timeoutMs: 0,
        reclaimProbeAfterMs: 0,
        reclaimLockTimeoutMs: 0,
        label,
      })
    } catch (err) {
      const legacy =
        err instanceof StuckLockError &&
        err.reason === 'unreclaimable_legacy' &&
        options.waitOnLegacy === true
      const probe: ClaimProbe =
        err instanceof StuckLockError &&
        err.reason === 'unreclaimable_unparseable' &&
        options.waitWhileUnreadable === true
          ? probeClaim(`${target}.lock`)
          : 'other'
      const retryable =
        legacy ||
        probe !== 'other' ||
        (err instanceof StuckLockError && RETRYABLE_REASONS.has(err.reason))
      if (!retryable || Date.now() >= deadline) {
        if (probe === 'unreadable' && typeof err === 'object' && err !== null) {
          endedUnreadable.add(err)
        }
        throw err
      }
      if (legacy && !warnedLegacy) {
        warnedLegacy = true
        options.onLegacyWait?.(legacyPid(`${target}.lock`))
      }
      await delay(FILE_LOCK_POLL_MS)
    }
  }
}

/**
 * Run `fn` holding the cross-process file lock `<target>.lock`, waiting
 * without blocking the event loop. Callers in one process contend on it too.
 * The lock-order tracker checks the request first: a refusal rejects with
 * `LockOrderError` before any wait (SMI-6531 step 1).
 */
export function withFileLock<T>(
  target: string,
  label: string,
  fn: () => Promise<T>,
  options: FileLockOptions
): Promise<T> {
  // The type requires a rank; an untyped caller (JS, a cast) gets a rejection,
  // not a silently unordered lock or an unrelated "reading 'rank'" crash.
  const rank: unknown = typeof options === 'object' && options !== null ? options.rank : undefined
  if (!isLockOrder(rank)) {
    return Promise.reject(
      new TypeError(
        `withFileLock(${JSON.stringify(label)}) requires options.rank, one of ${LOCK_ORDERS.map((r) => `'${r}'`).join(', ')}; got ${rank === undefined ? 'none' : JSON.stringify(rank)}`
      )
    )
  }
  try {
    return runHoldingLock(target, label, options.rank, async (acquired, releasing) => {
      const release = await acquireFileLock(target, label, options)
      acquired() // the lock's folder exists now: key it by its real path
      try {
        return await fn()
      } finally {
        // Release first, then stop counting the lock, with no await between:
        // work `fn` started can run in the next microtask and must not see a
        // lock whose file is already gone. If the release failed, or could not
        // read the claim while a file remains, the file may still be ours and
        // the entry stays live for that work, which would otherwise pass
        // admission and wait on its own retained lock file.
        if (release()) releasing()
      }
    })
  } catch (err) {
    const refused = Promise.reject(err)
    // Inside a manifest callback, which is synchronous and doesn't await this,
    // the refusal is reported when the callback returns (`runPureCallback`);
    // handle the rejection here so it isn't also an unhandled one.
    if (err instanceof LockOrderError && err.kind === 'in-pure-callback') {
      refused.catch(() => {})
    }
    return refused as Promise<T>
  }
}
