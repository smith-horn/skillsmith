/**
 * SMI-6531 (A1 steps 6a-ii, 6a-iii): `doctor recovery --apply` / `--undo` on a
 * §3.3 row, after confirmation (A1 plan §3.9, the confirmation contract items
 * 6-7; §3.3 dispositions; design § 2 "Used twice", § 4, § 5).
 *
 * `executeRecovery` (`skill-recovery.exec.ts`, 6b-i) takes lock 1 for the
 * root, re-plans with a fresh reader and compares digests; for a row it calls
 * `runRecorded` here, which runs the row, keeping the transaction's order
 * (commit, audit, publish, finish):
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
 * Across devices (6a-iii): before the first mutation, a keep that still has
 * to be copied and would not fit refuses `state-root-full` naming
 * `FREE_SPACE_REMEDY`, free space by hand (`spaceBlock`; the prune command is
 * not available yet), and a park intent the finish would write that the
 * reader would refuse refuses `staging-unsafe` (`intentBlock`). A keep's verified
 * source stays in OP, and the finish parks OP whole once its metadata is
 * unlinked (`skill-recovery.park.ts`, UD28); a park that does not finish is a
 * `removal-not-done` warning (exit 4, UD32). Doctor's own full-device stop
 * records the marker in the adopted record (`skill-recovery.mark.ts`), and a
 * sidecar a crashed run published is replaced through `unlinkAdopted`.
 *
 * @module @skillsmith/core/services/skill-recovery.run
 */
