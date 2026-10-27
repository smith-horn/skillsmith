/**
 * SMI-6531 (A1 step 6a-ii): `doctor recovery --apply` / `--undo` on one
 * device, after confirmation (A1 plan §3.9, the confirmation contract items
 * 6-7; §3.3 dispositions; design § 2 "Used twice", § 4, § 5).
 *
 * `executeRecovery(planned)` takes lock 1 for the root, then re-plans with a
 * fresh reader and compares `digestOf(transcript, plan)` with the confirmed
 * plan's. Any difference is `plan-changed` with zero mutation. Then it runs
 * the row, keeping the transaction's order (commit, audit, publish, finish):
 *
 * | Row | Sequence |
 * |---|---|
 * | S0 (`--apply` = `--undo`) | keep N; finish |
 * | S1 `--apply` | install N (claim, or over the bound empty claim); commit; audit; keep O as backup; finish |
 * | S1 `--undo` | install O; keep N; finish |
 * | S2 `--apply` (and post-keep) | commit; audit; keep O unless kept; finish |
 * | S3 `--apply` (and post-keep) | audit once; keep O unless kept; finish |
 * | S2/S2'/S2x `--undo` | set T aside (when present); install O; keep T's tree as `undone`/`conflict`; finish |
 * | UN1 | install O (claim, or over the bound empty claim); keep U; finish |
 * | UN2 | keep U unless kept; finish |
 *
 * Every keep resumes a started one (`skill-recovery.resume.ts`); the kinds are
 * the confirmed plan's. When the commit is the first mutation (S2), a CAS miss
 * is `plan-changed` with zero mutation; after the install (S1) it stops
 * `changed-since-plan` with the record kept, and the next run sees S2'. Every
 * stop keeps the record (unless the finish had already unlinked it), so the
 * same command resumes it. After a finished action, the probes and empty op
 * dirs the plan listed are removed (`sweepRoot`).
 *
 * @module @skillsmith/core/services/skill-recovery.run
 */
import path from 'node:path'
import { getJournalFilePath } from '../journal/path.js'
import { appendJournalRecordOnce } from '../journal/writer.js'
import { classifyOp } from './skill-recovery.classify.js'
import type { ClassifyContext } from './skill-recovery.classify.js'
import { digestOf } from './skill-recovery.digest.js'
import { finishRecovered, removeEmptyOp, sweepRoot } from './skill-recovery.finish.js'
import { serializePlan } from './skill-recovery.plan.js'
import { ClassifierReader } from './skill-recovery.reader.js'
import { installAt, keepRole } from './skill-recovery.resume.js'
import type { KeepContext } from './skill-recovery.resume.js'
import { adoptMetadata, recoveryState } from './skill-recovery.state.js'
import type { Adopted } from './skill-recovery.state.js'
import { crossDeviceReason } from './skill-recovery.target.js'
import type {
  AuditOutcome,
  PlannedRecovery,
  RecoveryDone,
  RecoveryRunOptions,
  RecoveryRunResult,
} from './skill-recovery.run.types.js'
import type { OpFacts, PlanStep, ReadTranscript, RecoveryClass } from './skill-recovery.types.js'
import { commit, journalInput } from './skill-swap.commit.js'
import { hook, opPaths, rethrowLockOrder, SwapFault, trace } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { publishTree } from './skill-swap.publish.js'
import { describe } from './skill-swap.abort.js'
import { undoAside } from './skill-swap.undo.js'
import { OWNER_FILE, RECORD_FILE } from './skill-swap.types.js'
import { bindSkillsRootReadOnly, withSkillWriteLock } from './skill-write-lock.js'
import type { SkillWriteContext } from './skill-write-lock.types.js'

type RowClass = Extract<RecoveryClass, { kind: 'state' }>

/** The kind the confirmed plan keeps `tree` as. */
function kindIn(steps: readonly PlanStep[], tree: PlanStep['tree']): string | null {
  const s = steps.find((x) => x.tree === tree)
  return s !== undefined && s.disposition.kind === 'kept' ? s.disposition.as : null
}

/** The metadata files finish may unlink: `owner.json`, a provable `record.json.tmp`, and `record.json` (last). */
function adoptAll(f: OpFacts, names: readonly string[], t: ReadTranscript): Adopted[] {
  const out: Adopted[] = []
  const at = (n: string): string => path.join(f.opDir, n)
  if (names.includes(OWNER_FILE)) out.push(adoptMetadata(t, at(OWNER_FILE)))
  const tmp = f.recordTmp
  if (tmp !== null) {
    if (!tmp.sameInode && !tmp.emptySingleLink && !(tmp.bodyMatches && !tmp.hasMarker)) {
      throw new SwapFault('staging-unsafe', `${tmp.path} is not provably this operation's`)
    }
    out.push(adoptMetadata(t, tmp.path))
  }
  out.push(adoptMetadata(t, at(RECORD_FILE)))
  return out
}

