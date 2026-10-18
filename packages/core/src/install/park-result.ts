/**
 * SMI-6531 (A1 step 3a): the park result shape, option resolution and
 * path-segment validation, ported from the SMI-6676 spike's `result-shape.mjs`
 * under ADR-166 D-9's names (UD26).
 *
 * One normalizer that every result passes through, so no return site can drop
 * a field (spike N-1, F13): absent fields become `null`, never `undefined`.
 *
 * Options must be a plain data object, read once from property descriptors
 * without running caller code, validated, and returned as plain data; nothing
 * downstream reads the caller's object again (spike F14, R5-1). An unknown or
 * hidden key is a TypeError, so a misspelled guard cannot run unguarded.
 *
 * Not wired to any caller yet (A1 step 8 routes the callers).
 *
 * @module @skillsmith/core/install/park-result
 */
import path from 'node:path'
import util from 'node:util'

/** Every field a park result carries, in a fixed order. */
export const RESULT_FIELDS = [
  'status',
  'reason',
  'path',
  'entry',
  'treeHash',
  'errno',
  'opId',
  'sidecarPath',
  'detail',
  // ADR-166 D-8: a `held` result names where the tree was and where it now sits.
  'originPath',
  'heldPath',
  // ADR-166 D-11: prune's `stopped/entry-misplaced` names what it renamed aside.
  'misplaced',
] as const

/**
 * Outcomes. `parked` (UD26; the spike's `quarantined`) and `removed` (prune's
 * delete, ADR-166 D-11) are success. `held` is not success: the tree was moved
 * and then found changed or mounted-into at its parked path (ADR-166 D-8, D-10).
 */
export const RESULT_STATUSES: ReadonlySet<string> = new Set([
  'parked',
  'removed',
  'kept',
  'stopped',
  'held',
])

export type ParkStatus = 'parked' | 'removed' | 'kept' | 'stopped' | 'held'

export interface ParkResultFields {
  reason: string | null
  path: string | null
  entry: string | null
  treeHash: string | null
  errno: string | null
  opId: string | null
  sidecarPath: string | null
  detail: string | null
  originPath: string | null
  heldPath: string | null
  misplaced: unknown[] | null
}

/** A shaped result. Extra keys a path adds are carried through, never dropped. */
export interface ParkResult extends ParkResultFields {
  status: ParkStatus
  /** A failed sidecar write; does not change the status (ADR-166 D-10 §5). */
  sidecarError?: string
  /** A failed parked-index append; does not change the status. */
  indexError?: string
  [extra: string]: unknown
}

/** What a return site builds before `shapeResult` fills in the rest. */
export type PartialParkResult = { status: ParkStatus } & Partial<ParkResultFields> & {
    sidecarError?: string
    indexError?: string
    [extra: string]: unknown
  }

/**
 * Normalizes a partial result to the full shape: every declared field present,
 * `null` where it does not apply, and every extra key preserved.
 */
export function shapeResult(partial: PartialParkResult): ParkResult {
  if (partial === null || typeof partial !== 'object') {
    throw new TypeError(`shapeResult: expected a result object, got ${String(partial)}`)
  }
  if (!RESULT_STATUSES.has(partial.status)) {
    throw new TypeError(`shapeResult: unknown status ${JSON.stringify(partial.status)}`)
  }
  const out: Record<string, unknown> = {}
  for (const f of RESULT_FIELDS) out[f] = partial[f] ?? null
  // hasOwnProperty, not `in`: `in` walks the prototype chain, so an extra key
  // named like an Object.prototype member (toString, constructor) was dropped
  // (spike m-6).
  for (const k of Object.keys(partial)) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = partial[k]
  }
  return out as ParkResult
}

/**
 * True when the removal is done. `held` is not: the caller keeps the manifest
 * entry and points the user at `skillsmith restore <id>` (ADR-166 D-8).
 */
export function isSuccess(result: { status: string }): boolean {
  return result.status === 'removed' || result.status === 'parked'
}

