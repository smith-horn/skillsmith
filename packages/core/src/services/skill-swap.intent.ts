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
 * **No path writes an intent the reader would not accept.** The bytes are
 * produced in one place (`readableIntentOf`): serialized exactly as
 * `publishJson` would, then put through the reader's own acceptance (under
 * `INTENT_CAP`, then `isParkIntentFor` on what the reader would parse). The
 * owner is the op's own (`st.owner`) when that intent is readable, else this
 * process's; when neither is, nothing is written and the write stops
 * `staging-unsafe` naming the size. Each writer also runs the same rule before
 * its first mutation (`intentPrecheck`, on the worst case of the intent it
 * could write), so that stop is a backstop. The update runs it before it
 * creates its op dir, on any device (`swapInPlace`).
 *
 * It is published like the other metadata (`publishBytes`): a temp, synced,
 * `link`ed to `park-intent.json` (never replacing an entry there), the temp
 * unlinked after a check that it is the file this run wrote, then OP synced.
 * It stays in OP, so the guard hash of OP covers it and it travels into the
 * parked area with the tree (UD28).
 *
 * @module @skillsmith/core/services/skill-swap.intent
 */
import path from 'node:path'
import { S_IFMT } from '../install/park-tree.perms.js'
import { KIND_ROLE } from './skill-recovery.pstate.js'
import { attributionOf } from './skill-swap.attribution.js'
import { INTENT_CAP, intentValueOf, isParkIntentFor } from './skill-swap.intent-schema.js'
import { hook, opPaths, SwapFault } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { jsonBytes, publishBytes, recordIdentity } from './skill-swap.staging.js'
import type { ParkIntent, ParkIntentKind, RecordIdentity } from './skill-swap.types.js'

type Owner = ParkIntent['owner']

/**
 * The intent for `owner` (by default the op's own, else this process): OP's
 * identity as `createOp` bound it. A `move-source` intent also names
 * `backupPath`, the verified copy the park's held message names (6a-iii:
 * doctor finishes the park from the intent alone once the record is gone). An
 * `abort-new` intent is schema 2 (6b-ii, O1): it copies `owner.json`'s
 * attribution, so doctor's `--clean-staging` can name the park's client and
 * parked index once `owner.json` is gone. A `move-source` intent stays schema
 * 1: its `backupPath` already names the state root, client and folder.
 */
export function parkIntentOf(
  st: SwapState,
  kind: ParkIntentKind = 'abort-new',
  backupPath?: string,
  owner: Owner = st.owner ?? st.self,
  opIdentity: RecordIdentity = opIdentityOf(st)
): ParkIntent {
  const base = {
    opId: st.opId,
    owner: { pid: owner.pid, host: owner.host, uid: owner.uid },
    opIdentity,
  }
  if (kind === 'abort-new') return { schema: 2, ...base, kind, ...attributionOf(st) }
  if (backupPath === undefined) {
    throw new SwapFault('staging-unsafe', 'a move-source park intent needs the backup path')
  }
  return { schema: 1, ...base, kind, backupPath }
}

/** OP's identity as `createOp` bound it, as the intent records it. */
function opIdentityOf(st: SwapState): RecordIdentity {
  if (st.op === null) throw new SwapFault('staging-unsafe', 'the park intent needs a bound OP')
  return recordIdentity(st.op.identity)
}

/** The bytes to write, or why the reader would refuse them (`size` when it is the cap). */
export type IntentBytes =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string; size: number | null }

/**
 * The round trip: `intent` serialized exactly as written, then the reader's
 * own acceptance of those bytes (`INTENT_CAP`, then `isParkIntentFor` on the
 * value `intentValueOf` parses, as `skill-recovery.opdir.ts` reads it).
 */
export function readableIntentBytes(
  intent: ParkIntent,
  opId: string,
  opIdentity: RecordIdentity
): IntentBytes {
  const bytes = jsonBytes(intent)
  if (bytes.length >= INTENT_CAP) {
    return {
      ok: false,
      reason: `the park intent would be ${bytes.length} bytes, at or over the reader's ${INTENT_CAP}-byte cap`,
      size: bytes.length,
    }
  }
  if (!isParkIntentFor(intentValueOf(bytes), opId, opIdentity)) {
    return { ok: false, reason: 'the park intent would not verify for this op dir', size: null }
  }
  return { ok: true, bytes }
}

/**
 * The one place intent bytes are produced: with the op's own owner
 * (`st.owner`: the update's, or one doctor's `--clean-staging` copied from
 * `owner.json`) when the reader accepts that intent, else with this process's
 * owner. When neither is readable, the reason for the last one tried.
 */
export function readableIntentOf(
  st: SwapState,
  kind: ParkIntentKind,
  backupPath?: string,
  opIdentity: RecordIdentity = opIdentityOf(st)
): IntentBytes {
  const owners = st.owner === null ? [st.self] : [st.owner, st.self]
  let out: IntentBytes = { ok: false, reason: 'no owner to name', size: null }
  for (const owner of owners) {
    const intent = parkIntentOf(st, kind, backupPath, owner, opIdentity)
    out = readableIntentBytes(intent, st.opId, opIdentity)
    if (out.ok) return out
  }
  return out
}

