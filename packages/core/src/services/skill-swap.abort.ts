/**
 * SMI-6531 (A1 step 4b): abort cleanup, for every abort before rename 1 (A1
 * plan §3.3 "Abort cleanup", UD15-UD17 as revised by UD28; UD25, UD32). It
 * removes nothing: a completed, unchanged staged tree is parked with its op
 * dir, and a changed or partial one is kept through `publishTree`.
 *
 *  1. Lock 1: `skill-swap.abort.wait.ts` (the step-1 wait, the second wait
 *     after a step-2 `busy`); an abort at steps 3-6 already holds it.
 *  2. `check`. A failure stops with no mutation; OP and any record stay.
 *  3. N still has `buildIdentity` and is a directory. Otherwise OP stays.
 *  4-6 below check OP with ONE rule (`opDiffers`): OP holds exactly an
 *     expected set of names, each with the identity this run bound for it
 *     (dev, ino, birthtime and file type). An entry not in the set ends
 *     `left` with `kept/op-not-empty`; an expected entry missing, or present
 *     with another identity, ends `left` with `kept/identity-changed`.
 *  4. Before anything is published or unlinked, the set is N (with
 *     `buildIdentity`, when the build made it) and every metadata file this
 *     run created in OP and still holds (`st.owned`): `owner.json`, and
 *     `record.json` and the temps only where this run created them.
 *  5. A failed build (no `postTree`): `check`, keep N as `failed-build`. A
 *     completed build: hash N; different is `edited-new`, unreadable
 *     `unrecorded-new` (`check`, then `publishTree`); equal stays to be parked.
 *  6. Metadata, then the park. Unlink `record.json` if this run published it
 *     (sync OP); if N is to be parked, write `park-intent.json` durably;
 *     unlink `record.json.tmp`, `owner.json.tmp` and `owner.json` where this
 *     run wrote them. Then, before the gate, the set is exactly `new`
 *     (`buildIdentity`) and `park-intent.json` (its own binding), both present,
 *     when N is to be parked; otherwise it is empty, and OP is `rmdir`ed (sync
 *     ST). To park: `check`, the clock gate with its probes in ST, OP's guard
 *     hash and identity (`gateAndBind`, the late-bound order), the same exact
 *     set again (a change made before the hash is inside the hash, so it must
 *     be caught here; a change made after the hash fails the park's own guard
 *     recheck), `check`, and park OP from ST (`parkTreeIndexed(ST, opId, …)`,
 *     caller `abort-cleanup`, kind `abort-new`), landing at
 *     `ST/.skillsmith-parked/<opId>/<opId>-<rnd>`.
 *  7. The report: `staged` is `parked` (with `parkedPath`), `kept` (with
 *     `keptAs`), `held` (with `parkedPath`), `left` (with `opDir` and the
 *     `--clean-staging` command; `keptAs` too when a keep finished and a later
 *     step stopped), or `none` when there was no OP or nothing in it. Every
 *     `left` and `held` adds a `removal-not-done` warning (UD32). This module
 *     writes one stderr line for each `left` or `held` outcome it produces,
 *     all of them under lock 1. A run left because lock 1 was never taken
 *     writes no line from this module; only the busy second wait announces
 *     itself, once, before it polls (`skill-swap.abort.wait.ts`).
 *
 * Residual (UD18's identical-serialization class, UD40): a byte-identical
 * swap of `new` (or of anything inside it), or of `park-intent.json` with the
 * same bytes and the same mode, made after the last entry check and before the
 * park's rename passes the park's guard hash, which covers bytes and modes but
 * not inodes. The substitute is parked in the original's place. It lands in
 * the parked area whole and nothing is deleted; the original, wherever the
 * swapper put it, is untouched. A replacement with another mode changes the
 * hash and the park refuses it. Node has no directory-handle rename that would
 * close the window.
 *
 * Every unlink is `unlinkOwned` (the file this run wrote, verified) and every
 * mutation runs `check` first. The guard hash comes from `gateAndBind`, which
 * uses the hash function the park recomputes with.
 *
 * Not here: the cross-device keep (4c) and doctor's acceptance of the intent
 * (step 6). The exit code is step 7's: every abort result is `refused`.
 *
 * @module @skillsmith/core/services/skill-swap.abort
 */
