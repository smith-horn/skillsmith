/**
 * SMI-6531 (A1 step 2, C5; fixes SMI-7149): create a directory that carries its
 * parent's permission bits, sticky and setgid included.
 *
 * A `mkdir` with a `mode` cannot do this on its own: the process umask is
 * applied to the request, so under umask 022 a parent of `1777` gives `1755`
 * on Linux and `0755` on macOS, and `0777` gives `0755`. In a shared root that
 * leaves every other user unable to create entries in the new directory (A1
 * plan §3.2, E31). So the directory is made, checked to be the directory this
 * call made, then `chmod`ed to the parent's bits, then checked again.
 *
 * The `chmod` follows a symlink and `lchmod` is macOS-only, so a swap of the
 * new directory between the check and the `chmod` is a one-syscall residual
 * (A1 plan §3.0 item 9); the re-`lstat` after it detects the swap but cannot
 * undo a `chmod` that already landed on the swapped target.
 *
 * Shared by `services/skill-write-lock.ts` (the staging directory) and
 * `install/park-tree.destination.ts` (the parked area).
 *
 * @module @skillsmith/core/install/mkdir-parent-bits
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { errCode } from './park-result.js'
import { identityOf, sameIdentity } from './park-tree.identity.js'
import type { BoundIdentity } from './park-tree.identity.js'

/** Permission bits, setgid and sticky; setuid is dropped (a directory's setuid is meaningless). */
export const PARENT_BITS_MASK = 0o3777

export type MkdirParentBitsResult =
  | {
      ok: true
      /** True only when this call's mkdir made the directory (not EEXIST). */
      created: boolean
      /** The directory's identity from the last `lstat` this call made. */
      identity: BoundIdentity
    }
  | {
      ok: false
      /**
       * Where it stopped. `mkdir`/`lstat`/`chmod` carry an errno; the other
       * three are verdicts: not a real directory, not owned by this process
       * (created by this call only), or replaced during the `chmod`.
       */
      phase: 'mkdir' | 'lstat' | 'chmod' | 'not-directory' | 'not-ours' | 'changed'
      errno: string | null
      /** True when this call's mkdir made the directory, on a refusal after it too. */
      created: boolean
    }

/**
 * `mkdir dir` (non-recursive, `EEXIST` accepted) carrying `parentMode`'s bits.
 *
 * The bits are applied only when this call made the directory: an existing one
 * belongs to whoever made it and keeps its own bits. An existing entry must
 * still be a real directory, never a symlink.
 */
export function mkdirWithParentBits(dir: string, parentMode: number): MkdirParentBitsResult {
  const want = parentMode & PARENT_BITS_MASK
  let created = false
  try {
    fs.mkdirSync(dir, { mode: want })
    created = true
  } catch (err) {
    if (errCode(err) !== 'EEXIST')
      return { ok: false, phase: 'mkdir', errno: errCode(err), created }
  }
  let st: BigIntStats
  try {
    st = fs.lstatSync(dir, { bigint: true })
  } catch (err) {
    return { ok: false, phase: 'lstat', errno: errCode(err), created }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { ok: false, phase: 'not-directory', errno: null, created }
  }
  if (!created) return { ok: true, created, identity: identityOf(st) }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && st.uid !== BigInt(uid)) {
    return { ok: false, phase: 'not-ours', errno: null, created }
  }
  try {
    fs.chmodSync(dir, want)
  } catch (err) {
    return { ok: false, phase: 'chmod', errno: errCode(err), created }
  }
  let after: BigIntStats
  try {
    after = fs.lstatSync(dir, { bigint: true })
  } catch (err) {
    return { ok: false, phase: 'lstat', errno: errCode(err), created }
  }
  if (after.isSymbolicLink() || !sameIdentity(identityOf(st), identityOf(after))) {
    return { ok: false, phase: 'changed', errno: null, created }
  }
  return { ok: true, created, identity: identityOf(after) }
}