/** The longest name a keep in KIND_ROLE's kinds can take (`<opId>.<kind>.<k>`). */
const LONGEST_KIND = Object.keys(KIND_ROLE).reduce((a, b) => (b.length > a.length ? b : a))

/** 2^64 - 1: `dev` and `ino` are unsigned 64-bit, and `birthtimeNs` fits until 2554. */
const U64_MAX = ((1n << 64n) - 1n).toString()

/**
 * The longest identity an intent can record: each field is the decimal string
 * of a non-negative bigint (`recordIdentity`; the schema accepts nothing else),
 * `dev` and `ino` at most `U64_MAX`, `birthtimeNs` at most `U64_MAX` until the
 * year 2554, and `fmt` is `mode & S_IFMT`, so at most `S_IFMT`. A decimal of a
 * smaller number has no more digits, so every real identity's JSON is no longer.
 */
export const WORST_OP_IDENTITY: RecordIdentity = {
  dev: U64_MAX,
  ino: U64_MAX,
  birthtimeNs: U64_MAX,
  fmt: S_IFMT.toString(),
}

/** `<opId>.<longest kind>.<Number.MAX_SAFE_INTEGER>`: no kept copy's name is longer (`destFor`). */
export const longestKeptName = (opId: string): string =>
  `${opId}.${LONGEST_KIND}.${Number.MAX_SAFE_INTEGER}`

/**
 * Every `backupPath` a move-source intent of this op could name, as the
 * longest of its shape: the backup's fixed `backupDest`, and
 * `<area>/<opId>.<kind>.<k>` with the longest kind and `k` at
 * `Number.MAX_SAFE_INTEGER` (`destFor` counts `k` up from 1). A real
 * `<area>/<opId>.<kind>[.<k>]` differs from the second only in a shorter ASCII
 * suffix, so its intent is never larger.
 */
function backupPathBounds(st: SwapState): string[] {
  return [st.backupDest, path.join(st.areaPath, longestKeptName(st.opId))]
}

/**
 * The precheck each writer runs before its first mutation: the reason, with
 * no suffix (each caller says what is true of its own state: doctor "nothing
 * was changed", the update "the update was not started"), or null. The size
 * it names is the worst case's, so it says "could be up to N bytes"; the
 * write's own stop says "would be N bytes", the real size. It runs the round trip on the worst case of the intent this op could write,
 * with every `backupPath` it could name (`backupPathBounds`) and the longest
 * identity (`WORST_OP_IDENTITY`). It needs no OP, so the update runs it before
 * `createOp`.
 *
 * Why a pass means the write passes: the real intent has the same opId,
 * owner chain (`readableIntentOf`), kind and attribution; its `backupPath` is
 * one of the bounds or shorter by an ASCII suffix only; each identity field is
 * a decimal with no more digits than the worst. JSON escapes each character
 * the same way wherever it sits, so the real bytes are never more than the
 * worst case's, and the schema check passes for both alike. The gap: a
 * `birthtimeNs` past `U64_MAX` (a clock after 2554); the write's own round
 * trip still refuses that intent, as a stop.
 */
export function intentPrecheck(st: SwapState, kind: ParkIntentKind): string | null {
  const paths = kind === 'move-source' ? backupPathBounds(st) : [undefined]
  for (const p of paths) {
    const r = readableIntentOf(st, kind, p, WORST_OP_IDENTITY)
    if (r.ok) continue
    return r.size === null
      ? r.reason
      : `the park intent could be up to ${r.size} bytes, at or over the reader's ${INTENT_CAP}-byte cap`
  }
  return null
}

/**
 * `--clean-staging`'s remedy for that refusal, in `FREE_SPACE_REMEDY`'s style:
 * with `--state-root` naming another state directory, the op's attribution no
 * longer matches a state root doctor was given, so its keep goes to that
 * directory's client-`none` area (`resolveAttribution`'s primary).
 */
export const SHORTER_STATE_ROOT_REMEDY =
  'run this command again with `--state-root` naming a state directory with a shorter path (the kept copy then goes there, in the client-`none` layout)'

/**
 * `--apply`/`--undo`'s: none exists. The record fixes the backup area under
 * the state root its update used (`recoveryState`: `dirname(manifestPath)`),
 * so no `--state-root` changes it.
 */
export const RECORDED_STATE_ROOT_NOTE =
  "this op's record fixes its backup area under the state root its update used, so `--state-root` does not shorten it; no command in this version finishes it"

/**
 * Publishes `park-intent.json` durably: the bytes `readableIntentOf` accepted,
 * or a `staging-unsafe` stop with nothing written. Kill points:
 * `afterIntentTemp`, `afterIntent`.
 */
export async function writeParkIntent(
  st: SwapState,
  kind: ParkIntentKind = 'abort-new',
  backupPath?: string
): Promise<void> {
  const r = readableIntentOf(st, kind, backupPath)
  if (!r.ok) throw new SwapFault('staging-unsafe', `${r.reason}; it was not written`)
  await publishBytes(st, opPaths(st).intent, r.bytes, 'afterIntentTemp')
  await hook(st, 'afterIntent')
}

export { isParkIntentFor } from './skill-swap.intent-schema.js'
