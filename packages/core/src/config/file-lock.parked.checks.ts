/**
 * SMI-6531 (A1 step 6d-i): the identity checks `withParkedAreaLock` runs on the
 * `locks/` directory and the claim in it (design note §3.1, checks 1 and 3).
 * Split out of `file-lock.parked.ts`; not part of the public surface.
 *
 * @module @skillsmith/core/config/file-lock.parked.checks
 */
import fs from 'node:fs'
import path from 'node:path'
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
 * `dirChanged` is true when `locks/` is no longer the bound directory;
 * `claimSeen` is whether a claim was found at the path through the directory
 * as it now resolves. A claim seen after a swap is in the REPLACEMENT, so the
 * release (by path) removes it; one not seen was left in the directory moved away.
 */
export type Inspect =
  | { ok: true; claim: Id }
  | { ok: false; detail: string; dirChanged: boolean; claimSeen: boolean }

/** Check 3, and `ctx.recheck()`'s repeat of it: `locks/`, the claim and the folder's realpath still match. */
export function inspect(bound: Bound, lockPath: string): Inspect {
  const dir = path.dirname(lockPath)
  let claim: fs.BigIntStats | null = null
  try {
    claim = fs.lstatSync(lockPath, { bigint: true })
  } catch {
    claim = null
  }
  const claimSeen = claim !== null
  if (!same(lstatId(dir), bound.locks)) {
    return { ok: false, detail: 'its identity changed', dirChanged: true, claimSeen }
  }
  const fail = (detail: string): Inspect => ({ ok: false, detail, dirChanged: false, claimSeen })
  if (claim === null) return fail('the claim is not at its path')
  if (!claim.isFile() || claim.dev !== bound.locks.dev) {
    return fail('the claim is not a file on the same device')
  }
  try {
    if (fs.realpathSync.native(dir) !== bound.real) return fail('its path moved')
  } catch {
    return fail('its path no longer resolves')
  }
  return { ok: true, claim: { dev: claim.dev, ino: claim.ino } }
}
