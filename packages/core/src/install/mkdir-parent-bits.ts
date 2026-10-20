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
 * directory with the permission bits `(want | 0o700) & ~umask`, owner rwx
 * among them (the umask filters the rest). Whether the sticky and setgid bits
 * survive depends on the platform: macOS `mkdir` drops them, Linux keeps
 * sticky and inherits setgid from a setgid parent. An existing directory keeps
 * the bits it has (it belongs to whoever made it) but is judged by the policy
 * below, so a directory this call made and the policy refuses as `mode-unsafe`
 * is refused again by the next call, until its permissions are fixed or it is
 * removed; the same holds for a wider one planted before the call. Nothing is
 * ever removed here. The refusal prints no command: one to copy could run after
 * a swap for a symlink, and `chmod` follows it.
 *
 * What the mode check promises is PARITY with the parent: the directory never
 * gives other users more access, through the mode bits seen through the parent,
 * than the parent does. ACLs, bind mounts and other aliases are not modelled,
 * the same as for the parent's own files, and the check is not a boundary
 * against the directory's owner, who can `chmod` after it. The identity checks
 * protect the contents.
 *
 * Applying the bits can be refused without that being a failure of the
 * directory: a platform without `O_DIRECTORY`/`O_NOFOLLOW` (Windows) is not
 * chmodded at all, a filesystem that refuses `chmod` (vfat, CIFS, some NFS:
 * `EPERM`, `ENOTSUP`, `EROFS`) leaves the bits as made, and a kernel may clear
 * setgid when this process is not in the directory's group. So whatever
 * happened, the ACTUAL mode is read back from the descriptor and judged by
 * `mkdir-parent-bits.policy.ts`, whose header is the rule. Where there is no
 * descriptor, it is read from the final `lstat` and recorded, not judged (the
 * last bullet). In short:
 *
 *  - a class the parent lets through (other: the parent has other execute;
 *    group: it has group or other execute) with a read, write or execute bit
 *    the parent does not give it, or a lost sticky bit where a reaching class
 *    can write, FAILS the call (`mode-unsafe`, with the wanted and actual bits
 *    and the reasons). Bits of a class the parent does not let through, and
 *    owner and setuid bits, are not judged;
 *  - otherwise a reaching class with fewer bits than the parent, setgid
 *    dropped or added (it grants no access by itself), a sticky bit lost with
 *    no writer, or a sticky bit added is a
 *    different directory: the call succeeds, the cause is recorded as
 *    `bitsApplied` (`exact`, `mismatch` with the actual bits, `not-applied`
 *    with the reason, errno and actual bits), and `warnings` holds at most one
 *    sentence naming every difference and why. A caller that has a place to
 *    show a warning shows it;
 *  - on a platform with no no-follow open the mode is never judged, whether
 *    this call made the directory or found it: the mode there is synthetic, so
 *    the actual mode is recorded and a warning says the bits could not be
 *    verified.
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
import { judgeMode, octal } from './mkdir-parent-bits.policy.js'

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
  /** `fchmod` ran and the directory has other bits than wanted: the kernel cleared setgid, say. */
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
      /**
       * What became of the parent's bits. When this call did not make the
       * directory it is `not-applied` with reason `existing-directory` (the
       * steady state, not a difference), or `no-nofollow-open` on a platform
       * with no no-follow open, whether or not the call made it. It says nothing
       * about whether the bits match: `warnings` is that signal.
       */
      bitsApplied: BitsApplied
      /**
       * Empty when the directory's bits are the parent's. Otherwise at most one
       * sentence naming every difference: missing bits, added bits, or (on a
       * platform with no no-follow open) that the bits could not be verified.
       */
      warnings: string[]
    }
  | {
      ok: false
      /**
       * Where it stopped. `mkdir`/`lstat`/`open`/`fstat`/`chmod` carry an errno.
       * `changed` (replaced while the bits were being applied) carries one only
       * when the swap showed as a failed open (`ELOOP`/`ENOTDIR`), else null.
       * `not-directory` and `not-ours` (created by this call only) are verdicts
       * with no errno.
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
      errno: string | null
      /** True when this call's mkdir made the directory, on a refusal after it too. */
      created: boolean
    }
  | {
      ok: false
      /** The policy refused the directory's actual mode. */
      phase: 'mode-unsafe'
      errno: null
      /** True when this call's mkdir made the directory. */
      created: boolean
      /** The parent's bits. */
      wanted: number
      /** The directory's actual bits. */
      actual: number
      /** Why the policy refused the actual bits. */
      reasons: string[]
    }

