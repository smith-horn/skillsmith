/**
 * SMI-6531 (A1 step 3a): binding and comparing an entry's identity, ported
 * from the closures in the SMI-6676 spike's `quarantine.mjs`.
 *
 * Identity is (dev, ino, birthtimeNs, file type) from a bigint `lstat` (UD24).
 * The file type is part of it (SMI-7130): on Linux overlayfs a symlink created
 * where a directory was just deleted reused the inode number and, within one
 * clock tick, the birthtime, so (dev, ino, birthtimeNs) alone accepted the
 * symlink as the directory. An identity with no type never compares equal.
 *
 * @module @skillsmith/core/install/park-tree.identity
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import type { ParkIdentity } from './park-result.js'
import { errCode } from './park-result.js'
import { S_IFMT } from './park-tree.perms.js'

/** A bound identity: every field, file type included. */
export interface BoundIdentity {
  ok: true
  dev: bigint
  ino: bigint
  birthtimeNs: bigint
  fmt: bigint
}

export type BindResult = BoundIdentity | { ok: false; errno: string | null }

/** The identity a bigint `lstat` reports. */
export function identityOf(st: BigIntStats): BoundIdentity {
  return { ok: true, dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs, fmt: st.mode & S_IFMT }
}

/** Binds `p`'s identity now, without following a link at `p`. */
export function bindIdentity(p: string): BindResult {
  try {
    return identityOf(fs.lstatSync(p, { bigint: true }))
  } catch (err) {
    return { ok: false, errno: errCode(err) }
  }
}

/** Equal only when every field matches and `a` carries a file type (fail closed). */
export function sameIdentity(a: ParkIdentity, b: ParkIdentity): boolean {
  return (
    typeof a.fmt === 'bigint' &&
    a.fmt === b.fmt &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeNs === b.birthtimeNs
  )
}
