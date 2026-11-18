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
import fs from 'node:fs'
import path from 'node:path'
import { withFileLock } from './file-lock.js'
import { checkLockRequest } from './lock-tracker.js'
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

/** A claim the release could not find at its path because `locks/` changed while it was held. */
export interface StrandedClaim {
  lockName: string // `parked-<key>.lock`
  locksDir: { dev: bigint; ino: bigint } // the directory the claim was created in
  claim: { dev: bigint; ino: bigint } // the claim file's identity, bound at check 3
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
  /** @internal Test seams around the `locks/` checks (W7b, W7c, W10). */
  hooks?: { afterValidate?: () => void; afterRecheck?: () => void; beforeFn?: () => void }
}

export type WithParkedAreaLockResult<T> =
  | { ok: true; value: T; stranded?: StrandedClaim }
  | { ok: false; stop: ParkedLockStop; stranded?: StrandedClaim }

interface Id {
  dev: bigint
  ino: bigint
}

const same = (a: Id | null, b: Id): boolean => a !== null && a.dev === b.dev && a.ino === b.ino

function lstatId(p: string): Id | null {
  try {
    const st = fs.lstatSync(p, { bigint: true })
    return { dev: st.dev, ino: st.ino }
  } catch {
    return null
  }
}

interface Bound {
  locks: Id
  real: string
}

type Bind = { ok: true; bound: Bound } | { ok: false; stop: ParkedLockStop }

/** Check 1: make `locks/` if needed and bind it by identity and realpath. */
function bindLocksDir(stateRoot: string, locks: string): Bind {
  const unsafe = (detail: string): Bind => ({
    ok: false,
    stop: { code: 'locks-dir-unsafe', path: locks, detail },
  })
  try {
    if (!fs.statSync(stateRoot).isDirectory()) throw new Error('not a directory')
  } catch {
    return { ok: false, stop: { code: 'state-root-missing', path: stateRoot } }
  }
  try {
    fs.mkdirSync(locks, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return unsafe(`cannot create it: ${(error as Error).message}`)
    }
  }
  let st: fs.BigIntStats
  try {
    st = fs.lstatSync(locks, { bigint: true })
  } catch (error) {
    return unsafe((error as Error).message)
  }
  if (!st.isDirectory()) return unsafe('it is not a real directory (a symlink or a file)')
  if (process.platform !== 'win32') {
    const uid = process.getuid?.()
    if (uid !== undefined && Number(st.uid) !== uid) return unsafe('it is owned by another user')
    if ((Number(st.mode) & 0o022) !== 0) return unsafe('it is writable by group or others')
  }
  let real: string
  try {
    real = fs.realpathSync.native(locks)
  } catch (error) {
    return unsafe((error as Error).message)
  }
  // No `real === <realpath(stateRoot)>/locks` guard: with `locks` already shown to be a real
  // directory it can only fail when `locks` is a symlink (caught above) or on a case-folding
  // filesystem, where `real` is simply the spelling `inspect` compares against later.
  return { ok: true, bound: { locks: { dev: st.dev, ino: st.ino }, real } }
}

type Inspect = { ok: true; claim: Id } | { ok: false; detail: string }

/** Checks 3 and 4's repeat: `locks/`, the claim file and the folder's realpath still match. */
function inspect(bound: Bound, lockPath: string): Inspect {
  const dir = path.dirname(lockPath)
  if (!same(lstatId(dir), bound.locks)) return { ok: false, detail: 'its identity changed' }
  let claim: fs.BigIntStats
  try {
    claim = fs.lstatSync(lockPath, { bigint: true })
  } catch {
    return { ok: false, detail: 'the claim is not at its path' }
  }
  if (!claim.isFile() || claim.dev !== bound.locks.dev) {
    return { ok: false, detail: 'the claim is not a file on the same device' }
  }
  try {
    if (fs.realpathSync.native(dir) !== bound.real) return { ok: false, detail: 'its path moved' }
  } catch {
    return { ok: false, detail: 'its path no longer resolves' }
  }
  return { ok: true, claim: { dev: claim.dev, ino: claim.ino } }
}

/**
 * Run `fn` holding lock 1′ at `lockPath`, a path built by `parkedLockPath`.
 * Rejects `LockOrderError` (before any fs call) when the tracker refuses.
 * `{ ok: false }` is a stop that ran nothing: `busy`, a missing state root, or
 * an unsafe or changed `locks/`. `fn`'s own errors propagate unchanged; when
 * `locks/` was swapped while the lock was held, the claim the release could not
 * find is on the result (`stranded`), or, for a propagating error, readable with
 * `strandedOf(error)`, so the caller sees it either way.
 */
export async function withParkedAreaLock<T>(
  lockPath: string,
  label: string,
  fn: (ctx: ParkedLockContext) => Promise<T>,
  options: WithParkedAreaLockOptions = {}
): Promise<WithParkedAreaLockResult<T>> {
  const locks = path.dirname(lockPath)
  if (!LOCK_FILE_RE.test(path.basename(lockPath)) || path.basename(locks) !== 'locks') {
    throw new TypeError(
      `withParkedAreaLock(${JSON.stringify(label)}) needs <stateRoot>/locks/parked-<16 hex>.lock, got ${JSON.stringify(lockPath)}`
    )
  }
  const target = lockPath.slice(0, -'.lock'.length)
  checkLockRequest(target, label, "1'")
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
  let stop: ParkedLockStop | undefined
  let value: T | undefined
  // Check 4: the release works by path, so it cannot have found its own claim
  // if `locks/` is no longer the directory the claim was made in.
  const findStranded = (): StrandedClaim | undefined =>
    claim !== undefined && !same(lstatId(locks), bound.locks)
      ? { lockName: path.basename(lockPath), locksDir: bound.locks, claim }
      : undefined
  try {
    value = await withFileLock(
      target,
      label,
      async () => {
        entered = true
        // Check 3: after the claim exists; on a mismatch `fn` never runs and
        // the release (by path) removes the claim wherever the path now leads.
        const first = inspect(bound, lockPath)
        if (!first.ok) {
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
    const lost = findStranded()
    if (lost !== undefined && typeof error === 'object' && error !== null) {
      strandedByError.set(error, lost)
    }
    throw error
  }
  const stranded = findStranded()
  const extra = stranded === undefined ? {} : { stranded }
  if (stop !== undefined) return { ok: false, stop, ...extra }
  return { ok: true, value: value as T, ...extra }
}
