/**
 * SMI-6531 (A1 step 3a): lock 4 (UD31) around every parked-index write.
 *
 * Lock 4 is `withFileLock(<indexPath>, …)`, so its file is
 * `<indexPath>.lock` (A1 plan §3.2). It serializes the two writers of the
 * index: one park's append and one compaction. Without it, a line appended
 * between a compaction's read and its rename is lost, and for an
 * `author init --path` park the index is the only route doctor has to the
 * tree.
 *
 * Lock 4 is a leaf: nothing requests another lock while holding it. That holds
 * by construction here, since the only work done under it is one append or one
 * compaction, and this module exports no way to run anything else under it.
 *
 * The lock file is `<indexPath>.lock`, spelled exactly as the caller spelled
 * the index, and the OS resolves it. Measured (SMI-6531): `..`, `//` and a
 * symlinked directory each reach the same lock file as the plain spelling, so
 * the path is deliberately not normalized here; `path.resolve` would send
 * `<symlink>/..` to a different directory than the OS does and split the lock.
 * The one spelling that does not share it is a symlink to the index file
 * itself, whose lock lands beside the symlink. Callers pass
 * `<stateRoot>/parked-index.jsonl`.
 *
 * This module sits outside the park graph that the static boundary test walks
 * from `park-tree.ts`, because it imports `config/file-lock`. It makes no fs
 * call of its own.
 *
 * @module @skillsmith/core/install/park-call
 */
import { withFileLock } from '../config/file-lock.js'
import { errCodeOrMessage } from './park-result.js'
import type { ParkOptions, ParkResult } from './park-result.js'
import { prepareParkTree } from './park-tree.js'
import { appendParkedIndex, compactParkedIndex } from './parked-index.js'
import type { CompactResult, ParkedIndexEntry } from './parked-index.js'

/** The label `withFileLock` puts in a lock-timeout error. */
const LOCK_LABEL = 'the parked-index lock (lock 4)'

/**
 * Appends one entry under lock 4. Throws on any failure, the lock's own
 * timeout included; `parkTreeIndexed` records it as `indexError`.
 */
export async function appendParkedIndexLocked(
  indexPath: string,
  entry: ParkedIndexEntry
): Promise<void> {
  await withFileLock(indexPath, LOCK_LABEL, async () => appendParkedIndex(indexPath, entry), {
    rank: '4',
  })
}

/**
 * `compactParkedIndex` under lock 4, which is that function's precondition. A
 * lock that cannot be taken leaves the index untouched and is returned as the
 * error, never thrown. Its `errno` is then the lock error's code if it has one
 * (`ENOENT` for a missing state directory), else its message (a timeout's
 * `StuckLockError`, which names the lock and its holder).
 */
export async function compactParkedIndexLocked(indexPath: string): Promise<CompactResult> {
  try {
    return await withFileLock(indexPath, LOCK_LABEL, async () => compactParkedIndex(indexPath), {
      rank: '4',
    })
  } catch (err) {
    return { ok: false, errno: errCodeOrMessage(err) }
  }
}

/**
 * The park call for a caller that records an index line (A1 plan §3.3): the
 * same validation and park as `parkTree`, then, when the tree moved and
 * `indexPath` is given, one append under lock 4. Invalid input rejects the
 * returned promise before any filesystem work, with the TypeError `parkTree`
 * would throw.
 *
 * A failed append, a lock timeout included, is reported as `indexError` and
 * never changes the status: the index is advisory, and the sidecar beside the
 * parked copy is what makes it restorable (ADR-166 D-1, D-3).
 */
export async function parkTreeIndexed(
  parentAbs: string,
  name: string,
  options: ParkOptions
): Promise<ParkResult> {
  const prepared = prepareParkTree(parentAbs, name, options)
  const { result, indexEntry } = prepared.run()
  if (prepared.indexPath === undefined || indexEntry === null) return result
  try {
    await appendParkedIndexLocked(prepared.indexPath, indexEntry)
    return result
  } catch (err) {
    return { ...result, indexError: errCodeOrMessage(err) }
  }
}
