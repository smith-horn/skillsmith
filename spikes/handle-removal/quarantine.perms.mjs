// SMI-7134: the F12 op-directory trust check (owner and mode), shared by the pre-move
// validation in quarantine.mjs and the post-move verification in
// quarantine.verify.mjs so the two sites cannot drift. Split out for file length.
// POSIX_PERM_CHECKS and SELF_UID are captured ONCE at module load (M-1, SMI-7128).

export const S_IFMT = 0o170000n // file-type bits of a bigint lstat mode

/**
 * Whether POSIX ownership/permission semantics apply to a directory mode here:
 * every platform except win32, decided from `process.platform` (always defined).
 * M-1: not from `typeof process.getuid === 'function'`, a writable property whose
 * removal silently disabled BOTH F12 checks and left no trace in the result.
 */
const POSIX_PERM_CHECKS = process.platform !== 'win32'
/**
 * Our own uid, captured once at load, or null when this POSIX platform has no
 * `process.getuid` at load time. Captured here so a later deletion of
 * `process.getuid` cannot switch the check off or make it throw. A null on a
 * POSIX platform is never a skip: the F12 ownership check refuses instead
 * (SMI-7128), because ownership cannot be verified. win32 keeps skipping both.
 */
const SELF_UID =
  POSIX_PERM_CHECKS && typeof process.getuid === 'function' ? BigInt(process.getuid()) : null

/**
 * F12, the ONE definition of "an op directory we may trust": owned by us and not
 * accessible to group or other. Used before the rename (quarantine.mjs) and again
 * after it (verifyAtDestination, SMI-7134), so the two sites cannot drift.
 * @param {{uid:bigint, mode:bigint}} st - a bigint lstat of the op directory
 * @returns {string|null} the reason it is not trustworthy, or null when it is
 */
export function opDirOwnerModeProblem(st) {
  // If this POSIX platform had no process.getuid at load, ownership cannot be
  // verified, so refuse: a missing getuid must not read as a pass (SMI-7128).
  if (POSIX_PERM_CHECKS && SELF_UID === null) {
    return 'cannot verify op directory ownership: process.getuid is unavailable'
  }
  if (POSIX_PERM_CHECKS && st.uid !== SELF_UID) return 'op directory is owned by another user'
  // R5-9: Windows reports directory modes that do not carry POSIX permission
  // semantics (all three plausible shapes fail this mask), so both checks are
  // skipped there and only there (POSIX_PERM_CHECKS).
  if (POSIX_PERM_CHECKS && (st.mode & 0o077n) !== 0n) {
    return `op directory is group- or world-accessible (mode ${(st.mode & 0o777n).toString(8)})`
  }
  return null
}
