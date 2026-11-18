/**
 * SMI-6531 (A1 step 6d-i): lock 1′, the lock a parked area, or a state-root
 * backup tree whose skills root is gone, is pruned and restored under (PLAN
 * lock table row 1′, UD31, UD62, UD63, UD72).
 *
 * `<stateRoot>/locks/parked-<key>.lock`, `<key>` being the first 16 hex
 * characters of sha256 over the UTF-8 bytes of the native realpath of the
 * area (or of `<stateRoot>/backups/update/<client>/<rootKey>/` for UD62).
 * `withFileLock` is passed the target without `.lock` and derives the lock
 * file (`file-lock.ts`), so `parkedLockPath` returns the lock FILE, the path a
 * reader orders by (UD60), and `parkedLockTarget` the target. Both are pure.
 *
 * `withParkedAreaLock` takes the lock. The claim is created by path (Node has
 * no `openat`), so the `locks` directory cannot be pinned by a handle; it is
 * bound by identity and checked three times, and again on request through
 * `ctx.recheck()`. The swap that remains after the third check is an accepted
 * residual (ADR-166 D-0, as UD71): swapping `locks/` needs the user's own
 * account. A claim the release could not find is reported as `stranded`.
 *
 * @module @skillsmith/core/config/file-lock.parked
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { withFileLock } from './file-lock.js'
import { bindLocksDir, inspect, lstatId, same, type Id } from './file-lock.parked.checks.js'
import { checkLockRequest, LockOrderError } from './lock-tracker.js'
import { StuckLockError, type StuckLockReason } from './owned-lock.js'

/** Hex characters of the digest kept in the lock's name (PLAN:915). */
const PARKED_LOCK_KEY_HEX = 16
const LOCK_FILE_RE = /^parked-[0-9a-f]{16}\.lock$/

function parkedKey(areaReal: string): string {
  return createHash('sha256').update(areaReal, 'utf8').digest('hex').slice(0, PARKED_LOCK_KEY_HEX)
}

/** `<stateRoot>/locks/parked-<key>`: the target `withFileLock` takes (it appends `.lock`). */
export function parkedLockTarget(stateRoot: string, areaReal: string): string {
  return path.join(stateRoot, 'locks', `parked-${parkedKey(areaReal)}`)
}

/** The lock 1′ file for `areaReal`, a native realpath. */
export function parkedLockPath(stateRoot: string, areaReal: string): string {
  return `${parkedLockTarget(stateRoot, areaReal)}.lock`
}

export type ParkedLockStop =
  | { code: 'busy'; lockPath: string; detail: string; reason: StuckLockReason }
  | { code: 'state-root-missing'; path: string }
  | { code: 'locks-dir-unsafe'; path: string; detail: string }
  | { code: 'locks-dir-changed'; path: string; detail: string }

/**
 * A claim the release may not have been able to find at its path, because
 * `locks/` changed while it was held. `certain: true` (a swap after check 3):
 * `claim` is the identity bound under the lock, and it is in `locksDir`.
 * `certain: false` (a swap before check 3 could bind a claim): `claim` is absent
 * and `detail` says what is known. Nothing about whose file is now visible at the
 * lock path is used to decide either way.
 */
export interface StrandedClaim {
  certain: boolean
  lockName: string // `parked-<key>.lock`
  locksDir: { dev: bigint; ino: bigint } // the directory the claim was created in
  claim?: { dev: bigint; ino: bigint }
  detail?: string
}

export interface ParkedLockContext {
  /** Throws `ParkedLockChanged` unless `locks/` and the claim still have their bound identities. */
  recheck(): void
}

/** `locks/` or the claim no longer has the identity bound when the lock was taken. */
export class ParkedLockChanged extends Error {
  constructor(
    readonly path: string,
    detail: string
  ) {
    super(`The lock folder ${path} changed while its lock was held: ${detail}`)
    this.name = 'ParkedLockChanged'
  }
}

const strandedByError = new WeakMap<object, StrandedClaim>()

