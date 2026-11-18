/**
 * SMI-6531 (A1 step 6d-i): the identity checks `withParkedAreaLock` runs on the
 * `locks/` directory and the claim in it (design note §3.1, checks 1 and 3).
 * Split out of `file-lock.parked.ts`; not part of the public surface.
 *
 * @module @skillsmith/core/config/file-lock.parked.checks
 */
import fs from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { readClaim } from './owned-lock.claim.js'
import type { ParkedLockStop } from './file-lock.parked.js'

export interface Id {
  dev: bigint
  ino: bigint
}

export const same = (a: Id | null, b: Id): boolean =>
  a !== null && a.dev === b.dev && a.ino === b.ino

export function lstatId(p: string): Id | null {
  try {
    const st = fs.lstatSync(p, { bigint: true })
    return { dev: st.dev, ino: st.ino }
  } catch {
    return null
  }
}

export interface Bound {
  locks: Id
  real: string
}

export type Bind = { ok: true; bound: Bound } | { ok: false; stop: ParkedLockStop }

/** Check 1: make `locks/` if needed and bind it by identity and realpath. */
export function bindLocksDir(stateRoot: string, locks: string): Bind {
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

/**
 * Whether the file at `lockPath` is THIS process's claim, by content: a v1
 * claim (`parseClaim`, owned-lock.claim.ts:69-100) naming `process.pid` and this
 * host, the two fields the writer records (owned-lock.acquire.ts:258-260). The
 * claim also carries a random `token` and `acquiredAt` that only the acquiring
 * call knows, but `withFileLock` does not hand them to its callback, so they
 * cannot be compared here. A claim forged with our pid and host needs the
 * user's own account (ADR-166 D-0). `at` is the inode the caller bound; the
 * file read must still be that inode afterwards. Returns why not, or `null`.
 */
function notOurClaim(lockPath: string, at: Id): string | null {
  const claim = readClaim(lockPath)
  if (claim.kind !== 'v1') return 'claim-not-ours: the file at the lock path is not a v1 claim'
  if (claim.pid !== process.pid || claim.host !== hostname()) {
    return "claim-not-ours: the claim at the lock path is not this process's claim"
  }
  return same(lstatId(lockPath), at) ? null : 'claim-not-ours: the claim changed while it was read'
}

/** `dirChanged` is true when `locks/` is no longer the bound directory. */
export type Inspect = { ok: true; claim: Id } | { ok: false; detail: string; dirChanged: boolean }

/** Check 3, and `ctx.recheck()`'s repeat of it: `locks/`, the claim and the folder's realpath still match. */
export function inspect(bound: Bound, lockPath: string): Inspect {
  const dir = path.dirname(lockPath)
  if (!same(lstatId(dir), bound.locks)) {
    return { ok: false, detail: 'its identity changed', dirChanged: true }
  }
  const fail = (detail: string): Inspect => ({ ok: false, detail, dirChanged: false })
  let claim: fs.BigIntStats
  try {
    claim = fs.lstatSync(lockPath, { bigint: true })
  } catch {
    return fail('the claim is not at its path')
  }
  if (!claim.isFile() || claim.dev !== bound.locks.dev) {
    return fail('the claim is not a file on the same device')
  }
  const foreign = notOurClaim(lockPath, { dev: claim.dev, ino: claim.ino })
  if (foreign !== null) return fail(foreign)
  try {
    if (fs.realpathSync.native(dir) !== bound.real) return fail('its path moved')
  } catch {
    return fail('its path no longer resolves')
  }
  return { ok: true, claim: { dev: claim.dev, ino: claim.ino } }
}
