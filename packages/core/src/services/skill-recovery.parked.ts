/**
 * SMI-6531 (A1 step 6a-iii, owner decision 2026-10-26): `--apply` / `--undo`
 * for an op whose dir is already parked (a kill after the park moved OP and
 * before its syncs reported). The park's own post-move syncs (`<opId>`'s
 * landing directory, then ST) may not have run, so under lock 1 the landing
 * directory must still have the identity the plan saw, and both are synced:
 * what the uninterrupted run's `syncPark` does. Nothing moves or is removed.
 *
 * @module @skillsmith/core/services/skill-recovery.parked
 */
import fs from 'node:fs'
import { syncDirectory } from '../install/dir-sync.js'
import { identityOf, sameIdentity } from '../install/park-tree.identity.js'
import { boundOf } from './skill-recovery.state.js'
import type {
  PlannedRecovery,
  RecoveryRunOptions,
  RecoveryRunResult,
} from './skill-recovery.run.types.js'
import type { SkillWriteContext } from './skill-write-lock.types.js'

/** Syncs the parked landing directory, then ST, and reports the parked copy. */
export async function syncParked(
  planned: PlannedRecovery,
  ctx: SkillWriteContext,
  opts: RecoveryRunOptions
): Promise<RecoveryRunResult> {
  const p = planned.parked!
  const refusal = (detail: string): RecoveryRunResult => ({
    status: 'refused',
    reason: 'plan-changed',
    detail,
    paths: [p.landing],
  })
  let now: fs.BigIntStats
  try {
    now = fs.lstatSync(p.landing, { bigint: true })
  } catch {
    return refusal(`${p.landing} is gone; nothing was changed`)
  }
  if (!now.isDirectory() || !sameIdentity(boundOf(p.identity), identityOf(now))) {
    return refusal(`${p.landing} is not the directory the plan saw; nothing was changed`)
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
    extraCopy: p.copies.length === 1 ? p.copies[0]! : null,
    manifest: 'untouched',
    audit: { kind: 'none' },
    warnings: [],
    swept: { removed: [], left: [] },
  }
}
