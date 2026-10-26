/**
 * SMI-6531 (A1 step 6a-i): the lock files `doctor locks` lists over the
 * discovered skills roots (plan §3.9 `doctor locks`).
 *
 * Each root has `<root>/.skillsmith-writes.lock` (lock 1) and its
 * `.reclaim`; both are listed with what `inspectLock` knows (claim kind, pid,
 * host, whether the pid is alive here, and the age from the file's
 * nanosecond mtime). Listing only: `--release` over these paths is 6a-ii's.
 *
 * @module @skillsmith/core/services/skill-recovery.locks
 */
import { inspectLock } from '../config/lock-doctor.js'
import type { LockInspection } from '../config/lock-doctor.js'
import { skillsRootLockPaths } from './skill-write-lock.js'

export interface RootLockEntry {
  /** The skills root the lock belongs to. */
  root: string
  /** `<root>/.skillsmith-writes.lock` or its `.reclaim`. */
  path: string
  /** What is there now; null when no file is. */
  inspection: LockInspection | null
}

/** Every discovered root's write lock and its reclaim lock, with the claim each holds. */
export function rootLockEntries(
  roots: readonly string[],
  inspect: (p: string) => LockInspection | null = inspectLock
): RootLockEntry[] {
  const entries: RootLockEntry[] = []
  for (const root of roots) {
    for (const p of skillsRootLockPaths(root)) {
      entries.push({ root, path: p, inspection: inspect(p) })
    }
  }
  return entries
}
