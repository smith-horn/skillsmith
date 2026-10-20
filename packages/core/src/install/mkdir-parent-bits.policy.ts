/**
 * SMI-6531 (A1 step 2): the permission policy for `mkdir-parent-bits.ts`. What
 * a new directory's actual mode may be, given the mode its parent asked for.
 *
 * Two questions, answered from the two numbers alone:
 *
 *  - Is it SAFE? A directory with a permission bit its parent does not have
 *    exposes the contents beyond the parent's access policy (a filesystem that
 *    ignores `fchmod` but reports `0777` under a `0700` parent), and a wanted
 *    sticky bit that is missing lets any user with write access rename or
 *    remove another user's entries. Either is a failure.
 *  - Otherwise, is it EXACT? A mode that only lacks bits the parent has (a
 *    kernel that cleared setgid, a filesystem that refused `chmod` under a
 *    narrower umask) is narrower, not wider: the call succeeds and the
 *    shortfall is reported in words.
 *
 * @module @skillsmith/core/install/mkdir-parent-bits.policy
 */

/** The setgid and sticky bits. */
const SETGID = 0o2000
const STICKY = 0o1000
/** Every bit a mode can carry. */
const ALL_BITS = 0o7777

export type ModeVerdict =
  /** `actual` is exactly `want`. */
  | { kind: 'exact' }
  /** `actual` has a bit `want` lacks, or `want` is sticky and `actual` is not. */
  | { kind: 'unsafe' }
  /** `actual` lacks only bits `want` has: `missing` names them. */
  | { kind: 'narrower'; missing: string[] }

const CLASSES = [
  { name: 'owner', shift: 6 },
  { name: 'group', shift: 3 },
  { name: 'other', shift: 0 },
] as const
const PERMISSIONS = [
  { name: 'read', bit: 0o4 },
  { name: 'write', bit: 0o2 },
  { name: 'execute', bit: 0o1 },
] as const

/** A mode as four octal digits: `0755`, `2775`, `1777`. */
export function octal(mode: number): string {
  return mode.toString(8).padStart(4, '0')
}

/** Names of the bits in `want` that `actual` lacks: `setgid`, `group write`, and so on. */
export function missingBits(want: number, actual: number): string[] {
  const missing: string[] = []
  if ((want & STICKY) !== 0 && (actual & STICKY) === 0) missing.push('sticky')
  if ((want & SETGID) !== 0 && (actual & SETGID) === 0) missing.push('setgid')
  for (const { name, shift } of CLASSES) {
    for (const permission of PERMISSIONS) {
      const bit = permission.bit << shift
      if ((want & bit) !== 0 && (actual & bit) === 0) missing.push(`${name} ${permission.name}`)
    }
  }
  return missing
}

/** Judge `actual` against `want` by the policy in this module's header. */
export function judgeMode(want: number, actual: number): ModeVerdict {
  const extra = actual & ~want & ALL_BITS
  const lostSticky = (want & STICKY) !== 0 && (actual & STICKY) === 0
  if (extra !== 0 || lostSticky) return { kind: 'unsafe' }
  if (actual === want) return { kind: 'exact' }
  return { kind: 'narrower', missing: missingBits(want, actual) }
}
