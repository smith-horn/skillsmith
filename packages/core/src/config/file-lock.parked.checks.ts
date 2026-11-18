/**
 * SMI-6531 (A1 step 6d-i): the identity checks `withParkedAreaLock` runs on the
 * `locks/` directory and the claim in it (design note §3.1, checks 1 and 3).
 * Split out of `file-lock.parked.ts`; not part of the public surface.
 *
 * @module @skillsmith/core/config/file-lock.parked.checks
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseClaim } from './owned-lock.claim.js'
import { MAX_LOCK_BYTES, type Claim, type V1Claim } from './owned-lock.types.js'
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

const NOT_OURS = 'claim-not-ours'

type ClaimRead = { ok: true; id: Id; claim: Claim } | { ok: false; detail: string }

/**
 * Read the claim at `lockPath` without trusting what the path names. The shared
 * `readClaim` opens with a plain `open`, which blocks forever on a FIFO and
 * follows a symlink; this one opens `O_NOFOLLOW | O_NONBLOCK`, then checks the
 * OPEN descriptor: a regular file, on the lock folder's device, and (when
 * `expect` is given) the inode already bound. The read is bounded as
 * `readClaim`'s is (`MAX_LOCK_BYTES`) and parsed with the same `parseClaim`.
 */
function readClaimFd(lockPath: string, dev: bigint, expect: Id | undefined): ClaimRead {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  let fd: number
  try {
    fd = fs.openSync(lockPath, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, detail: 'the claim is not at its path' }
    return { ok: false, detail: `${NOT_OURS}: the lock path cannot be opened as a file (${code})` }
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true })
    // Defence in depth: the positional read below (position 0, a pread) already fails
    // ESPIPE on any pipe, so a FIFO never reaches parsing. Reading at position `null`
    // instead would make this check load-bearing.
    if (!st.isFile())
      return { ok: false, detail: `${NOT_OURS}: the lock path is not a regular file` }
    if (st.dev !== dev) return { ok: false, detail: `${NOT_OURS}: the claim is on another device` }
    const id = { dev: st.dev, ino: st.ino }
    if (expect !== undefined && !same(id, expect)) {
      return { ok: false, detail: `${NOT_OURS}: the claim file is not the one bound` }
    }
    if (st.size > BigInt(MAX_LOCK_BYTES)) {
      return { ok: false, detail: `${NOT_OURS}: the file at the lock path is larger than a claim` }
    }
    const buf = Buffer.allocUnsafe(MAX_LOCK_BYTES)
    const n = fs.readSync(fd, buf, 0, MAX_LOCK_BYTES, 0)
    return { ok: true, id, claim: parseClaim(buf.subarray(0, n).toString('utf8')) }
  } catch {
    return { ok: false, detail: `${NOT_OURS}: the claim could not be read` }
  } finally {
    fs.closeSync(fd)
  }
}

/** The claim bound at check 3: its identity and the v1 record read from it. */
export interface Born {
  id: Id
  record: V1Claim
}

/**
 * Check 3 (no `born`): a v1 claim naming this process and host, the two fields
 * the writer records (owned-lock.acquire.ts:258-260). `recheck()` (with `born`):
 * the same pid, host AND token as the record verified at check 3, so a later
 * hostname change cannot fail a correct holder and a forgery must also copy the
 * random token. The token cannot be checked at check 3 itself: only the
 * acquiring call knows it and `withFileLock` does not hand it to its callback.
 */
function isOurs(c: Claim, born: Born | undefined): c is V1Claim {
  return (
    c.kind === 'v1' &&
    (born === undefined
      ? c.pid === process.pid && c.host === os.hostname()
      : c.pid === born.record.pid && c.host === born.record.host && c.token === born.record.token)
  )
}

/** `dirChanged` is true when `locks/` is no longer the bound directory. */
export type Inspect = { ok: true; claim: Born } | { ok: false; detail: string; dirChanged: boolean }

/**
 * Check 3, and `ctx.recheck()`'s repeat of it (pass the `born` it bound): `locks/`,
 * the claim's content and the folder's realpath still match. `beforeOpen` is a
 * test seam between the folder check and the open.
 */
export function inspect(
  bound: Bound,
  lockPath: string,
  born?: Born,
  beforeOpen?: () => void
): Inspect {
  const dir = path.dirname(lockPath)
  if (!same(lstatId(dir), bound.locks)) {
    return { ok: false, detail: 'its identity changed', dirChanged: true }
  }
  const fail = (detail: string): Inspect => ({ ok: false, detail, dirChanged: false })
  beforeOpen?.()
  const read = readClaimFd(lockPath, bound.locks.dev, born?.id)
  if (!read.ok) return fail(read.detail)
  const { claim } = read
  if (!isOurs(claim, born)) {
    return fail(`${NOT_OURS}: the claim at the lock path is not this acquisition's v1 claim`)
  }
  try {
    if (fs.realpathSync.native(dir) !== bound.real) return fail('its path moved')
  } catch {
    return fail('its path no longer resolves')
  }
  return { ok: true, claim: { id: read.id, record: claim } }
}
