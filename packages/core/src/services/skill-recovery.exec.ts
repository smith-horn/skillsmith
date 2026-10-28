/**
 * SMI-6531 (A1 step 6b-i): every doctor action after confirmation, the shared
 * prologue (A1 plan §3.9, the confirmation contract items 6-7; design
 * `step6b-design.md` § 1, generalised from 6a's `apply | undo`).
 *
 * `executeRecovery(planned)`:
 *  1. binds the root read-only and takes lock 1 (`withSkillWriteLock`);
 *  2. re-plans with a fresh `ClassifierReader` and compares
 *     `digestOf(transcript, serializePlan(cls))` with the confirmed plan's.
 *     Any difference is `plan-changed` with zero mutation;
 *  3. dispatches:
 *     - an empty target op dir, for any action: one `rmdir` (PLAN:1279);
 *     - `--park`: `parkUnreadable` (`skill-recovery.park-unreadable.ts`); a
 *       stop reports whether OP is still at its origin (`parkStopped`);
 *     - `--abandon` and `--clean-staging` on a non-empty op dir: refused
 *       "not performed by this version yet" with zero mutation (a backstop:
 *       `planRecovery` already refuses them before the prompt, until 6b-ii
 *       and 6b-iii);
 *     - `--apply` / `--undo` of a no-record op dir whose intent verifies:
 *       `finishFromIntent` (6a-iii);
 *     - `--apply` / `--undo` of a §3.3 row: `runRecorded`
 *       (`skill-recovery.run.ts`);
 *  4. after a finished action, `sweepRoot` removes the probes and empty op
 *     dirs the plan listed.
 *
 * It never prompts. A stop before any mutation keeps everything as it was,
 * so the same command resumes it.
 *
 * @module @skillsmith/core/services/skill-recovery.exec
 */
import fs from 'node:fs'
import path from 'node:path'
import { getJournalFilePath } from '../journal/path.js'
import { classifyOp } from './skill-recovery.classify.js'
import type { ClassifyContext } from './skill-recovery.classify.js'
import { digestOf } from './skill-recovery.digest.js'
import { removeEmptyOp, sweepRoot } from './skill-recovery.finish.js'
import { finishFromIntent } from './skill-recovery.intent-park.js'
import { parkUnreadable } from './skill-recovery.park-unreadable.js'
import { serializePlan } from './skill-recovery.plan.js'
import { ClassifierReader } from './skill-recovery.reader.js'
import { refused, runRecorded } from './skill-recovery.run.js'
import type {
  PlannedRecovery,
  RecoveryDone,
  RecoveryRunOptions,
  RecoveryRunResult,
} from './skill-recovery.run.types.js'
import { rethrowLockOrder } from './skill-swap.ops.js'
import { describe } from './skill-swap.abort.js'
import { RECORD_FILE } from './skill-swap.types.js'
import type { RecoveryClass } from './skill-recovery.types.js'
import { bindSkillsRootReadOnly, withSkillWriteLock } from './skill-write-lock.js'
import type { SkillWriteContext } from './skill-write-lock.types.js'

/** Lock 1, the re-plan and its digest comparison, then the action. Never prompts. */
export async function executeRecovery(
  planned: PlannedRecovery,
  opts: RecoveryRunOptions = {}
): Promise<RecoveryRunResult> {
  const req = planned.request
  const binding = await bindSkillsRootReadOnly(planned.root).catch(() => null)
  if (binding === null)
    return refused('plan-changed', `${planned.root} has no staging dir now`, planned.opDir)
  const journalFile = req.journalFile ?? getJournalFilePath()
  const classifyCtx: ClassifyContext = {
    root: binding.root,
    stagingDir: binding.stagingDir,
    euid: req.euid ?? process.geteuid?.() ?? -1,
    journalFile,
    ...(req.acceptIdentity === undefined ? {} : { acceptIdentity: req.acceptIdentity }),
    stateRoots: req.stateRoots ?? [],
  }
  const locked = await withSkillWriteLock(
    binding,
    'doctor recovery',
    (ctx) => underLock(planned, opts, ctx, classifyCtx, journalFile),
    opts.lockTimeoutMs === undefined ? {} : { timeoutMs: opts.lockTimeoutMs }
  )
  if (locked.ok) return locked.value
  return {
    status: 'refused',
    reason: locked.stop.code,
    detail: locked.stop.detail,
    paths: [planned.opDir],
  }
}