/** The names the re-plan listed in OP. */
function listedNames(t: ReadTranscript, opDir: string): string[] {
  const e = t.find((x) => x.method === 'list' && x.key === `${opDir}\0all`)
  const fact = e?.fact as { ok: boolean; names?: string[] } | undefined
  return fact?.ok === true && fact.names !== undefined ? fact.names : []
}

interface Row {
  st: SwapState
  cls: RowClass
  steps: readonly PlanStep[]
  k: KeepContext
  out: RecoveryDone
  opts: RecoveryRunOptions
  journalFile: string
}

/** Keeps `tree` (a role) as the plan says, recording where. */
async function keep(row: Row, tree: 'O' | 'N' | 'U'): Promise<void> {
  const kind = kindIn(row.steps, tree) ?? (tree === 'O' ? 'backup' : null)
  if (kind === null) return
  const dest = await keepRole(row.st, tree, kind, row.k)
  if (dest === null) return
  row.out.kept.push({ tree, kind, path: dest })
  if (kind === 'conflict') row.st.warnings.push({ code: 'conflict-kept', path: dest })
}

/** Step 11 once: `appended`, `present`, or `not-recorded` on a torn tail. */
async function audit(row: Row): Promise<AuditOutcome> {
  const append = row.opts.appendOnce ?? appendJournalRecordOnce
  let r: Awaited<ReturnType<typeof appendJournalRecordOnce>>
  try {
    r = await append(journalInput(row.st), { file: row.journalFile })
  } catch (err) {
    rethrowLockOrder(err)
    const msg = err instanceof Error ? err.message : String(err)
    throw new SwapFault('journal-append-failed', `the audit append failed (${msg})`, err)
  }
  // Only an append is a journal write: `present` found the record and wrote nothing.
  if (r.outcome === 'appended') trace(row.st, { op: 'journal-append', path: row.st.opId })
  await hook(row.st, 'afterAudit')
  if (r.outcome === 'torn-tail') {
    const how =
      r.why === 'unparseable-tail'
        ? 'ends mid-line or with a line that does not parse'
        : 'ends with a complete line that names no chain head (record_hash)'
    return {
      kind: 'not-recorded',
      file: r.file,
      detail:
        `audit-not-recorded: ${r.file} ${how}, so no audit record was appended for ` +
        `${row.st.opId}; once this operation's record is removed the gap is permanent`,
    }
  }
  return { kind: r.outcome, file: r.file }
}

/** The commit when nothing has moved yet: a CAS miss is the plan having changed. */
async function commitFirst(row: Row): Promise<'plan-changed' | null> {
  if ((await commit(row.st)) === 'cas-failed') return 'plan-changed'
  row.out.manifest = 'committed'
  await hook(row.st, 'afterCommit')
  return null
}

/** The claim at T the re-plan saw, when T is one. */
const claimOf = (f: OpFacts) => (f.tState === 'claim' && f.t.present ? f.t.identity : null)

/** Runs the row. Returns `plan-changed` when the first mutation found the plan stale. */
async function runRow(row: Row, action: 'apply' | 'undo'): Promise<'plan-changed' | null> {
  const { st, cls } = row
  const f = cls.facts
  const p = opPaths(st)
  switch (cls.state) {
    case 'S0':
      await keep(row, 'N')
      return null
    case 'S1':
      if (action === 'apply') {
        await installAt(st, p.newDir, claimOf(f))
        row.out.installed = 'N'
        if ((await commit(st)) === 'cas-failed') {
          throw new SwapFault(
            'changed-since-plan',
            'the manifest entry changed after the new folder was installed; the record is kept'
          )
        }
        row.out.manifest = 'committed'
        await hook(st, 'afterCommit')
        row.out.audit = await audit(row)
        await keep(row, 'O')
        return null
      }
      await installAt(st, p.oldDir, claimOf(f))
      row.out.installed = 'O'
      await keep(row, 'N')
      return null
    case 'S2':
    case 'S2prime':
    case 'S2x':
      if (action === 'apply') {
        if ((await commitFirst(row)) !== null) return 'plan-changed'
        row.out.audit = await audit(row)
        if (!cls.postKeep) await keep(row, 'O')
        return null
      }
      return undoSwapped(row)
    case 'S3':
      row.out.audit = await audit(row)
      if (!cls.postKeep) await keep(row, 'O')
      return null
    case 'UN1':
      await installAt(st, p.oldDir, claimOf(f))
      row.out.installed = 'O'
      await keep(row, 'U')
      return null
    case 'UN2':
      await keep(row, 'U')
      return null
  }
}

