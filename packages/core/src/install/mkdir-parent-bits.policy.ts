/**
 * SMI-6531 (A1 step 2): the permission policy for `mkdir-parent-bits.ts`. What
 * a directory's actual mode may be, given the mode its parent has.
 *
 * THE PROMISE is parity with the parent: the directory never gives other users
 * more access, through the mode bits as seen through the parent, than the
 * parent itself does. It is a promise about mode bits and nothing else. ACLs,
 * bind mounts and other aliases of the directory are not modelled, the same as
 * they are not for the parent's own files, and the check is not a boundary
 * against the directory's owner, who can `chmod` after the check.
 *
 * Let P be the parent's mode and A the directory's, both `& 0o7777`.
 *
 *  - The owner class (0o700) and setuid (0o4000) never make a directory unsafe
 *    and are never reported: the owner can change the mode at will, so the mode
 *    is not a boundary against them (the identity checks protect the contents).
 *  - A class REACHES the directory when it can get to it through the parent.
 *    The other class reaches when P gives other execute (`P & 0o001`). The
 *    group class reaches when P gives group OR other execute (`P & 0o011`): a
 *    member of the directory's group traverses the parent through its other
 *    execute bit, and the directory's group can differ from the parent's (on
 *    Linux a new directory takes the process's egid). For a reaching class, a
 *    read, write or execute bit A gives it that P does not is UNSAFE (wider),
 *    and a bit P gives it that A lacks is a warning. A class the parent does not
 *    let through is ignored: its bits in A change nobody's access (a root
 *    tightened to 0700 after a staging directory was made at 0755 is fine).
 *  - Setgid: it grants no access by itself. A has it and P does not: a warning
 *    (setgid added). P has it and A does not: a warning (setgid missing).
 *  - Sticky: P has it and A does not: UNSAFE when a reaching class can write
 *    to A (anyone who can write may rename or remove another user's entries),
 *    otherwise a warning. A has it and P does not: a warning.
 *  - Anything else is EXACT: no failure, no warning.
 *
 * A platform with no no-follow open (Windows) is not judged at all: its modes
 * are synthetic. The caller records the actual mode and warns that the bits
 * could not be verified.
 *
 * An unsafe verdict is refused with a message that names both modes and the
 * reasons and says what is wrong; it prints no command. A command printed for
 * the user to copy could be run after a group member swapped the directory for
 * a symlink, and `chmod` follows it.
 *
 * @module @skillsmith/core/install/mkdir-parent-bits.policy
 */

const SETGID = 0o2000
const STICKY = 0o1000
/** Every bit a mode can carry. */
const ALL_BITS = 0o7777

/** Why a directory was refused for its mode: both modes, the reasons, and the sentence built from them. */
export interface ModeProblem {
  /** The parent's bits. */
  wanted: number
  /** The directory's actual bits. */
  actual: number
  reasons: string[]
  /** One sentence: both modes, the reasons, what must hold. No command. */
  message: string
}

export type ModeVerdict =
  /** Nothing to refuse and nothing to say. */
  | { kind: 'exact' }
  /** `actual` exposes the directory beyond the parent's access: `reasons` say how. */
  | { kind: 'unsafe'; reasons: string[] }
  /**
   * Not unsafe, but different where it matters: `missing` bits the parent has
   * and the directory lacks, `added` bits (sticky, setgid) the directory has and
   * the parent does not.
   */
  | { kind: 'narrower'; missing: string[]; added: string[] }

/** The classes the parent can let through, with their shift, name and the parent bits that let them. */
const REACHABLE_CLASSES = [
  { name: 'group', shift: 3, via: 0o011 },
  { name: 'other', shift: 0, via: 0o001 },
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

/** Judge `actual` against the parent's `want` by the policy in this module's header. */
export function judgeMode(want: number, actual: number): ModeVerdict {
  const p = want & ALL_BITS
  const a = actual & ALL_BITS
  const reaching = REACHABLE_CLASSES.filter(({ via }) => (p & via) !== 0)
  const unsafe: string[] = []
  const missing: string[] = []
  const added: string[] = []

  if ((p & STICKY) !== 0 && (a & STICKY) === 0) {
    const writers = reaching.filter(({ shift }) => ((a >> shift) & 0o2) !== 0).map((c) => c.name)
    if (writers.length > 0) {
      unsafe.push(`it lost the parent's sticky bit while ${writers.join(' and ')} can write to it`)
    } else {
      missing.push('sticky')
    }
  }
  if ((a & STICKY) !== 0 && (p & STICKY) === 0) added.push('sticky')
  if ((p & SETGID) !== 0 && (a & SETGID) === 0) missing.push('setgid')
  if ((a & SETGID) !== 0 && (p & SETGID) === 0) added.push('setgid')
  for (const { name, shift } of reaching) {
    for (const permission of PERMISSIONS) {
      const bit = permission.bit << shift
      if ((a & bit) !== 0 && (p & bit) === 0) {
        unsafe.push(`${name} ${permission.name} is allowed where the parent does not allow it`)
      }
      if ((p & bit) !== 0 && (a & bit) === 0) missing.push(`${name} ${permission.name}`)
    }
  }

  if (unsafe.length > 0) return { kind: 'unsafe', reasons: unsafe }
  if (missing.length === 0 && added.length === 0) return { kind: 'exact' }
  return { kind: 'narrower', missing, added }
}

/**
 * The refusal text for an unsafe directory: both modes, why, and what must
 * hold. It carries no command (see the module header).
 */
export function modeUnsafeMessage(a: {
  subject: string
  parent: string
  wanted: number
  actual: number
  reasons: readonly string[]
}): string {
  return (
    `${a.subject} has mode ${octal(a.actual)} where ${a.parent} has ${octal(a.wanted)}: ` +
    `${a.reasons.join('; ')}. It must not give other users more access than ${a.parent} does. ` +
    `Fix its permissions or remove it; if another user owns it, ask them.`
  )
}

/** The `ModeProblem` for a refused directory, its message included. */
export function modeProblemOf(a: {
  subject: string
  parent: string
  wanted: number
  actual: number
  reasons: readonly string[]
}): ModeProblem {
  return {
    wanted: a.wanted,
    actual: a.actual,
    reasons: [...a.reasons],
    message: modeUnsafeMessage(a),
  }
}