import fs from 'node:fs'
import path from 'node:path'
import { parkTreeIndexed } from '../install/park-call.js'
import { gateAndBind } from '../install/park-clock-gate.js'
import type { ParkResult } from '../install/park-result.js'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { S_IFDIR } from '../install/park-tree.perms.js'
import { PARKED_INDEX_FILE } from '../install/parked-index.js'
import { treeHashOf } from './skill-tree.js'
import { SkillWriteStop } from './skill-write-lock.types.js'
import { writeParkIntent } from './skill-swap.intent.js'
import {
  check,
  hook,
  messageOf,
  opPaths,
  rethrowLockOrder,
  rmdirChecked,
  SwapFault,
  syncDir,
  trace,
  unlinkOwned,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { publishTree, rootKeyOf } from './skill-swap.publish.js'
import { cleanStagingHint } from './skill-swap.staging.js'
import { NEW_DIR, PARK_INTENT_FILE } from './skill-swap.types.js'
import type {
  AbortKeptKind,
  AbortStaged,
  SwapRefuseReason,
  SwapResult,
  SwapWarning,
} from './skill-swap.types.js'

export type Refused = Extract<SwapResult, { status: 'refused' }>
export type NotDone = Omit<Extract<SwapWarning, { code: 'removal-not-done' }>, 'code' | 'path'> & {
  path?: string
}
type Kept = { kind: AbortKeptKind; path: string } | undefined

/** The reason word and detail of a failure. An unexpected error is `write-failed`. */
export function describe(err: unknown): { reason: string; detail: string } {
  if (err instanceof SwapFault) return { reason: err.reason, detail: err.detail }
  if (err instanceof SkillWriteStop) return { reason: err.code, detail: err.detail }
  return { reason: 'write-failed', detail: messageOf(err) }
}

/** One line on the injected sink, or stderr. */
export function say(st: SwapState, line: string): void {
  if (st.options.stderr !== undefined) st.options.stderr(line)
  else process.stderr.write(`${line}\n`)
}

/** The result, plus the `removal-not-done` warning when one is given. */
export function refused(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string,
  o: { staged: AbortStaged; parkedPath?: string; keptAs?: Kept; notDone?: NotDone }
): Refused {
  if (o.notDone !== undefined) {
    const { path: p, ...rest } = o.notDone
    st.warnings.push({ code: 'removal-not-done', path: p ?? st.opDir, ...rest })
  }
  const left = o.staged === 'left'
  return {
    status: 'refused',
    reason,
    staged: o.staged,
    opDir: left ? st.opDir : null,
    cleanStagingHint: left ? cleanStagingHint(st.opId) : null,
    ...(o.parkedPath === undefined ? {} : { parkedPath: o.parkedPath }),
    ...(o.keptAs === undefined ? {} : { keptAs: o.keptAs }),
    detail,
    warnings: st.warnings,
  }
}

/** No OP was made by this call: nothing to clean. */
export function noneResult(st: SwapState, reason: SwapRefuseReason, detail: string): Refused {
  return refused(st, reason, detail, { staged: 'none' })
}

/** The one line for a cleanup or park that did not set the staged copy aside. */
function sayNotDone(st: SwapState, n: NotDone & { path: string }): void {
  const errno = n.errno === undefined ? '' : ` (${n.errno})`
  const where = n.parkedPath === undefined ? '' : `; it is now at ${n.parkedPath}`
  const next =
    n.status === 'held'
      ? 'the staged copy may have changed while it was set aside'
      : `run \`${cleanStagingHint(st.opId)}\``
  say(
    st,
    `Skillsmith did not set aside the staged copy at ${n.path}: ${n.status}/${n.reason}${errno}${where}; ${next}.`
  )
}

/** `left`, with its stderr line and its `removal-not-done` warning. */
function leftWith(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string,
  keptAs: Kept,
  notDone: NotDone
): Refused {
  sayNotDone(st, { ...notDone, path: notDone.path ?? st.opDir })
  return refused(st, reason, detail, {
    staged: 'left',
    ...(keptAs === undefined ? {} : { keptAs }),
    notDone,
  })
}

function checkTraced(st: SwapState): void {
  check(st)
  trace(st, { op: 'check' })
}

/** The metadata names this run wrote into OP (unlinked by step 6 when still its own). */
function ownedMeta(st: SwapState): string[] {
  const p = opPaths(st)
  return [p.owner, `${p.owner}.tmp`, `${p.record}.tmp`].filter((f) => st.owned.has(f))
}

/** What OP must hold at one point of cleanup: each name and the identity this run bound for it. */
type Expected = ReadonlyMap<string, BoundIdentity>

/**
 * The one rule for OP's entries: OP holds exactly `expected`, each name with
 * the identity this run bound for it (dev, ino, birthtime, file type). An
 * entry not expected is `kept/op-not-empty`; an expected entry that is
 * missing, or present with another identity, is `kept/identity-changed`.
 * Returns null when OP is exactly as expected.
 */
async function opDiffers(st: SwapState, expected: Expected): Promise<NotDone | null> {
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

/** Every file this run created directly in OP and still holds (`st.owned`), by name. */
function ownedInOp(st: SwapState): Map<string, BoundIdentity> {
  const out = new Map<string, BoundIdentity>()
  for (const [p, id] of st.owned) if (path.dirname(p) === st.opDir) out.set(path.basename(p), id)
  return out
}

/** Steps 2-7, holding lock 1. Never throws but a `LockOrderError`. */
export async function runCleanup(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string
): Promise<Refused> {
  trace(st, { op: 'abort-lock' })
  let keptAs: Kept
  try {
    checkTraced(st)
    await hook(st, 'abortAfterCheck')
    const { newDir } = opPaths(st)
    const n = bindIdentity(newDir)
    const built = !(st.buildIdentity === null && !n.ok && n.errno === 'ENOENT')
    if (built) {
      const notDone = notTheBuild(st, newDir, n)
      if (notDone !== null) return leftWith(st, reason, detail, undefined, notDone)
      trace(st, { op: 'identity', path: newDir })
    }
    // Step 4: OP holds exactly N and the metadata this run created, or all cleanup stops.
    const expected = ownedInOp(st)
    if (built && st.buildIdentity !== null) expected.set(NEW_DIR, st.buildIdentity)
    const differs = await opDiffers(st, expected)
    if (differs !== null) return leftWith(st, reason, detail, undefined, differs)
    if (built) keptAs = await keepIfNeeded(st, newDir)
    return await metadataThenPark(st, reason, detail, keptAs, built && keptAs === undefined)
  } catch (err) {
    rethrowLockOrder(err)
    const stop = describe(err)
    // A keep whose rename ran is kept, whatever stopped after it.
    const pub = st.published
    if (keptAs === undefined && pub !== null && pub.src === opPaths(st).newDir) {
      keptAs = { kind: pub.kind as AbortKeptKind, path: pub.dest }
    }
    return leftWith(st, reason, detail, keptAs, {
      status: 'stopped',
      reason: stop.reason,
      detail: stop.detail,
    })
  }
}

/** Step 3: why N is not the directory the build made, or null when it is. */
function notTheBuild(
  st: SwapState,
  newDir: string,
  n: ReturnType<typeof bindIdentity>
): NotDone | null {
  if (!n.ok && n.errno !== 'ENOENT') {
    return {
      status: 'stopped',
      reason: 'unreadable',
      ...(n.errno === null ? {} : { errno: n.errno }),
      detail: `${newDir} could not be inspected; it was left for doctor`,
    }
  }
  if (n.ok && n.fmt !== S_IFDIR) {
    return {
      status: 'kept',
      reason: 'identity-changed',
      detail: `${newDir} is not a directory; it was left for doctor`,
    }
  }
  if (!n.ok || st.buildIdentity === null || !sameIdentity(st.buildIdentity, n)) {
    return {
      status: 'kept',
      reason: 'identity-changed',
      detail: `${newDir} is not the directory this update built; it was left for doctor`,
    }
  }
  return null
}

/** Step 5: keep a partial or changed N through `publishTree`; undefined to park it. */
async function keepIfNeeded(st: SwapState, newDir: string): Promise<Kept> {
  let kind: AbortKeptKind
  if (st.postTree === null) {
    // UD17: nothing about a partial tree is compared (E40).
    kind = 'failed-build'
  } else {
    const h = treeHashOf(newDir)
    trace(st, { op: 'compare', path: newDir, equal: h.ok ? h.hash === st.postTree : null })
    await hook(st, 'abortAfterCompare')
    if (h.ok && h.hash === st.postTree) return undefined
    kind = h.ok ? 'edited-new' : 'unrecorded-new'
  }
  checkTraced(st)
  return { kind, path: await publishTree(st, newDir, kind) }
}

/** Step 6 and the report. Throws for the caller to report as `left`. */
async function metadataThenPark(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string,
  keptAs: Kept,
  parkN: boolean
): Promise<Refused> {
  const p = opPaths(st)
  if (st.owned.has(p.record)) {
    await unlinkOwned(st, p.record, 'staging-unsafe')
    st.recordRemoved = true
    await syncDir(st, st.opDir)
    await hook(st, 'afterRecordUnlink')
  }
  if (parkN) await writeParkIntent(st)
  for (const f of ownedMeta(st)) {
    await unlinkOwned(st, f, 'staging-unsafe')
    if (f === p.owner) await hook(st, 'afterOwnerUnlink')
  }
  // Before the gate: to park, exactly N and the intent, each with its bound
  // identity; otherwise OP is empty. Anything else stops here.
  const expected = new Map<string, BoundIdentity>()
  if (parkN) {
    const intent = st.owned.get(p.intent)
    if (st.buildIdentity === null || intent === undefined) {
      throw new SwapFault('staging-unsafe', 'the park needs N and its intent bound')
    }
    expected.set(NEW_DIR, st.buildIdentity)
    expected.set(PARK_INTENT_FILE, intent)
  }
  const differs = await opDiffers(st, expected)
  if (differs !== null) return leftWith(st, reason, detail, keptAs, differs)
  if (!parkN) {
    await rmdirChecked(st, st.opDir)
    await syncDir(st, st.binding.stagingDir)
    return refused(st, reason, detail, {
      staged: keptAs === undefined ? 'none' : 'kept',
      ...(keptAs === undefined ? {} : { keptAs }),
    })
  }
  return parkOp(st, reason, detail, keptAs, expected)
}

/** Step 6's park of OP from ST, in the late-bound order. */
async function parkOp(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string,
  keptAs: Kept,
  expected: Expected
): Promise<Refused> {
  const ST = st.binding.stagingDir
  const kept = keptAs === undefined ? {} : { keptAs }
  const left = (notDone: NotDone): Refused => leftWith(st, reason, detail, keptAs, notDone)
  checkTraced(st)
  const g = await gateAndBind({ probeDir: ST, parentAbs: ST, name: st.opId, opId: st.opId })
  if (!g.ok) {
    const probe = 'leftProbe' in g && g.leftProbe !== null ? ` (probe left at ${g.leftProbe})` : ''
    return left({
      status: 'stopped',
      reason: g.reason,
      ...(g.errno === null ? {} : { errno: g.errno }),
      detail: `${g.detail}${probe}`,
    })
  }
  if (st.op === null || !sameIdentity(st.op.identity, g.expectIdentity)) {
    return left({ status: 'kept', reason: 'identity-changed', detail: `${st.opDir} changed` })
  }
  // A change made before the hash is inside it: the same exact set, checked again.
  const differs = await opDiffers(st, expected)
  if (differs !== null) return left(differs)
  trace(st, { op: 'guard', path: st.opDir, hash: g.guardHash })
  await hook(st, 'beforePark')
  checkTraced(st)
  const park = st.options.park ?? parkTreeIndexed
  const r: ParkResult = await park(ST, st.opId, {
    client: st.input.client,
    caller: 'abort-cleanup',
    kind: 'abort-new',
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
  if (moved && (r.sidecarError !== undefined || r.indexError !== undefined)) {
    st.warnings.push({
      code: 'park-metadata-failed',
      path: String(r.path),
      ...(r.sidecarError === undefined ? {} : { sidecarError: r.sidecarError }),
      ...(r.indexError === undefined ? {} : { indexError: r.indexError }),
    })
  }
  if (r.status === 'parked') {
    return refused(st, reason, detail, { staged: 'parked', parkedPath: String(r.path), ...kept })
  }
  const errno = r.errno === null ? {} : { errno: r.errno }
  const why = r.detail === null ? {} : { detail: r.detail }
  if (r.status === 'held') {
    const parkedPath = String(r.heldPath ?? r.path)
    const notDone: NotDone = {
      status: 'held',
      reason: r.reason ?? 'held',
      parkedPath,
      ...errno,
      ...why,
    }
    sayNotDone(st, { ...notDone, path: st.opDir })
    return refused(st, reason, detail, { staged: 'held', parkedPath, ...kept, notDone })
  }
  // `kept` or `stopped` (`removed` is prune's, never a park's): OP stays.
  return left({
    status: r.status === 'kept' ? 'kept' : 'stopped',
    reason: r.reason ?? r.status,
    ...errno,
    ...why,
  })
}

/** An abort at steps 3-6: lock 1 is already held. */
export async function abortUnderLock(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string
): Promise<Refused> {
  if (!st.opCreated) return noneResult(st, reason, detail)
  return runCleanup(st, reason, detail)
}
