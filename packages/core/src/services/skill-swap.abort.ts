/**
 * SMI-6531 (A1 step 4b): abort cleanup, for every abort before rename 1 (A1
 * plan §3.3 "Abort cleanup", UD15-UD17 as revised by UD28; UD16, UD25, UD32).
 * It removes nothing: a completed, unchanged staged tree is parked with its op
 * dir, and a changed or partial one is kept through `publishTree`.
 *
 *  1. Lock 1. An abort at steps 3-6 already holds it (`abortUnderLock`). A
 *     step-1 failure takes it with one normal wait (`abortBeforeLock`). After a
 *     step-2 `busy`, the update waits once more (`abortAfterBusy`, UD16):
 *     `withSkillWriteLock` with `timeoutMs: 0` every 50 ms for up to 30 s,
 *     holding nothing between polls, announced by one stderr line. Still busy:
 *     OP is left for `doctor recovery --clean-staging <opId>`.
 *  2. `check`. A failure stops with no mutation; OP and any record stay.
 *  3. N still has `buildIdentity` (a directory). Otherwise OP stays.
 *  4. A failed build (no `postTree`): `check`, keep N as `failed-build`.
 *  5. A completed build: hash N; different is `edited-new`, unreadable
 *     `unrecorded-new` (`check`, then `publishTree`); equal stays to be parked.
 *  6. Metadata, then the park. First, OP may hold only N (to be parked) and
 *     the metadata this run wrote: any other entry stops here with nothing
 *     unlinked or parked (`kept/op-not-empty`, like step 13), and OP stays for
 *     doctor. Then unlink `record.json` if this run published it (sync OP); if
 *     N is to be parked, write `park-intent.json` durably; unlink
 *     `record.json.tmp`, `owner.json.tmp` and `owner.json` where this run
 *     wrote them. OP empty: `rmdir` it, sync ST. Otherwise `check`, the
 *     clock gate with its probes in ST, OP's guard hash and identity
 *     (`gateAndBind`, the late-bound order), `check`, and park OP from ST
 *     (`parkTreeIndexed(ST, opId, …)`, caller `abort-cleanup`, kind
 *     `abort-new`), so it lands at `ST/.skillsmith-parked/<opId>/<opId>-<rnd>`.
 *     Lock 1 is released when this returns.
 *  7. The report: `staged` is `parked` (with `parkedPath`), `kept` (with
 *     `keptAs`), `held` (with `parkedPath`) or `left` (with `opDir` and the
 *     `--clean-staging` command); `none` when there was no OP or nothing in it.
 *     Every `left` and `held` adds a `removal-not-done` warning (UD32), and a
 *     park or cleanup that did not finish writes one stderr line.
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
import { setTimeout as delay } from 'node:timers/promises'
import { assertSkillWriteLockNotHeld } from '../config/lock-tracker.js'
import { parkTreeIndexed } from '../install/park-call.js'
import { gateAndBind } from '../install/park-clock-gate.js'
import type { ParkResult } from '../install/park-result.js'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import { S_IFDIR } from '../install/park-tree.perms.js'
import { PARKED_INDEX_FILE } from '../install/parked-index.js'
import { treeHashOf } from './skill-tree.js'
import { withSkillWriteLock } from './skill-write-lock.js'
import { SkillWriteStop } from './skill-write-lock.types.js'
import type { SkillWriteResult } from './skill-write-lock.types.js'
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
import { NEW_DIR } from './skill-swap.types.js'
import type {
  AbortKeptKind,
  AbortStaged,
  SwapRefuseReason,
  SwapResult,
  SwapWarning,
} from './skill-swap.types.js'

type Refused = Extract<SwapResult, { status: 'refused' }>
type NotDone = Omit<Extract<SwapWarning, { code: 'removal-not-done' }>, 'code' | 'path'> & {
  path?: string
}

const DEFAULT_SECOND_WAIT_MS = 30_000
const DEFAULT_POLL_MS = 50
const LABEL = 'skill update abort cleanup'

/** The reason word and detail of a failure. An unexpected error is `write-failed`. */
export function describe(err: unknown): { reason: string; detail: string } {
  if (err instanceof SwapFault) return { reason: err.reason, detail: err.detail }
  if (err instanceof SkillWriteStop) return { reason: err.code, detail: err.detail }
  return { reason: 'write-failed', detail: messageOf(err) }
}

/** One line on the injected sink, or stderr. */
function say(st: SwapState, line: string): void {
  if (st.options.stderr !== undefined) st.options.stderr(line)
  else process.stderr.write(`${line}\n`)
}

