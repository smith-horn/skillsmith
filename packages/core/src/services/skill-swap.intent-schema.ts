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
  const owner = o.owner as Record<string, unknown> | null
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) return false
  if (Object.keys(owner).sort().join(',') !== 'host,pid,uid') return false
  if (!Number.isInteger(owner.pid) || typeof owner.host !== 'string') return false
  if (!Number.isInteger(owner.uid)) return false
  if (!isRecordIdentity(o.opIdentity)) return false
  const id = o.opIdentity
  return (
    id.dev === opIdentity.dev &&
    id.ino === opIdentity.ino &&
    id.birthtimeNs === opIdentity.birthtimeNs &&
    id.fmt === opIdentity.fmt
  )
}
