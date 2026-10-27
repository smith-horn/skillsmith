/**
 * SMI-6531 (A1 step 6a-iii): `--apply` / `--undo` for an op whose dir is
 * already parked (a kill after the park moved OP and before its syncs
 * reported). The park's own post-move syncs (`<opId>`'s landing directory,
 * then ST) may not have run. Under lock 1 the park is judged again with a
 * fresh reader (`inspectParked`), and its digest must equal the confirmed
 * plan's before either directory is synced (GPT-5.6-Sol bf-zyg F1); then both
 * are synced, as the uninterrupted run's `syncPark` does. Nothing moves or is
 * removed.
 *
 * @module @skillsmith/core/services/skill-recovery.parked
 */
import { syncDirectory } from '../install/dir-sync.js'
import { digestOf } from './skill-recovery.digest.js'
import { inspectParked } from './skill-recovery.parked-check.js'
import type { ParkedView } from './skill-recovery.parked-check.js'
import { ClassifierReader } from './skill-recovery.reader.js'
import type {
  PlannedRecovery,
  RecoveryRequest,
  RecoveryRunOptions,
  RecoveryRunResult,
} from './skill-recovery.run.types.js'
import type { SkillWriteContext } from './skill-write-lock.types.js'

/** `inspectParked`'s arguments for a request in a bound root. */
export function parkedArgs(request: RecoveryRequest, b: { root: string; stagingDir: string }) {
  return {
    root: b.root,
    stagingDir: b.stagingDir,
    opId: request.opId,
    euid: request.euid ?? process.geteuid?.() ?? -1,
    stateRoots: request.stateRoots ?? [],
  }
}

/** The digest over everything `inspectParked` read and what it concluded. */
export function parkedDigest(
  reader: ClassifierReader,
  view: ParkedView,
  request: RecoveryRequest
): string {
  return digestOf(reader.transcript(), { parked: view, action: request.action })
}

/** Re-judges the park under lock 1, then syncs its landing directory and ST. */
export async function syncParked(
  planned: PlannedRecovery,
  ctx: SkillWriteContext,
  opts: RecoveryRunOptions
): Promise<RecoveryRunResult> {
  const p = planned.parked!
  const reader = new ClassifierReader(planned.request.reader)
  const view = inspectParked(reader, parkedArgs(planned.request, ctx))
  if (view === null || parkedDigest(reader, view, planned.request) !== planned.report.digest) {
    return {
      status: 'refused',
      reason: 'plan-changed',
      detail: `${p.landing} is not what the plan read; nothing was changed. Run the command again to see the new plan`,
      paths: [p.landing],
    }
  }
  ctx.check()
  for (const dir of [p.landing, ctx.stagingDir]) {
    const s = await syncDirectory(dir)
    if (s.outcome === 'failed') {
      return {
        status: 'stopped',
        opId: planned.request.opId,
        reason: 'write-failed',
        detail: `${dir} could not be synced (${s.code})`,
        recordPath: null,
        warnings: [],
      }
    }
    opts.swap?.trace?.({ op: 'dirsync', path: dir })
  }
  return {
    status: 'done',
    opId: planned.request.opId,
    action: planned.request.action,
    from: planned.report.label,
    installed: null,
    kept: [],
    extraCopy: p.copy,
    manifest: 'untouched',
    audit: { kind: 'none' },
    warnings: [],
    swept: { removed: [], left: [] },
  }
}