/** The result, plus the `removal-not-done` warning for anything but parked/kept/none. */
function refused(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string,
  o: {
    staged: AbortStaged
    parkedPath?: string
    keptAs?: { kind: AbortKeptKind; path: string }
    notDone?: NotDone
  }
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

function checkTraced(st: SwapState): void {
  check(st)
  trace(st, { op: 'check' })
}

/** The metadata names this run wrote into OP (unlinked by step 6 when still its own). */
function ownedMeta(st: SwapState): string[] {
  const p = opPaths(st)
  return [p.owner, `${p.owner}.tmp`, `${p.record}.tmp`].filter((f) => st.owned.has(f))
}

/** Steps 2-7, holding lock 1. Never throws but a `LockOrderError`. */
async function runCleanup(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string
): Promise<Refused> {
  trace(st, { op: 'abort-lock' })
  let keptAs: { kind: AbortKeptKind; path: string } | undefined
  try {
    checkTraced(st)
    await hook(st, 'abortAfterCheck')
    const { newDir } = opPaths(st)
    const n = await lstatId(newDir)
    if (n === 'absent' && st.buildIdentity === null) {
      // Nothing was built (step 1 failed before `new/`): only metadata to unlink.
      return await metadataThenPark(st, reason, detail, keptAs)
    }
    if (
      n === 'absent' ||
      !n.ok ||
      st.buildIdentity === null ||
      !sameIdentity(st.buildIdentity, n)
    ) {
      const notDone: NotDone = {
        status: 'kept',
        reason: 'identity-changed',
        detail: `${newDir} is not the directory this update built; it was left for doctor`,
      }
      sayNotDone(st, { ...notDone, path: st.opDir })
      return refused(st, reason, detail, { staged: 'left', notDone })
    }
    trace(st, { op: 'identity', path: newDir })
    keptAs = await keepIfNeeded(st, newDir)
    return await metadataThenPark(st, reason, detail, keptAs)
  } catch (err) {
    rethrowLockOrder(err)
    const stop = describe(err)
    const notDone: NotDone = { status: 'stopped', reason: stop.reason, detail: stop.detail }
    sayNotDone(st, { ...notDone, path: st.opDir })
    return refused(st, reason, detail, {
      staged: 'left',
      ...(keptAs === undefined ? {} : { keptAs }),
      notDone,
    })
  }
}

/** N's identity as a directory, `absent` when nothing is there; null for a non-directory. */
async function lstatId(p: string): Promise<ReturnType<typeof bindIdentity> | 'absent'> {
  const id = bindIdentity(p)
  if (!id.ok) return id.errno === 'ENOENT' ? 'absent' : id
  return id.fmt === S_IFDIR ? id : { ok: false, errno: null }
}

/** Steps 4 and 5: keep a partial or changed N through `publishTree`; undefined to park it. */
async function keepIfNeeded(
  st: SwapState,
  newDir: string
): Promise<{ kind: AbortKeptKind; path: string } | undefined> {
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
  keptAs: { kind: AbortKeptKind; path: string } | undefined
): Promise<Refused> {
  const p = opPaths(st)
  // OP may hold only what this run put there: N (when it is to be parked) and
  // its own metadata. Anything else was put there by someone else; like step
  // 13's `op-not-empty`, nothing is unlinked or parked and OP stays for doctor.
  const mine = new Set(
    [...ownedMeta(st), ...(st.owned.has(p.record) ? [p.record] : [])].map((f) => path.basename(f))
  )
  const names = await fs.promises.readdir(st.opDir)
  const parkN = keptAs === undefined && names.includes(NEW_DIR) && st.buildIdentity !== null
  const foreign = names.filter((n) => !mine.has(n) && !(parkN && n === NEW_DIR)).sort()
  if (foreign.length > 0) {
    const notDone: NotDone = {
      status: 'kept',
      reason: 'op-not-empty',
      detail: `${st.opDir} holds ${foreign.join(', ')}, which this update did not write`,
    }
    sayNotDone(st, { ...notDone, path: st.opDir })
    return refused(st, reason, detail, { staged: 'left', ...(keptAs ? { keptAs } : {}), notDone })
  }
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
  const kept = keptAs === undefined ? {} : { keptAs }
  if ((await fs.promises.readdir(st.opDir)).length === 0) {
    await rmdirChecked(st, st.opDir)
    await syncDir(st, st.binding.stagingDir)
    return refused(st, reason, detail, { staged: keptAs === undefined ? 'none' : 'kept', ...kept })
  }
  return parkOp(st, reason, detail, keptAs)
}

/** Step 6's park of OP from ST, in the late-bound order. */
async function parkOp(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string,
  keptAs: { kind: AbortKeptKind; path: string } | undefined
): Promise<Refused> {
  const ST = st.binding.stagingDir
  const kept = keptAs === undefined ? {} : { keptAs }
  const leftWith = (notDone: NotDone): Refused => {
    sayNotDone(st, { ...notDone, path: notDone.path ?? st.opDir })
    return refused(st, reason, detail, { staged: 'left', ...kept, notDone })
  }
  checkTraced(st)
  const g = await gateAndBind({ probeDir: ST, parentAbs: ST, name: st.opId, opId: st.opId })
  if (!g.ok) {
    const left = 'leftProbe' in g && g.leftProbe !== null ? ` (probe left at ${g.leftProbe})` : ''
    return leftWith({
      status: 'stopped',
      reason: g.reason,
      ...(g.errno === null ? {} : { errno: g.errno }),
      detail: `${g.detail}${left}`,
    })
  }
  if (st.op === null || !sameIdentity(st.op.identity, g.expectIdentity)) {
    return leftWith({ status: 'kept', reason: 'identity-changed', detail: `${st.opDir} changed` })
  }
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
  return leftWith({
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

const withHint = <R extends SwapResult>(r: R, hint: string | undefined): R =>
  hint === undefined ? r : { ...r, gitignoreHint: hint }

/** Lock 1 was not taken (busy, or `check` refused as it was taken): OP is left. */
function leftUnlocked(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string,
  stop: SkillWriteStop
): Refused {
  return refused(st, reason, detail, {
    staged: 'left',
    notDone: { status: 'stopped', reason: stop.code, detail: stop.detail },
  })
}

/** A step-1 failure: lock 1 with one normal wait (§3.2), then cleanup. */
export async function abortBeforeLock(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string
): Promise<SwapResult> {
  if (!st.opCreated) return noneResult(st, reason, detail)
  const locked = await withSkillWriteLock(
    st.binding,
    LABEL,
    async (ctx) => {
      st.ctx = ctx
      return runCleanup(st, reason, detail)
    },
    st.options.lockTimeoutMs === undefined ? {} : { timeoutMs: st.options.lockTimeoutMs }
  )
  st.ctx = null
  if (locked.ok) return withHint(locked.value, locked.gitignoreHint)
  return withHint(leftUnlocked(st, reason, detail, locked.stop), locked.gitignoreHint)
}

/**
 * After step 2 did not get lock 1. `busy`: the second wait (UD16), then
 * cleanup with `busy` kept as the reason; still busy, OP is left. Any other
 * stop (`check` refused as the lock was taken): OP is left, nothing touched.
 */
export async function abortAfterBusy(
  st: SwapState,
  first: SkillWriteResult<SwapResult> & { ok: false }
): Promise<SwapResult> {
  const { stop } = first
  if (stop.code !== 'busy') {
    return withHint(leftUnlocked(st, stop.code, stop.detail, stop), first.gitignoreHint)
  }
  const waitMs = st.options.secondWaitMs ?? DEFAULT_SECOND_WAIT_MS
  const pollMs = st.options.secondWaitPollMs ?? DEFAULT_POLL_MS
  assertSkillWriteLockNotHeld('update: the second wait for lock 1')
  say(
    st,
    `Another Skillsmith operation is changing ${st.binding.root}; waiting up to ` +
      `${Math.ceil(waitMs / 1000)} s to set aside this update's unused staged copy.`
  )
  await hook(st, 'secondWaitStart')
  let hint = first.gitignoreHint
  const deadline = Date.now() + waitMs
  for (;;) {
    const r = await withSkillWriteLock(
      st.binding,
      LABEL,
      async (ctx) => {
        st.ctx = ctx
        return runCleanup(st, 'busy', stop.detail)
      },
      { timeoutMs: 0 }
    )
    st.ctx = null
    hint ??= r.gitignoreHint
    if (r.ok) return withHint(r.value, hint)
    if (r.stop.code !== 'busy') return withHint(leftUnlocked(st, 'busy', stop.detail, r.stop), hint)
    if (Date.now() >= deadline) return withHint(leftUnlocked(st, 'busy', stop.detail, r.stop), hint)
    await delay(pollMs)
  }
}
