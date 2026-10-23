/**
 * SMI-6531 (A1 steps 4b, 4c): the park of an op dir from ST, shared by its two
 * callers (A1 plan §3.3; UD25, UD28, UD40): abort cleanup step 6 (caller
 * `abort-cleanup`, kind `abort-new`) and transaction step 13 after a
 * cross-device move (caller `move-source`, kind `move-source`, with the
 * backup's path).
 *
 * The one rule for OP's entries (`opDiffers`, UD40): OP holds exactly an
 * expected set of names, each with the identity this run bound for it (dev,
 * ino, birthtime and file type). An entry not in the set is
 * `kept/op-not-empty`; an expected entry missing, or present with another
 * identity, is `kept/identity-changed`.
 *
 * The park, in the late-bound order (`parkOpFromStaging`): `check`, the clock
 * gate with its probes in ST, OP's guard hash and identity (`gateAndBind`, the
 * hash function the park recomputes with), the same exact set again (a change
 * made before the hash is inside the hash, so it must be caught here; a change
 * made after the hash fails the park's own guard recheck), `check`, then
 * `parkTreeIndexed(ST, opId, …)`, landing at
 * `ST/.skillsmith-parked/<opId>/<opId>-<rnd>`. It removes nothing, and it
 * never retries: an outcome other than `parked` is the caller's to report as a
 * removal not done (UD32).
 *
 * **The park made durable (round 1, caller side).** The ADR-166 park port
 * creates `.skillsmith-parked/<opId>/` and renames OP into it, but syncs no
 * directory. A later sync of ST would make OP's removal durable while the new
 * parked-area entries could still be lost, taking with them the only copy of a
 * write that landed in OP after a cross-device copy verified. So once the
 * result says the tree moved (`parked` or `held`), this module syncs, in
 * order, the directory the tree landed in, its parent (`.skillsmith-parked`),
 * then ST, before it reports anything. A failed sync is not done: the tree has
 * moved, so it is reported as `held` at its parked path, with reason
 * `park-not-durable` (or, for a park already `held`, its own reason with the
 * failure in the detail).
 *
 * Residual (UD18's identical-serialization class, UD40): a byte-identical
 * swap of an expected entry made after the last entry check and before the
 * park's rename passes the guard hash, which covers bytes and modes but not
 * inodes, and is parked in the original's place, whole; nothing is deleted.
 *
 * @module @skillsmith/core/services/skill-swap.park-op
 */
import fs from 'node:fs'
import path from 'node:path'
import { parkTreeIndexed } from '../install/park-call.js'
import { gateAndBind } from '../install/park-clock-gate.js'
import type { ParkResult } from '../install/park-result.js'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { PARKED_INDEX_FILE } from '../install/parked-index.js'
import { check, hook, messageOf, syncDir, trace } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { rootKeyOf } from './skill-swap.sidecar.js'
import type { SwapWarning } from './skill-swap.types.js'

/** A `removal-not-done` warning's fields; `path` defaults to OP. */
export type NotDone = Omit<Extract<SwapWarning, { code: 'removal-not-done' }>, 'code' | 'path'> & {
  path?: string
}

/** What OP must hold at one point: each name and the identity this run bound for it. */
export type Expected = ReadonlyMap<string, BoundIdentity>

/** One line on the injected sink, or stderr. */
export function say(st: SwapState, line: string): void {
  if (st.options.stderr !== undefined) st.options.stderr(line)
  else process.stderr.write(`${line}\n`)
}

/** A `check`, traced (the mutations' own `check`s are not). */
export function checkTraced(st: SwapState): void {
  check(st)
  trace(st, { op: 'check' })
}

/**
 * The one rule for OP's entries (UD40): OP holds exactly `expected`, each name
 * with the identity this run bound for it. Returns null when it does, else the
 * not-done reason (`kept/op-not-empty` or `kept/identity-changed`).
 */
export async function opDiffers(st: SwapState, expected: Expected): Promise<NotDone | null> {
  const names = (await fs.promises.readdir(st.opDir)).sort()
  const extra = names.filter((n) => !expected.has(n))
  if (extra.length > 0) {
    return {
      status: 'kept',
      reason: 'op-not-empty',
      detail: `${st.opDir} holds ${extra.join(', ')}, which this update did not write`,
    }
  }
  for (const [name, id] of [...expected].sort(([a], [b]) => a.localeCompare(b))) {
    const now = bindIdentity(path.join(st.opDir, name))
    if (!now.ok || !sameIdentity(id, now)) {
      return {
        status: 'kept',
        reason: 'identity-changed',
        detail: now.ok
          ? `${path.join(st.opDir, name)} is not the entry this update made`
          : `${path.join(st.opDir, name)} is missing (${now.errno ?? 'unknown'})`,
      }
    }
  }
  return null
}

export type ParkOpOutcome =
  | { status: 'parked'; parkedPath: string }
  /** Moved, then found changed or mounted-into at its parked path. */
  | { status: 'held'; notDone: NotDone & { parkedPath: string } }
  /** Nothing moved: the gate, an entry check or the park refused (`kept`) or failed (`stopped`). */
  | { status: 'not-done'; notDone: NotDone }

