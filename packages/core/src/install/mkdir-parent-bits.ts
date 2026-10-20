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
 * The directory is made with the parent's bits plus owner read, write and
 * execute (`want | 0o700`), so a parent whose owner lacks read (`0333`) still
 * gives a directory this process can open; the `fchmod` then sets exactly the
 * parent's bits.
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
 * directory keeps the bits it has (it belongs to whoever made it), though it
 * is judged by the policy below: a directory this call made and refused as
 * `mode-unsafe` is refused again by the next call, and a wider one planted
 * before the call is refused too. Nothing is ever removed.
 *
 * Applying the bits can be refused without that being a failure of the
 * directory: a platform without `O_DIRECTORY`/`O_NOFOLLOW` (Windows) is not
 * chmodded at all, a filesystem that refuses `chmod` (vfat, CIFS, some NFS:
 * `EPERM`, `ENOTSUP`, `EROFS`) leaves the bits as made, and a kernel may clear
 * setgid when this process is not in the directory's group. So whatever
 * happened, the ACTUAL mode is read back (from the descriptor, or from the
 * final `lstat` where there is none) and judged by `mkdir-parent-bits.policy.ts`:
 *
 *  - a permission bit the parent does not have, or a sticky bit the parent
 *    has and the directory lacks, FAILS the call (`mode-unsafe`, with the
 *    wanted and actual bits);
 *  - otherwise any difference (setgid dropped, group/other write missing) is a
 *    narrower directory: the call succeeds, the cause is recorded as
 *    `bitsApplied` (`exact`, `mismatch` with the actual bits, `not-applied`
 *    with the reason, errno and actual bits), and `warnings` says in words
 *    which bits are missing and why. A caller that has a place to show a
 *    warning shows it.
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
import { judgeMode, missingBits, octal } from './mkdir-parent-bits.policy.js'

/** Permission bits, setgid and sticky; setuid is dropped (a directory's setuid is meaningless). */
export const PARENT_BITS_MASK = 0o3777

/** Owner read, write and execute: what the new directory always has, so this process can open it. */
const OWNER_RWX = 0o700

/** `chmod` errnos that mean "this filesystem will not take permission bits", not "this directory is bad". */
const CHMOD_REFUSED = new Set(['EPERM', 'ENOTSUP', 'EROFS'])

