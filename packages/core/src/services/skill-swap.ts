/**
 * SMI-6531 (A1 step 4a): `swapInPlace`, the in-place update transaction on
 * one device (A1 plan §3.3 steps 1-13, undo and `publishTree`; §3.1, §3.4-3.7).
 *
 *  1. Outside any lock: bind R and ST, make OP, write `owner.json`, build
 *     `new/` (`skill-swap.staging.ts`).
 *  2. Lock 1 (`withSkillWriteLock`, label `skill update`); `check`.
 *  3. The record scan: SMI-6531 step 5 (below).
 *  4. Re-verify the target, its tree hash and the manifest CAS.
 *  5. `record.json`.
 *  6-8. Rename 1 (`realDir` → `OP/old`), rename 2 (`OP/new` → `realDir`),
 *     identity checks; a replaced folder is undone (`target-changed`).
 *  9. Hash O: a foreign write before rename 1 warns `backup-holds-foreign-change`.
 *  10. Commit under one `withManifestLock`: (a) CAS, else undo
 *     (`changed-since-plan`); (b) `check` and `newIdentity`, else `stopped`;
 *     (c) re-hash, warning `live-folder-changed`; (d) pre-commit check; (e) write.
 *  11. Journal append; a failure is `committed` with `incomplete: audit`.
 *  12. `publishTree(O, 'backup')`.
 *  13. Metadata unlinks and `rmdir OP`.
 *
 * Results: `refused` before rename 1 (every abort goes through
 * `abortBeforeRename1`, which in 4a removes nothing), `stopped` after rename 1
 * with the record kept, `undone`, or `committed` (with `incomplete` when a step
 * after the commit stopped; the record is then kept).
 *
 * Before step 1, `ensureSkillsRoot` makes an absent root and its missing
 * parents (UD22); a refusal there is `refused` / `root-unsafe`.
 *
 * Owned elsewhere: abort cleanup (step 4b), cross-device publish and the park
 * (step 4c).
 *
 * @module @skillsmith/core/services/skill-swap
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LockOrderError } from '../config/lock-tracker.js'
import { appendJournalRecord } from '../journal/writer.js'
import { getJournalSessionId } from '../journal/path.js'
import { JOURNAL_SCHEMA_VERSION } from '../journal/types.js'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import { ensureSkillsRoot } from './skill-root.ensure.js'
import { treeHashOf } from './skill-tree.js'
import { bindSkillsRoot, withSkillWriteLock } from './skill-write-lock.js'
import { SkillWriteStop } from './skill-write-lock.types.js'
import type { SkillsRootBinding } from './skill-write-lock.types.js'
import {
  check,
  hook,
  messageOf,
  opPaths,
  renameChecked,
  SwapFault,
  syncDir,
  trace,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { backupAreaPath, finishOp, publishTree, warnForeignChange } from './skill-swap.publish.js'
import {
  abortBeforeRename1,
  buildNewFolder,
  createOp,
  writeOwner,
  writeRecord,
} from './skill-swap.staging.js'
import { undoSwap } from './skill-swap.undo.js'
import { changedPaths } from './skill-swap.writeset.js'
import type {
  SwapInput,
  SwapOptions,
  SwapRefuseReason,
  SwapResult,
  SwapWarning,
} from './skill-swap.types.js'

export * from './skill-swap.types.js'
export { computeRecordSha256 } from './skill-swap.staging.js'

const REFUSE_REASONS: ReadonlySet<string> = new Set<SwapRefuseReason>([
  'changed-since-plan',
  'target-changed',
  'write-failed',
  'staging-collision',
  'staging-unsafe',
  'root-changed',
  'backup-unsafe',
  'root-unsafe',
  'busy',
])

/** The reason word and detail of a failure. Unexpected errors are `write-failed` / `failed`. */
function describe(err: unknown, fallback: string): { reason: string; detail: string } {
  if (err instanceof SwapFault) return { reason: err.reason, detail: err.detail }
  if (err instanceof SkillWriteStop) return { reason: err.code, detail: err.detail }
  return { reason: fallback, detail: messageOf(err) }
}

/** Maps a failure to a result by how far the transaction got. */
function resultOfFailure(st: SwapState, err: unknown): SwapResult {
  if (st.phase === 'staging' || st.phase === 'locked') {
    const { reason, detail } = describe(err, 'write-failed')
    const r = REFUSE_REASONS.has(reason) ? (reason as SwapRefuseReason) : 'write-failed'
    return abortBeforeRename1(st, r, detail)
  }
  const recordPath = opPaths(st).record
  if (st.phase === 'swapped') {
    const { reason, detail } = describe(err, 'failed')
    return { status: 'stopped', opId: st.opId, recordPath, reason, detail, warnings: st.warnings }
  }
  const { reason, detail } = describe(err, 'failed')
  return {
    status: 'committed',
    opId: st.opId,
    backupDest: st.backupDest,
    warnings: st.warnings,
    incomplete: { step: st.step, reason, detail },
    recordPath,
  }
}