/** S2, S2' and S2x `--undo`: T aside (when present), O back, T's tree kept. */
async function undoSwapped(row: Row): Promise<null> {
  const { st } = row
  const f = row.cls.facts
  const p = opPaths(st)
  if (f.t.present) await undoAside(st)
  await installAt(st, p.oldDir, null)
  row.out.installed = 'O'
  if (f.t.present) {
    const kind = kindIn(row.steps, 'T') ?? 'conflict'
    const dest = await publishTree(st, p.undoneDir, kind === 'undone' ? 'undone' : 'conflict')
    row.out.kept.push({ tree: 'T', kind, path: dest })
    if (kind !== 'undone') st.warnings.push({ code: 'conflict-kept', path: dest })
  }
  return null
}

/** `--accept-identity`: the identities observed now, for the re-checks (check 5 only is waived). */
function acceptedIdentities(f: OpFacts) {
  const obs = (r: OpFacts['roles']['O']) => (r.kind === 'source' ? r.obs.identity : undefined)
  const t = f.t.present ? f.t.identity : undefined
  const old = obs(f.roles.O) ?? (f.tState === 'old' ? t : undefined)
  const next = obs(f.roles.N) ?? (f.tState === 'new' ? t : undefined)
  return { ...(old === undefined ? {} : { old }), ...(next === undefined ? {} : { new: next }) }
}

const refused = (reason: 'plan-changed', detail: string, opDir: string): RecoveryRunResult => ({
  status: 'refused',
  reason,
  detail,
  paths: [opDir],
})

/** Lock 1, the re-plan and its digest comparison, then the row. Never prompts. */
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
  if (cls.kind !== 'empty-op-dir' && 'facts' in cls && cls.facts !== null) {
    const xdev = crossDeviceReason(cls.facts)
    if (xdev !== null)
      return refused('plan-changed', `the backup area moved devices: ${xdev}`, planned.opDir)
  }
  await opts.afterReplan?.()
  const out: RecoveryDone = {
    status: 'done',
    opId: req.opId,
    action: req.action,
    from: planned.report.label,
    installed: null,
    kept: [],
    manifest: 'untouched',
    audit: { kind: 'none' },
    warnings: [],
    swept: { removed: [], left: [] },
  }
  if (planned.emptyTarget !== null) {
    try {
      await removeEmptyOp(ctx, planned.emptyTarget, opts.swap?.trace)
    } catch (err) {
      rethrowLockOrder(err)
      const d = describe(err)
      return { status: 'stopped', opId: req.opId, ...d, recordPath: null, warnings: [] }
    }
    const swept = await sweepRoot(ctx, planned.sweep, opts.swap?.trace)
    // The target itself is the first thing this action removed.
    out.swept = { removed: [planned.emptyTarget.path, ...swept.removed], left: swept.left }
    return out
  }
  if (cls.kind !== 'state') {
    return refused('plan-changed', `the op is now ${cls.kind}`, planned.opDir)
  }
  const f = cls.facts
  const st = recoveryState({
    record: f.record,
    binding: ctx,
    ctx,
    options: opts.swap ?? {},
    ...(req.acceptIdentity === true ? { identities: acceptedIdentities(f) } : {}),
    ...(opts.manifestPort === undefined ? {} : { manifest: opts.manifestPort }),
  })
  out.warnings = st.warnings
  const row: Row = {
    st,
    cls,
    steps: planned.plan.steps,
    k: { facts: f, transcript },
    out,
    opts,
    journalFile,
  }
  try {
    const adopted = adoptAll(f, listedNames(transcript, f.opDir), transcript)
    if ((await runRow(row, req.action)) === 'plan-changed') {
      return refused(
        'plan-changed',
        'the manifest entry is no longer the planned one; nothing was changed',
        planned.opDir
      )
    }
    await finishRecovered(st, adopted)
  } catch (err) {
    rethrowLockOrder(err)
    const d = describe(err)
    return {
      status: 'stopped',
      opId: req.opId,
      reason: d.reason,
      detail: d.detail,
      recordPath: st.recordRemoved ? null : opPaths(st).record,
      warnings: st.warnings,
    }
  }
  out.swept = await sweepRoot(ctx, planned.sweep, opts.swap?.trace)
  return out
}
