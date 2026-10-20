/**
 * SMI-6531 (A1 step 2): the permission policy for `mkdir-parent-bits.ts`. What
 * a directory's actual mode may be, given the mode its parent has.
 *
 * Let P be the parent's mode and A the directory's, both `& 0o7777`.
 *
 *  - The owner class (0o700) and setuid (0o4000) never make a directory unsafe
 *    and are never reported: the owner can change the mode at will, so the mode
 *    is not a boundary against them (the identity checks protect the contents).
 *  - A class (group, other) REACHES the directory when P gives it execute: it
 *    can only get to the directory through the parent. For a reaching class,
 *    a read, write or execute bit A gives it that P does not is UNSAFE (wider),
 *    and a bit P gives it that A lacks is a warning. A class the parent does not
 *    let through is ignored: its bits in A change nobody's access (a root
 *    tightened to 0700 after a staging directory was made at 0755 is fine).
 *  - Setgid: A has it and P does not, with the group reaching: UNSAFE. P has it
 *    and A does not: a warning.
 *  - Sticky: P has it and A does not: UNSAFE when a reaching class can write
 *    to A (anyone who can write may rename or remove another user's entries),
 *    otherwise a warning. A has it and P does not: a warning.
 *  - Anything else is EXACT: no failure, no warning.
 *
 * A platform with no no-follow open (Windows) is not judged at all: its modes
 * are synthetic. The caller records the actual mode and warns that the bits
 * could not be verified.
 *
 * Every unsafe verdict comes with a remedy the directory's owner can run:
 * `chmod <P & 0o3777 with owner rwx> <path>`. That mode satisfies this policy
 * against P by construction (a reaching class has exactly P's bits, the
 * setgid/sticky bits match, the owner class is not judged).
 *
 * @module @skillsmith/core/install/mkdir-parent-bits.policy
 */

const SETGID = 0o2000
const STICKY = 0o1000
/** Every bit a mode can carry. */
const ALL_BITS = 0o7777
/** The bits the remedy sets: permissions, setgid and sticky; never setuid. */
const REMEDY_MASK = 0o3777
const OWNER_RWX = 0o700

export type ModeVerdict =
  /** Nothing to refuse and nothing to say. */
  | { kind: 'exact' }
  /** `actual` exposes the directory beyond the parent's access: `reasons` say how. */
  | { kind: 'unsafe'; reasons: string[] }
  /**
   * Not unsafe, but different where it matters: `missing` bits the parent has
   * and the directory lacks, `added` bits (sticky) the directory has and the
   * parent does not.
   */
  | { kind: 'narrower'; missing: string[]; added: string[] }

/** The classes a parent's execute bit lets through, with their shift and name. */
const REACHABLE_CLASSES = [
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

/** Judge `actual` against the parent's `want` by the policy in this module's header. */
export function judgeMode(want: number, actual: number): ModeVerdict {
  const p = want & ALL_BITS
  const a = actual & ALL_BITS
  const reaching = REACHABLE_CLASSES.filter(({ shift }) => ((p >> shift) & 0o1) !== 0)
  const groupReaches = reaching.some(({ name }) => name === 'group')
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
  if ((a & SETGID) !== 0 && (p & SETGID) === 0 && groupReaches) {
    unsafe.push('it has setgid where the parent does not')
  }
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

/** The mode that satisfies `judgeMode` against `want`: its permission, setgid and sticky bits, owner rwx. */
export function remedyMode(want: number): number {
  return (want & REMEDY_MASK) | OWNER_RWX
}

/** Quote a path for a POSIX shell only when it needs it. */
function shellQuote(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/** The command the directory's owner can run to make `dir` satisfy the policy against `want`. */
export function remedyCommand(dir: string, want: number): string {
  return `chmod ${octal(remedyMode(want))} ${shellQuote(dir)}`
}

/** The refusal text for an unsafe directory: both modes, why, and the owner's remedy. */
export function modeUnsafeMessage(a: {
  subject: string
  parent: string
  wanted: number
  actual: number
  reasons: readonly string[]
  remedy: string
}): string {
  return (
    `${a.subject} has mode ${octal(a.actual)} where ${a.parent} has ${octal(a.wanted)}: ` +
    `${a.reasons.join('; ')}. As its owner, run: ${a.remedy}`
  )
}