/** Step 4 under lock 1. Throws `SwapFault` (`target-changed`, `changed-since-plan`). */
async function reverify(st: SwapState): Promise<void> {
  const { comparedPath, realDir, oldIdentity, preTree, manifest } = st.input
  let resolved: string
  try {
    resolved = await fs.promises.realpath(comparedPath)
  } catch (err) {
    throw new SwapFault('target-changed', `${comparedPath} no longer resolves`, err)
  }
  if (resolved !== realDir) {
    throw new SwapFault('target-changed', `${comparedPath} now resolves to ${resolved}`)
  }
  assertIdentity(realDir, oldIdentity, 'target-changed', 'the skill folder')
  const h = treeHashOf(realDir)
  if (!h.ok || h.hash !== preTree) {
    throw new SwapFault('changed-since-plan', 'the skill folder changed since it was planned')
  }
  await hook(st, 'afterStep4Hash')
  let cas: boolean
  try {
    cas = await manifest.withManifestLock((m) => m.casMatches())
  } catch (err) {
    // The CAS could not confirm the entry equals `preEntry`.
    throw new SwapFault(
      'changed-since-plan',
      `the manifest entry could not be read (${messageOf(err)})`,
      err
    )
  }
  if (!cas)
    throw new SwapFault('changed-since-plan', 'the manifest entry changed since it was planned')
}

/** `lstat(p)` is a directory (not a symlink) with `id`, else `SwapFault(reason)`. */
function assertIdentity(
  p: string,
  id: Parameters<typeof sameIdentity>[0],
  reason: string,
  what: string
): void {
  const now = bindIdentity(p)
  if (!now.ok || !sameIdentity(id, now)) {
    throw new SwapFault(reason, `${what} at ${p} is not the one that was planned`)
  }
}

type CommitVerdict = 'committed' | 'cas-failed'

/** Step 10 (a)-(e), all inside one `withManifestLock`. */
async function commit(st: SwapState): Promise<CommitVerdict> {
  const { realDir, manifest, manifestPath } = st.input
  return manifest.withManifestLock(async (m): Promise<CommitVerdict> => {
    if (!(await m.casMatches())) return 'cas-failed'
    check(st)
    assertIdentity(realDir, st.newIdentity!, 'target-changed', 'the new folder')
    await hook(st, 'beforeCommitRehash')
    const live = treeHashOf(realDir)
    if (!live.ok) {
      st.warnings.push({ code: 'live-folder-changed', paths: [path.relative(realDir, live.path)] })
    } else if (live.hash !== st.postTree) {
      st.warnings.push({
        code: 'live-folder-changed',
        paths: changedPaths(st.postRecord!, live.record),
      })
    }
    try {
      await m.preCommitCheck()
    } catch (err) {
      throw new SwapFault('pre-commit-check-failed', messageOf(err), err)
    }
    try {
      await m.write()
    } catch (err) {
      throw new SwapFault('manifest-write-failed', messageOf(err), err)
    }
    trace(st, { op: 'manifest-write', path: manifestPath })
    st.phase = 'committed'
    return 'committed'
  })
}

/** Undo, step 13, and the `undone` result. Failures propagate (phase `swapped`: `stopped`). */
async function undoAndFinish(
  st: SwapState,
  reason: 'target-changed' | 'changed-since-plan'
): Promise<SwapResult> {
  const { keptAs, keptPath } = await undoSwap(st)
  await finishOp(st)
  return { status: 'undone', opId: st.opId, reason, keptAs, keptPath, warnings: st.warnings }
}

/** Step 11's journal input. */
function journalInput(st: SwapState) {
  return {
    schema: JOURNAL_SCHEMA_VERSION,
    ts: Date.now(),
    session_id: getJournalSessionId(),
    tool: 'update',
    action: 'apply' as const,
    suggestion_id: st.opId,
    target_path: st.input.realDir,
    before_hash: st.input.preTree,
    after_hash: st.postTree,
    approval: 'update',
    backup_ref: st.backupDest,
    detail: null,
  }
}

