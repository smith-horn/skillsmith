/**
 * SMI-6531 (A1 steps 4a, 6a-ii): step 10, the manifest commit, shared by the
 * in-place update (`skill-swap.ts`) and doctor's `--apply` (S1 and S2, A1 plan
 * §3.3 step 10: "Doctor's `--apply` commit runs the same order"), so the order
 * has one implementation.
 *
 * Before lock 3: `check`, the new folder's identity, the `beforeCommitRehash`
 * hook and the advisory re-hash (`live-folder-changed`). Under one
 * `withManifestLock` hold (retried once on `ManifestLockLost`, so no side
 * effect repeats): (a) CAS, (b) `check` and identity, (e) `write()` with (d),
 * the pre-commit lock check, inside it.
 *
 * What a throw from the hold becomes (7a retro): `ManifestLockLost` (twice) is
 * `pre-commit-check-failed`; a `LockOrderError` is a bug and propagates; a
 * `SwapFault` or `SkillWriteStop` from this module's own checks stays as it
 * is; anything else (a `ManifestUnwritableError` from the strict load inside
 * `casMatches()`, a `StuckLockError` from lock 3's acquisition) is
 * `manifest-write-failed`, naming the cause. That is the plan's word for "the
 * step-10 commit did not happen" (10e); `write-failed` names a filesystem write
 * of trees or staging and would send the reader to the wrong place, and `busy`
 * is a refusal before rename 1, while this stop comes after it with the record
 * kept.
 *
 * @module @skillsmith/core/services/skill-swap.commit
 */
import path from 'node:path'
import { getJournalSessionId } from '../journal/path.js'
import { JOURNAL_SCHEMA_VERSION } from '../journal/types.js'
import { bindIdentity, sameIdentity } from '../install/park-tree.identity.js'
import { ManifestEntryChanged } from './skill-manifest.entry.js'
import { ManifestLockLost } from './skill-manifest.lock.js'
import { treeHashOf } from './skill-tree.js'
import { SkillWriteStop } from './skill-write-lock.types.js'
import { check, hook, messageOf, rethrowLockOrder, SwapFault, trace } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { changedPaths } from './skill-swap.writeset.js'

/** `lstat(p)` is a directory (not a symlink) with `id`, else `SwapFault(reason)`. */
export function assertIdentity(
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

/**
 * Step 10's advisory re-hash, before lock 3: a foreign write after rename 2
 * only warns. The changed paths are named when the built tree's walk record is
 * known (the transaction); doctor has only `postTree`, so it names none.
 */
export function warnIfLiveFolderChanged(st: SwapState): void {
  const live = treeHashOf(st.input.realDir)
  if (!live.ok) {
    st.warnings.push({
      code: 'live-folder-changed',
      paths: [path.relative(st.input.realDir, live.path)],
    })
  } else if (live.hash !== st.postTree) {
    st.warnings.push({
      code: 'live-folder-changed',
      paths: st.postRecord === null ? [] : changedPaths(st.postRecord, live.record),
    })
  }
}

export type CommitVerdict = 'committed' | 'cas-failed'

/** The name and message of a throw, for a stop's detail. */
const causeOf = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err)

/**
 * Step 10. Returns `committed`, or `cas-failed` when the entry is not the
 * planned one (the caller decides what that means: an undo in the
 * transaction, `plan-changed` or a new row in doctor). Throws `SwapFault`
 * (`target-changed`, `pre-commit-check-failed`, `manifest-write-failed`) or
 * `SkillWriteStop` from a `check`; a `LockOrderError` propagates.
 */
export async function commit(st: SwapState): Promise<CommitVerdict> {
  const { realDir, manifest, manifestPath } = st.input
  check(st)
  assertIdentity(realDir, st.newIdentity!, 'target-changed', 'the new folder')
  await hook(st, 'beforeCommitRehash')
  warnIfLiveFolderChanged(st)
  try {
    return await manifest.withManifestLock(async (m): Promise<CommitVerdict> => {
      if (!(await m.casMatches())) return 'cas-failed'
      check(st)
      assertIdentity(realDir, st.newIdentity!, 'target-changed', 'the new folder')
      try {
        await m.write()
      } catch (err) {
        if (err instanceof ManifestEntryChanged) return 'cas-failed'
        if (err instanceof ManifestLockLost) throw err
        rethrowLockOrder(err)
        throw new SwapFault('manifest-write-failed', messageOf(err), err)
      }
      trace(st, { op: 'manifest-write', path: manifestPath })
      st.phase = 'committed'
      return 'committed'
    })
  } catch (err) {
    rethrowLockOrder(err)
    if (err instanceof ManifestLockLost) {
      throw new SwapFault('pre-commit-check-failed', messageOf(err), err)
    }
    if (err instanceof SwapFault || err instanceof SkillWriteStop) throw err
    throw new SwapFault(
      'manifest-write-failed',
      `the manifest commit under lock 3 did not happen (${causeOf(err)})`,
      err
    )
  }
}

/** Step 11's journal input (the transaction's, and doctor's audit append for the same op). */
export function journalInput(st: SwapState) {
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
