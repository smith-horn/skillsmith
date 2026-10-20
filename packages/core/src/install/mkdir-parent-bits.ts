/**
 * SMI-6531 (A1 step 2, C5; fixes SMI-7149): create a directory that carries its
 * parent's permission bits, sticky and setgid included.
 *
 * A `mkdir` with a `mode` cannot do this on its own: the process umask is
 * applied to the request, so under umask 022 a parent of `1777` gives `1755`
 * on Linux and `0755` on macOS, and `0777` gives `0755`. In a shared root that
 * leaves every other user unable to create entries in the new directory (A1
 * plan §3.2, E31). So the directory is made, checked to be the directory this
 * call made, and its bits are applied through a descriptor.
 *
 * The bits are applied with `fchmod` on a descriptor opened `O_RDONLY |
 * O_DIRECTORY | O_NOFOLLOW`, never with a `chmod` by path: a path `chmod`
 * follows a symlink swapped in after the check and would change the mode of
 * whatever it points at. The descriptor is `fstat`ed against the first `lstat`
 * (same device and inode, same owner) before the `fchmod`, so only the
 * directory this call made is ever changed. A swap before the open fails the
 * open (`ELOOP`/`ENOTDIR`) and is reported as `changed`; a swap after it
 * changes nothing, because the descriptor still names the original directory.
 *
 * What is not closed: a crash between the `mkdir` and the `fchmod` leaves the
 * directory with the umask-filtered bits for good, because an existing
 * directory is accepted as it is (it belongs to whoever made it).
 *
 * Applying the bits can be refused without that being a failure of the
 * directory: a platform without `O_DIRECTORY`/`O_NOFOLLOW` (Windows) is not
 * chmodded at all, a filesystem that refuses `chmod` (vfat, CIFS, some NFS:
 * `EPERM`, `ENOTSUP`, `EROFS`) leaves the bits as made, and a kernel may clear
 * setgid when this process is not in the directory's group. Each is reported on
 * the result as `bitsApplied` (`exact`, `mismatch` with the actual bits,
 * `not-applied` with the reason and errno) and the call still succeeds, the way
 * `dir-sync.ts` reports an unsupported sync.
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

/** `chmod` errnos that mean "this filesystem will not take permission bits", not "this directory is bad". */
const CHMOD_REFUSED = new Set(['EPERM', 'ENOTSUP', 'EROFS'])

/** What happened to the parent's bits on the new directory. */
export type BitsApplied =
  /** `fchmod` ran and the directory now has exactly the wanted bits. */
  | { state: 'exact' }
  /** `fchmod` ran and the directory has other bits (the kernel cleared setgid, say). */
  | { state: 'mismatch'; wanted: number; actual: number }
  /** No bits were applied: why, and the errno when a `fchmod` was refused. */
  | {
      state: 'not-applied'
      reason: 'existing-directory' | 'no-nofollow-open' | 'chmod-refused'
      errno: string | null
    }

export type MkdirParentBitsResult =
  | {
      ok: true
      /** True only when this call's mkdir made the directory (not EEXIST). */
      created: boolean
      /** The directory's identity from the last `lstat` this call made. */
      identity: BoundIdentity
      /** What became of the parent's bits; `existing-directory` when this call did not make it. */
      bitsApplied: BitsApplied
    }
  | {
      ok: false
      /**
       * Where it stopped. `mkdir`/`lstat`/`open`/`chmod` carry an errno; the
       * other three are verdicts: not a real directory, not owned by this
       * process (created by this call only), or replaced while the bits were
       * being applied.
       */
      phase: 'mkdir' | 'lstat' | 'open' | 'chmod' | 'not-directory' | 'not-ours' | 'changed'
      errno: string | null
      /** True when this call's mkdir made the directory, on a refusal after it too. */
      created: boolean
    }