/** Steps 6-13. */
async function swapAndCommit(st: SwapState): Promise<SwapResult> {
  const { realDir, oldIdentity, preTree } = st.input
  const { oldDir, newDir } = opPaths(st)
  const root = st.binding.root

  await hook(st, 'beforeRename1Check')
  check(st)
  assertIdentity(realDir, oldIdentity, 'target-changed', 'the skill folder')
  await hook(st, 'beforeRename1')
  await renameChecked(st, realDir, oldDir)
  st.phase = 'swapped'
  await hook(st, 'afterRename1')
  await syncDir(st, st.opDir)
  await syncDir(st, root)
  await hook(st, 'afterRename1Syncs')

  await renameChecked(st, newDir, realDir)
  await syncDir(st, root)
  await syncDir(st, st.opDir)
  await hook(st, 'afterRename2')

  const o = bindIdentity(oldDir)
  const n = bindIdentity(realDir)
  if (!o.ok || !sameIdentity(oldIdentity, o) || !n.ok || !sameIdentity(st.newIdentity!, n)) {
    return undoAndFinish(st, 'target-changed')
  }

  const oldHash = treeHashOf(oldDir)
  if (!oldHash.ok || oldHash.hash !== preTree) warnForeignChange(st, st.backupDest)

  await hook(st, 'beforeCommit')
  if ((await commit(st)) === 'cas-failed') return undoAndFinish(st, 'changed-since-plan')
  await hook(st, 'afterCommit')

  st.step = 'audit'
  try {
    await (st.options.appendJournal ?? appendJournalRecord)(journalInput(st))
  } catch (err) {
    return resultOfFailure(st, new SwapFault('journal-append-failed', messageOf(err), err))
  }
  trace(st, { op: 'journal-append', path: st.opId })

  st.step = 'publish'
  st.backupDest = await publishTree(st, oldDir, 'backup')
  st.step = 'cleanup'
  await finishOp(st)
  return { status: 'committed', opId: st.opId, backupDest: st.backupDest, warnings: st.warnings }
}

/** Everything under lock 1 (steps 2-13). Never throws a `SkillWriteStop`. */
async function underLock(st: SwapState): Promise<SwapResult> {
  st.phase = 'locked'
  try {
    // Step 3, the record scan of `ST/*/record.json` (`recovery-pending`,
    // `recovery-record-unreadable`): SMI-6531 step 5 of the implementation order.
    await reverify(st)
    await writeRecord(st)
    await hook(st, 'afterRecord')
    return await swapAndCommit(st)
  } catch (err) {
    // A lock-order violation is a bug, not an outcome: it propagates.
    if (err instanceof LockOrderError) throw err
    return resultOfFailure(st, err)
  }
}

function newState(
  input: SwapInput,
  options: SwapOptions,
  binding: SkillsRootBinding,
  warnings: SwapWarning[]
): SwapState {
  const opId = options.opId ?? randomBytes(16).toString('hex')
  let stateRootReal: string
  try {
    stateRootReal = fs.realpathSync.native(input.stateRoot)
  } catch {
    stateRootReal = path.resolve(input.stateRoot)
  }
  const areaPath = backupAreaPath(stateRootReal, input.client, binding.root, input.dirName)
  return {
    input,
    options,
    opId,
    binding,
    warnings,
    opDir: path.join(binding.stagingDir, opId),
    ctx: null,
    opCreated: false,
    op: null,
    area: null,
    newIdentity: null,
    postTree: null,
    postRecord: null,
    stateRootReal,
    areaPath,
    backupDest: path.join(areaPath, opId),
    phase: 'staging',
    step: 'audit',
  }
}

/**
 * Updates one skill folder in place on one device (plan §3.3). Never throws
 * for an expected outcome; see `SwapResult`.
 */
export async function swapInPlace(
  input: SwapInput,
  options: SwapOptions = {}
): Promise<SwapResult> {
  const warnings: SwapWarning[] = []
  // UD22: an absent root (and missing parents) is made before R is bound.
  const sink = options.trace
  const ensured = await ensureSkillsRoot(
    input.skillsDir,
    sink === undefined
      ? {}
      : { trace: (t) => sink({ op: t.op === 'sync' ? 'dirsync' : 'mkdir', path: t.path }) }
  )
  if (!ensured.ok) {
    return {
      status: 'refused',
      reason: 'root-unsafe',
      staged: 'none',
      opDir: null,
      cleanStagingHint: null,
      detail: ensured.detail,
      warnings,
    }
  }
  let binding: SkillsRootBinding
  try {
    binding = await bindSkillsRoot(input.skillsDir)
  } catch (err) {
    if (!(err instanceof SkillWriteStop)) throw err
    const reason = REFUSE_REASONS.has(err.code) ? (err.code as SwapRefuseReason) : 'staging-unsafe'
    return {
      status: 'refused',
      reason,
      staged: 'none',
      opDir: null,
      cleanStagingHint: null,
      detail: err.detail,
      warnings,
    }
  }
  for (const w of binding.warnings)
    warnings.push({ code: 'mode', path: binding.stagingDir, detail: w })
  const st = newState(input, options, binding, warnings)

  try {
    await createOp(st)
    await writeOwner(st)
    await buildNewFolder(st)
  } catch (err) {
    return resultOfFailure(st, err)
  }

  const locked = await withSkillWriteLock(
    binding,
    'skill update',
    async (ctx) => {
      st.ctx = ctx
      return underLock(st)
    },
    options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }
  )
  if (locked.ok) return locked.value
  // `busy` (4b adds the second wait), or `check` refusing as lock 1 was taken.
  return abortBeforeRename1(st, locked.stop.code, locked.stop.detail)
}
