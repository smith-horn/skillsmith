/**
 * SMI-6531 (A1 steps 4b, 4c): `park-intent.json`, written into OP before abort
 * cleanup (kind `abort-new`) or step 13 after a cross-device move (kind
 * `move-source`) unlinks `owner.json` (A1 plan §3.3 "Park intent", review
 * round 1 F3).
 *
 * Without it, a crash between the `owner.json` unlink and the park would leave
 * an op dir with no record and no owner, which doctor cannot tell apart from
 * one another writer has just made and not yet given an `owner.json`. With
 * it, `doctor recovery --clean-staging <opId>` (step 6) finishes the intended
 * park without `--unsafe-unverified-owner`, but only when the intent parses,
 * matches this schema, names this op dir's `opId`, and OP's current identity
 * equals the recorded one (`isParkIntentFor`).
 *
 * It is published like the other metadata (`publishJson`): a temp, synced,
 * `link`ed to `park-intent.json` (never replacing an entry there), the temp
 * unlinked after a check that it is the file this run wrote, then OP synced.
 * It stays in OP, so the guard hash of OP covers it and it travels into the
 * parked area with the tree (UD28).
 *
 * @module @skillsmith/core/services/skill-swap.intent
 */
import os from 'node:os'
import { hook, opPaths, SwapFault } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { publishJson, recordIdentity } from './skill-swap.staging.js'
import type { ParkIntent, ParkIntentKind, RecordIdentity } from './skill-swap.types.js'

const KINDS: ReadonlySet<unknown> = new Set<ParkIntentKind>(['abort-new', 'move-source'])

/** The intent this run writes: OP's identity as `createOp` bound it, and the owner it recorded. */
export function parkIntentOf(st: SwapState, kind: ParkIntentKind = 'abort-new'): ParkIntent {
  if (st.op === null) throw new SwapFault('staging-unsafe', 'the park intent needs a bound OP')
  // `owner.json` is written before anything else in OP; if this run never
  // published it, the owner is still this process.
  const owner = st.owner ?? {
    pid: process.pid,
    host: os.hostname(),
    uid: process.geteuid?.() ?? -1,
  }
  return {
    schema: 1,
    opId: st.opId,
    owner: { pid: owner.pid, host: owner.host, uid: owner.uid },
    opIdentity: recordIdentity(st.op.identity),
    kind,
  }
}

/** Publishes `park-intent.json` durably. Kill points: `afterIntentTemp`, `afterIntent`. */
export async function writeParkIntent(
  st: SwapState,
  kind: ParkIntentKind = 'abort-new'
): Promise<void> {
  await publishJson(st, opPaths(st).intent, parkIntentOf(st, kind), 'afterIntentTemp')
  await hook(st, 'afterIntent')
}

const DECIMAL = /^(0|[1-9][0-9]*)$/

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
 * finishes): anything else is refused, never repaired.
 */
export function isParkIntentFor(
  value: unknown,
  opId: string,
  opIdentity: RecordIdentity
): value is ParkIntent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (Object.keys(o).sort().join(',') !== 'kind,opId,opIdentity,owner,schema') return false
  if (o.schema !== 1 || o.opId !== opId || !KINDS.has(o.kind)) return false
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