export type ParkOpCall =
  | { caller: 'abort-cleanup'; kind: 'abort-new'; expected: Expected }
  | { caller: 'move-source'; kind: 'move-source'; backupPath: string; expected: Expected }

const notDone = (n: NotDone): ParkOpOutcome => ({ status: 'not-done', notDone: n })

/** Parks OP from ST in the late-bound order. Throws only what a `check` or a hook throws. */
export async function parkOpFromStaging(st: SwapState, c: ParkOpCall): Promise<ParkOpOutcome> {
  const ST = st.binding.stagingDir
  checkTraced(st)
  const g = await gateAndBind({ probeDir: ST, parentAbs: ST, name: st.opId, opId: st.opId })
  if (!g.ok) {
    const probe = 'leftProbe' in g && g.leftProbe !== null ? ` (probe left at ${g.leftProbe})` : ''
    return notDone({
      status: 'stopped',
      reason: g.reason,
      ...(g.errno === null ? {} : { errno: g.errno }),
      detail: `${g.detail}${probe}`,
    })
  }
  if (st.op === null || !sameIdentity(st.op.identity, g.expectIdentity)) {
    return notDone({ status: 'kept', reason: 'identity-changed', detail: `${st.opDir} changed` })
  }
  // A change made before the hash is inside it: the same exact set, checked again.
  const differs = await opDiffers(st, c.expected)
  if (differs !== null) return notDone(differs)
  trace(st, { op: 'guard', path: st.opDir, hash: g.guardHash })
  await hook(st, 'beforePark')
  checkTraced(st)
  const park = st.options.park ?? parkTreeIndexed
  const r: ParkResult = await park(ST, st.opId, {
    client: st.input.client,
    caller: c.caller,
    kind: c.kind,
    ...(c.caller === 'move-source' ? { backupPath: c.backupPath } : {}),
    opId: st.opId,
    guardHash: g.guardHash,
    expectIdentity: g.expectIdentity,
    maxBirthtimeNs: g.maxBirthtimeNs,
    rootKey: rootKeyOf(st.binding.root),
    indexPath: path.join(st.stateRootReal, PARKED_INDEX_FILE),
  })
  const moved = r.status === 'parked' || r.status === 'held'
  trace(st, { op: 'park', path: st.opDir, status: r.status, dest: moved ? r.path : null })
  await hook(st, 'afterPark')
  const landed = String(r.status === 'held' ? (r.heldPath ?? r.path) : r.path)
  const unsynced = moved ? await syncPark(st, landed) : null
  await hook(st, 'afterParkSync')
  if (moved && (r.sidecarError !== undefined || r.indexError !== undefined)) {
    st.warnings.push({
      code: 'park-metadata-failed',
      path: String(r.path),
      ...(r.sidecarError === undefined ? {} : { sidecarError: r.sidecarError }),
      ...(r.indexError === undefined ? {} : { indexError: r.indexError }),
    })
  }
  if (r.status === 'parked' && unsynced === null) return { status: 'parked', parkedPath: landed }
  if (r.status === 'parked' && unsynced !== null) {
    return {
      status: 'held',
      notDone: { status: 'held', reason: 'park-not-durable', parkedPath: landed, ...unsynced },
    }
  }
  const errno = r.errno === null ? {} : { errno: r.errno }
  const why = r.detail === null ? {} : { detail: r.detail }
  if (r.status === 'held') {
    const also = unsynced === null ? '' : `; its park could not be synced (${unsynced.detail})`
    const detail = `${r.detail ?? `held at ${landed}`}${also}`
    return {
      status: 'held',
      notDone: {
        status: 'held',
        reason: r.reason ?? 'held',
        parkedPath: landed,
        ...errno,
        ...(r.detail === null && also === '' ? {} : { detail }),
      },
    }
  }
  // `kept` or `stopped` (`removed` is prune's, never a park's): OP stays.
  return notDone({
    status: r.status === 'kept' ? 'kept' : 'stopped',
    reason: r.reason ?? r.status,
    ...errno,
    ...why,
  })
}

/**
 * Syncs the parked copy's directory, `.skillsmith-parked`, then ST. Returns
 * null when all three synced, else the first failure (the rest are not tried:
 * a later sync must not make OP's removal durable before its new home is).
 */
async function syncPark(
  st: SwapState,
  landed: string
): Promise<{ errno?: string; detail: string } | null> {
  const opArea = path.dirname(landed)
  for (const dir of [opArea, path.dirname(opArea), st.binding.stagingDir]) {
    try {
      await syncDir(st, dir)
    } catch (err) {
      const code = (err as { cause?: { code?: unknown } }).cause?.code
      return {
        ...(typeof code === 'string' ? { errno: code } : {}),
        detail: `the park moved the tree to ${landed}, but ${dir} could not be synced (${messageOf(err)}), so the move may not survive a power loss`,
      }
    }
  }
  return null
}