import path from 'node:path'
import { appendJournalRecordOnce } from '../journal/writer.js'
import { finishRecovered, sweepRoot } from './skill-recovery.finish.js'
import { intentBlock, rewriteMarkerAdopted, spaceBlock } from './skill-recovery.mark.js'
import { finishRecoveredAcross } from './skill-recovery.park.js'
import { installAt, keepRole } from './skill-recovery.resume.js'
import type { KeepContext } from './skill-recovery.resume.js'
import { adoptMetadata, recoveryState, unlinkAdopted } from './skill-recovery.state.js'
import type { Adopted } from './skill-recovery.state.js'
import type {
  AuditOutcome,
  PlannedRecovery,
  RecoveryDone,
  RecoveryRefusal,
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
import type { SkillWriteContext } from './skill-write-lock.types.js'

type RowClass = Extract<RecoveryClass, { kind: 'state' }>

/** The kind the confirmed plan keeps `tree` as. */
function kindIn(steps: readonly PlanStep[], tree: PlanStep['tree']): string | null {
  const s = steps.find((x) => x.tree === tree)
  return s !== undefined && s.disposition.kind === 'kept' ? s.disposition.as : null
}

/**
 * The metadata files finish may unlink: `owner.json`, a provable
 * `record.json.tmp`, a provable `park-intent.json.tmp`, and `record.json`
 * (last); plus a verifying `park-intent.json`, which a cross-device finish
 * reuses (and a one-device one unlinks).
 */
function adoptAll(
  f: OpFacts,
  names: readonly string[],
  t: ReadTranscript
): { files: Adopted[]; intent: Adopted | null; tmp: Adopted | null } {
  const out: Adopted[] = []
  const at = (n: string): string => path.join(f.opDir, n)
  if (names.includes(OWNER_FILE)) out.push(adoptMetadata(t, at(OWNER_FILE)))
  const tmp = f.recordTmp
  let recordTmp: Adopted | null = null
  if (tmp !== null) {
    // A marked temp whose body matches the record is this op's (a marker rewrite that crashed).
    if (!tmp.sameInode && !tmp.emptySingleLink && !tmp.bodyMatches) {
      throw new SwapFault('staging-unsafe', `${tmp.path} is not provably this operation's`)
    }
    recordTmp = adoptMetadata(t, tmp.path)
    out.push(recordTmp)
  }
  if (f.parkIntentTmp !== null) {
    if (!f.parkIntentTmp.provable) {
      throw new SwapFault(
        'staging-unsafe',
        `${f.parkIntentTmp.path} is not provably this operation's`
      )
    }
    out.push(adoptMetadata(t, f.parkIntentTmp.path))
  }
  let intent: Adopted | null = null
  if (f.parkIntent !== null) {
    if (!f.parkIntent.valid) {
      throw new SwapFault('staging-unsafe', `${f.parkIntent.path} is not this operation's`)
    }
    intent = adoptMetadata(t, f.parkIntent.path)
  }
  out.push(adoptMetadata(t, at(RECORD_FILE)))
  return { files: out, intent, tmp: recordTmp }
}

/**
 * Doctor's seams on the state: the adopted sidecar unlink and its own marker
 * rewrite. Exported for its unit test (the area-path guard).
 * @internal
 */
export function adoptInto(st: SwapState, t: ReadTranscript, a: ReturnType<typeof adoptAll>): void {
  adoptSidecarsInto(st, t)
  const record = a.files[a.files.length - 1]!
  st.rewriteMarker = (marker) => rewriteMarkerAdopted(st, record, a.tmp, marker)
}

/**
 * The adopted sidecar unlink alone (6b-ii `--clean-staging` too, which has no
 * record to mark): a sidecar or its temp in this op's area, read whole by the
 * re-plan, may be replaced by a resumed rewrite.
 * @internal
 */
export function adoptSidecarsInto(st: SwapState, t: ReadTranscript): void {
  st.unlinkAdopted = async (p, reason) => {
    // Only a sidecar or its temp in this op's area, read whole by the re-plan.
    if (path.dirname(p) !== st.areaPath) return false
    let adopted: Adopted
    try {
      adopted = adoptMetadata(t, p)
    } catch {
      return false
    }
    await unlinkAdopted(st, adopted, reason)
    return true
  }
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
  const before = row.k.partials.length
  const dest = await keepRole(row.st, tree, kind, row.k)
  // A cross-device resume keeps a copy temp that was not the source (P2) before it copies again.
  for (const p of row.k.partials.slice(before)) {
    row.out.kept.push({ tree, kind: 'partial-copy', path: p })
  }
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

/** What `runRecorded` needs from `executeRecovery`'s prologue (lock 1 held, the re-plan matched). */
export interface RecordedRun {
  planned: PlannedRecovery
  opts: RecoveryRunOptions
  ctx: SkillWriteContext
  cls: RowClass
  transcript: ReadTranscript
  journalFile: string
  out: RecoveryDone
}

/**
 * A §3.3 row's `--apply` or `--undo` under lock 1: adopt the metadata, the
 * space block, the row, then the finish (one device, or the park across
 * devices) and the sweep. Called by `executeRecovery` (`skill-recovery.exec.ts`).
 */
export async function runRecorded(a: RecordedRun): Promise<RecoveryRunResult> {
  const { planned, opts, ctx, cls, transcript, journalFile, out } = a
  const req = planned.request
  const action = req.action
  // Type narrowing only: `executeRecovery` calls this for `--apply`/`--undo` alone.
  if (action !== 'apply' && action !== 'undo') {
    return refused('plan-changed', `--${action} does not act on ${cls.state}`, planned.opDir)
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
    k: { facts: f, transcript, partials: [] },
    out,
    opts,
    journalFile,
  }
  try {
    const adopted = adoptAll(f, listedNames(transcript, f.opDir), transcript)
    adoptInto(st, transcript, adopted)
    // Before the first mutation: a cross-device copy that cannot fit refuses, nothing changed.
    const full = await spaceBlock(st, f, planned.plan.steps)
    if (full !== null) return refused('state-root-full', full, planned.opDir)
    // And a park intent the finish would write that the reader would refuse (none is written when one is reused).
    const unreadable = adopted.intent === null ? intentBlock(st, f, planned.plan.steps) : null
    if (unreadable !== null) return refused('staging-unsafe', unreadable, planned.opDir)
    if ((await runRow(row, action)) === 'plan-changed') {
      return refused(
        'plan-changed',
        'the manifest entry is no longer the planned one; nothing was changed',
        planned.opDir
      )
    }
    if (st.moveSources.size > 0) {
      out.extraCopy = await finishRecoveredAcross(st, adopted.files, adopted.intent)
    } else {
      await finishRecovered(st, [...adopted.files, ...(adopted.intent ? [adopted.intent] : [])])
    }
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

/** A refusal with zero mutation, naming the op dir. */
export function refused(
  reason: 'plan-changed' | 'state-root-full' | 'staging-unsafe',
  detail: string,
  opDir: string
): RecoveryRefusal {
  return { status: 'refused', reason, detail, paths: [opDir] }
}
