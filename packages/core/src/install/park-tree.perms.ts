/**
 * SMI-6531 (A1 step 3a): the op-directory trust check (owner and mode), ported
 * from the SMI-6676 spike's `quarantine.perms.mjs`. One definition, used before
 * the rename and again after it, so the two sites cannot drift (SMI-7134).
 *
 * `POSIX_PERM_CHECKS` and `SELF_UID` are captured once at module load, so
 * deleting `process.getuid` later can neither switch the check off nor make it
 * throw (spike M-1, SMI-7128).
 *
 * @module @skillsmith/core/install/park-tree.perms
 */

/** File-type bits of a bigint `lstat` mode. */
export const S_IFMT = 0o170000n
export const S_IFDIR = 0o040000n
export const S_IFREG = 0o100000n
export const S_IFLNK = 0o120000n

/**
 * POSIX ownership and permission semantics apply everywhere but win32, decided
 * from `process.platform`, never from `typeof process.getuid` (a writable
 * property whose removal silently disabled both checks, spike M-1).
 */
const POSIX_PERM_CHECKS = process.platform !== 'win32'

/**
 * Our uid, captured at load, or null when this POSIX platform has no
 * `process.getuid` at load. A null here refuses rather than skips (SMI-7128).
 */
const SELF_UID: bigint | null =
  POSIX_PERM_CHECKS && typeof process.getuid === 'function' ? BigInt(process.getuid()) : null

/**
 * The one definition of "an op directory we may trust": owned by us and not
 * accessible to group or other (spike F12; the `mode: 0o700` given to `mkdir`
 * is discarded when EEXIST is accepted, so it must be checked).
 *
 * @returns the reason the directory is not trustworthy, or null when it is
 */
export function opDirOwnerModeProblem(st: { uid: bigint; mode: bigint }): string | null {
  if (POSIX_PERM_CHECKS && SELF_UID === null) {
    return 'cannot verify op directory ownership: process.getuid is unavailable'
  }
  if (POSIX_PERM_CHECKS && st.uid !== SELF_UID) return 'op directory is owned by another user'
  // win32 modes carry no POSIX permission semantics, so both checks skip there only.
  if (POSIX_PERM_CHECKS && (st.mode & 0o077n) !== 0n) {
    return `op directory is group- or world-accessible (mode ${(st.mode & 0o777n).toString(8)})`
  }
  return null
}