/**
 * The stranded claim `withParkedAreaLock` found when `fn` (or the release)
 * threw, for the error it rethrew; `undefined` when there was none. A thrown
 * primitive cannot carry it, so only a thrown object is tracked.
 */
export function strandedOf(error: unknown): StrandedClaim | undefined {
  return typeof error === 'object' && error !== null ? strandedByError.get(error) : undefined
}

export interface WithParkedAreaLockOptions {
  timeoutMs?: number
}

/** @internal Test seams around the `locks/` checks (W7b, W7c, W10, afterAcquire). */
export interface ParkedLockHooks {
  afterValidate?: () => void
  afterRecheck?: () => void
  afterAcquire?: () => void
  beforeFn?: () => void
}

/** @internal What the tests pass; the public options are `WithParkedAreaLockOptions`. */
export interface ParkedLockTestOptions extends WithParkedAreaLockOptions {
  hooks?: ParkedLockHooks
}

export type WithParkedAreaLockResult<T> =
  | { ok: true; value: T; stranded?: StrandedClaim }
  | { ok: false; stop: ParkedLockStop; stranded?: StrandedClaim }

/**
 * Run `fn` holding lock 1′ at `lockPath`, a path built by `parkedLockPath`.
 * Rejects `TypeError` for any other path and `LockOrderError` when the tracker
 * refuses, both before any fs call. `{ ok: false }` is a stop that did not run
 * `fn`: `busy`, a missing state root, or an unsafe, changed or removed
 * `locks/`. `fn`'s own errors propagate unchanged.
 *
 * `stranded` reports a claim the release may not have found, because `locks/`
 * changed while the lock was held (on `ok: true` and `ok: false`; for a
 * propagating error, `strandedOf(error)`). A swap after the claim was bound
 * (check 4) is `certain: true` and names the claim. A swap found by check 3,
 * before a claim could be bound, is `certain: false` with no claim: the wrapper
 * does not guess whose file is visible at the path afterwards, so it reports
 * every such swap, including one that came before the claim was made, when the
 * release removed the claim from the replacement. A `locks/` removed outright
 * is reported the same way, though nothing is then left to reclaim.
 *
 * Check 3 and `ctx.recheck()` read the claim at the lock path and require it to
 * be this process's own (a v1 claim naming this pid and host), not just a file
 * with the expected inode: `withFileLock` hands its callback no claim identity,
 * so the inode alone would bind whatever was put at the path. A mismatch stops
 * with `locks-dir-changed` and a `claim-not-ours` detail, `fn` never runs, and
 * nothing is reported as ours. Same-process holders of one lock cannot both own
 * a claim at the path: the file claim is created by an exclusive `link`
 * (owned-lock.claim.ts:296-300), a live owner's claim is never reclaimed
 * (:165-170, :200-201), and a nested request for the same lock is refused by
 * the tracker (lock-tracker.ts:15-16). Residual (ADR-166 D-0): a claim forged
 * with this process's pid and host needs the user's own account and is not
 * detected; nor is a claim removed after check 3, which a later swap would
 * still report by the identity bound there.
 */
export function withParkedAreaLock<T>(
  lockPath: string,
  label: string,
  fn: (ctx: ParkedLockContext) => Promise<T>,
  options: WithParkedAreaLockOptions = {}
): Promise<WithParkedAreaLockResult<T>> {
  return runLockedForTests(
    lockPath,
    label,
    fn,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
  )
}

/** @internal `withParkedAreaLock` with the test seams; not exported from the package. */
export function runLockedForTests<T>(
  lockPath: string,
  label: string,
  fn: (ctx: ParkedLockContext) => Promise<T>,
  options: ParkedLockTestOptions
): Promise<WithParkedAreaLockResult<T>> {
  try {
    if (
      !LOCK_FILE_RE.test(path.basename(lockPath)) ||
      path.basename(path.dirname(lockPath)) !== 'locks'
    ) {
      throw new TypeError(
        `withParkedAreaLock(${JSON.stringify(label)}) needs <stateRoot>/locks/parked-<16 hex>.lock, got ${JSON.stringify(lockPath)}`
      )
    }
    checkLockRequest(lockPath.slice(0, -'.lock'.length), label, "1'")
  } catch (err) {
    const refused = Promise.reject(err)
    // Inside a manifest callback, which doesn't await this, the refusal is
    // reported when the callback returns; don't also leave it unhandled.
    if (err instanceof LockOrderError && err.kind === 'in-pure-callback') {
      refused.catch(() => {})
    }
    return refused as Promise<WithParkedAreaLockResult<T>>
  }
  return runLocked(lockPath, label, fn, options)
}