/**
 * A single path segment, never a path. A traversing `opId` or `name` would
 * land the tree outside the parked area while reporting success (spike F6).
 * `reserveLeadingDot` (opId only): a leading `.` is reserved for Skillsmith's
 * own names inside the parked area, such as prune's `.prune-*` staging
 * directories (ADR-166 D-11).
 */
export function assertPathSegment(
  label: string,
  value: unknown,
  { reserveLeadingDot = false }: { reserveLeadingDot?: boolean } = {}
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string, got ${String(value)}`)
  }
  if (reserveLeadingDot && value.startsWith('.')) {
    throw new TypeError(
      `${label} must not start with "." (reserved for Skillsmith's staging names). ` +
        `Got ${JSON.stringify(value)}.`
    )
  }
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new TypeError(
      `${label} must be a single path segment, not a path. Got ${JSON.stringify(value)}. ` +
        `A traversing value escapes the parked area and lands the tree elsewhere ` +
        `while reporting success.`
    )
  }
}

/**
 * ADR-166 D-5: `undefined` means no guard; a non-empty string means guard with
 * that hash; anything else (`null`, `''`, a number) is a TypeError, raised
 * before any filesystem work. Neither reading of `null` is adopted, because a
 * caller passing it has not said which it meant.
 */
export function normalizeGuardHash(guardHash: unknown): string | undefined {
  if (guardHash === undefined) return undefined
  if (typeof guardHash === 'string' && guardHash.length > 0) return guardHash
  throw new TypeError(
    `guardHash must be a non-empty string, or omitted entirely for no guard. ` +
      `Got ${guardHash === null ? 'null' : typeof guardHash === 'string' ? 'an empty string' : typeof guardHash}. ` +
      `null and '' are refused deliberately (ADR-166 D-5): guessing whether they ` +
      `mean "no guard" or "a hash that never matches" decides whether data moves.`
  )
}

/** An identity a caller bound earlier (ADR-166 D-0, SMI-7130: file type included). */
export interface ParkIdentity {
  dev: bigint
  ino: bigint
  birthtimeNs: bigint
  /** `mode & S_IFMT`. An identity without it never compares equal (SMI-7130). */
  fmt?: bigint
}

export interface ParkOptions {
  /** UD22's client. Required: there is no default (the spike defaulted to 'spike'). */
  client: string
  /** The §3.4 tree hash the caller certified (UD27). Omit for no guard. */
  guardHash?: string
  /** The operation id, a single segment not starting with `.`; random if omitted. */
  opId?: string
  /** The identity the caller bound (UD24), compared before the walk and the rename. */
  expectIdentity?: ParkIdentity
  /** Probe 2's birthtime from UD25's clock gate. */
  maxBirthtimeNs?: bigint
  /** §3.5's parked kind, for the sidecar and the index. Required: prune classifies by it. */
  kind: string
  /** UD22's rootKey. */
  rootKey?: string | null
  /** Absolute path of the parked index to append to (§3.5). */
  indexPath?: string
}

/** Options after the single read and validation. Plain data. */
export interface ResolvedParkOptions {
  client: string
  guardHash: string | undefined
  opId: string | undefined
  expectIdentity: ParkIdentity | undefined
  maxBirthtimeNs: bigint | undefined
  kind: string
  rootKey: string | null
  indexPath: string | undefined
}

/** Every option the park consumes. Any other key is refused. */
export const PARK_OPTION_KEYS = [
  'client',
  'guardHash',
  'opId',
  'expectIdentity',
  'maxBirthtimeNs',
  'kind',
  'rootKey',
  'indexPath',
] as const

const KNOWN_KEYS: ReadonlySet<string> = new Set(PARK_OPTION_KEYS)