/** What happened to the parent's bits on the new directory. */
export type BitsApplied =
  /** `fchmod` ran and the directory now has exactly the wanted bits. */
  | { state: 'exact' }
  /** `fchmod` ran and the directory has other (narrower) bits: the kernel cleared setgid, say. */
  | { state: 'mismatch'; wanted: number; actual: number }
  /**
   * No bits were applied: why, the errno when a `fchmod` was refused, and the
   * mode the directory has.
   */
  | {
      state: 'not-applied'
      reason: 'existing-directory' | 'no-nofollow-open' | 'chmod-refused'
      errno: string | null
      actual: number
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
      /** One sentence per way the directory is narrower than the parent's bits; empty when it is not. */
      warnings: string[]
    }
  | {
      ok: false
      /**
       * Where it stopped. `mkdir`/`lstat`/`open`/`fstat`/`chmod` carry an errno.
       * `changed` (replaced while the bits were being applied) carries one only
       * when the swap showed as a failed open (`ELOOP`/`ENOTDIR`), else null.
       * `not-directory`, `not-ours` (created by this call only) and
       * `mode-unsafe` are verdicts with no errno.
       */
      phase:
        | 'mkdir'
        | 'lstat'
        | 'open'
        | 'fstat'
        | 'chmod'
        | 'not-directory'
        | 'not-ours'
        | 'changed'
        | 'mode-unsafe'
      errno: string | null
      /** True when this call's mkdir made the directory, on a refusal after it too. */
      created: boolean
      /** `mode-unsafe` only: the parent's bits and the directory's actual bits. */
      wanted?: number
      actual?: number
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

/** How the bits were (not) applied, before the actual mode is judged. */
type How =
  | { kind: 'applied' }
  | { kind: 'chmod-refused'; errno: string }
  | { kind: 'no-nofollow-open' }
  | { kind: 'existing-directory' }

/**
 * `mkdir dir` (non-recursive, `EEXIST` accepted) carrying `parentMode`'s bits.
 *
 * The bits are applied only when this call made the directory: an existing one
 * belongs to whoever made it and keeps its own bits, but its mode is judged by
 * the same policy (`mode-unsafe` when wider than the parent's or not sticky
 * under a sticky parent; a warning when narrower). An existing entry must
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
    fs.mkdirSync(dir, { mode: want | OWNER_RWX })
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
    // An existing directory is not changed, but it is judged by the same
    // policy as a new one: one planted before this call, or left behind by a
    // call that refused it as mode-unsafe, must not be accepted as it is.
    return judged(
      dir,
      want,
      Number(st.mode & 0o7777n),
      { kind: 'existing-directory' },
      created,
      identityOf(st)
    )
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && st.uid !== BigInt(uid)) {
    return { ok: false, phase: 'not-ours', errno: null, created }
  }
  hooks.beforeOpen?.()
  const flags = noFollowDirectoryFlags(hooks)
  let how: How
  let descriptorMode: number | null = null
  if (flags === null) {
    // No safe descriptor sequence on this platform: never chmod by path.
    how = { kind: 'no-nofollow-open' }
  } else {
    const applied = applyBitsThroughDescriptor(dir, flags, st, want)
    if (!applied.ok) return { ok: false, ...applied.refusal, created }
    how = applied.how
    descriptorMode = applied.actual
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
  // The descriptor's mode where there is one; otherwise the final lstat's.
  const actual = descriptorMode ?? Number(after.mode & 0o7777n)
  return judged(dir, want, actual, how, created, identityOf(after))
}

/** Judge the actual mode by the policy and build the result. */
function judged(
  dir: string,
  want: number,
  actual: number,
  how: How,
  created: boolean,
  identity: BoundIdentity
): MkdirParentBitsResult {
  const verdict = judgeMode(want, actual)
  if (verdict.kind === 'unsafe') {
    return { ok: false, phase: 'mode-unsafe', errno: null, created, wanted: want, actual }
  }
  const bitsApplied: BitsApplied =
    how.kind === 'applied'
      ? verdict.kind === 'exact'
        ? { state: 'exact' }
        : { state: 'mismatch', wanted: want, actual }
      : {
          state: 'not-applied',
          reason: how.kind,
          errno: how.kind === 'chmod-refused' ? how.errno : null,
          actual,
        }
  const warnings =
    verdict.kind === 'narrower'
      ? [
          `${dir} has mode ${octal(actual)}, not its parent's ${octal(want)}; missing: ` +
            `${missingBits(want, actual).join(', ')} (${causeOf(how)})`,
        ]
      : []
  return { ok: true, created, identity, bitsApplied, warnings }
}

function causeOf(how: How): string {
  switch (how.kind) {
    case 'applied':
      return 'chmod ran, but the filesystem or kernel left these bits unset'
    case 'chmod-refused':
      return `the filesystem refused chmod: ${how.errno}`
    case 'no-nofollow-open':
      return "this platform has no no-follow directory open, so the parent's bits were not applied"
    case 'existing-directory':
      return 'the directory already existed and was left as it is'
  }
}

type Refusal = {
  phase: 'open' | 'fstat' | 'chmod' | 'changed'
  errno: string | null
}
type Applied = { ok: true; how: How; actual: number } | { ok: false; refusal: Refusal }

/**
 * Close a descriptor without letting a failure replace the result. It is a
 * read-only directory descriptor: nothing is buffered and nothing can be lost
 * by a failed close, and a `finally` that throws would discard the outcome of
 * the work already done (or a refusal that is the real answer).
 */
function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd)
  } catch {
    // Deliberately dropped: see above.
  }
}

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
    let opened: BigIntStats
    try {
      opened = fs.fstatSync(fd, { bigint: true })
    } catch (err) {
      return { ok: false, refusal: { phase: 'fstat', errno: errCode(err) } }
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (
      !opened.isDirectory() ||
      !sameIdentity(identityOf(before), identityOf(opened)) ||
      (uid !== null && opened.uid !== BigInt(uid))
    ) {
      return { ok: false, refusal: { phase: 'changed', errno: null } }
    }
    let how: How = { kind: 'applied' }
    try {
      fs.fchmodSync(fd, want)
    } catch (err) {
      const errno = errCode(err)
      if (errno === null || !CHMOD_REFUSED.has(errno)) {
        return { ok: false, refusal: { phase: 'chmod', errno } }
      }
      // Refused: the mode is whatever the mkdir left, read before the close.
      how = { kind: 'chmod-refused', errno }
    }
    try {
      const actual = Number(fs.fstatSync(fd, { bigint: true }).mode & 0o7777n)
      return { ok: true, how, actual }
    } catch (err) {
      return { ok: false, refusal: { phase: 'fstat', errno: errCode(err) } }
    }
  } finally {
    closeQuietly(fd)
  }
}