/** @internal Test seams: not part of the contract. */
export interface MkdirParentBitsHooks {
  /** Runs after the first `lstat` and before the directory is opened. */
  beforeOpen?: () => void
  /** Replaces `fs.constants` for the open-flag lookup (a platform without `O_NOFOLLOW`). */
  constants?: Partial<Record<'O_RDONLY' | 'O_DIRECTORY' | 'O_NOFOLLOW', number>>
}

function noFollowDirectoryFlags(hooks: MkdirParentBitsHooks): number | null {
  const c = hooks.constants ?? fs.constants
  if (c.O_DIRECTORY === undefined || c.O_NOFOLLOW === undefined) return null
  return (c.O_RDONLY ?? 0) | c.O_DIRECTORY | c.O_NOFOLLOW
}

/**
 * `mkdir dir` (non-recursive, `EEXIST` accepted) carrying `parentMode`'s bits.
 *
 * The bits are applied only when this call made the directory: an existing one
 * belongs to whoever made it and keeps its own bits. An existing entry must
 * still be a real directory, never a symlink.
 */
export function mkdirWithParentBits(
  dir: string,
  parentMode: number,
  hooks: MkdirParentBitsHooks = {}
): MkdirParentBitsResult {
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
  if (!created) {
    const bitsApplied: BitsApplied = {
      state: 'not-applied',
      reason: 'existing-directory',
      errno: null,
    }
    return { ok: true, created, identity: identityOf(st), bitsApplied }
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && st.uid !== BigInt(uid)) {
    return { ok: false, phase: 'not-ours', errno: null, created }
  }
  hooks.beforeOpen?.()
  const flags = noFollowDirectoryFlags(hooks)
  let bitsApplied: BitsApplied
  if (flags === null) {
    // No safe descriptor sequence on this platform: never chmod by path.
    bitsApplied = { state: 'not-applied', reason: 'no-nofollow-open', errno: null }
  } else {
    const applied = applyBitsThroughDescriptor(dir, flags, st, want)
    if (!applied.ok) return { ok: false, ...applied.refusal, created }
    bitsApplied = applied.bitsApplied
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
  return { ok: true, created, identity: identityOf(after), bitsApplied }
}

type Refusal = {
  phase: 'open' | 'chmod' | 'changed'
  errno: string | null
}
type Applied = { ok: true; bitsApplied: BitsApplied } | { ok: false; refusal: Refusal }

/** Open `dir` without following a symlink, check it is the directory `before` described, `fchmod` it. */
function applyBitsThroughDescriptor(
  dir: string,
  flags: number,
  before: BigIntStats,
  want: number
): Applied {
  let fd: number
  try {
    fd = fs.openSync(dir, flags)
  } catch (err) {
    const errno = errCode(err)
    // A symlink (or anything but a directory) where our directory was.
    if (errno === 'ELOOP' || errno === 'ENOTDIR') {
      return { ok: false, refusal: { phase: 'changed', errno } }
    }
    return { ok: false, refusal: { phase: 'open', errno } }
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (
      !opened.isDirectory() ||
      !sameIdentity(identityOf(before), identityOf(opened)) ||
      (uid !== null && opened.uid !== BigInt(uid))
    ) {
      return { ok: false, refusal: { phase: 'changed', errno: null } }
    }
    try {
      fs.fchmodSync(fd, want)
    } catch (err) {
      const errno = errCode(err)
      if (errno !== null && CHMOD_REFUSED.has(errno)) {
        return {
          ok: true,
          bitsApplied: { state: 'not-applied', reason: 'chmod-refused', errno },
        }
      }
      return { ok: false, refusal: { phase: 'chmod', errno } }
    }
    const actual = Number(fs.fstatSync(fd, { bigint: true }).mode & 0o7777n)
    return {
      ok: true,
      bitsApplied:
        actual === want ? { state: 'exact' } : { state: 'mismatch', wanted: want, actual },
    }
  } finally {
    fs.closeSync(fd)
  }
}