async function runLocked<T>(
  lockPath: string,
  label: string,
  fn: (ctx: ParkedLockContext) => Promise<T>,
  options: ParkedLockTestOptions
): Promise<WithParkedAreaLockResult<T>> {
  const locks = path.dirname(lockPath)
  const target = lockPath.slice(0, -'.lock'.length)
  const hooks = options.hooks
  const bind = bindLocksDir(path.dirname(locks), locks)
  if (!bind.ok) return { ok: false, stop: bind.stop }
  const { bound } = bind
  hooks?.afterValidate?.()
  const changed = (detail: string): WithParkedAreaLockResult<T> => ({
    ok: false,
    stop: { code: 'locks-dir-changed', path: locks, detail },
  })
  // Check 2: nothing is created yet.
  if (!same(lstatId(locks), bound.locks)) return changed('its identity changed before the lock')
  hooks?.afterRecheck?.()
  let entered = false
  let claim: Id | undefined
  let lostAtCheck3 = false
  let stop: ParkedLockStop | undefined
  let value: T | undefined
  // Check 4: the release works by path, so it cannot have found its own claim
  // if `locks/` is no longer the directory the claim was made in.
  const findStranded = (): StrandedClaim | undefined => {
    const base = { lockName: path.basename(lockPath), locksDir: bound.locks }
    if (claim !== undefined) {
      return same(lstatId(locks), bound.locks) ? undefined : { ...base, certain: true, claim }
    }
    return lostAtCheck3
      ? {
          ...base,
          certain: false,
          detail:
            "the lock folder changed after the claim was taken, so a claim may have been left in the folder that moved away; it is reclaimed as a dead owner's claim if the folder returns",
        }
      : undefined
  }
  try {
    value = await withFileLock(
      target,
      label,
      async () => {
        entered = true
        hooks?.afterAcquire?.()
        // Check 3: after the claim exists; on a mismatch `fn` never runs and
        // the release (by path) removes the claim wherever the path now leads.
        const first = inspect(bound, lockPath)
        if (!first.ok) {
          // `locks/` changed after the claim was taken. Whose file is visible
          // through the path now says nothing about where OUR claim went.
          lostAtCheck3 = first.dirChanged
          stop = { code: 'locks-dir-changed', path: locks, detail: first.detail }
          return undefined as T
        }
        const bornClaim = first.claim
        claim = bornClaim
        hooks?.beforeFn?.()
        return fn({
          recheck(): void {
            const again = inspect(bound, lockPath)
            if (!again.ok) throw new ParkedLockChanged(locks, again.detail)
            if (!same(again.claim, bornClaim))
              throw new ParkedLockChanged(locks, 'the claim was replaced')
          },
        })
      },
      { rank: "1'", ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }
    )
  } catch (error) {
    if (error instanceof StuckLockError && !entered && error.lockPath === lockPath) {
      return {
        ok: false,
        stop: { code: 'busy', lockPath, detail: error.message, reason: error.reason },
      }
    }
    if (!entered && !same(lstatId(locks), bound.locks)) {
      return changed(
        lstatId(locks) === null
          ? 'it was removed while the lock was being taken'
          : 'it was replaced while the lock was being taken'
      )
    }
    const lost = findStranded()
    if (typeof error === 'object' && error !== null) {
      if (lost === undefined) strandedByError.delete(error)
      else strandedByError.set(error, lost)
    }
    throw error
  }
  const stranded = findStranded()
  const extra = stranded === undefined ? {} : { stranded }
  if (stop !== undefined) return { ok: false, stop, ...extra }
  return { ok: true, value: value as T, ...extra }
}
