/**
 * SMI-6531 (A1 step 3a): the park callers, one per row of the A1 plan's §3.8
 * park-caller table plus `doctor recovery --park` (§3.9), and what each one's
 * `held` detail says.
 *
 * A held tree's detail names `skillsmith restore <id>` only when the origin is
 * a place the user would want the tree back: never for a Skillsmith-internal
 * origin (a staging op dir, a mkdtemp staging folder, a backup folder), where
 * restoring would put a tree back into Skillsmith's own scratch space. The
 * spike named the restore command for every caller
 * (`quarantine.postmove.mjs:43-64`); the plan makes it caller-aware.
 *
 * `kind` stays a separate option, as §3.3 lists it, and must be this caller's
 * kind: three fan-out callers share `fan-out-overwrite` and two callers share
 * `install-rollback`, so the kind alone cannot pick the message.
 *
 * An internal-origin sentence never asserts where the tree is unless the
 * post-move check confirmed it (`safe`, SMI-7134): the detail's own location
 * clause already says when it could not be confirmed.
 *
 * @module @skillsmith/core/install/park-callers
 */
import path from 'node:path'

/** POSIX single-quote escaping, for paths quoted in a held `detail`. */
export const shq = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`

interface CallerSpec {
  /** §3.8 row(s), for the reader. */
  rows: string
  /** The §3.5 kind this caller parks with. */
  kind: string
  /** The held detail's closing sentence; null means the restore line. */
  internalOrigin:
    | ((a: { destPath: string; backupPath: string | null; safe: boolean }) => string)
    | null
}

const CALLERS = {
  'abort-cleanup': {
    rows: '1',
    kind: 'abort-new',
    internalOrigin: () =>
      'The staged copy changed while it was set aside. Its origin is a staging directory, so ' +
      'there is nothing to restore.',
  },
  'move-source': {
    rows: '2',
    kind: 'move-source',
    internalOrigin: ({ destPath, backupPath, safe }) =>
      `A write landed in the old folder while it was being backed up. The backup at ` +
      `${shq(String(backupPath))} doesn't have it; the extra copy ` +
      `${safe ? 'is' : 'was reported'} at ${shq(destPath)}.`,
  },
  uninstall: { rows: '3', kind: 'uninstall', internalOrigin: null },
  'fan-out-cleanup': { rows: '4', kind: 'fan-out-cleanup', internalOrigin: null },
  'fan-out-undo': { rows: '5', kind: 'fan-out-undo', internalOrigin: null },
  'fan-out-staging': {
    rows: '6',
    kind: 'fan-out-overwrite',
    internalOrigin: () =>
      'Its origin is a temporary staging folder, so there is nothing to restore.',
  },
  'fan-out-symlink': { rows: '7', kind: 'fan-out-overwrite', internalOrigin: null },
  'fan-out-backup': {
    rows: '8',
    kind: 'fan-out-overwrite',
    internalOrigin: () => 'Its origin is a backup folder, so there is nothing to restore.',
  },
  'install-rollback': { rows: '9', kind: 'install-rollback', internalOrigin: null },
  'activation-undo': { rows: '10, 11', kind: 'activation-undo', internalOrigin: null },
  'init-rollback': { rows: '12', kind: 'init-rollback', internalOrigin: null },
  'agent-uninstall': { rows: '13', kind: 'agent-uninstall', internalOrigin: null },
  'companion-rollback': { rows: '14', kind: 'install-rollback', internalOrigin: null },
  'doctor-park': {
    rows: '§3.9 doctor recovery --park',
    kind: 'unreadable-record',
    internalOrigin: () =>
      'Its origin is an op directory in the staging area, so there is nothing to restore.',
  },
} as const satisfies Record<string, CallerSpec>

export type ParkCaller = keyof typeof CALLERS

/** Every caller name, in §3.8 row order. */
export const PARK_CALLERS = Object.keys(CALLERS) as ParkCaller[]

const has = (c: string): c is ParkCaller => Object.prototype.hasOwnProperty.call(CALLERS, c)

/**
 * Validates the caller, its kind, and `backupPath`, which `move-source` alone
 * requires (its held detail names the backup) and every other caller refuses.
 * Throws the TypeError the park's option refusals use.
 */
export function checkCaller(caller: unknown, kind: string, backupPath: unknown): ParkCaller {
  if (typeof caller !== 'string' || !has(caller)) {
    throw new TypeError(
      `parkTree: caller must be one of ${PARK_CALLERS.join(', ')}, got ${
        typeof caller === 'string' ? JSON.stringify(caller) : typeof caller
      }`
    )
  }
  const want = CALLERS[caller].kind
  if (kind !== want) {
    throw new TypeError(
      `parkTree: caller ${caller} parks with kind ${JSON.stringify(want)}, got ${JSON.stringify(kind)}`
    )
  }
  if (caller === 'move-source') {
    if (typeof backupPath !== 'string' || !path.isAbsolute(backupPath)) {
      throw new TypeError(
        'parkTree: caller move-source requires backupPath, the absolute path of the backup it made'
      )
    }
  } else if (backupPath !== undefined) {
    throw new TypeError(`parkTree: backupPath is only for caller move-source, not ${caller}`)
  }
  return caller
}

/**
 * The held detail's closing sentence: the restore line for a user-facing
 * origin, or the caller's own sentence for a Skillsmith-internal one.
 */
export function heldClosing(a: {
  caller: ParkCaller
  originPath: string
  destPath: string
  opId: string
  backupPath: string | null
  /** The post-move check confirmed the tree's location (SMI-7134). */
  safe: boolean
}): string {
  const internal: CallerSpec['internalOrigin'] = CALLERS[a.caller].internalOrigin
  if (internal !== null) {
    return internal({ destPath: a.destPath, backupPath: a.backupPath, safe: a.safe })
  }
  return (
    `If something now exists at ${shq(a.originPath)}, move it aside first, then run ` +
    `\`skillsmith restore ${a.opId}\`.`
  )
}