/**
 * Reads the options as plain data and validates them (ADR-166 D-5). The rule:
 * a non-proxy object whose prototype is `Object.prototype` or null, with only
 * known string keys, each an own data property. Values come only from property
 * descriptors, so no caller code (getter, proxy trap) runs during the read and
 * no inherited value, a polluted `Object.prototype` included, is consulted.
 * Anything else throws TypeError before any filesystem work, so a misspelled
 * or hidden guard cannot run unguarded (review rounds 1 and 2).
 */
export function resolveParkOptions(options: unknown): ResolvedParkOptions {
  const refuse = (why: string): never => {
    throw new TypeError(`parkTree options: ${why}. Pass a plain object literal.`)
  }
  if (options === null || typeof options !== 'object') refuse(`got ${String(options)}`)
  const obj = options as object
  if (util.types.isProxy(obj)) refuse('a Proxy is refused (its traps run caller code)')
  const proto: unknown = Object.getPrototypeOf(obj)
  if (proto !== Object.prototype && proto !== null) {
    refuse('the prototype must be Object.prototype or null (class instances are refused)')
  }
  // Null prototype: an absent option must read as undefined, never as a
  // value inherited from a polluted Object.prototype.
  const snap = Object.create(null) as Record<string, unknown>
  for (const k of Reflect.ownKeys(obj)) {
    if (typeof k === 'symbol') refuse(`symbol key ${String(k)} is refused`)
    const key = k as string
    if (!KNOWN_KEYS.has(key)) {
      refuse(`unknown option ${JSON.stringify(key)} (known: ${PARK_OPTION_KEYS.join(', ')})`)
    }
    const d = Object.getOwnPropertyDescriptor(obj, key)
    if (d === undefined) refuse(`option ${JSON.stringify(key)} vanished while being read`)
    const desc = d as PropertyDescriptor
    if ('get' in desc || 'set' in desc) {
      refuse(`option ${JSON.stringify(key)} is an accessor; only data properties are read`)
    }
    snap[key] = desc.value
  }

  const { client, opId, expectIdentity, maxBirthtimeNs, kind, rootKey, indexPath } = snap
  if (typeof client !== 'string' || client.length === 0) {
    throw new TypeError(`parkTree: client must be a non-empty string, got ${String(client)}`)
  }
  const guardHash = normalizeGuardHash(snap.guardHash)
  if (opId !== undefined) assertPathSegment('opId', opId, { reserveLeadingDot: true })
  if (
    expectIdentity !== undefined &&
    (expectIdentity === null || typeof expectIdentity !== 'object')
  ) {
    throw new TypeError('parkTree: expectIdentity must be an identity object or omitted')
  }
  if (maxBirthtimeNs !== undefined && typeof maxBirthtimeNs !== 'bigint') {
    throw new TypeError(
      `parkTree: maxBirthtimeNs must be a bigint or omitted, got ${
        maxBirthtimeNs === null ? 'null' : typeof maxBirthtimeNs
      }. A null is refused rather than read as "no gate", the spike's meaning.`
    )
  }
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError(`parkTree: kind must be a non-empty string, got ${String(kind)}`)
  }
  if (rootKey !== undefined && rootKey !== null && typeof rootKey !== 'string') {
    throw new TypeError('parkTree: rootKey must be a string, null or omitted')
  }
  if (indexPath !== undefined && (typeof indexPath !== 'string' || !path.isAbsolute(indexPath))) {
    throw new TypeError('parkTree: indexPath must be an absolute path or omitted')
  }
  return {
    client,
    guardHash,
    opId,
    expectIdentity: expectIdentity as ParkIdentity | undefined,
    maxBirthtimeNs,
    kind,
    rootKey: rootKey ?? null,
    indexPath,
  }
}

/** The errno code of a caught error, or null. */
export function errCode(err: unknown): string | null {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code
    if (typeof c === 'string') return c
  }
  return null
}

/** The errno code of a caught error, else its message. */
export function errCodeOrMessage(err: unknown): string {
  return errCode(err) ?? (err instanceof Error ? err.message : String(err))
}
