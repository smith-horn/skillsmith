/**
 * SMI-6531 (A1 step 6a-iii): the pure schema check of `park-intent.json`,
 * split from `skill-swap.intent.ts` so doctor's classifier, which may not
 * import a module that touches the filesystem except through its reader
 * (design § 2 "One reader, one digest"), can judge an intent it read.
 *
 * @module @skillsmith/core/services/skill-swap.intent-schema
 */
import { hasAttributionStrings } from './skill-swap.attribution.js'
import type { ParkIntent, ParkIntentKind, RecordIdentity } from './skill-swap.types.js'

const KINDS: ReadonlySet<unknown> = new Set<ParkIntentKind>(['abort-new', 'move-source'])

/**
 * The default byte cap for `park-intent.json` and its temp (64 KiB, as the
 * sidecar's). A path cannot exceed about 4 KiB (`PATH_MAX`), so every real
 * intent fits and no state root is too deep to finish a recorded op (SMI-7205).
 * Read the cap in force with `intentCap()`, never this constant.
 */
export const INTENT_CAP = 64 * 1024

let capInForce = INTENT_CAP

/**
 * The reader's byte cap for `park-intent.json` and its temp: a read that fills
 * the cap may be cut off, so it is not parsed. The one value both the
 * classifier's reads and the writer's round trip use.
 */
export function intentCap(): number {
  return capInForce
}

/**
 * @internal Test seam: lowers (or, with `null`, restores) the cap for the
 * writer and the reader together, so a refusal test needs no 64 KiB path. Not
 * exported by the package (`exports` lists no deep path to this module and the
 * barrels do not re-export it), and it throws unless the process is a vitest
 * worker (`VITEST=true`, set by vitest itself), so no production caller can
 * move the cap.
 */
export function setIntentCapForTest(cap: number | null): void {
  if (process.env.VITEST !== 'true') throw new Error('setIntentCapForTest is for tests only')
  if (cap !== null && (!Number.isInteger(cap) || cap < 1)) throw new Error(`bad intent cap ${cap}`)
  capInForce = cap ?? INTENT_CAP
}

/**
 * What the reader makes of an intent file's bytes, read with `intentCap()`: the
 * parsed JSON, or null when the read reached the cap or the bytes are not JSON.
 */
export function intentValueOf(bytes: Buffer | null): unknown {
  if (bytes === null || bytes.length >= capInForce) return null
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return null
  }
}

const DECIMAL = /^(0|[1-9][0-9]*)$/
const ABORT_KEYS = 'kind,opId,opIdentity,owner,schema'
/** Schema 2 (6b-ii, O1): an `abort-new` intent that also carries the attribution's five strings. */
const ABORT_KEYS_V2 = 'client,dirName,kind,manifestKey,opId,opIdentity,owner,schema,scope,stateRoot'
const MOVE_SOURCE_KEYS = 'backupPath,kind,opId,opIdentity,owner,schema'

/** The exact keys for the intent's kind and schema; null for a combination no writer makes. */
function keysFor(o: Record<string, unknown>): string | null {
  if (o.kind === 'move-source') return o.schema === 1 ? MOVE_SOURCE_KEYS : null
  if (o.schema === 1) return ABORT_KEYS
  return o.schema === 2 ? ABORT_KEYS_V2 : null
}

/** An absolute POSIX path with no NUL, `.` or `..` component: where the verified copy is. */
function isBackupPath(v: unknown): v is string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.includes('\0')) return false
  return v
    .split('/')
    .slice(1)
    .every((c) => c !== '' && c !== '.' && c !== '..')
}

function isRecordIdentity(v: unknown): v is RecordIdentity {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort().join(',')
  return (
    keys === 'birthtimeNs,dev,fmt,ino' &&
    ['dev', 'ino', 'birthtimeNs', 'fmt'].every(
      (k) => typeof o[k] === 'string' && DECIMAL.test(o[k] as string)
    )
  )
}

/**
 * True when `value` is an owner a park intent may carry: exactly `host`, `pid`
 * and `uid`, a string host and integer pid and uid. Part of `isParkIntentFor`.
 * Passing it does not make an intent readable: a long `host` can still push the
 * intent past `intentCap()`. What a writer may write is decided only by the
 * round trip (`readableIntentBytes`, `skill-swap.intent.ts`), which runs this
 * check and the cap on the exact bytes.
 */
export function isIntentOwner(value: unknown): value is ParkIntent['owner'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const owner = value as Record<string, unknown>
  if (Object.keys(owner).sort().join(',') !== 'host,pid,uid') return false
  return (
    Number.isInteger(owner.pid) && typeof owner.host === 'string' && Number.isInteger(owner.uid)
  )
}

/**
 * True when `value` is a park intent for `opId` with `opIdentity` (the
 * acceptance doctor's `--clean-staging` applies, step 6). Exact keys, exact
 * types, and a kind of `abort-new` or `move-source` (the park doctor then
 * finishes): anything else is refused, never repaired. Schema 1 (both kinds)
 * and schema 2 (`abort-new` with O1's attribution, 6b-ii) are accepted; the
 * attribution is checked here only for its type (five strings): it is a
 * routing hint, which doctor validates all or nothing elsewhere
 * (`skill-recovery.attribution.ts`), so a bad hint never makes an intent
 * that names this op dir fail to verify.
 */
export function isParkIntentFor(
  value: unknown,
  opId: string,
  opIdentity: RecordIdentity
): value is ParkIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  // 6a-iii: a move-source intent also names the verified copy (`backupPath`), so the
  // park can be finished from the intent alone once the record is gone.
  const keys = keysFor(o)
  if (keys === null || Object.keys(o).sort().join(',') !== keys) return false
  if (o.opId !== opId || !KINDS.has(o.kind)) return false
  if (o.kind === 'move-source' && !isBackupPath(o.backupPath)) return false
  if (o.schema === 2 && !hasAttributionStrings(o)) return false
  if (!isIntentOwner(o.owner)) return false
  if (!isRecordIdentity(o.opIdentity)) return false
  const id = o.opIdentity
  return (
    id.dev === opIdentity.dev &&
    id.ino === opIdentity.ino &&
    id.birthtimeNs === opIdentity.birthtimeNs &&
    id.fmt === opIdentity.fmt
  )
}