/** @internal Test seam: not part of the contract. */
export interface MkdirParentBitsHooks {
  /** Runs after the first `lstat` and before the directory is opened. */
  beforeOpen?: () => void
}

type NoFollowConstants = Partial<Record<'O_RDONLY' | 'O_DIRECTORY' | 'O_NOFOLLOW', number>>

/** Module state, set only through `setNoFollowConstantsForTests`; never reachable from a call's arguments. */
let constantsForTests: NoFollowConstants | null = null

/**
 * @internal Test seam: pretend the platform has other open-flag constants (none
 * of `O_DIRECTORY`/`O_NOFOLLOW`, as on Windows). `null` restores the real
 * `fs.constants`. It is a module-level setter, not a parameter, so no argument
 * to `mkdirWithParentBits` can switch the platform exemption on; it refuses to
 * run outside vitest.
 */
export function setNoFollowConstantsForTests(constants: NoFollowConstants | null): void {
  if (process.env.VITEST === undefined) {
    throw new Error('setNoFollowConstantsForTests is a test seam and runs only under vitest')
  }
  constantsForTests = constants
}

function noFollowDirectoryFlags(): number | null {
  const c: NoFollowConstants = constantsForTests ?? fs.constants
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
 * the same policy (`mode-unsafe` when it exposes the directory beyond the
 * parent's access; a warning when it differs otherwise). Whoever owns an
 * existing directory is accepted (in a shared root another user may have made
 * it first); the entry must still be a real directory, never a symlink.
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
      // No no-follow open (Windows): the mode is synthetic, so it is not judged.
      noFollowDirectoryFlags() === null
        ? { kind: 'no-nofollow-open' }
        : { kind: 'existing-directory' },
      created,
      identityOf(st)
    )
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && st.uid !== BigInt(uid)) {
    return { ok: false, phase: 'not-ours', errno: null, created }
  }
  hooks.beforeOpen?.()
  const flags = noFollowDirectoryFlags()
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
  if (how.kind === 'no-nofollow-open') {
    // No descriptor, no real mode to trust (Windows): never refuse on it.
    return {
      ok: true,
      created,
      identity,
      bitsApplied: { state: 'not-applied', reason: how.kind, errno: null, actual },
      warnings: [
        `${dir} has mode ${octal(actual)}; its parent's ${octal(want)} could not be verified on ` +
          `this platform (${causeOf(how)})`,
      ],
    }
  }
  const verdict = judgeMode(want, actual)
  if (verdict.kind === 'unsafe') {
    return {
      ok: false,
      phase: 'mode-unsafe',
      errno: null,
      created,
      wanted: want,
      actual,
      reasons: verdict.reasons,
    }
  }
  const bitsApplied: BitsApplied =
    how.kind === 'applied'
      ? actual === want
        ? { state: 'exact' }
        : { state: 'mismatch', wanted: want, actual }
      : {
          state: 'not-applied',
          reason: how.kind,
          errno: how.kind === 'chmod-refused' ? how.errno : null,
          actual,
        }
  const differences =
    verdict.kind === 'narrower'
      ? [
          ...(verdict.missing.length > 0 ? [`missing: ${verdict.missing.join(', ')}`] : []),
          ...(verdict.added.length > 0 ? [`added: ${verdict.added.join(', ')}`] : []),
        ]
      : []
  const warnings =
    differences.length > 0
      ? [
          `${dir} has mode ${octal(actual)}, not its parent's ${octal(want)}; ` +
            `${differences.join('; ')} (${causeOf(how)})`,
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