/** A stop thrown before anything finished, as a result naming no record. */
function stoppedOf(opId: string, err: unknown): RecoveryRunResult {
  rethrowLockOrder(err)
  const d = describe(err)
  return { status: 'stopped', opId, ...d, recordPath: null, warnings: [] }
}

/**
 * A `--park` that stopped: whether OP is still at its origin with the identity
 * the re-plan saw is observed now, so the result says truthfully whether
 * anything moved (a stop before the rename leaves `record.json` in OP).
 */
function parkStopped(
  opId: string,
  err: unknown,
  cls: Extract<RecoveryClass, { kind: 'unreadable' }>
): RecoveryRunResult {
  rethrowLockOrder(err)
  const d = describe(err)
  const seen = cls.observed?.identity ?? null
  let stillThere = false
  try {
    const s = fs.lstatSync(cls.opDir, { bigint: true })
    stillThere =
      s.isDirectory() &&
      seen !== null &&
      s.dev.toString() === seen.dev &&
      s.ino.toString() === seen.ino
  } catch {
    stillThere = false
  }
  return {
    status: 'stopped',
    opId,
    ...d,
    recordPath: stillThere ? path.join(cls.opDir, RECORD_FILE) : null,
    warnings: [],
    opDir: { path: cls.opDir, stillThere },
  }
}

async function underLock(
  planned: PlannedRecovery,
  opts: RecoveryRunOptions,
  ctx: SkillWriteContext,
  classifyCtx: ClassifyContext,
  journalFile: string
): Promise<RecoveryRunResult> {
  const req = planned.request
  const reader = new ClassifierReader(req.reader)
  const cls = await classifyOp(reader, classifyCtx, req.opId)
  const transcript = reader.transcript()
  if (digestOf(transcript, serializePlan(cls)) !== planned.report.digest) {
    return refused(
      'plan-changed',
      'what the plan read changed before the lock was taken; nothing was changed. Run the command again to see the new plan',
      planned.opDir
    )
  }
  await opts.afterReplan?.()
  const out: RecoveryDone = {
    status: 'done',
    opId: req.opId,
    action: req.action,
    from: planned.report.label,
    installed: null,
    kept: [],
    extraCopy: null,
    manifest: 'untouched',
    audit: { kind: 'none' },
    warnings: [],
    swept: { removed: [], left: [] },
  }
  if (planned.emptyTarget !== null) {
    try {
      await removeEmptyOp(ctx, planned.emptyTarget, opts.swap?.trace)
    } catch (err) {
      return stoppedOf(req.opId, err)
    }
    const swept = await sweepRoot(ctx, planned.sweep, opts.swap?.trace)
    // The target itself is the first thing this action removed.
    out.swept = { removed: [planned.emptyTarget.path, ...swept.removed], left: swept.left }
    return out
  }
  if (req.action === 'park') {
    if (cls.kind !== 'unreadable') {
      return refused('plan-changed', `the op is now ${cls.kind}`, planned.opDir)
    }
    try {
      const r = await parkUnreadable(ctx, cls, req.stateRoots ?? [], opts.swap ?? {})
      out.warnings = r.st.warnings
      if (r.parkedPath !== null) {
        out.kept.push({ tree: 'OP', kind: 'unreadable-record', path: r.parkedPath })
      }
    } catch (err) {
      return parkStopped(req.opId, err, cls)
    }
    out.swept = await sweepRoot(ctx, planned.sweep, opts.swap?.trace)
    return out
  }
  if (req.action !== 'apply' && req.action !== 'undo') {
    return refused(
      'plan-changed',
      `--${req.action} is not performed by this version yet`,
      planned.opDir
    )
  }
  if (cls.kind === 'no-record') {
    // 6a-iii: the record is gone and the park intent verifies: finish the park from it.
    try {
      const r = await finishFromIntent(ctx, cls, transcript, opts.swap ?? {})
      out.warnings = r.st.warnings
      out.extraCopy = r.extraCopy
    } catch (err) {
      return stoppedOf(req.opId, err)
    }
    out.swept = await sweepRoot(ctx, planned.sweep, opts.swap?.trace)
    return out
  }
  if (cls.kind !== 'state') {
    return refused('plan-changed', `the op is now ${cls.kind}`, planned.opDir)
  }
  return runRecorded({ planned, opts, ctx, cls, transcript, journalFile, out })
}
